import { Header } from './Header'

/** Placeholder screen while local data loads — never a blank page. */
export function LoadingScreen({ title = 'Loading…', onBack }: { title?: string; onBack?: () => void }) {
  return (
    <>
      <Header title={title} onBack={onBack} />
      <main className="page">
        <div className="loading" role="status">
          <span className="spinner dark" />
          <span className="muted">Loading…</span>
        </div>
      </main>
    </>
  )
}
