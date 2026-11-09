import { useSyncExternalStore } from 'react'
import { DialogHost, ToastHost } from './components/Dialog'
import { ErrorBoundary } from './components/ErrorBoundary'
import { UpdatePrompt } from './components/UpdatePrompt'
import { useSession } from './components/SyncStatus'
import { hasSkippedLogin, subscribeAuth } from './lib/auth'
import { parseRoute, useRoute } from './router'
import { ExpenseForm } from './screens/ExpenseForm'
import { Friends } from './screens/Friends'
import { Login } from './screens/Login'
import { QuickAdd } from './screens/QuickAdd'
import { TripScreen } from './screens/TripScreen'
import { TripsList } from './screens/TripsList'

export function App() {
  const session = useSession()
  const skipped = useSyncExternalStore(subscribeAuth, hasSkippedLogin)
  const route = parseRoute(useRoute())

  let screen: React.ReactNode
  if (!session && !skipped) screen = <Login canGoBack={false} />
  else if (route.name === 'login') screen = session ? <TripsList /> : <Login canGoBack />
  else if (route.name === 'trip') screen = <TripScreen tripId={route.tripId} tab={route.tab} />
  else if (route.name === 'friends') screen = <Friends tripId={route.tripId} />
  else if (route.name === 'expense') screen = <ExpenseForm tripId={route.tripId} expenseId={route.expenseId} />
  else if (route.name === 'quick') screen = <QuickAdd tripId={route.tripId} />
  else screen = <TripsList />

  return (
    <>
      <UpdatePrompt />
      <ErrorBoundary key={route.name}>{screen}</ErrorBoundary>
      <DialogHost />
      <ToastHost />
    </>
  )
}
