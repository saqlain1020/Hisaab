/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<string | { url: string; revision: string | null }> }

// App shell: everything the build produced, so the app opens with no network.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

// The page shows "Update available"; tapping Reload sends this.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting()
})

// Background Sync (Android Chrome only, a bonus): tell any open window to sync.
// Sync itself lives in the page, which owns the auth tokens.
interface SyncEvent extends ExtendableEvent {
  tag: string
}
self.addEventListener('sync' as keyof ServiceWorkerGlobalScopeEventMap, (event) => {
  const e = event as SyncEvent
  if (e.tag !== 'hisaab-sync') return
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const c of clients) c.postMessage({ type: 'hisaab-sync' })
    }),
  )
})
