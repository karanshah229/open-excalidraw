import { lazy, Suspense } from 'react'
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { AppShell } from './app'
import { WorkspaceHome } from './features/workspace/workspace-home'
import { SettingsPage } from './features/settings/settings-page'

const BoardEditor = lazy(() => import('./routes/board-editor').then((module) => ({ default: module.BoardEditor })))
const rootRoute = createRootRoute({ component: AppShell })

export interface HomeSearch {
  projectId?: string
}

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    projectId: typeof search.projectId === 'string' ? search.projectId : undefined,
  }),
  component: WorkspaceHome,
})
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: WorkspaceHome,
})
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage })
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/boards/$boardId',
  component: () => (
    <Suspense fallback={<div className="workspace-loading">Loading editor…</div>}>
      <BoardEditor />
    </Suspense>
  ),
})
const routeTree = rootRoute.addChildren([homeRoute, projectRoute, settingsRoute, boardRoute])
export const router = createRouter({ routeTree, defaultPreload: 'intent' })
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
