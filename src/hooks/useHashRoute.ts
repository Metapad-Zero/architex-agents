import { useCallback, useEffect, useState } from 'react'
import { isAddress, type Address } from 'viem'
import { DEFAULT_DOC_SECTION, isDocSection, type DocSection } from '../lib/docs'

export type AppRoute =
  | { view: 'home' }
  | { view: 'stats' }
  | { view: 'launch'; token?: Address }
  | { view: 'activity' }
  | { view: 'bbs' }
  | { view: 'docs'; section?: DocSection }

function hashFor(next: AppRoute): string {
  if (next.view === 'home') return '#home'
  if (next.view === 'stats') return '#stats'
  if (next.view === 'activity') return '#activity'
  if (next.view === 'bbs') return '#bbs'
  if (next.view === 'docs') return next.section && next.section !== DEFAULT_DOC_SECTION ? `#docs/${next.section}` : '#docs'
  return next.token ? `#launch/${next.token}` : '#launch'
}

function readRoute(): AppRoute {
  const hash = window.location.hash || '#home'
  if (hash === '#home') return { view: 'home' }
  if (hash === '#stats') return { view: 'stats' }
  if (hash.startsWith('#launch/')) {
    const token = hash.slice('#launch/'.length)
    return isAddress(token) ? { view: 'launch', token } : { view: 'launch' }
  }
  if (hash === '#launch') return { view: 'launch' }
  if (hash === '#activity') return { view: 'activity' }
  if (hash === '#bbs') return { view: 'bbs' }
  if (hash.startsWith('#docs/')) {
    const section = hash.slice('#docs/'.length)
    return { view: 'docs', section: isDocSection(section) ? section : DEFAULT_DOC_SECTION }
  }
  if (hash === '#docs') return { view: 'docs', section: DEFAULT_DOC_SECTION }
  return { view: 'home' }
}

export function useHashRoute() {
  const [route, setRouteState] = useState<AppRoute>(readRoute)

  useEffect(() => {
    const onHashChange = () => setRouteState(readRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const setRoute = useCallback((next: AppRoute) => {
    const update = () => {
      window.location.hash = hashFor(next)
      setRouteState(next)
    }
    if ('startViewTransition' in document) {
      document.startViewTransition(update)
    } else {
      update()
    }
  }, [])

  return { route, setRoute }
}
