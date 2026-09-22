import { useState } from 'react'
import {
  Check,
  Cpu,
  Laptop,
  Loader2,
  Moon,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Square,
  Sun,
  User as UserIcon,
} from 'lucide-react'
import { useTheme } from '../../lib/theme-context'
import { useUser } from '../../lib/user-context'
import { useMcpStatus } from './use-mcp-status'

type SettingsTab = 'preferences' | 'mcp' | 'account'

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('preferences')
  const { mode, setMode } = useTheme()
  const { user, initials, fullName, updateUser } = useUser()
  const mcp = useMcpStatus()

  // Form state for account
  const [firstName, setFirstName] = useState(user.firstName)
  const [lastName, setLastName] = useState(user.lastName)
  const [email, setEmail] = useState(user.email)
  const [savedSuccess, setSavedSuccess] = useState(false)

  const handleSaveAccount = (e: React.FormEvent) => {
    e.preventDefault()
    updateUser({ firstName, lastName, email })
    setSavedSuccess(true)
    setTimeout(() => setSavedSuccess(false), 2500)
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
              onClick={() => setActiveTab('preferences')}
            >
              <SlidersHorizontal size={16} />
              <span>Preferences</span>
            </button>

            <button
              type="button"
              className={`settings-nav-btn ${activeTab === 'mcp' ? 'active' : ''}`}
              onClick={() => setActiveTab('mcp')}
            >
              <Cpu size={16} />
              <span>MCP Server</span>
              <span
                className={`settings-nav-dot ${
                  mcp.status === 'running'
                    ? 'settings-nav-dot--online'
                    : mcp.status === 'checking'
                      ? 'settings-nav-dot--checking'
                      : 'settings-nav-dot--offline'
                }`}
                title={`Status: ${mcp.status}`}
              />
            </button>

            <button
              type="button"
              className={`settings-nav-btn ${activeTab === 'account' ? 'active' : ''}`}
              onClick={() => setActiveTab('account')}
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
                                : 'offline'
                          }`}
                        >
                          <span className="mcp-badge-dot" />
                          <span>
                            {mcp.status === 'running'
                              ? 'Running'
                              : mcp.status === 'checking'
                                ? 'Checking…'
                                : 'Not running'}
                          </span>
                        </div>

                        {mcp.status !== 'running' ? (
                          <button
                            type="button"
                            className="ui-button ui-button--default mcp-action-btn"
                            onClick={mcp.startServer}
                            disabled={mcp.isStarting || mcp.status === 'checking'}
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

                        <button
                          type="button"
                          className="ui-button ui-button--outline mcp-refresh-btn"
                          onClick={mcp.checkStatus}
                          disabled={mcp.status === 'checking' || mcp.isStarting}
                          title="Re-check MCP bridge connection"
                        >
                          <RefreshCw
                            size={13}
                            className={mcp.status === 'checking' ? 'sync-status-icon--saving' : ''}
                          />
                          <span>Check status</span>
                        </button>
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

                  {mcp.status === 'offline' && (
                    <div className="mcp-notice mcp-notice--offline">
                      <p>
                        The MCP server bridge is not responding. To start it locally, run:
                      </p>
                      <pre>
                        <code>pnpm dev:mcp</code>
                      </pre>
                      <p className="mcp-notice-hint">
                        Or start all services concurrently with <code>pnpm dev:all</code>.
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
                    Your user information determines the avatar initials and name shown across
                    the workspace.
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

                  <form onSubmit={handleSaveAccount} className="account-form">
                    <div className="account-form-grid">
                      <div className="modal-field">
                        <label htmlFor="settings-first-name">
                          <strong>First Name</strong>
                        </label>
                        <input
                          id="settings-first-name"
                          type="text"
                          className="ui-input"
                          value={firstName}
                          onChange={(e) => setFirstName(e.target.value)}
                          required
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
                          value={lastName}
                          onChange={(e) => setLastName(e.target.value)}
                          required
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
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </div>

                    <div className="account-form-actions">
                      {savedSuccess && (
                        <span className="account-saved-pill">
                          <Check size={13} />
                          Profile saved!
                        </span>
                      )}
                      <button type="submit" className="ui-button ui-button--default">
                        Save changes
                      </button>
                    </div>
                  </form>
                </div>
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
