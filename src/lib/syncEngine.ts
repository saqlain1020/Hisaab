import { AuthError, NetworkError, getAccessToken, getSession, subscribeAuth } from './auth'
import { SUPABASE_ANON_KEY, SUPABASE_URL, isConfigured } from './config'
import { db } from './db'
import { setLocalChangeListener } from './repo'
import { HttpError, pull, push } from './sync'

export type SyncPhase = 'idle' | 'syncing' | 'error'
export interface SyncState {
  phase: SyncPhase
  error: string | null
  lastSyncedAt: number | null
}

let state: SyncState = { phase: 'idle', error: null, lastSyncedAt: null }
const listeners = new Set<() => void>()
function set(patch: Partial<SyncState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}
export const getSyncState = () => state
export function subscribeSync(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

let running: Promise<void> | null = null
let again = false

/** Run one push+pull. Only one runs at a time; a request made mid-sync runs once more afterwards. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await runOnce()
    } while (again)
  })().finally(() => {
    running = null
  })
  return running
}

async function runOnce() {
  if (!isConfigured || !getSession()) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    set({ phase: 'idle', error: null })
    return
  }
  set({ phase: 'syncing', error: null })
  try {
    const ctx = { db, url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, getToken: getAccessToken }
    await push(ctx)
    await pull(ctx)
    set({ phase: 'idle', error: null, lastSyncedAt: Date.now() })
  } catch (err) {
    if (err instanceof NetworkError || (err instanceof HttpError && err.status === 0)) {
      // Offline or flaky: not worth alarming anyone; the pending count still shows.
      set({ phase: 'idle', error: null })
    } else if (err instanceof AuthError) {
      set({ phase: 'error', error: 'Signed out — please sign in again' })
    } else {
      set({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined
/** Sync 2 s after the last local edit. */
export function scheduleSync(delay = 2000) {
  clearTimeout(debounce)
  debounce = setTimeout(() => void syncNow(), delay)
}

async function registerBackgroundSync() {
  // Bonus only (Android Chrome): lets the browser wake the service worker when
  // connectivity returns. The main path is still the in-app triggers below.
  try {
    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return
    const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
      sync?: { register(tag: string): Promise<void> }
    }
    await reg.sync?.register('hisaab-sync')
  } catch {
    /* not supported or not allowed */
  }
}

let started = false
export function startSyncEngine() {
  if (started) return
  started = true

  setLocalChangeListener(() => {
    scheduleSync()
    void registerBackgroundSync()
  })

  window.addEventListener('online', () => void syncNow())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow()
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') void syncNow()
  }, 60_000)

  // The service worker pings us when a background sync fires while the app is open.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'hisaab-sync') void syncNow()
  })

  // Signing in should upload anything created offline straight away.
  let wasSignedIn = Boolean(getSession())
  subscribeAuth(() => {
    const signedIn = Boolean(getSession())
    if (signedIn && !wasSignedIn) void syncNow()
    if (!signedIn) set({ phase: 'idle', error: null })
    wasSignedIn = signedIn
  })

  void requestPersistentStorage()
  void syncNow()
}

async function requestPersistentStorage() {
  try {
    if (localStorage.getItem('hisaab.persistAsked')) return
    localStorage.setItem('hisaab.persistAsked', '1')
    await navigator.storage?.persist?.()
  } catch {
    /* ignore */
  }
}
