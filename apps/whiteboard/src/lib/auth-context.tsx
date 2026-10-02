import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth'
import { getFirebaseAuth, googleProvider, isFirebaseConfigured } from './firebase'

// Firebase normally delivers the initial auth state immediately. A deep link must
// still be usable if browser storage or a network transition delays that callback.
const INITIAL_AUTH_STATE_TIMEOUT_MS = 5_000

type AuthContextValue = {
  user: User | null
  isLoading: boolean
  error: string | null
  signInWithGoogle: () => Promise<void>
  signOutUser: () => Promise<void>
  isConfigured: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const auth = getFirebaseAuth()
    if (!auth) {
      setIsLoading(false)
      return
    }
    const settle = (nextUser: User | null) => {
      if (nextUser && !nextUser.isAnonymous) {
        setUser(nextUser)
      } else {
        setUser(null)
      }
      setIsLoading(false)
    }

    const unsubscribe = onAuthStateChanged(auth, settle)
    // Do not hold a shared-board deep link hostage to an unavailable initial
    // callback. Keep the listener alive: a late sign-in still updates the UI.
    const timeout = window.setTimeout(() => setIsLoading(false), INITIAL_AUTH_STATE_TIMEOUT_MS)

    return () => {
      unsubscribe()
      window.clearTimeout(timeout)
    }
  }, [])

  const signInWithGoogle = async () => {
    const auth = getFirebaseAuth()
    if (!auth) {
      setError('Firebase has not been configured yet.')
      return
    }
    setError(null)
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Google sign-in could not be completed.'
      setError(message)
    }
  }

  const signOutUser = async () => {
    const auth = getFirebaseAuth()
    if (auth) {
      await signOut(auth)
    }
    setUser(null)
  }

  return (
    <AuthContext.Provider
      value={{ user, isLoading, error, signInWithGoogle, signOutUser, isConfigured: isFirebaseConfigured }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within an AuthProvider')
  return context
}
