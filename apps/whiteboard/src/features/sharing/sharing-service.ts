import { collection, deleteDoc, doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore'
import { getFirestoreDb } from '../../lib/firebase'
import { firestoreValue, workspaceStore, workspaceValue } from '../workspace/workspace-api'
import type { BoardScene } from '@agentic-whiteboard/storage'
import type { ActiveSessionRecord } from '../collaboration/types'

export const STALE_SESSION_TIMEOUT_MS = 45 * 1000 // 45 seconds (supported by 15s heartbeat)

export type ShareAccessLevel = 'restricted' | 'anyone_with_link'
export type ShareRole = 'viewer' | 'editor'

export interface BoardCollaborator {
  email: string
  role: ShareRole
  addedAt: string
}

export interface BoardShareConfig {
  boardId: string
  boardName: string
  ownerId: string
  ownerName: string
  ownerEmail?: string
  ownerPhotoURL?: string
  generalAccess: ShareAccessLevel
  generalRole: ShareRole
  invitedEmails: string[]
  collaborators: Record<string, BoardCollaborator>
  scene?: BoardScene
  createdAt: string
  updatedAt: string
}

async function getDocWithTimeout<T>(docRef: any, timeoutMs = 3000): Promise<T> {
  return Promise.race([
    getDoc(docRef) as Promise<T>,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Firestore getDoc timeout')), timeoutMs)),
  ])
}

const activeSessionRefCount = new Map<string, number>()

export const sharingService = {
  async getShareConfig(
    boardId: string,
    fallback?: {
      boardName?: string
      ownerId?: string
      ownerName?: string
      ownerEmail?: string
      ownerPhotoURL?: string
      scene?: BoardScene
    },
  ): Promise<BoardShareConfig> {
    const db = getFirestoreDb()
    if (db) {
      try {
        const snap = await getDocWithTimeout<any>(doc(db, 'boardShares', boardId))
        if (snap.exists()) {
          const data = workspaceValue(snap.data()) as BoardShareConfig
          if (
            (!data.scene?.elements || data.scene.elements.length === 0) &&
            fallback?.scene?.elements &&
            fallback.scene.elements.length > 0
          ) {
            data.scene = fallback.scene
          }
          return data
        }
      } catch {
        // Fall through to default if Firestore lookup fails
      }
    }

    // Default restricted configuration
    const defaultConfig: BoardShareConfig = {
      boardId,
      boardName: fallback?.boardName ?? 'Untitled',
      ownerId: fallback?.ownerId ?? 'local-user',
      ownerName: fallback?.ownerName ?? 'User',
      ownerEmail: fallback?.ownerEmail,
      ownerPhotoURL: fallback?.ownerPhotoURL,
      generalAccess: 'restricted',
      generalRole: 'viewer',
      invitedEmails: [],
      collaborators: {},
      scene: fallback?.scene,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    return defaultConfig
  },

  async saveShareConfig(config: BoardShareConfig): Promise<void> {
    let resolvedScene = config.scene
    if (!resolvedScene || !resolvedScene.elements || resolvedScene.elements.length === 0) {
      try {
        const localDoc = await workspaceStore.loadBoard(config.boardId)
        if (localDoc?.scene?.elements && localDoc.scene.elements.length > 0) {
          resolvedScene = localDoc.scene
        }
      } catch {
        // Ignore if local store unavailable
      }
    }

    const normalizedConfig: BoardShareConfig = {
      ...config,
      scene: resolvedScene,
      updatedAt: new Date().toISOString(),
      invitedEmails: Array.from(new Set(config.invitedEmails.map((e) => e.trim().toLowerCase()))),
    }

    const db = getFirestoreDb()
    if (db) {
      const ref = doc(db, 'boardShares', config.boardId)
      await setDoc(ref, firestoreValue(normalizedConfig) as Record<string, unknown>, { merge: true })
    }
  },

  async syncBoardSceneToShare(boardId: string, scene: BoardScene, boardName?: string): Promise<void> {
    const db = getFirestoreDb()
    if (db) {
      try {
        const ref = doc(db, 'boardShares', boardId)
        const updatePayload: Record<string, unknown> = {
          scene: firestoreValue(scene),
          updatedAt: new Date().toISOString(),
        }
        if (boardName) updatePayload.boardName = boardName
        await updateDoc(ref, updatePayload)
      } catch {
        // Document may not exist yet if the board has never been shared; ignore silently
      }
    }
  },

  async updateSharedScene(boardId: string, scene: BoardScene): Promise<void> {
    const db = getFirestoreDb()
    if (db) {
      const ref = doc(db, 'boardShares', boardId)
      await updateDoc(ref, {
        scene: firestoreValue(scene),
        updatedAt: new Date().toISOString(),
      })
    }
  },

  subscribeToSharedBoard(
    boardId: string,
    onUpdate: (config: BoardShareConfig) => void,
    onError?: (error: any) => void,
  ): () => void {
    const db = getFirestoreDb()
    if (!db) return () => {}
    const ref = doc(db, 'boardShares', boardId)
    return onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const data = workspaceValue(snap.data()) as BoardShareConfig
          onUpdate(data)
        }
      },
      (error) => {
        if (onError) {
          onError(error)
        }
      },
    )
  },

  async getSharedBoard(
    boardId: string,
    currentUserEmail?: string | null,
    currentUserId?: string | null,
  ): Promise<{
    status: 'allowed' | 'restricted' | 'not-found'
    config?: BoardShareConfig
  }> {
    const db = getFirestoreDb()
    let remoteData: BoardShareConfig | null = null

    if (db) {
      try {
        const snap = await getDocWithTimeout<any>(doc(db, 'boardShares', boardId))
        if (snap.exists()) {
          remoteData = workspaceValue(snap.data()) as BoardShareConfig
        }
      } catch (err: any) {
        if (err?.code === 'permission-denied') {
          return { status: 'restricted' }
        }
      }
    }

    if (!remoteData) {
      return { status: 'not-found' }
    }

    // Permission checks
    if (remoteData.generalAccess === 'anyone_with_link') {
      return { status: 'allowed', config: remoteData }
    }

    if (currentUserId && remoteData.ownerId === currentUserId) {
      return { status: 'allowed', config: remoteData }
    }

    if (currentUserEmail) {
      const normalizedEmail = currentUserEmail.trim().toLowerCase()
      if (remoteData.invitedEmails.some((e) => e.toLowerCase() === normalizedEmail)) {
        return { status: 'allowed', config: remoteData }
      }
    }

    return { status: 'restricted', config: remoteData }
  },

  async registerActiveSession(boardId: string, sessionId: string): Promise<() => void> {
    const regKey = `${boardId}:${sessionId}`
    activeSessionRefCount.set(regKey, (activeSessionRefCount.get(regKey) ?? 0) + 1)

    const sessionData: ActiveSessionRecord = {
      sessionId,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    }

    // 1. Direct Firestore session registration
    const db = getFirestoreDb()
    if (db) {
      try {
        const sessionRef = doc(db, 'boardShares', boardId, 'activeSessions', sessionId)
        await setDoc(sessionRef, sessionData)
      } catch (err: any) {
        console.warn('[Collab] Could not register Firestore active session:', err?.message)
      }
    }

    // 2. Periodic heartbeat to keep session fresh
    const heartbeatTimer = setInterval(() => {
      if (cleanedUp) return
      const now = Date.now()
      sessionData.lastSeen = now

      const currentDb = getFirestoreDb()
      if (currentDb) {
        const sessionRef = doc(currentDb, 'boardShares', boardId, 'activeSessions', sessionId)
        updateDoc(sessionRef, { lastSeen: now }).catch(() => {})
      }
    }, 15000)

    // Cleanup logic
    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      clearInterval(heartbeatTimer)
      const currentCount = (activeSessionRefCount.get(regKey) ?? 1) - 1
      if (currentCount <= 0) {
        activeSessionRefCount.delete(regKey)
        void sharingService.removeActiveSession(boardId, sessionId)
      } else {
        activeSessionRefCount.set(regKey, currentCount)
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', cleanup, { once: true })
      window.addEventListener('pagehide', cleanup, { once: true })
    }

    return cleanup
  },

  async removeActiveSession(boardId: string, sessionId: string): Promise<void> {
    // 1. Reliable synchronous keepalive REST delete (survives tab closure & beforeunload)
    const env =
      typeof import.meta !== 'undefined' && import.meta.env
        ? import.meta.env
        : typeof process !== 'undefined' && process.env
          ? (process.env as any)
          : {}
    const db = getFirestoreDb()
    const projectId = db?.app.options.projectId || env.VITE_FIREBASE_PROJECT_ID
    if (projectId && typeof fetch !== 'undefined') {
      try {
        const deleteUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/boardShares/${boardId}/activeSessions/${sessionId}`
        fetch(deleteUrl, { method: 'DELETE', keepalive: true }).catch(() => {})
      } catch {
        // ignore
      }
    }

    // 2. Firestore doc cleanup via SDK
    if (db) {
      try {
        const sessionRef = doc(db, 'boardShares', boardId, 'activeSessions', sessionId)
        await deleteDoc(sessionRef)
      } catch (err: any) {
        console.warn('[Collab] Could not remove Firestore active session:', err?.message)
      }
    }
  },

  subscribeToActiveSessions(
    boardId: string,
    onActiveSessionsChange: (activeSessions: ActiveSessionRecord[]) => void,
  ): () => void {
    const db = getFirestoreDb()
    if (!db) {
      onActiveSessionsChange([])
      return () => {}
    }

    try {
      const sessionsCol = collection(db, 'boardShares', boardId, 'activeSessions')
      return onSnapshot(
        sessionsCol,
        (snap) => {
          const list: ActiveSessionRecord[] = []
          const now = Date.now()
          snap.forEach((d) => {
            const data = d.data() as any
            if (data) {
              const joinedAt = Number(data.joinedAt ?? now)
              const lastSeen = Number(data.lastSeen ?? joinedAt)
              if (now - lastSeen > STALE_SESSION_TIMEOUT_MS) {
                // Actively purge stale session document from Firestore
                deleteDoc(d.ref).catch(() => {})
              } else {
                list.push({
                  sessionId: d.id,
                  joinedAt,
                  lastSeen,
                })
              }
            }
          })
          onActiveSessionsChange(filterValidActiveSessions(list))
        },
        (err) => {
          console.warn('[Collab] Firestore activeSessions subscription warning:', err?.message)
          onActiveSessionsChange([])
        },
      )
    } catch {
      onActiveSessionsChange([])
      return () => {}
    }
  },
}

export function filterValidActiveSessions(
  sessions: ActiveSessionRecord[],
  timeoutMs = STALE_SESSION_TIMEOUT_MS,
  now = Date.now(),
): ActiveSessionRecord[] {
  return sessions.filter((s) => s && s.sessionId && now - (s.lastSeen || s.joinedAt) <= timeoutMs)
}
