import { PanelsTopLeft } from 'lucide-react'
import { useAuth } from '../lib/auth-context'

export function SignInScreen() {
  const { error, isConfigured, signInWithGoogle } = useAuth()
  return (
    <main className="sign-in-shell">
      <section className="sign-in-card">
        <div className="sign-in-brand-mark" aria-hidden="true">
          <PanelsTopLeft size={22} />
        </div>
        <p className="sign-in-eyebrow">OPENEXCALIDRAW</p>
        <h1>Welcome back</h1>
        <p className="sign-in-description">Sign in to create, organize, and sync your boards.</p>
        <button
          type="button"
          className="sign-in-button"
          onClick={() => void signInWithGoogle()}
          disabled={!isConfigured}
        >
          <span className="sign-in-google-mark" aria-hidden="true">
            G
          </span>
          Continue with Google
        </button>
        <p className="sign-in-note">Your boards stay private to you.</p>
        {!isConfigured && (
          <p className="sign-in-hint">Firebase configuration is required before sign-in is available.</p>
        )}
        {error && <p className="sign-in-error">{error}</p>}
      </section>
    </main>
  )
}
