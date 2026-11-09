import { Component, type ReactNode } from 'react'

/** Last resort: if a screen crashes, offer a reload instead of a blank app. Data is safe in IndexedDB. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[hisaab] screen crashed', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="page">
        <div className="empty">
          <p>Something went wrong showing this screen.</p>
          <p className="muted small">Your data is saved on this phone.</p>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </main>
    )
  }
}
