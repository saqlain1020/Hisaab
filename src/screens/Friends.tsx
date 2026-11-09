import { useState } from 'react'
import { confirmDialog, promptDialog, toast } from '../components/Dialog'
import { Header } from '../components/Header'
import { db } from '../lib/db'
import { ValidationError, addMember, isMemberInvolved, removeMember, renameMember } from '../lib/repo'
import type { Member } from '../lib/types'
import { useTrip } from '../lib/useTrip'
import { goBack } from '../router'

export function Friends({ tripId }: { tripId: string }) {
  const data = useTrip(tripId)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!data) return null
  const back = () => goBack(`/t/${tripId}`)

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = name
    if (!value.trim()) return
    setName('') // clear now so anything typed while saving isn't wiped
    try {
      await addMember(tripId, value)
    } catch (err) {
      setName((cur) => cur || value)
      setError(err instanceof ValidationError ? err.message : String(err))
    }
  }

  const rename = async (m: Member) => {
    await promptDialog({
      title: 'Rename friend',
      input: { label: 'Name', value: m.name },
      confirmLabel: 'Save',
      validate: async (v) => {
        try {
          await renameMember(m.id, v)
          return null
        } catch (err) {
          return err instanceof ValidationError ? err.message : String(err)
        }
      },
    })
  }

  const remove = async (m: Member) => {
    const fresh = await db.members.get(m.id)
    if (fresh && (await isMemberInvolved(fresh))) {
      toast(`${m.name} is part of an expense or payment, so they can't be removed.`)
      return
    }
    const ok = await confirmDialog({ title: `Remove ${m.name}?`, confirmLabel: 'Remove', danger: true })
    if (!ok) return
    try {
      await removeMember(m.id)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <Header title="Friends" subtitle={data.trip?.name} onBack={back} />
      <main className="page">
        <form className="row gap add-row" onSubmit={add}>
          <input
            className="grow"
            value={name}
            placeholder="Friend's name"
            aria-label="Friend's name"
            autoCapitalize="words"
            enterKeyHint="done"
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
          <button className="btn primary" disabled={!name.trim()}>
            Add
          </button>
        </form>
        {error && <p className="error">{error}</p>}

        {data.members.length === 0 ? (
          <div className="empty">
            <p>No friends on this trip yet.</p>
            <p className="muted">Add everyone who's sharing costs — including you.</p>
          </div>
        ) : (
          <ul className="list">
            {data.members.map((m) => (
              <li key={m.id} className="list-item static">
                <div className="avatar" aria-hidden="true">
                  {m.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="grow item-title">{m.name}</div>
                <button className="btn ghost" onClick={() => rename(m)}>
                  Rename
                </button>
                <button className="btn ghost danger-text" onClick={() => remove(m)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {data.members.length > 0 && (
          <button className="btn primary block big" onClick={back}>
            Done
          </button>
        )}
      </main>
    </>
  )
}
