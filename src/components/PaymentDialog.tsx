import { useEffect, useRef, useState } from 'react'
import { formatMoney, minorToInput, parseAmount, validatePayment } from '../lib/calc'
import { addSettlement } from '../lib/repo'
import type { Member } from '../lib/types'
import { toast } from './Dialog'

export type PaymentRequest =
  /** "Mark paid" on a suggestion: people fixed, amount editable up to the full figure. */
  | { kind: 'suggested'; from: string; to: string; max: number }
  /** "Record a payment": anyone to anyone, any positive amount. */
  | { kind: 'free' }

export function PaymentDialog({
  request,
  tripId,
  currency,
  members,
  nameOf,
  onClose,
}: {
  request: PaymentRequest
  tripId: string
  currency: string
  members: Member[]
  nameOf: (id: string) => string
  onClose: () => void
}) {
  const suggested = request.kind === 'suggested' ? request : null
  const [from, setFrom] = useState<string | null>(suggested?.from ?? null)
  const [to, setTo] = useState<string | null>(suggested?.to ?? null)
  const [amount, setAmount] = useState(suggested ? minorToInput(suggested.max) : '')
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const amountRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (suggested) setTimeout(() => amountRef.current?.select(), 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const amountMinor = amount.trim() ? parseAmount(amount) : null
  const draft = { from, to, amount_minor: amountMinor, max: suggested?.max }
  const partial = suggested && amountMinor !== null && amountMinor > 0 && amountMinor < suggested.max

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs = validatePayment(draft, currency)
    setErrors(errs)
    if (errs.length || busy) return
    setBusy(true)
    try {
      await addSettlement(tripId, from!, to!, amountMinor!)
      toast(partial ? `Partial payment recorded · ${formatMoney(suggested!.max - amountMinor!, currency)} still owed` : 'Payment recorded')
      onClose()
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)])
      setBusy(false)
    }
  }

  const chips = (selected: string | null, onPick: (id: string) => void, disabledId: string | null) => (
    <div className="chips">
      {members.map((m) => (
        <button
          type="button"
          key={m.id}
          className={`chip ${selected === m.id ? 'selected' : ''}`}
          aria-pressed={selected === m.id}
          disabled={m.id === disabledId}
          onClick={() => {
            onPick(m.id)
            setErrors([])
          }}
        >
          {m.name}
        </button>
      ))}
    </div>
  )

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={save}
        noValidate
      >
        <h2 id="payment-title">{suggested ? 'Mark as paid' : 'Record a payment'}</h2>

        {suggested ? (
          <p className="muted">
            {nameOf(suggested.from)} → {nameOf(suggested.to)} · owes {formatMoney(suggested.max, currency)}
          </p>
        ) : (
          <>
            <fieldset className="field">
              <legend>Who paid</legend>
              {chips(from, setFrom, null)}
            </fieldset>
            <fieldset className="field">
              <legend>Paid to</legend>
              {chips(to, setTo, from)}
            </fieldset>
          </>
        )}

        <label className="field">
          <span>Amount paid ({currency})</span>
          <div className="row gap">
            <input
              ref={amountRef}
              className="amount-input grow"
              value={amount}
              inputMode="decimal"
              placeholder="0"
              autoComplete="off"
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^\d.,]/g, ''))
                setErrors([])
              }}
            />
            {suggested && amountMinor !== suggested.max && (
              <button type="button" className="btn ghost small" onClick={() => setAmount(minorToInput(suggested.max))}>
                Full
              </button>
            )}
          </div>
        </label>

        {partial && (
          <p className="running warn">
            Partial payment · {formatMoney(suggested.max - amountMinor, currency)} will still be owed
          </p>
        )}
        {errors.length > 0 && (
          <ul className="error-list" role="alert">
            {errors.map((er) => (
              <li key={er}>{er}</li>
            ))}
          </ul>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {partial ? 'Record partial' : suggested ? 'Mark paid' : 'Record'}
          </button>
        </div>
      </form>
    </div>
  )
}
