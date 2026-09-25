import { Link, Outlet, useLocation } from '@tanstack/react-router'
import { useEffect } from 'react'
import { PanelsTopLeft } from 'lucide-react'
import { ThemeProvider } from './lib/theme-context'
import { UserProvider } from './lib/user-context'
import { UserDropdown } from './components/user-dropdown'
import { SignInScreen } from './components/sign-in-screen'
import { AuthProvider, useAuth } from './lib/auth-context'
import { workspaceApi } from './features/workspace/workspace-api'

export function AppShell() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AuthenticatedApp />
      </AuthProvider>
    </ThemeProvider>
  )
}

function AuthenticatedApp() {
  const { user, isLoading, signInWithGoogle } = useAuth()
  const location = useLocation()
  const isProject = location.pathname.startsWith('/projects')
  const isBoard = location.pathname.startsWith('/boards')
  const showBrandName = !isBoard && !isProject

  useEffect(() => {
    if (!user || user.isAnonymous) {
      workspaceApi.deactivateCloudWorkspace()
      return
    }
    void workspaceApi.activateCloudWorkspace(user.uid)
  }, [user])

  if (isLoading) return <main className="workspace-loading workspace-loading--full">Checking your account…</main>
  if ((!user || user.isAnonymous) && !isBoard) return <SignInScreen />

  return (
    <UserProvider>
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
      <Outlet />
    </UserProvider>
  )
}
