import { lazy, Suspense } from 'react'
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { AppShell } from './app'
import { WorkspaceHome } from './features/workspace/workspace-home'
import { SettingsPage } from './features/settings/settings-page'
import { BoardLoading } from './components/board-loading'

const BoardEditor = lazy(() => import('./routes/board-editor').then((module) => ({ default: module.BoardEditor })))
const PresentationPage = lazy(() =>
  import('./routes/presentation').then((module) => ({ default: module.PresentationPage })),
)
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
    <Suspense fallback={<BoardLoading />}>
      <BoardEditor />
    </Suspense>
  ),
})
const presentationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/presentations/$boardId',
  component: () => (
    <Suspense fallback={<div>Loading presentation…</div>}>
      <PresentationPage />
    </Suspense>
  ),
})
const routeTree = rootRoute.addChildren([homeRoute, projectRoute, settingsRoute, boardRoute, presentationRoute])
export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultErrorComponent: () => (
    <div className="access-denied-container">
      <div className="access-denied-card" role="alert">
        <h2 className="access-denied-title">Could not load this page</h2>
        <p className="access-denied-desc">Please reload to try again.</p>
        <button className="google-share-done-btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  ),
})
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
