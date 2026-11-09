import { useSyncExternalStore } from 'react'

/** Minimal hash router: works from a precached index.html with no server rewrites. */
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
window.addEventListener('hashchange', emit)
window.addEventListener('popstate', emit)

const current = () => location.hash.replace(/^#/, '') || '/'

export function useRoute(): string {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    current,
  )
}

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  if (path === current()) return
  const depth = (history.state?.depth ?? 0) + (opts.replace ? 0 : 1)
  if (opts.replace) history.replaceState({ depth }, '', `#${path}`)
  else history.pushState({ depth }, '', `#${path}`)
  emit()
}

/** Go back inside the app if we navigated here; otherwise jump to `fallback`. */
export function goBack(fallback: string) {
  if ((history.state?.depth ?? 0) > 0) history.back()
  else navigate(fallback, { replace: true })
}

export type Route =
  | { name: 'trips' }
  | { name: 'login' }
  | { name: 'trip'; tripId: string; tab: 'balances' | 'expenses' | 'settle' }
  | { name: 'friends'; tripId: string }
  | { name: 'expense'; tripId: string; expenseId: string | null }
  | { name: 'quick'; tripId: string }
  | { name: 'notfound' }

export function parseRoute(path: string): Route {
  const p = path.split('/').filter(Boolean)
  if (p.length === 0) return { name: 'trips' }
  if (p[0] === 'login') return { name: 'login' }
  if (p[0] === 't' && p[1]) {
    const tripId = p[1]
    if (!p[2]) return { name: 'trip', tripId, tab: 'balances' }
    if (p[2] === 'expenses' || p[2] === 'settle') return { name: 'trip', tripId, tab: p[2] }
    if (p[2] === 'friends') return { name: 'friends', tripId }
    if (p[2] === 'new') return { name: 'expense', tripId, expenseId: null }
    if (p[2] === 'quick') return { name: 'quick', tripId }
    if (p[2] === 'e' && p[3]) return { name: 'expense', tripId, expenseId: p[3] }
  }
  return { name: 'notfound' }
}
