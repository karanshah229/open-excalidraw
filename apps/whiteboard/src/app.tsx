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
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  )
}

function AuthenticatedApp() {
  const { user, isLoading } = useAuth()
  const location = useLocation()
  const isWorkspace = location.pathname === '/' || location.pathname.startsWith('/projects')
  const isSettings = location.pathname.startsWith('/settings')
  const showBrandName = isWorkspace || isSettings

  useEffect(() => {
    if (!user) {
      workspaceApi.deactivateCloudWorkspace()
      return
    }
    void workspaceApi.activateCloudWorkspace(user.uid)
  }, [user])

  if (isLoading) return <main className="workspace-loading">Checking your account…</main>
  if (!user) return <SignInScreen />

  return (
    <ThemeProvider>
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
            <UserDropdown />
          </div>
        </header>
        <Outlet />
      </UserProvider>
    </ThemeProvider>
  )
}
