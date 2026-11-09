import { useRegisterSW } from 'virtual:pwa-register/react'

/** Shows "Update available" when a new version has been deployed and downloaded. */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // Check for a new deploy every hour while the app stays open.
      if (reg) setInterval(() => void reg.update().catch(() => {}), 60 * 60 * 1000)
    },
  })

  if (!needRefresh) return null
  return (
    <div className="update-bar" role="status">
      <span>Update available</span>
      <button className="btn ghost small" onClick={() => setNeedRefresh(false)}>
        Later
      </button>
      <button className="btn primary small" onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
    </div>
  )
}
