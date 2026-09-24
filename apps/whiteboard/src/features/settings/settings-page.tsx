import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  Cpu,
  Laptop,
  Loader2,
  Moon,
  Play,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  Sun,
  User as UserIcon,
} from 'lucide-react'
import { useTheme } from '../../lib/theme-context'
import { useUser } from '../../lib/user-context'
import { useMcpStatus } from './use-mcp-status'

type SettingsTab = 'preferences' | 'mcp' | 'account'

function isSettingsTab(tab: string | undefined): tab is SettingsTab {
  return tab === 'preferences' || tab === 'mcp' || tab === 'account'
}

export function SettingsPage() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { tab?: string }
  const activeTab = isSettingsTab(search.tab) ? search.tab : 'preferences'
  const { mode, setMode } = useTheme()
  const { user, initials, fullName } = useUser()
  const mcp = useMcpStatus()

  const selectTab = (tab: SettingsTab) => {
    navigate({ to: '/settings', search: { tab } })
  }

  return (
    <div className="settings-shell">
      <div className="settings-container">
        <header className="settings-header">
          <h1>Settings</h1>
          <p>Manage your appearance, integrations, and workspace preferences.</p>
        </header>

        <div className="settings-layout">
          {/* Left Sidebar */}
          <nav className="settings-sidebar" aria-label="Settings navigation">
            <button
              type="button"
              className={`settings-nav-btn ${activeTab === 'preferences' ? 'active' : ''}`}
              onClick={() => selectTab('preferences')}
            >
              <SlidersHorizontal size={16} />
              <span>Preferences</span>
            </button>

            <button
              type="button"
              className={`settings-nav-btn ${activeTab === 'mcp' ? 'active' : ''}`}
              onClick={() => selectTab('mcp')}
            >
              <Cpu size={16} />
              <span>MCP Server</span>
              <span
                className={`settings-nav-dot ${
                  mcp.status === 'running'
                    ? 'settings-nav-dot--online'
                    : mcp.status === 'checking'
                      ? 'settings-nav-dot--checking'
                      : mcp.status === 'blocked'
                        ? 'settings-nav-dot--blocked'
                        : 'settings-nav-dot--offline'
                }`}
                title={`Status: ${mcp.status}`}
              />
            </button>

            <button
              type="button"
              className={`settings-nav-btn ${activeTab === 'account' ? 'active' : ''}`}
              onClick={() => selectTab('account')}
            >
              <UserIcon size={16} />
              <span>Account</span>
            </button>
          </nav>

          {/* Right Content */}
          <main className="settings-content">
            {activeTab === 'preferences' && (
              <section className="settings-section animate-fade-in">
                <div className="settings-section-header">
                  <h2>Appearance & Theme</h2>
                  <p>
                    Customize your visual preferences. The theme applies to both our custom interface
                    and the Excalidraw canvas.
                  </p>
                </div>

                <div className="settings-card">
                  <div className="settings-field">
                    <div className="settings-field-label">
                      <strong>Theme</strong>
                      <span>Select how OpenExcalidraw appears to you</span>
                    </div>

                    {/* Theme Button Group */}
                    <div className="theme-button-group" role="group" aria-label="Theme mode selection">
                      <button
                        type="button"
                        className={`theme-btn ${mode === 'light' ? 'active' : ''}`}
                        onClick={() => setMode('light')}
                        aria-pressed={mode === 'light'}
                      >
                        <Sun size={15} />
                        <span>Light</span>
                      </button>

                      <button
                        type="button"
                        className={`theme-btn ${mode === 'dark' ? 'active' : ''}`}
                        onClick={() => setMode('dark')}
                        aria-pressed={mode === 'dark'}
                      >
                        <Moon size={15} />
                        <span>Dark</span>
                      </button>

                      <button
                        type="button"
                        className={`theme-btn ${mode === 'auto' ? 'active' : ''}`}
                        onClick={() => setMode('auto')}
                        aria-pressed={mode === 'auto'}
                      >
                        <Laptop size={15} />
                        <span>Auto</span>
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {activeTab === 'mcp' && (
              <section className="settings-section animate-fade-in">
                <div className="settings-section-header">
                  <h2>Model Context Protocol (MCP)</h2>
                  <p>
                    OpenExcalidraw connects your editor canvas to AI agents via the Model Context
                    Protocol WebSocket bridge.
                  </p>
                </div>

                <div className="settings-card">
                  <div className="mcp-status-row">
                    <div>
                      <span className="mcp-label">Server Status</span>
                      <div className="mcp-badge-wrap">
                        <div
                          className={`mcp-badge mcp-badge--${
                            mcp.status === 'running'
                              ? 'running'
                              : mcp.status === 'checking'
                                ? 'checking'
                                : mcp.status === 'blocked'
                                  ? 'blocked'
                                  : 'offline'
                          }`}
                        >
                          <span className="mcp-badge-dot" />
                          <span>
                            {mcp.status === 'running'
                              ? 'Running'
                              : mcp.status === 'checking'
                                ? 'Checking…'
                                : mcp.status === 'blocked'
                                  ? 'Permission Blocked'
                                  : 'Not running'}
                          </span>
                        </div>

                        {mcp.status === 'blocked' ? (
                          <button
                            type="button"
                            className="ui-button ui-button--default mcp-action-btn"
                            onClick={mcp.retriggerPermission}
                            disabled={mcp.isChecking || mcp.isRetriggering}
                            title="Re-check device access permission"
                          >
                            {mcp.isRetriggering || mcp.isChecking ? (
                              <>
                                <Loader2 size={13} className="sync-status-icon--saving" />
                                <span>Checking…</span>
                              </>
                            ) : (
                              <>
                                <RefreshCw size={13} />
                                <span>Re-check Permission</span>
                              </>
                            )}
                          </button>
                        ) : mcp.status !== 'running' ? (
                          <button
                            type="button"
                            className="ui-button ui-button--default mcp-action-btn"
                            onClick={mcp.startServer}
                            disabled={mcp.isStarting || mcp.isChecking}
                            title="Start local MCP server"
                          >
                            {mcp.isStarting ? (
                              <>
                                <Loader2 size={13} className="sync-status-icon--saving" />
                                <span>Starting…</span>
                              </>
                            ) : (
                              <>
                                <Play size={13} fill="currentColor" />
                                <span>Start server</span>
                              </>
                            )}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="ui-button ui-button--outline mcp-action-btn mcp-action-btn--stop"
                            onClick={mcp.stopServer}
                            disabled={mcp.isStopping}
                            title="Stop MCP server"
                          >
                            {mcp.isStopping ? (
                              <>
                                <Loader2 size={13} className="sync-status-icon--saving" />
                                <span>Stopping…</span>
                              </>
                            ) : (
                              <>
                                <Square size={11} fill="currentColor" />
                                <span>Stop server</span>
                              </>
                            )}
                          </button>
                        )}

                        {!mcp.isPermissionBlocked && (
                          <button
                            type="button"
                            className="ui-button ui-button--outline mcp-refresh-btn"
                            onClick={mcp.checkStatus}
                            disabled={mcp.isChecking || mcp.isStarting}
                            title="Re-check MCP bridge connection"
                          >
                            <RefreshCw
                              size={13}
                              className={mcp.isChecking ? 'sync-status-icon--saving' : ''}
                            />
                            <span>Check status</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mcp-details-grid">
                    <div className="mcp-detail-item">
                      <span className="mcp-detail-label">Bridge WebSocket URL</span>
                      <code className="mcp-detail-code">{mcp.bridgeUrl}</code>
                    </div>

                    <div className="mcp-detail-item">
                      <span className="mcp-detail-label">Last Checked</span>
                      <span className="mcp-detail-value">
                        {mcp.lastChecked ? mcp.lastChecked.toLocaleTimeString() : 'Never'}
                      </span>
                    </div>
                  </div>

                  {mcp.isPermissionBlocked && (
                    <div className="mcp-notice mcp-notice--blocked">
                      <div className="mcp-blocked-header">
                        <ShieldAlert size={20} className="mcp-blocked-icon" />
                        <div>
                          <h3 className="mcp-blocked-title">Browser access blocked</h3>
                          <p className="mcp-blocked-subtitle">
                            Chrome can&apos;t reach your local MCP bridge, so its status and controls are unavailable.
                          </p>
                        </div>
                      </div>

                      <div className="mcp-blocked-steps">
                        <strong>To reconnect:</strong> Open Site settings → Apps on device → Allow, then re-check above.
                      </div>
                    </div>
                  )}

                  {mcp.status === 'offline' && (
                    <div className="mcp-offline-help">
                      <p className="mcp-offline-text">
                        The MCP server bridge is offline.
                      </p>
                    </div>
                  )}

                  {mcp.status === 'running' && (
                    <div className="mcp-notice mcp-notice--running">
                      <p>
                        The MCP server is connected and ready to sync operations between your agent and
                        the canvas.
                      </p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {activeTab === 'account' && (
              <section className="settings-section animate-fade-in">
                <div className="settings-section-header">
                  <h2>User Profile</h2>
                  <p>
                    Your user profile details are synced from your Google account and are read-only.
                  </p>
                </div>

                <div className="settings-card">
                  <div className="account-preview-row">
                    <div className="user-avatar-preview">{initials}</div>
                    <div>
                      <strong className="account-preview-name">{fullName}</strong>
                      <span className="account-preview-email">{user.email}</span>
                    </div>
                  </div>

                  <div className="account-form">
                    <div className="account-form-grid">
                      <div className="modal-field">
                        <label htmlFor="settings-first-name">
                          <strong>First Name</strong>
                        </label>
                        <input
                          id="settings-first-name"
                          type="text"
                          className="ui-input"
                          value={user.firstName}
                          readOnly
                        />
                      </div>

                      <div className="modal-field">
                        <label htmlFor="settings-last-name">
                          <strong>Last Name</strong>
                        </label>
                        <input
                          id="settings-last-name"
                          type="text"
                          className="ui-input"
                          value={user.lastName}
                          readOnly
                        />
                      </div>
                    </div>

                    <div className="modal-field">
                      <label htmlFor="settings-email">
                        <strong>Email Address</strong>
                      </label>
                      <input
                        id="settings-email"
                        type="email"
                        className="ui-input"
                        value={user.email}
                        readOnly
                      />
                    </div>
                  </div>
                </div>
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
