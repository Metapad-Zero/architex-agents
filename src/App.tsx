import { lazy, Suspense } from 'react'
import { AppShell } from './components/AppShell'
import { TableSkeleton } from './components/Skeleton'
import { useHashRoute } from './hooks/useHashRoute'

const HomeView = lazy(() => import('./components/HomeView').then((module) => ({ default: module.HomeView })))
const JITView = lazy(() => import('./components/JITView').then((module) => ({ default: module.JITView })))
const StatsView = lazy(() => import('./components/StatsView').then((module) => ({ default: module.StatsView })))
const LaunchView = lazy(() => import('./components/LaunchView').then((module) => ({ default: module.LaunchView })))
const DocsView = lazy(() => import('./components/DocsView').then((module) => ({ default: module.DocsView })))
const ActivityView = lazy(() => import('./components/ActivityView').then((module) => ({ default: module.ActivityView })))
const BBSView = lazy(() => import('./components/BBSView').then((module) => ({ default: module.BBSView })))

const fallback = <div className="pools-page"><TableSkeleton rows={5} /></div>

export default function App() {
  const { route, setRoute } = useHashRoute()
  return (
    <AppShell route={route} onRoute={setRoute}>
      {route.view === 'home' ? (
        <Suspense fallback={fallback}>
          <HomeView onOpenLaunch={(token) => setRoute({ view: 'launch', token })} />
        </Suspense>
      ) : route.view === 'jit' ? (
        <Suspense fallback={fallback}>
          <JITView launchId={route.launchId} onOpen={(launchId) => setRoute({ view: 'jit', launchId })} />
        </Suspense>
      ) : route.view === 'launch' ? (
        <Suspense fallback={fallback}>
          <LaunchView token={route.token} onOpen={(token) => setRoute({ view: 'launch', token })} />
        </Suspense>
      ) : route.view === 'docs' ? (
        <Suspense fallback={fallback}>
          <DocsView section={route.section} onSection={(section) => setRoute({ view: 'docs', section })} />
        </Suspense>
      ) : route.view === 'activity' ? (
        <Suspense fallback={fallback}>
          <ActivityView onOpenLaunch={(token) => setRoute({ view: 'launch', token })} />
        </Suspense>
      ) : route.view === 'bbs' ? (
        <Suspense fallback={fallback}>
          <BBSView />
        </Suspense>
      ) : (
        <Suspense fallback={fallback}>
          <StatsView onOpenLaunch={(token) => setRoute({ view: 'launch', token })} />
        </Suspense>
      )}
    </AppShell>
  )
}
