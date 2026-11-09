import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { db, syncWriteStartedAt } from './db'

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

const STUCK_MS = 1500
const MAX_BACKOFF_MS = 10_000
/** A sync write running longer than this is treated as stuck too. */
const WRITE_GRACE_MS = 8_000

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

type Box<T> = { gen: number; ok: true; value: T } | { gen: number; ok: false }

const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

export function useLocalQuery<T>(querier: () => Promise<T> | T, deps: unknown[] = []): T | undefined {
  const tick = useSyncExternalStore(subscribeResume, () => resumeTick)
  const [attempt, setAttempt] = useState(0)
  const lastGood = useRef<T | undefined>(undefined)

  // Each change of `deps` (e.g. a different trip) starts a new generation. A
  // result is only used if it was read for the current generation, so data for
  // one trip is never shown while another trip is loading or failing.
  const depsRef = useRef(deps)
  const genRef = useRef(0)
  if (!sameDeps(depsRef.current, deps)) {
    depsRef.current = deps
    genRef.current++
    lastGood.current = undefined
  }
  const gen = genRef.current

  const raw = useLiveQuery<Box<T>>(
    async () => {
      try {
        return { gen, ok: true, value: await querier() }
      } catch (err) {
        console.warn('[hisaab] local read failed', err)
        return { gen, ok: false }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...deps, tick, attempt],
  )

  const current = raw && raw.gen === gen ? raw : undefined
  const failed = current?.ok === false
  const value = current?.ok ? current.value : undefined
  if (current?.ok) lastGood.current = current.value

  // Watchdog: no answer yet (or an error) → reopen the database and try again.
  const waiting = current === undefined
  useEffect(() => {
    if (!waiting && !failed) return
    const delay = failed ? 300 : Math.min(STUCK_MS * 2 ** attempt, MAX_BACKOFF_MS)
    const timer = setTimeout(() => {
      // A sync write in progress legitimately delays reads: wait for it rather
      // than closing the database underneath it (which would abort the sync).
      const writing = syncWriteStartedAt()
      if (!failed && writing !== null && Date.now() - writing < WRITE_GRACE_MS) {
        setAttempt((a) => a + 1)
        return
      }
      void reconnectDb().then(() => setAttempt((a) => a + 1))
    }, delay)
    return () => clearTimeout(timer)
  }, [waiting, failed, attempt, gen])

  return failed ? lastGood.current : value
}
