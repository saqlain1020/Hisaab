import { useState } from 'react'
import { AuthError, signIn, skipLogin } from '../lib/auth'
import { isConfigured } from '../lib/config'
import { goBack } from '../router'

export function Login({ canGoBack }: { canGoBack: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) return setError('Enter your email and password.')
    setBusy(true)
    setError(null)
    try {
      await signIn(email, password)
      if (canGoBack) goBack('/')
    } catch (err) {
      setError(
        err instanceof AuthError
          ? err.message
          : 'Could not reach the server. Signing in needs internet once — try again when online.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <div className="login-brand">
        <img src="/icon.svg" alt="" width={72} height={72} />
        <h1>Hisaab</h1>
        <p>Split trip expenses with friends. Works offline.</p>
      </div>
      <form className="card login-card" onSubmit={submit}>
        {!isConfigured && (
          <p className="notice">
            Supabase isn't configured in this build, so data stays on this phone. Add VITE_SUPABASE_URL and
            VITE_SUPABASE_ANON_KEY to enable sync.
          </p>
        )}
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary block" disabled={busy || !isConfigured}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button
          type="button"
          className="btn ghost block"
          onClick={() => {
            skipLogin()
            if (canGoBack) goBack('/')
          }}
        >
          {canGoBack ? 'Not now' : 'Skip, use offline for now'}
        </button>
        <p className="muted small center">Anything you add offline uploads once you sign in.</p>
      </form>
    </main>
  )
}
