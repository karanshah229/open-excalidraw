import { LogIn } from 'lucide-react'
import { useAuth } from '../lib/auth-context'

export function SignInScreen() {
  const { error, isConfigured, signInWithGoogle } = useAuth()
  return (
    <main className="sign-in-shell">
      <section className="sign-in-card">
        <p className="sign-in-eyebrow">OPENEXCALIDRAW</p>
        <h1>Your boards, everywhere.</h1>
        <p>Sign in to securely sync your projects and boards across devices.</p>
        <button type="button" className="sign-in-button" onClick={() => void signInWithGoogle()} disabled={!isConfigured}>
          <LogIn size={18} /> Continue with Google
        </button>
        {!isConfigured && <p className="sign-in-hint">Firebase configuration is required before sign-in is available.</p>}
        {error && <p className="sign-in-error">{error}</p>}
      </section>
    </main>
  )
}
