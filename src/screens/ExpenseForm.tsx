import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { confirmDialog, toast } from '../components/Dialog'
import { Header } from '../components/Header'
import { buildShares, dayKey, formatMoney, minorToInput, parseAmount, splitEqual, sumShares } from '../lib/calc'
import { db } from '../lib/db'
import { deleteExpense, saveExpense } from '../lib/repo'
import type { Expense } from '../lib/types'
import { memberName, useTrip } from '../lib/useTrip'
import { goBack } from '../router'

const today = () => dayKey(new Date().toISOString())

/** Date input value → stored timestamp. Today uses "now" so same-day items keep their order; other days use local noon. */
function dateToSpentAt(day: string, previous?: string): string {
  if (previous && dayKey(previous) === day) return previous
  if (day === today()) return new Date().toISOString()
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12).toISOString()
}

export function ExpenseForm({ tripId, expenseId }: { tripId: string; expenseId: string | null }) {
  const data = useTrip(tripId)
  const existing = useLiveQuery(
    async () => (expenseId ? ((await db.expenses.get(expenseId)) ?? null) : null),
    [expenseId],
  )
  if (!data || existing === undefined) return null
  if (expenseId && (!existing || existing.deleted)) {
    return (
      <>
        <Header title="Expense" onBack={() => goBack(`/t/${tripId}/expenses`)} />
        <main className="page">
          <div className="empty">This expense was deleted.</div>
        </main>
      </>
    )
  }
  return <Form key={expenseId ?? 'new'} tripId={tripId} existing={existing} data={data} />
}

function Form({
  tripId,
  existing,
  data,
}: {
  tripId: string
  existing: Expense | null
  data: NonNullable<ReturnType<typeof useTrip>>
}) {
  const currency = data.trip?.currency ?? ''
  // Active members, plus anyone already on this expense who has since been removed.
  const people = useMemo(() => {
    const ids = new Set(data.members.map((m) => m.id))
    const extra = existing
      ? data.allMembers.filter(
          (m) => !ids.has(m.id) && (m.id === existing.paid_by || existing.shares.some((s) => s.member_id === m.id)),
        )
      : []
    return [...data.members, ...extra]
  }, [data, existing])

  const isEqualSplit = (e: Expense) => {
    const ids = e.shares.map((s) => s.member_id)
    const eq = splitEqual(e.amount_minor, ids)
    return eq.every((s, i) => s.amount_minor === e.shares[i].amount_minor)
  }

  const [title, setTitle] = useState(existing?.title ?? '')
  const [amount, setAmount] = useState(existing ? minorToInput(existing.amount_minor) : '')
  const [day, setDay] = useState(existing ? dayKey(existing.spent_at) : today())
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [paidBy, setPaidBy] = useState<string | null>(existing?.paid_by ?? null)
  const [included, setIncluded] = useState<string[]>(
    existing ? existing.shares.map((s) => s.member_id) : data.members.map((m) => m.id),
  )
  const [mode, setMode] = useState<'equal' | 'custom'>(existing && !isEqualSplit(existing) ? 'custom' : 'equal')
  const [custom, setCustom] = useState<Record<string, string>>(() =>
    Object.fromEntries((existing?.shares ?? []).map((s) => [s.member_id, minorToInput(s.amount_minor)])),
  )
  const [errors, setErrors] = useState<string[]>([])
  const [tried, setTried] = useState(false)

  const amountMinor = parseAmount(amount)
  // Keep the included list in the members' display order.
  const includedOrdered = people.map((p) => p.id).filter((id) => included.includes(id))
  const customMinor = Object.fromEntries(
    includedOrdered.map((id) => [id, custom[id]?.trim() ? parseAmount(custom[id]) : 0]),
  )
  const draft = {
    title,
    amount_minor: amountMinor,
    paid_by: paidBy,
    included: includedOrdered,
    mode,
    custom: customMinor,
  }
  const result = buildShares(draft)

  useEffect(() => {
    if (tried) setErrors(buildShares(draft).errors)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tried, title, amount, paidBy, included, mode, custom])

  const toggle = (id: string) =>
    setIncluded((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (amount.trim() && amountMinor === null) {
      setErrors(['Amount should be a number with at most 2 decimals, like 1500.50.'])
      return
    }
    if (result.errors.length) return setErrors(result.errors)
    await saveExpense(tripId, existing?.id ?? null, {
      title,
      amount_minor: amountMinor!,
      paid_by: paidBy!,
      spent_at: dateToSpentAt(day, existing?.spent_at),
      notes,
      shares: result.shares,
    })
    toast(existing ? 'Expense updated' : 'Expense added')
    goBack(`/t/${tripId}/expenses`)
  }

  const remove = async () => {
    if (!existing) return
    const ok = await confirmDialog({ title: `Delete “${existing.title}”?`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    await deleteExpense(existing.id)
    toast('Expense deleted')
    goBack(`/t/${tripId}/expenses`)
  }

  const customTotal = sumShares(includedOrdered.map((id) => ({ member_id: id, amount_minor: customMinor[id] ?? 0 })))
  const equalShares = amountMinor ? splitEqual(amountMinor, includedOrdered) : []
  const shareOf = (id: string) => equalShares.find((s) => s.member_id === id)?.amount_minor ?? 0

  return (
    <>
      <Header title={existing ? 'Edit expense' : 'Add expense'} subtitle={data.trip?.name} onBack={() => goBack(`/t/${tripId}/expenses`)} />
      <main className="page">
        <form className="stack" onSubmit={save} noValidate>
          <label className="field">
            <span>What for</span>
            <input value={title} placeholder="Dinner, petrol, hotel…" onChange={(e) => setTitle(e.target.value)} autoCapitalize="sentences" />
          </label>
          <div className="row gap">
            <label className="field grow">
              <span>Amount ({currency})</span>
              <input
                className="amount-input"
                value={amount}
                inputMode="decimal"
                placeholder="0"
                autoComplete="off"
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
              />
            </label>
            <label className="field date-field">
              <span>Date</span>
              <input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value || today())} />
            </label>
          </div>

          <fieldset className="field">
            <legend>Paid by</legend>
            <div className="chips">
              {people.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  className={`chip ${paidBy === m.id ? 'selected' : ''}`}
                  aria-pressed={paidBy === m.id}
                  onClick={() => setPaidBy(m.id)}
                >
                  {memberName(data.allMembers, m.id)}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="field">
            <div className="legend-row">
              <legend>Split between</legend>
              <div className="row gap-s">
                <button type="button" className="btn small ghost" onClick={() => setIncluded(people.map((p) => p.id))}>
                  All
                </button>
                <button type="button" className="btn small ghost" onClick={() => setIncluded([])}>
                  None
                </button>
              </div>
            </div>
            <div className="segmented" role="radiogroup" aria-label="Split mode">
              <button type="button" role="radio" aria-checked={mode === 'equal'} className={mode === 'equal' ? 'active' : ''} onClick={() => setMode('equal')}>
                Equally
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'custom'}
                className={mode === 'custom' ? 'active' : ''}
                onClick={() => {
                  // Prefill custom amounts with the equal split so editing is easy.
                  if (mode === 'equal' && amountMinor)
                    setCustom(Object.fromEntries(equalShares.map((s) => [s.member_id, minorToInput(s.amount_minor)])))
                  setMode('custom')
                }}
              >
                Custom amounts
              </button>
            </div>
            <ul className="checklist">
              {people.map((m) => {
                const on = included.includes(m.id)
                return (
                  <li key={m.id} className={on ? 'on' : ''}>
                    <label className="check">
                      <input type="checkbox" checked={on} onChange={() => toggle(m.id)} />
                      <span className="grow">{memberName(data.allMembers, m.id)}</span>
                    </label>
                    {on && mode === 'equal' && <span className="muted">{formatMoney(shareOf(m.id), currency)}</span>}
                    {on && mode === 'custom' && (
                      <input
                        className="share-input"
                        inputMode="decimal"
                        aria-label={`Share for ${m.name}`}
                        placeholder="0"
                        value={custom[m.id] ?? ''}
                        onChange={(e) => setCustom({ ...custom, [m.id]: e.target.value.replace(/[^\d.,]/g, '') })}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
            {mode === 'custom' && (
              <p className={`running ${amountMinor !== null && customTotal === amountMinor ? 'ok' : 'warn'}`}>
                Total {formatMoney(customTotal, currency)} of {formatMoney(amountMinor ?? 0, currency)}
                {amountMinor !== null && customTotal !== amountMinor &&
                  (customTotal < amountMinor
                    ? ` · ${formatMoney(amountMinor - customTotal, currency)} left`
                    : ` · ${formatMoney(customTotal - amountMinor, currency)} too much`)}
              </p>
            )}
          </fieldset>

          <label className="field">
            <span>Notes</span>
            <textarea rows={2} value={notes} placeholder="Optional" onChange={(e) => setNotes(e.target.value)} />
          </label>

          {errors.length > 0 && (
            <ul className="error-list" role="alert">
              {errors.map((er) => (
                <li key={er}>{er}</li>
              ))}
            </ul>
          )}

          <button className="btn primary block big">{existing ? 'Save changes' : 'Add expense'}</button>
          {existing && (
            <button type="button" className="btn ghost block danger-text" onClick={remove}>
              Delete expense
            </button>
          )}
        </form>
      </main>
    </>
  )
}
