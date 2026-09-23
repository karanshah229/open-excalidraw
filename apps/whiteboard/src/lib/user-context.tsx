import React, { createContext, useContext, useEffect, useState } from 'react'
import { useAuth } from './auth-context'

export interface UserProfile {
  firstName: string
  lastName: string
  email: string
}

interface UserContextValue {
  user: UserProfile
  initials: string
  fullName: string
  updateUser: (profile: Partial<UserProfile>) => void
  logout: () => void
}

const USER_STORAGE_KEY = 'agentic-whiteboard:user:v1'

const DEFAULT_USER: UserProfile = {
  firstName: 'Karan',
  lastName: 'Walia',
  email: 'karan@workspace.local',
}

export function getInitials(firstName: string, lastName: string): string {
  const first = firstName.trim().charAt(0)
  const last = lastName.trim().charAt(0)
  if (first && last) {
    return (first + last).toUpperCase()
  }
  if (first) return first.toUpperCase()
  if (last) return last.toUpperCase()
  return 'U'
}

function getInitialUser(): UserProfile {
  if (typeof window === 'undefined') return DEFAULT_USER
  try {
    const saved = localStorage.getItem(USER_STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_USER
}

const UserContext = createContext<UserContextValue | null>(null)

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<UserProfile>(getInitialUser)
  const { user: authenticatedUser, signOutUser } = useAuth()

  useEffect(() => {
    if (!authenticatedUser) return
    const [firstName = '', ...rest] = (authenticatedUser.displayName ?? '').trim().split(/\s+/)
    setUserState({
      firstName: firstName || 'User',
      lastName: rest.join(' '),
      email: authenticatedUser.email ?? '',
    })
  }, [authenticatedUser])

  const updateUser = (profile: Partial<UserProfile>) => {
    setUserState((prev) => {
      const next = { ...prev, ...profile }
      try {
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(next))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  }

  const logout = () => void signOutUser()

  const initials = getInitials(user.firstName, user.lastName)
  const fullName = `${user.firstName} ${user.lastName}`.trim()

  return (
    <UserContext.Provider value={{ user, initials, fullName, updateUser, logout }}>
      {children}
    </UserContext.Provider>
  )
}

export function useUser() {
  const context = useContext(UserContext)
  if (!context) {
    throw new Error('useUser must be used within a UserProvider')
  }
  return context
}
