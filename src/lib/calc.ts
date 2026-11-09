import type { Expense, Member, Settlement, Share } from './types'

/** Split `total` minor units equally; leftover units go one each to the first people. */
export function splitEqual(total: number, memberIds: string[]): Share[] {
  const n = memberIds.length
  if (n === 0) return []
  const base = Math.floor(total / n)
  const leftover = total - base * n
  return memberIds.map((member_id, i) => ({ member_id, amount_minor: base + (i < leftover ? 1 : 0) }))
}

export interface MemberBalance {
  member_id: string
  name: string
  removed: boolean
  paid: number
  share: number
  sent: number
  received: number
  /** paid − share + sent − received. Positive = gets money back. */
  balance: number
}

/**
 * Per-member totals for one trip. Deleted expenses/settlements are ignored.
 * Removed (soft-deleted) members are included only if they have money involved.
 */
export function computeBalances(
  members: Member[],
  expenses: Expense[],
  settlements: Settlement[],
): MemberBalance[] {
  const map = new Map<string, MemberBalance>()
  const ensure = (id: string): MemberBalance => {
    let b = map.get(id)
    if (!b) {
      const m = members.find((x) => x.id === id)
      b = {
        member_id: id,
        name: m?.name ?? 'Unknown',
        removed: !m || m.deleted,
        paid: 0,
        share: 0,
        sent: 0,
        received: 0,
        balance: 0,
      }
      map.set(id, b)
    }
    return b
  }

  for (const m of members) if (!m.deleted) ensure(m.id)
  for (const e of expenses) {
    if (e.deleted) continue
    ensure(e.paid_by).paid += e.amount_minor
    for (const s of e.shares) ensure(s.member_id).share += s.amount_minor
  }
  for (const s of settlements) {
    if (s.deleted) continue
    ensure(s.from_member).sent += s.amount_minor
    ensure(s.to_member).received += s.amount_minor
  }

  const out: MemberBalance[] = []
  for (const b of map.values()) {
    b.balance = b.paid - b.share + b.sent - b.received
    const involved = b.paid || b.share || b.sent || b.received
    if (b.removed && !involved) continue
    out.push(b)
  }
  return out.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name))
}

export interface Transfer {
  from: string
  to: string
  amount_minor: number
}

/**
 * Fewest-payments suggestion: repeatedly match the largest debtor with the
 * largest creditor. Each step settles at least one person, so ≤ n−1 transfers.
 */
export function suggestTransfers(balances: { member_id: string; balance: number }[]): Transfer[] {
  const debtors = balances.filter((b) => b.balance < 0).map((b) => ({ id: b.member_id, amt: -b.balance }))
  const creditors = balances.filter((b) => b.balance > 0).map((b) => ({ id: b.member_id, amt: b.balance }))
  const bySize = (a: { id: string; amt: number }, b: { id: string; amt: number }) =>
    b.amt - a.amt || a.id.localeCompare(b.id)
  const out: Transfer[] = []
  while (debtors.length && creditors.length) {
    debtors.sort(bySize)
    creditors.sort(bySize)
    const d = debtors[0]
    const c = creditors[0]
    const amt = Math.min(d.amt, c.amt)
    out.push({ from: d.id, to: c.id, amount_minor: amt })
    d.amt -= amt
    c.amt -= amt
    if (d.amt === 0) debtors.shift()
    if (c.amt === 0) creditors.shift()
  }
  return out
}

/** "1,500.50" → 150050. Returns null for anything that isn't a positive amount with ≤ 2 decimals. */
export function parseAmount(input: string): number | null {
  const s = input.replace(/[,\s]/g, '')
  if (!/^\d+(\.\d{0,2})?$/.test(s) && !/^\.\d{1,2}$/.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  const minor = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2))
  if (!Number.isSafeInteger(minor)) return null
  return minor
}

/** 150050 → "1500.50", 200000 → "2000" (for putting back into an input). */
export function minorToInput(minor: number): string {
  const whole = Math.floor(minor / 100)
  const frac = minor % 100
  return frac ? `${whole}.${String(frac).padStart(2, '0')}` : String(whole)
}

const fmtCache = new Map<string, Intl.NumberFormat>()
/** 200000, 'PKR' → "PKR 2,000"; 150050 → "PKR 1,500.50". */
export function formatMoney(minor: number, currency?: string): string {
  const frac = minor % 100 !== 0
  const key = frac ? 'f' : 'w'
  let f = fmtCache.get(key)
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 })
    fmtCache.set(key, f)
  }
  const sign = minor < 0 ? '−' : ''
  const text = f.format(Math.abs(minor) / 100)
  return currency ? `${sign}${currency} ${text}` : `${sign}${text}`
}

export function sumShares(shares: Share[]): number {
  return shares.reduce((t, s) => t + s.amount_minor, 0)
}

export interface PaymentDraft {
  from: string | null
  to: string | null
  /** Parsed amount; null when the input isn't a valid number. */
  amount_minor: number | null
  /** For a suggested transfer: the most that may be recorded (prevents overpaying). */
  max?: number
}

/** Validate a settlement (full, partial, or a free-form payment). Returns error messages. */
export function validatePayment(p: PaymentDraft, currency?: string): string[] {
  const errors: string[] = []
  if (!p.from) errors.push('Choose who paid.')
  if (!p.to) errors.push('Choose who received it.')
  if (p.from && p.to && p.from === p.to) errors.push('Someone can’t pay themselves.')
  if (p.amount_minor === null) errors.push('Enter an amount like 500 or 500.50.')
  else if (p.amount_minor <= 0) errors.push('Enter an amount greater than 0.')
  else if (p.max !== undefined && p.amount_minor > p.max)
    errors.push(`That’s more than the ${formatMoney(p.max, currency)} owed.`)
  return errors
}

export interface ExpenseDraft {
  title: string
  amount_minor: number | null
  paid_by: string | null
  included: string[]
  mode: 'equal' | 'custom'
  custom: Record<string, number | null>
}

/** Validate an expense form and build its shares. Returns errors or the final shares. */
export function buildShares(d: ExpenseDraft): { errors: string[]; shares: Share[] } {
  const errors: string[] = []
  if (!d.title.trim()) errors.push('Enter what it was for.')
  if (d.amount_minor === null || d.amount_minor <= 0) errors.push('Enter an amount greater than 0.')
  if (!d.paid_by) errors.push('Choose who paid.')
  if (d.included.length === 0) errors.push('Pick at least one person to split between.')
  let shares: Share[] = []
  if (d.amount_minor && d.amount_minor > 0 && d.included.length) {
    if (d.mode === 'equal') {
      shares = splitEqual(d.amount_minor, d.included)
    } else {
      const missing = d.included.some((id) => d.custom[id] === null || d.custom[id] === undefined)
      shares = d.included.map((id) => ({ member_id: id, amount_minor: d.custom[id] ?? 0 }))
      const total = sumShares(shares)
      if (missing) errors.push('Check the custom amounts — use numbers like 500 or 500.50.')
      else if (total !== d.amount_minor)
        errors.push(
          `Custom amounts add up to ${formatMoney(total)}, but the expense is ${formatMoney(d.amount_minor)}.`,
        )
      // People ticked with 0 stay on the expense: they were included, they just owe nothing for it.
    }
  }
  return { errors, shares }
}

/** Local calendar day key, e.g. "2026-11-09". */
export function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Today's local day key, for date inputs. */
export const today = () => dayKey(new Date().toISOString())

/** Date input value → stored timestamp. Today uses "now" so same-day items keep their order; other days use local noon. */
export function dateToSpentAt(day: string, previous?: string): string {
  if (previous && dayKey(previous) === day) return previous
  if (day === today()) return new Date().toISOString()
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12).toISOString()
}

export function dayLabel(key: string, now = new Date()): string {
  const today = dayKey(now.toISOString())
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (key === today) return 'Today'
  if (key === dayKey(y.toISOString())) return 'Yesterday'
  const [yy, mm, dd] = key.split('-').map(Number)
  const date = new Date(yy, mm - 1, dd)
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(yy !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}

export function groupByDay(expenses: Expense[]): { key: string; total: number; items: Expense[] }[] {
  const groups = new Map<string, Expense[]>()
  const sorted = [...expenses].sort((a, b) => b.spent_at.localeCompare(a.spent_at))
  for (const e of sorted) {
    const k = dayKey(e.spent_at)
    const list = groups.get(k) ?? []
    list.push(e)
    groups.set(k, list)
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    items,
    total: items.reduce((t, e) => t + e.amount_minor, 0),
  }))
}

/**
 * Parse an amount that may be a running sum: "500+250.50 + 100" → 85050.
 * Empty input → 0. A trailing "+" (still typing) is ignored. Returns null if any part is invalid.
 */
export function parseSum(input: string): number | null {
  const parts = input.split('+').map((p) => p.trim())
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  if (parts.length === 1 && parts[0] === '') return 0
  let total = 0
  for (const p of parts) {
    const v = parseAmount(p)
    if (v === null) return null
    total += v
  }
  return Number.isSafeInteger(total) ? total : null
}

export interface QuickExpense {
  paid_by: string
  amount_minor: number
  shares: Share[]
}

/**
 * One expense per friend who paid, each split equally between `splitIds`.
 * Leftover minor units rotate from expense to expense, so the same person
 * doesn't absorb every rounding unit.
 */
export function buildQuickExpenses(payers: { member_id: string; amount_minor: number }[], splitIds: string[]): QuickExpense[] {
  if (splitIds.length === 0) return []
  return payers
    .filter((p) => p.amount_minor > 0)
    .map((p, i) => {
      const offset = i % splitIds.length
      const rotated = [...splitIds.slice(offset), ...splitIds.slice(0, offset)]
      const byId = new Map(splitEqual(p.amount_minor, rotated).map((s) => [s.member_id, s.amount_minor]))
      return {
        paid_by: p.member_id,
        amount_minor: p.amount_minor,
        // Keep shares in the caller's order for a stable display.
        shares: splitIds.map((id) => ({ member_id: id, amount_minor: byId.get(id)! })),
      }
    })
}
