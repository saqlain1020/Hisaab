import { useMemo, useState } from 'react'
import { confirmDialog, promptDialog, toast } from '../components/Dialog'
import { Header } from '../components/Header'
import { LoadingScreen } from '../components/Loading'
import { MoreIcon, PlusIcon, ShareIcon, UsersIcon } from '../components/Icons'
import { PaymentDialog, type PaymentRequest } from '../components/PaymentDialog'
import { SyncStatus } from '../components/SyncStatus'
import {
  type MemberBalance,
  type Transfer,
  computeBalances,
  dayLabel,
  formatMoney,
  groupByDay,
  suggestTransfers,
} from '../lib/calc'
import { deleteTrip, undoSettlement, updateTrip } from '../lib/repo'
import type { Trip } from '../lib/types'
import { type TripData, memberName, useTrip } from '../lib/useTrip'
import { goBack, navigate } from '../router'

type Tab = 'balances' | 'expenses' | 'settle'

export function TripScreen({ tripId, tab }: { tripId: string; tab: Tab }) {
  const data = useTrip(tripId)
  const [menuOpen, setMenuOpen] = useState(false)
  const [copyText, setCopyText] = useState<string | null>(null)

  const balances = useMemo(
    () => (data ? computeBalances(data.allMembers, data.expenses, data.settlements) : []),
    [data],
  )
  const transfers = useMemo(() => suggestTransfers(balances), [balances])

  if (data === undefined) return <LoadingScreen onBack={() => goBack('/')} />
  if (!data.trip) return <TripGone />
  const trip = data.trip

  const setTab = (t: Tab) => navigate(`/t/${tripId}${t === 'balances' ? '' : `/${t}`}`, { replace: true })

  const rename = async () => {
    setMenuOpen(false)
    const name = await promptDialog({
      title: 'Rename trip',
      input: { label: 'Trip name', value: trip.name },
      confirmLabel: 'Save',
      validate: (v) => (v.trim() ? null : 'Give the trip a name.'),
    })
    if (name !== null) await updateTrip(trip.id, { name })
  }

  const remove = async () => {
    setMenuOpen(false)
    const ok = await confirmDialog({
      title: `Delete “${trip.name}”?`,
      message: 'This removes the trip and its expenses for everyone you sync with.',
      confirmLabel: 'Delete trip',
      danger: true,
    })
    if (ok) {
      await deleteTrip(trip.id)
      navigate('/', { replace: true })
      toast('Trip deleted')
    }
  }

  const share = async () => {
    const text = summaryText(trip, data, balances, transfers)
    if (navigator.share) {
      try {
        await navigator.share({ title: `Hisaab — ${trip.name}`, text })
      } catch (err) {
        // Cancelled by the user: nothing to do. Any other failure: the tap that
        // started this has been used up, so Safari would refuse a clipboard
        // write now. Show the text with its own Copy button (a fresh tap).
        if ((err as Error).name !== 'AbortError') setCopyText(text)
      }
      return
    }
    // No share sheet: copy directly, still inside the original tap.
    try {
      await navigator.clipboard.writeText(text)
      toast('Summary copied')
    } catch {
      setCopyText(text)
    }
  }

  const total = data.expenses.reduce((t, e) => t + e.amount_minor, 0)

  return (
    <>
      <Header
        title={trip.name}
        subtitle={<SyncStatus />}
        onBack={() => goBack('/')}
        actions={
          <>
            <button className="icon-btn" aria-label="Friends" onClick={() => navigate(`/t/${tripId}/friends`)}>
              <UsersIcon />
            </button>
            <button className="icon-btn" aria-label="Share summary" onClick={share}>
              <ShareIcon />
            </button>
            <div className="menu-wrap">
              <button className="icon-btn" aria-label="More" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
                <MoreIcon />
              </button>
              {menuOpen && (
                <>
                  <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
                  <div className="menu" role="menu">
                    <button role="menuitem" onClick={rename}>Rename trip</button>
                    <button role="menuitem" className="danger-text" onClick={remove}>Delete trip</button>
                  </div>
                </>
              )}
            </div>
          </>
        }
        below={
          <nav className="tabs" role="tablist">
            {(['balances', 'expenses', 'settle'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t === 'balances' ? 'Balances' : t === 'expenses' ? 'Expenses' : 'Settle up'}
              </button>
            ))}
          </nav>
        }
      />
      <main className="page with-fab">
        {data.members.length === 0 && (
          <div className="card notice-card">
            <p>Add the friends on this trip first.</p>
            <button className="btn primary" onClick={() => navigate(`/t/${tripId}/friends`)}>
              Add friends
            </button>
          </div>
        )}
        {tab === 'balances' && <Balances trip={trip} balances={balances} total={total} />}
        {tab === 'expenses' && <Expenses trip={trip} data={data} />}
        {tab === 'settle' && <SettleUp trip={trip} data={data} transfers={transfers} />}
      </main>
      {copyText !== null && <CopyDialog text={copyText} onClose={() => setCopyText(null)} />}
      {tab !== 'settle' && data.members.length > 0 && (
        <div className="fab-stack">
          <button className="fab secondary" onClick={() => navigate(`/t/${tripId}/quick`)}>
            <UsersIcon size={20} /> Quick add
          </button>
          <button className="fab" onClick={() => navigate(`/t/${tripId}/new`)}>
            <PlusIcon /> Add expense
          </button>
        </div>
      )}
    </>
  )
}

function CopyDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast('Summary copied')
      onClose()
    } catch {
      toast('Select the text and copy it')
    }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="copy-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="copy-title">Trip summary</h2>
        <textarea readOnly rows={10} value={text} onFocus={(e) => e.currentTarget.select()} />
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn primary" onClick={copy}>
            Copy
          </button>
        </div>
      </div>
    </div>
  )
}

function TripGone() {
  return (
    <>
      <Header title="Trip not found" onBack={() => navigate('/', { replace: true })} />
      <main className="page">
        <div className="empty">
          <p>This trip was deleted or hasn't synced to this phone yet.</p>
        </div>
      </main>
    </>
  )
}

function Balances({ trip, balances, total }: { trip: Trip; balances: MemberBalance[]; total: number }) {
  return (
    <>
      <div className="card total-card">
        <div className="muted small">Total spent</div>
        <div className="total">{formatMoney(total, trip.currency)}</div>
      </div>
      <ul className="list">
        {balances.map((b) => (
          <li key={b.member_id} className="list-item static">
            <div className="grow">
              <div className="item-title">
                {b.name}
                {b.removed && <span className="muted"> (removed)</span>}
              </div>
              <div className="item-sub">
                Paid {formatMoney(b.paid, trip.currency)} · Share {formatMoney(b.share, trip.currency)}
                {b.sent > 0 && ` · Sent ${formatMoney(b.sent, trip.currency)}`}
                {b.received > 0 && ` · Received ${formatMoney(b.received, trip.currency)}`}
              </div>
            </div>
            <div className={`balance ${b.balance > 0 ? 'pos' : b.balance < 0 ? 'neg' : ''}`}>
              <div className="small">{b.balance > 0 ? 'gets back' : b.balance < 0 ? 'owes' : 'settled'}</div>
              <div className="amount">{b.balance !== 0 ? formatMoney(Math.abs(b.balance), trip.currency) : '—'}</div>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

function Expenses({ trip, data }: { trip: Trip; data: TripData }) {
  const groups = useMemo(() => groupByDay(data.expenses), [data.expenses])
  if (groups.length === 0)
    return (
      <div className="empty">
        <p>No expenses yet.</p>
        <p className="muted">Tap “Add expense” when someone pays for something.</p>
      </div>
    )
  return (
    <>
      {groups.map((g) => (
        <section key={g.key} className="day">
          <div className="day-head">
            <span>{dayLabel(g.key)}</span>
            <span>{formatMoney(g.total, trip.currency)}</span>
          </div>
          <ul className="list">
            {g.items.map((e) => (
              <li key={e.id}>
                <button className="list-item" onClick={() => navigate(`/t/${trip.id}/e/${e.id}`)}>
                  <div className="grow">
                    <div className="item-title">{e.title}</div>
                    <div className="item-sub">
                      Paid by {memberName(data.allMembers, e.paid_by)} · split between {e.shares.length}
                    </div>
                  </div>
                  <div className="amount">{formatMoney(e.amount_minor, trip.currency)}</div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

function SettleUp({ trip, data, transfers }: { trip: Trip; data: TripData; transfers: Transfer[] }) {
  const name = (id: string) => memberName(data.allMembers, id)
  const history = [...data.settlements].sort((a, b) => b.paid_at.localeCompare(a.paid_at))

  const [payment, setPayment] = useState<PaymentRequest | null>(null)

  return (
    <>
      <h2 className="section-title">Suggested payments</h2>
      {transfers.length === 0 ? (
        <div className="card center">
          <p>{data.expenses.length ? 'All settled up 🎉' : 'Nothing to settle yet.'}</p>
        </div>
      ) : (
        <ul className="list">
          {transfers.map((t) => (
            <li key={`${t.from}-${t.to}`} className="list-item static">
              <div className="grow">
                <div className="item-title">
                  {name(t.from)} → {name(t.to)}
                </div>
                <div className="amount-strong">{formatMoney(t.amount_minor, trip.currency)}</div>
              </div>
              <button
                className="btn primary"
                onClick={() => setPayment({ kind: 'suggested', from: t.from, to: t.to, max: t.amount_minor })}
              >
                Mark paid
              </button>
            </li>
          ))}
        </ul>
      )}

      {data.members.length >= 2 && (
        <button className="btn ghost block" onClick={() => setPayment({ kind: 'free' })}>
          Record a payment
        </button>
      )}

      <h2 className="section-title">Payments made</h2>
      {history.length === 0 ? (
        <p className="muted center">No payments recorded yet.</p>
      ) : (
        <ul className="list">
          {history.map((s) => (
            <li key={s.id} className="list-item static">
              <div className="grow">
                <div className="item-title">
                  {name(s.from_member)} paid {name(s.to_member)}
                </div>
                <div className="item-sub">
                  {formatMoney(s.amount_minor, trip.currency)} ·{' '}
                  {new Date(s.paid_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </div>
              </div>
              <button
                className="btn ghost"
                onClick={async () => {
                  await undoSettlement(s.id)
                  toast('Payment undone')
                }}
              >
                Undo
              </button>
            </li>
          ))}
        </ul>
      )}
      {payment && (
        <PaymentDialog
          request={payment}
          tripId={trip.id}
          currency={trip.currency}
          members={data.members}
          nameOf={name}
          onClose={() => setPayment(null)}
        />
      )}
    </>
  )
}

export function summaryText(trip: Trip, data: TripData, balances: MemberBalance[], transfers: Transfer[]): string {
  const c = trip.currency
  const total = data.expenses.reduce((t, e) => t + e.amount_minor, 0)
  const name = (id: string) => memberName(data.allMembers, id)
  const lines = [`Hisaab — ${trip.name}`, `Total spent: ${formatMoney(total, c)}`, '', 'Balances:']
  for (const b of balances) {
    const label = b.balance > 0 ? `gets back ${formatMoney(b.balance, c)}` : b.balance < 0 ? `owes ${formatMoney(-b.balance, c)}` : 'is settled'
    lines.push(`• ${b.name}${b.removed ? ' (removed)' : ''} ${label}`)
  }
  lines.push('', transfers.length ? 'To settle up:' : 'Everyone is settled up.')
  for (const t of transfers) lines.push(`• ${name(t.from)} → ${name(t.to)} ${formatMoney(t.amount_minor, c)}`)
  return lines.join('\n')
}
