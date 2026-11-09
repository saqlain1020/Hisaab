import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { confirmDialog } from '../components/Dialog'
import { Header } from '../components/Header'
import { LogoutIcon, PlusIcon } from '../components/Icons'
import { SyncStatus, useSession } from '../components/SyncStatus'
import { signOut } from '../lib/auth'
import { formatMoney } from '../lib/calc'
import { db } from '../lib/db'
import { ValidationError, createTrip } from '../lib/repo'
import { countDirty } from '../lib/sync'
import { navigate } from '../router'

export function TripsList() {
  const session = useSession()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('PKR')
  const [error, setError] = useState<string | null>(null)

  const trips = useLiveQuery(async () => {
    const [trips, expenses] = await Promise.all([db.trips.toArray(), db.expenses.toArray()])
    return trips
      .filter((t) => !t.deleted)
      .map((t) => {
        const ex = expenses.filter((e) => e.trip_id === t.id && !e.deleted)
        const start = ex.reduce((min, e) => (e.spent_at < min ? e.spent_at : min), t.created_at)
        return { ...t, start, total: ex.reduce((s, e) => s + e.amount_minor, 0), count: ex.length }
      })
      .sort((a, b) => b.start.localeCompare(a.start))
  })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const id = await createTrip(name, currency)
      setName('')
      setCreating(false)
      navigate(`/t/${id}`)
      navigate(`/t/${id}/friends`)
    } catch (err) {
      setError(err instanceof ValidationError ? err.message : String(err))
    }
  }

  const onSignOut = async () => {
    const pending = await countDirty(db)
    const ok = await confirmDialog({
      title: 'Sign out?',
      message: pending
        ? `${pending} change(s) haven't uploaded yet. They stay on this phone and upload when you sign in again.`
        : 'Your trips stay on this phone.',
      confirmLabel: 'Sign out',
      danger: true,
    })
    if (ok) signOut()
  }

  return (
    <>
      <Header
        title="Hisaab"
        subtitle={session ? session.user.email : 'Not signed in'}
        actions={
          <>
            <SyncStatus />
            {session && (
              <button className="icon-btn" onClick={onSignOut} aria-label="Sign out">
                <LogoutIcon />
              </button>
            )}
          </>
        }
      />
      <main className="page">
        {creating ? (
          <form className="card stack" onSubmit={submit}>
            <h2>New trip</h2>
            <label className="field">
              <span>Trip name</span>
              <input
                autoFocus
                value={name}
                placeholder="e.g. Hunza 2026"
                onChange={(e) => {
                  setName(e.target.value)
                  setError(null)
                }}
              />
            </label>
            <label className="field">
              <span>Currency</span>
              <input
                value={currency}
                maxLength={3}
                autoCapitalize="characters"
                onChange={(e) => {
                  setCurrency(e.target.value.toUpperCase())
                  setError(null)
                }}
              />
            </label>
            {error && <p className="error">{error}</p>}
            <div className="row gap">
              <button type="button" className="btn ghost grow" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="btn primary grow">Create trip</button>
            </div>
          </form>
        ) : (
          <button className="btn primary block big" onClick={() => setCreating(true)}>
            <PlusIcon /> New trip
          </button>
        )}

        {trips && trips.length === 0 && !creating && (
          <div className="empty">
            <p>No trips yet.</p>
            <p className="muted">Create one, add your friends, then log who paid for what.</p>
          </div>
        )}

        <ul className="list">
          {trips?.map((t) => (
            <li key={t.id}>
              <button className="list-item" onClick={() => navigate(`/t/${t.id}`)}>
                <div className="grow">
                  <div className="item-title">{t.name}</div>
                  <div className="item-sub">
                    {t.currency} · from{' '}
                    {new Date(t.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}{' '}
                    · {t.count} expense{t.count === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="amount">{formatMoney(t.total, t.currency)}</div>
              </button>
            </li>
          ))}
        </ul>
      </main>
    </>
  )
}
