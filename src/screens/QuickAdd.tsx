import { useMemo, useRef, useState } from 'react'
import { toast } from '../components/Dialog'
import { Header } from '../components/Header'
import { LoadingScreen } from '../components/Loading'
import { buildQuickExpenses, dateToSpentAt, formatMoney, parseSum, today } from '../lib/calc'
import { ValidationError, saveQuickExpenses } from '../lib/repo'
import { useTrip } from '../lib/useTrip'
import { goBack } from '../router'

/**
 * Quick add: enter what each friend paid (amounts can be typed as a running
 * sum, e.g. 500+250+120), tick who it's split between, and save one expense
 * per friend who paid.
 */
export function QuickAdd({ tripId }: { tripId: string }) {
  const data = useTrip(tripId)
  const back = () => goBack(`/t/${tripId}/expenses`)
  if (!data) return <LoadingScreen title="Quick add" onBack={back} />
  return <QuickAddForm tripId={tripId} data={data} back={back} />
}

function QuickAddForm({
  tripId,
  data,
  back,
}: {
  tripId: string
  data: NonNullable<ReturnType<typeof useTrip>>
  back: () => void
}) {
  const currency = data.trip?.currency ?? ''
  const members = data.members
  const [title, setTitle] = useState('')
  const [day, setDay] = useState(today())
  const [notes, setNotes] = useState('')
  const [paid, setPaid] = useState<Record<string, string>>({})
  const [split, setSplit] = useState<string[]>(members.map((m) => m.id))
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})

  const parsed = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, parseSum(paid[m.id] ?? '')])),
    [members, paid],
  )
  const splitOrdered = members.map((m) => m.id).filter((id) => split.includes(id))
  const payers = members.map((m) => ({ member_id: m.id, amount_minor: parsed[m.id] ?? 0 }))
  const total = payers.reduce((t, p) => t + p.amount_minor, 0)
  const items = buildQuickExpenses(payers, splitOrdered)
  const shareOf = (id: string) =>
    items.reduce((t, e) => t + (e.shares.find((s) => s.member_id === id)?.amount_minor ?? 0), 0)
  const invalid = members.filter((m) => parsed[m.id] === null)

  const appendPlus = (id: string) => {
    setPaid((cur) => {
      const v = (cur[id] ?? '').trimEnd()
      return { ...cur, [id]: v === '' || v.endsWith('+') ? v : `${v}+` }
    })
    setErrors([])
    requestAnimationFrame(() => {
      const el = inputs.current[id]
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs: string[] = []
    if (!title.trim()) errs.push('Enter what it was for.')
    if (invalid.length) errs.push(`Check the amount for ${invalid.map((m) => m.name).join(', ')} (e.g. 500+250).`)
    else if (total <= 0) errs.push('Enter how much at least one friend paid.')
    if (splitOrdered.length === 0) errs.push('Pick at least one person to split between.')
    setErrors(errs)
    if (errs.length || saving) return
    setSaving(true)
    try {
      const n = await saveQuickExpenses(tripId, { title, spent_at: dateToSpentAt(day), notes }, items)
      toast(`${n} expense${n === 1 ? '' : 's'} added · ${formatMoney(total, currency)}`)
      back()
    } catch (err) {
      setErrors([err instanceof ValidationError ? err.message : String(err)])
      setSaving(false)
    }
  }

  return (
    <>
      <Header title="Quick add" subtitle={data.trip?.name} onBack={back} />
      <main className="page">
        <form className="stack" onSubmit={save} noValidate>
          <div className="row gap">
            <label className="field grow">
              <span>What for</span>
              <input value={title} placeholder="Day 2, shopping, dinner…" onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field date-field">
              <span>Date</span>
              <input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value || today())} />
            </label>
          </div>

          <fieldset className="field">
            <legend>Who paid how much ({currency})</legend>
            <p className="muted small">Tap + to add another amount for the same person.</p>
            <ul className="checklist payer-list">
              {members.map((m) => {
                const raw = paid[m.id] ?? ''
                const value = parsed[m.id]
                const showSum = raw.includes('+') && value !== null && value > 0
                return (
                  <li key={m.id}>
                    <span className="payer-name">{m.name}</span>
                    <div className="payer-input">
                      <input
                        ref={(el) => {
                          inputs.current[m.id] = el
                        }}
                        className={value === null ? 'invalid' : ''}
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="0"
                        aria-label={`Amount ${m.name} paid`}
                        value={raw}
                        onChange={(e) => {
                          setPaid({ ...paid, [m.id]: e.target.value.replace(/[^\d.,+\s]/g, '') })
                          setErrors([])
                        }}
                      />
                      {showSum && <span className="payer-sum">= {formatMoney(value, currency)}</span>}
                    </div>
                    <button
                      type="button"
                      className="btn ghost plus-btn"
                      aria-label={`Add another amount for ${m.name}`}
                      onClick={() => appendPlus(m.id)}
                    >
                      +
                    </button>
                  </li>
                )
              })}
            </ul>
            <p className="running ok">Total paid {formatMoney(total, currency)}</p>
          </fieldset>

          <fieldset className="field">
            <div className="legend-row">
              <legend>Split equally between</legend>
              <div className="row gap-s">
                <button type="button" className="btn small ghost" onClick={() => setSplit(members.map((m) => m.id))}>
                  All
                </button>
                <button type="button" className="btn small ghost" onClick={() => setSplit([])}>
                  None
                </button>
              </div>
            </div>
            <ul className="checklist">
              {members.map((m) => {
                const on = split.includes(m.id)
                return (
                  <li key={m.id} className={on ? 'on' : ''}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          setSplit((cur) => (cur.includes(m.id) ? cur.filter((x) => x !== m.id) : [...cur, m.id]))
                          setErrors([])
                        }}
                      />
                      <span className="grow">{m.name}</span>
                    </label>
                    {on && total > 0 && <span className="muted">{formatMoney(shareOf(m.id), currency)}</span>}
                  </li>
                )
              })}
            </ul>
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

          <button className="btn primary block big" disabled={saving}>
            {items.length > 1 ? `Add ${items.length} expenses` : 'Add expense'}
            {total > 0 && ` · ${formatMoney(total, currency)}`}
          </button>
        </form>
      </main>
    </>
  )
}
