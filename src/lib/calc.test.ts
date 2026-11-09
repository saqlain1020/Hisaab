import { describe, expect, it } from 'vitest'
import {
  buildShares,
  computeBalances,
  formatMoney,
  minorToInput,
  parseAmount,
  splitEqual,
  suggestTransfers,
  sumShares,
  validatePayment,
  parseSum,
  buildQuickExpenses,
} from './calc'
import { nextStamp } from './db'
import type { Expense, Member, Settlement } from './types'

const base = { updated_at: '2026-01-01T00:00:00.000Z', deleted: false }
const member = (id: string, name = id, deleted = false): Member => ({ ...base, id, trip_id: 't', name, deleted })
const expense = (id: string, paid_by: string, amount_minor: number, ids: string[], deleted = false): Expense => ({
  ...base,
  id,
  trip_id: 't',
  title: id,
  amount_minor,
  paid_by,
  spent_at: base.updated_at,
  notes: '',
  shares: splitEqual(amount_minor, ids),
  deleted,
})
const settlement = (from: string, to: string, amount_minor: number, deleted = false): Settlement => ({
  ...base,
  id: `${from}-${to}-${amount_minor}`,
  trip_id: 't',
  from_member: from,
  to_member: to,
  amount_minor,
  paid_at: base.updated_at,
  deleted,
})
const bal = (list: ReturnType<typeof computeBalances>) => Object.fromEntries(list.map((b) => [b.member_id, b.balance]))

describe('splitEqual', () => {
  it('splits evenly when divisible', () => {
    expect(splitEqual(300000, ['a', 'b', 'c']).map((s) => s.amount_minor)).toEqual([100000, 100000, 100000])
  })

  it('gives leftover minor units one each to the first people', () => {
    const shares = splitEqual(100, ['a', 'b', 'c'])
    expect(shares.map((s) => s.amount_minor)).toEqual([34, 33, 33])
    expect(sumShares(shares)).toBe(100)
    expect(splitEqual(1001, ['a', 'b', 'c', 'd']).map((s) => s.amount_minor)).toEqual([251, 250, 250, 250])
  })

  it('always adds up exactly to the total', () => {
    for (let total = 1; total < 2000; total += 7)
      for (let n = 1; n <= 9; n++)
        expect(sumShares(splitEqual(total, Array.from({ length: n }, (_, i) => `m${i}`)))).toBe(total)
  })

  it('handles fewer minor units than people', () => {
    expect(splitEqual(2, ['a', 'b', 'c']).map((s) => s.amount_minor)).toEqual([1, 1, 0])
  })

  it('returns nothing for nobody', () => {
    expect(splitEqual(100, [])).toEqual([])
  })
})

describe('computeBalances', () => {
  const members = [member('ali', 'Ali'), member('bilal', 'Bilal'), member('sara', 'Sara')]

  it('does not charge people who were not included', () => {
    // Ali pays 3,000 dinner for all three; Bilal pays 1,000 breakfast for Bilal + Ali only.
    const expenses = [expense('dinner', 'ali', 300000, ['ali', 'bilal', 'sara']), expense('bf', 'bilal', 100000, ['ali', 'bilal'])]
    const list = computeBalances(members, expenses, [])
    const sara = list.find((b) => b.member_id === 'sara')!
    expect(sara.share).toBe(100000) // only the dinner
    expect(bal(list)).toEqual({ ali: 150000, bilal: -50000, sara: -100000 })
    expect(list.reduce((t, b) => t + b.balance, 0)).toBe(0)
  })

  it('applies settlements: sent raises balance, received lowers it', () => {
    const expenses = [expense('dinner', 'ali', 300000, ['ali', 'bilal', 'sara'])]
    const list = computeBalances(members, expenses, [settlement('bilal', 'ali', 100000)])
    expect(bal(list)).toEqual({ ali: 100000, bilal: 0, sara: -100000 })
  })

  it('ignores deleted expenses and settlements', () => {
    const expenses = [expense('x', 'ali', 999, ['bilal'], true)]
    const list = computeBalances(members, expenses, [settlement('bilal', 'ali', 500, true)])
    expect(bal(list)).toEqual({ ali: 0, bilal: 0, sara: 0 })
  })

  it('keeps removed members who have money involved and marks them removed', () => {
    const ms = [...members, member('zed', 'Zed', true), member('gone', 'Gone', true)]
    const list = computeBalances(ms, [expense('taxi', 'zed', 900, ['ali', 'zed', 'sara'])], [])
    const zed = list.find((b) => b.member_id === 'zed')!
    expect(zed.removed).toBe(true)
    expect(zed.balance).toBe(600)
    expect(list.find((b) => b.member_id === 'gone')).toBeUndefined()
  })

  it('sorts by balance, highest first', () => {
    const list = computeBalances(members, [expense('d', 'sara', 300, ['ali', 'bilal', 'sara'])], [])
    expect(list[0].member_id).toBe('sara')
  })
})

describe('suggestTransfers', () => {
  it('settles everyone with at most n−1 transfers', () => {
    const balances = [
      { member_id: 'a', balance: 5000 },
      { member_id: 'b', balance: 2000 },
      { member_id: 'c', balance: -4000 },
      { member_id: 'd', balance: -2500 },
      { member_id: 'e', balance: -500 },
    ]
    const transfers = suggestTransfers(balances)
    expect(transfers.length).toBeLessThanOrEqual(balances.length - 1)
    const after = Object.fromEntries(balances.map((b) => [b.member_id, b.balance]))
    for (const t of transfers) {
      after[t.from] += t.amount_minor
      after[t.to] -= t.amount_minor
      expect(t.amount_minor).toBeGreaterThan(0)
    }
    expect(Object.values(after).every((v) => v === 0)).toBe(true)
  })

  it('matches the largest debtor with the largest creditor first', () => {
    const t = suggestTransfers([
      { member_id: 'ali', balance: 3000 },
      { member_id: 'sara', balance: 1000 },
      { member_id: 'bilal', balance: -2000 },
      { member_id: 'omar', balance: -2000 },
    ])
    expect(t[0]).toEqual({ from: 'bilal', to: 'ali', amount_minor: 2000 })
    expect(t).toHaveLength(3)
  })

  it('returns nothing when everyone is even', () => {
    expect(suggestTransfers([{ member_id: 'a', balance: 0 }, { member_id: 'b', balance: 0 }])).toEqual([])
  })

  it('works end-to-end with an excluded friend and rounding', () => {
    const members = [member('a'), member('b'), member('c')]
    const expenses = [expense('e1', 'a', 1000, ['a', 'b', 'c']), expense('e2', 'b', 101, ['a', 'b'])]
    const balances = computeBalances(members, expenses, [])
    const transfers = suggestTransfers(balances)
    const settlements = transfers.map((t) => settlement(t.from, t.to, t.amount_minor))
    expect(computeBalances(members, expenses, settlements).every((b) => b.balance === 0)).toBe(true)
  })
})

describe('parseAmount / formatMoney', () => {
  it('parses decimals into minor units', () => {
    expect(parseAmount('1500.50')).toBe(150050)
    expect(parseAmount('1,500.5')).toBe(150050)
    expect(parseAmount('2000')).toBe(200000)
    expect(parseAmount('0.07')).toBe(7)
    expect(parseAmount('.5')).toBe(50)
    expect(parseAmount('12.')).toBe(1200)
  })

  it('rejects junk and too many decimals', () => {
    for (const bad of ['', 'abc', '1.234', '-5', '1e5', '1.2.3']) expect(parseAmount(bad)).toBeNull()
  })

  it('round-trips through the input format', () => {
    for (const v of [1, 50, 100, 150050, 200000]) expect(parseAmount(minorToInput(v))).toBe(v)
  })

  it('formats with currency and separators', () => {
    expect(formatMoney(200000, 'PKR')).toBe('PKR 2,000')
    expect(formatMoney(150050, 'PKR')).toBe('PKR 1,500.50')
    expect(formatMoney(-5, 'PKR')).toBe('−PKR 0.05')
  })
})

describe('buildShares', () => {
  const draft = {
    title: 'Dinner',
    amount_minor: 1000,
    paid_by: 'a',
    included: ['a', 'b', 'c'],
    mode: 'equal' as const,
    custom: {},
  }

  it('builds equal shares', () => {
    const r = buildShares(draft)
    expect(r.errors).toEqual([])
    expect(r.shares.map((s) => s.amount_minor)).toEqual([334, 333, 333])
  })

  it('requires custom amounts to add up exactly', () => {
    const r = buildShares({ ...draft, mode: 'custom', custom: { a: 500, b: 400, c: 99 } })
    expect(r.errors[0]).toMatch(/add up/)
    const ok = buildShares({ ...draft, mode: 'custom', custom: { a: 500, b: 500, c: 0 } })
    expect(ok.errors).toEqual([])
    // c was ticked with 0: still included (so editing keeps them ticked), owes nothing.
    expect(ok.shares).toEqual([
      { member_id: 'a', amount_minor: 500 },
      { member_id: 'b', amount_minor: 500 },
      { member_id: 'c', amount_minor: 0 },
    ])
  })

  it('reports missing fields', () => {
    const r = buildShares({ ...draft, title: ' ', amount_minor: null, paid_by: null, included: [] })
    expect(r.errors).toHaveLength(4)
  })
})

describe('nextStamp', () => {
  it('uses now when the clock is ahead of the previous edit', () => {
    expect(nextStamp('2026-01-01T00:00:00.000Z', Date.parse('2026-01-02T00:00:00.000Z'))).toBe('2026-01-02T00:00:00.000Z')
  })

  it('still moves forward when this phone’s clock is behind', () => {
    expect(nextStamp('2026-01-02T00:00:00.000Z', Date.parse('2026-01-01T00:00:00.000Z'))).toBe('2026-01-02T00:00:00.001Z')
  })
})

describe('partial settlements', () => {
  const members = [member('ali', 'Ali'), member('bilal', 'Bilal'), member('sara', 'Sara')]
  const expenses = [expense('dinner', 'ali', 300000, ['ali', 'bilal', 'sara'])]

  it('a partial payment reduces what is owed and the next suggestion', () => {
    const list = computeBalances(members, expenses, [settlement('sara', 'ali', 40000)])
    expect(bal(list)).toEqual({ ali: 160000, bilal: -100000, sara: -60000 })
    const t = suggestTransfers(list)
    expect(t).toContainEqual({ from: 'sara', to: 'ali', amount_minor: 60000 })
    expect(t).toContainEqual({ from: 'bilal', to: 'ali', amount_minor: 100000 })
  })

  it('several partial payments add up to settled', () => {
    const parts = [settlement('sara', 'ali', 25000), settlement('sara', 'ali', 75050), settlement('bilal', 'ali', 100000)]
    // 25,000 + 75,050 = 100,050 → Sara overpaid by 50 minor units; the next suggestion sends it back.
    const list = computeBalances(members, expenses, parts)
    expect(bal(list)).toEqual({ ali: -50, bilal: 0, sara: 50 })
    expect(suggestTransfers(list)).toEqual([{ from: 'ali', to: 'sara', amount_minor: 50 }])
  })

  it('a payment between two debtors moves debt between them', () => {
    // Bilal pays Sara 500: Sara now owes Ali more on Bilal's behalf.
    const list = computeBalances(members, expenses, [settlement('bilal', 'sara', 50000)])
    expect(bal(list)).toEqual({ ali: 200000, bilal: -50000, sara: -150000 })
  })
})

describe('validatePayment', () => {
  const ok = { from: 'a', to: 'b', amount_minor: 500, max: 1000 }

  it('accepts full and partial amounts up to the max', () => {
    expect(validatePayment(ok)).toEqual([])
    expect(validatePayment({ ...ok, amount_minor: 1000 })).toEqual([])
    expect(validatePayment({ ...ok, amount_minor: 1 })).toEqual([])
  })

  it('rejects overpaying a suggested transfer', () => {
    expect(validatePayment({ ...ok, amount_minor: 1001 }, 'PKR')[0]).toBe('That’s more than the PKR 10 owed.')
  })

  it('allows any positive amount when there is no max', () => {
    expect(validatePayment({ from: 'a', to: 'b', amount_minor: 999999 })).toEqual([])
  })

  it('rejects zero, invalid, missing people and paying yourself', () => {
    expect(validatePayment({ ...ok, amount_minor: 0 })).toHaveLength(1)
    expect(validatePayment({ ...ok, amount_minor: null })).toHaveLength(1)
    expect(validatePayment({ ...ok, to: 'a' })).toEqual(['Someone can’t pay themselves.'])
    expect(validatePayment({ from: null, to: null, amount_minor: 5 })).toHaveLength(2)
  })
})

describe('parseSum', () => {
  it('adds up amounts typed with +', () => {
    expect(parseSum('500+250.50 + 100')).toBe(85050)
    expect(parseSum('1,000+500')).toBe(150000)
    expect(parseSum('300')).toBe(30000)
  })
  it('treats empty as 0 and ignores a trailing + while typing', () => {
    expect(parseSum('')).toBe(0)
    expect(parseSum('  ')).toBe(0)
    expect(parseSum('500+')).toBe(50000)
  })
  it('rejects junk parts', () => {
    expect(parseSum('500+abc')).toBeNull()
    expect(parseSum('500++100')).toBeNull()
    expect(parseSum('1.234+1')).toBeNull()
  })
})

describe('buildQuickExpenses', () => {
  it('makes one expense per payer, split between the chosen friends only', () => {
    const out = buildQuickExpenses(
      [
        { member_id: 'ali', amount_minor: 300000 },
        { member_id: 'bilal', amount_minor: 0 },
        { member_id: 'sara', amount_minor: 90000 },
      ],
      ['ali', 'bilal'], // Sara paid but is not part of the split
    )
    expect(out.map((e) => e.paid_by)).toEqual(['ali', 'sara'])
    expect(out[0].shares).toEqual([{ member_id: 'ali', amount_minor: 150000 }, { member_id: 'bilal', amount_minor: 150000 }])
    expect(out[1].shares).toEqual([{ member_id: 'ali', amount_minor: 45000 }, { member_id: 'bilal', amount_minor: 45000 }])
    const members = ['ali', 'bilal', 'sara'].map((id) => member(id))
    const expenses = out.map((e, i) => ({ ...expense(`q${i}`, e.paid_by, e.amount_minor, []), shares: e.shares }))
    expect(bal(computeBalances(members, expenses, []))).toEqual({ ali: 105000, bilal: -195000, sara: 90000 })
  })

  it('every expense adds up exactly and rounding units are spread out', () => {
    const out = buildQuickExpenses(
      ['a', 'b', 'c'].map((id) => ({ member_id: id, amount_minor: 100 })),
      ['a', 'b', 'c'],
    )
    for (const e of out) expect(sumShares(e.shares)).toBe(e.amount_minor)
    const totals = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, out.reduce((t, e) => t + e.shares.find((s) => s.member_id === id)!.amount_minor, 0)]))
    expect(totals).toEqual({ a: 100, b: 100, c: 100 }) // not 102 / 99 / 99
  })

  it('returns nothing when nobody is chosen to split', () => {
    expect(buildQuickExpenses([{ member_id: 'a', amount_minor: 100 }], [])).toEqual([])
  })
})
