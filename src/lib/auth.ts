import { SUPABASE_ANON_KEY, SUPABASE_URL, isConfigured } from './config'

export interface Session {
  access_token: string
  refresh_token: string
  expires_at: number // epoch seconds
  user: { id: string; email: string }
}

const SESSION_KEY = 'hisaab.session'
const SKIPPED_KEY = 'hisaab.skippedLogin'

/** Network failure (offline, DNS, CORS). The session is kept; try again later. */
export class NetworkError extends Error {}
/** The server rejected the credentials or refresh token. */
export class AuthError extends Error {}

const listeners = new Set<() => void>()
function emit() {
  for (const l of listeners) l()
}
export function subscribeAuth(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function read(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}
let current: Session | null = typeof localStorage !== 'undefined' ? read() : null

export const getSession = () => current

function save(s: Session | null) {
  current = s
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
  else localStorage.removeItem(SESSION_KEY)
  emit()
}

export function hasSkippedLogin() {
  return localStorage.getItem(SKIPPED_KEY) === '1'
}
export function skipLogin() {
  localStorage.setItem(SKIPPED_KEY, '1')
  emit()
}

// Keep tabs in step: another tab may rotate the refresh token.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === SESSION_KEY) {
      current = read()
      emit()
    } else if (e.key === SKIPPED_KEY) emit()
  })
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in?: number
  expires_at?: number
  user: { id: string; email: string }
  error_description?: string
  msg?: string
  error?: string
}

async function tokenRequest(grant: 'password' | 'refresh_token', body: object): Promise<Session> {
  if (!isConfigured) throw new AuthError('Supabase is not configured (see .env.example).')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new NetworkError('No connection')
  }
  const data = (await res.json().catch(() => ({}))) as TokenResponse
  if (!res.ok) {
    const message = data.error_description || data.msg || data.error || `Sign-in failed (${res.status})`
    // Permanent rejection → AuthError; 429 and 5xx are temporary.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new AuthError(message)
    throw new NetworkError(message)
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // Use the relative lifetime on this phone's own clock: Supabase's absolute
    // expires_at is server time, and a phone whose clock is behind would never
    // think the token had expired.
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    user: { id: data.user.id, email: data.user.email },
  }
}

export async function signIn(email: string, password: string): Promise<Session> {
  const s = await tokenRequest('password', { email: email.trim(), password })
  save(s)
  return s
}

export function signOut() {
  const s = current
  save(null)
  localStorage.removeItem(SKIPPED_KEY)
  if (s && isConfigured) {
    // Best effort; local sign-out is what matters.
    fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${s.access_token}` },
    }).catch(() => {})
  }
}

let refreshing: Promise<Session> | null = null

/**
 * A valid access token, refreshing it when within 60 s of expiry.
 * Returns null when signed out. Throws NetworkError when a refresh is needed but
 * the network is down; signs out (and throws AuthError) on a 4xx other than 429.
 */
export async function getAccessToken(): Promise<string | null> {
  const s = current
  if (!s) return null
  if (s.expires_at - 60 > Date.now() / 1000) return s.access_token
  return refreshAccessToken()
}

/**
 * Refresh now, regardless of the stored expiry. Used when the server rejects a
 * token we believed was valid (401), e.g. after a clock change.
 */
export async function refreshAccessToken(): Promise<string | null> {
  const s = current
  if (!s) return null
  if (!refreshing) {
    refreshing = tokenRequest('refresh_token', { refresh_token: s.refresh_token })
      .then((next) => {
        save(next) // refresh tokens rotate: always keep the new one
        return next
      })
      .catch((err) => {
        if (err instanceof AuthError) signOut()
        throw err
      })
      .finally(() => {
        refreshing = null
      })
  }
  return (await refreshing).access_token
}
