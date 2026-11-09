import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getSession, subscribeAuth } from '../lib/auth'
import { isConfigured } from '../lib/config'
import { db } from '../lib/db'
import { countDirty } from '../lib/sync'
import { getSyncState, subscribeSync, syncNow } from '../lib/syncEngine'
import { navigate } from '../router'
import { AlertIcon, CheckIcon, CloudIcon, UploadIcon } from './Icons'

export function useSession() {
  return useSyncExternalStore(subscribeAuth, getSession)
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

export function SyncStatus() {
  const sync = useSyncExternalStore(subscribeSync, getSyncState)
  const session = useSession()
  const online = useOnline()
  const pending = useLiveQuery(() => countDirty(db), [], 0)

  let icon = <CheckIcon size={16} />
  let label = 'Synced'
  let tone = 'ok'
  let onClick: () => void = () => void syncNow()

  if (!isConfigured) {
    icon = <CloudIcon size={16} />
    label = pending ? `${pending} saved on this phone` : 'On this phone'
    tone = 'muted'
    onClick = () => {}
  } else if (!session) {
    icon = <UploadIcon size={16} />
    label = pending ? `${pending} to upload · Sign in` : 'Sign in to sync'
    tone = 'warn'
    onClick = () => navigate('/login')
  } else if (sync.phase === 'syncing') {
    icon = <span className="spinner" />
    label = 'Syncing…'
    tone = 'muted'
  } else if (sync.phase === 'error') {
    icon = <AlertIcon size={16} />
    label = sync.error ?? 'Sync failed'
    tone = 'error'
  } else if (pending > 0) {
    icon = <UploadIcon size={16} />
    label = `${pending} to upload${online ? '' : ' · offline'}`
    tone = 'warn'
  } else if (!online) {
    icon = <CloudIcon size={16} />
    label = 'Offline'
    tone = 'muted'
  }

  return (
    <button className={`sync-pill ${tone}`} onClick={onClick} title="Tap to sync now" aria-live="polite">
      {icon}
      <span className="sync-label">{label}</span>
    </button>
  )
}
