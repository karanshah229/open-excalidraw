import { Link, Outlet, useLocation } from '@tanstack/react-router'
import { PanelsTopLeft } from 'lucide-react'
import { ThemeProvider } from './lib/theme-context'
import { UserProvider } from './lib/user-context'
import { UserDropdown } from './components/user-dropdown'

export function AppShell() {
  const location = useLocation()
  const isWorkspace = location.pathname === '/' || location.pathname.startsWith('/projects')
  const isSettings = location.pathname.startsWith('/settings')
  const showBrandName = isWorkspace || isSettings

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
