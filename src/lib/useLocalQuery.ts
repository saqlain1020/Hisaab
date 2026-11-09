import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { db } from './db'

/**
 * useLiveQuery, hardened for installed PWAs (especially iOS home-screen apps).
 *
 * When iOS resumes a web app, its IndexedDB connection can be silently lost or
 * a read can hang. Plain useLiveQuery then shows nothing until some write
 * (e.g. the next sync) happens to re-run the query. This hook:
 *  - re-runs queries whenever the app comes back to the foreground,
 *  - reopens the database and retries if a read hasn't answered in 1.5 s,
 *  - never throws a read error into React (which would blank the whole app);
 *    it keeps the last good result and retries with backoff instead.
 */

const FAILED = Symbol('local-read-failed')
const STUCK_MS = 1500
const MAX_BACKOFF_MS = 10_000

let resumeTick = 0
const tickListeners = new Set<() => void>()
function bumpResume() {
  resumeTick++
  tickListeners.forEach((l) => l())
}
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') bumpResume()
  })
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) bumpResume()
  })
}
const subscribeResume = (fn: () => void) => {
  tickListeners.add(fn)
  return () => tickListeners.delete(fn)
}

let reconnecting: Promise<void> | null = null
/** Drop the (possibly dead) IndexedDB connection and open a fresh one. */
export function reconnectDb(): Promise<void> {
  if (!reconnecting) {
    reconnecting = (async () => {
      console.warn('[hisaab] local database read was slow or failed; reopening it')
      try {
        db.close({ disableAutoOpen: false })
        await db.open()
      } catch (err) {
        console.warn('[hisaab] reopening the local database failed', err)
      }
    })().finally(() => {
      reconnecting = null
    })
  }
  return reconnecting
}

export function useLocalQuery<T>(querier: () => Promise<T> | T, deps: unknown[] = []): T | undefined {
  const tick = useSyncExternalStore(subscribeResume, () => resumeTick)
  const [attempt, setAttempt] = useState(0)
  const lastGood = useRef<T | undefined>(undefined)

  const raw = useLiveQuery<T | typeof FAILED>(
    async () => {
      try {
        return await querier()
      } catch (err) {
        console.warn('[hisaab] local read failed', err)
        return FAILED
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...deps, tick, attempt],
  )

  const failed = raw === FAILED
  if (!failed && raw !== undefined) lastGood.current = raw

  // Watchdog: no answer yet (or an error) → reopen the database and try again.
  useEffect(() => {
    if (raw !== undefined && !failed) return
    const delay = failed ? 300 : Math.min(STUCK_MS * 2 ** attempt, MAX_BACKOFF_MS)
    const timer = setTimeout(() => {
      void reconnectDb().then(() => setAttempt((a) => a + 1))
    }, delay)
    return () => clearTimeout(timer)
  }, [raw, failed, attempt])

  return failed ? lastGood.current : raw
}
