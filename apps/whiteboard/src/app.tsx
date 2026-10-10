import { AppChromeProvider, useAppChrome } from './lib/app-chrome-context'
import { Link, Outlet, useLocation } from '@tanstack/react-router'
import { useLayoutEffect, useState } from 'react'
import { PanelsTopLeft } from 'lucide-react'
import { ThemeProvider } from './lib/theme-context'
import { UserProvider } from './lib/user-context'
import { UserDropdown } from './components/user-dropdown'
import { SignInScreen } from './components/sign-in-screen'
import { AuthProvider, useAuth } from './lib/auth-context'
import { GlobalLoadingProvider, WorkspaceLoading } from './components/workspace-loading'
import { workspaceApi } from './features/workspace/workspace-api'

export function AppShell() {
  return (
    <ThemeProvider>
      <GlobalLoadingProvider>
        <AuthProvider>
          <AppChromeProvider>
            <AuthenticatedApp />
          </AppChromeProvider>
        </AuthProvider>
      </GlobalLoadingProvider>
    </ThemeProvider>
  )
}

function AuthenticatedApp() {
  const { user, isLoading, signInWithGoogle } = useAuth()
  const [localWorkspace, setLocalWorkspace] = useState(() => {
    try {
      return localStorage.getItem('agentic-whiteboard:local-workspace') === 'true'
    } catch {
      return false
    }
  })
  const { presentationActive } = useAppChrome()
  const location = useLocation()
  const isProject = location.pathname.startsWith('/projects')
  const isPresentation = location.pathname.startsWith('/presentations/') || presentationActive
  const isBoard = location.pathname.startsWith('/boards')
  const showBrandName = !isBoard && !isProject

  useLayoutEffect(() => {
    if (isPresentation) return
    if (!user || user.isAnonymous) {
      workspaceApi.deactivateCloudWorkspace()
      return
    }
    void workspaceApi
      .activateCloudWorkspace(user.uid)
      .catch((error) => console.error('Workspace activation failed:', error))
  }, [user, isPresentation])

  if (isLoading)
    return (
      <WorkspaceLoading
        message={isBoard ? 'Loading board…' : isPresentation ? 'Loading presentation…' : 'Loading boards…'}
      />
    )
  if (
    (!user || user.isAnonymous) &&
    !localWorkspace &&
    !isBoard &&
    !isPresentation &&
    !(location.pathname === '/' && new URLSearchParams(location.searchStr).has('projectId'))
  )
    return (
      <SignInScreen
        onContinueLocal={() => {
          localStorage.setItem('agentic-whiteboard:local-workspace', 'true')
          setLocalWorkspace(true)
        }}
      />
    )

  return (
    <UserProvider>
      {!isPresentation && (
        <header className="app-header">
          <div className="app-header-left">
            <Link to="/" className="brand-logo" title="OpenExcalidraw" aria-label="OpenExcalidraw">
              <span className="brand-icon">
                <PanelsTopLeft size={16} />
              </span>
              {showBrandName && <span className="brand-name">OpenExcalidraw</span>}
            </Link>
            <div id="header-nav-slot" />
          </div>
          <div className="app-header-right">
            <div id="header-status-slot" />
            {user && !user.isAnonymous ? (
              <UserDropdown />
            ) : (
              <button type="button" className="header-share-btn" onClick={signInWithGoogle} title="Sign in with Google">
                Sign in
              </button>
            )}
          </div>
        </header>
      )}
      <Outlet />
    </UserProvider>
  )
}
