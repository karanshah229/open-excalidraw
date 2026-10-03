import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Lock } from 'lucide-react'
import { useAuth } from '../lib/auth-context'

/** Shared denied-link presentation for board and project URLs. */
export function AccessDenied({
  resourceType = 'board',
  email,
  signedIn,
  busy = false,
  onSignIn,
  onSwitchAccount,
}: {
  resourceType?: 'board' | 'project'
  email?: string | null
  signedIn?: boolean
  busy?: boolean
  onSignIn?: () => Promise<void>
  onSwitchAccount?: () => Promise<void>
}) {
  const { user, signInWithGoogle, signOutUser } = useAuth()
  const navigate = useNavigate()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const displayEmail = email ?? user?.email
  const isSignedIn = signedIn ?? Boolean(user && !user.isAnonymous)
  const disabled = busy || working
  const run = async (operation: () => Promise<void>) => {
    setWorking(true)
    setError('')
    try {
      await operation()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Sign-in failed.')
    } finally {
      setWorking(false)
    }
  }
  return (
    <div className="access-denied-container">
      <div className="access-denied-card animate-scale-in">
        <div className="access-denied-icon-wrap">
          <Lock size={26} />
        </div>
        <h2 className="access-denied-title">You need access</h2>
        <p className="access-denied-desc">
          Ask for access, or switch to an account with access to this {resourceType}.
        </p>
        <div className="access-denied-user-info">
          {displayEmail ? `Signed in as ${displayEmail}` : 'You are not signed in'}
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="access-denied-actions">
          {isSignedIn ? (
            <>
              <button
                type="button"
                className="google-share-copy-btn"
                disabled={disabled}
                onClick={() =>
                  void run(
                    onSwitchAccount ??
                      (async () => {
                        await signOutUser()
                        await navigate({ to: '/' })
                      }),
                  )
                }
              >
                {disabled && <Loader2 size={14} className="animate-spin" />}
                <span>Switch account</span>
              </button>
              <button
                type="button"
                className="google-share-done-btn"
                disabled={disabled}
                onClick={() => void navigate({ to: '/' })}
              >
                Go to workspace
              </button>
            </>
          ) : (
            <button
              type="button"
              className="google-share-done-btn"
              disabled={disabled}
              onClick={() => void run(onSignIn ?? signInWithGoogle)}
            >
              {disabled && <Loader2 size={14} className="animate-spin" />}
              <span>Sign in with Google</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
