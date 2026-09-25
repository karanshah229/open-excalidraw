import { signInAnonymously, updateProfile, type Auth, type User } from 'firebase/auth'
export { signInAnonymously, updateProfile }
import type { CollabUser } from './types'

export const CITIES = [
  'Mumbai',
  'Tokyo',
  'Berlin',
  'Paris',
  'Sydney',
  'Toronto',
  'Nairobi',
  'Oslo',
  'Kyoto',
  'Austin',
  'London',
  'Singapore',
  'Seoul',
  'Amsterdam',
  'Rio',
  'Stockholm',
  'Zurich',
  'Dublin',
  'Vienna',
  'Montreal',
] as const

export const COLLAB_COLORS = [
  '#E11D48', // rose-600
  '#2563EB', // blue-600
  '#059669', // emerald-600
  '#D97706', // amber-600
  '#7C3AED', // violet-600
  '#DB2777', // pink-600
  '#0891B2', // cyan-600
  '#4F46E5', // indigo-600
  '#EA580C', // orange-600
  '#16A34A', // green-600
] as const

/**
 * Deterministically maps a string ID (e.g. Firebase UID) to a city name and color.
 * Guarantees that the same user/visitor gets the identical anonymous avatar across refreshes.
 */
export function getAnonymousProfile(uid: string): { displayName: string; color: string } {
  let hash = 0
  for (let i = 0; i < uid.length; i++) {
    hash = (hash << 5) - hash + uid.charCodeAt(i)
    hash |= 0
  }
  const positiveHash = Math.abs(hash)
  const cityIndex = positiveHash % CITIES.length
  const colorIndex = (positiveHash >> 3) % COLLAB_COLORS.length

  return {
    displayName: `Anonymous ${CITIES[cityIndex]}`,
    color: COLLAB_COLORS[colorIndex],
  }
}

/**
 * Generates a unique, tab-scoped session ID to prevent multi-tab self-collision.
 */
export function generateSessionId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `tab_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Ensures an authenticated Firebase User exists.
 * Gracefully falls back to null if Anonymous auth is not yet enabled in the Firebase Console.
 */
export async function ensureAuthenticatedUser(auth: Auth): Promise<User | null> {
  if (auth.currentUser) {
    return auth.currentUser
  }
  try {
    const userCredential = await signInAnonymously(auth)
    return userCredential.user
  } catch (err: any) {
    console.warn(
      '[Collab] Anonymous auth not enabled in Firebase Console yet. Running in local session mode:',
      err?.message,
    )
    return null
  }
}

/**
 * Resolves a full CollabUser for a Firebase User and specific tab session.
 */
export function resolveCollabUser(user: User, sessionId: string): CollabUser {
  const isExplicitName = Boolean(user.displayName && !user.displayName.startsWith('Anonymous '))
  const isNonAnonymous = !user.isAnonymous || isExplicitName

  if (!isNonAnonymous) {
    const profile = getAnonymousProfile(user.uid)
    return {
      uid: user.uid,
      sessionId,
      displayName: profile.displayName,
      color: profile.color,
      avatarUrl: undefined,
      isAnonymous: true,
    }
  }

  const profile = getAnonymousProfile(user.uid)
  const realName = user.displayName?.trim() || (user.email ? user.email.split('@')[0] : '') || profile.displayName

  return {
    uid: user.uid,
    sessionId,
    displayName: realName,
    color: profile.color,
    avatarUrl: user.photoURL || undefined,
    isAnonymous: false,
  }
}
