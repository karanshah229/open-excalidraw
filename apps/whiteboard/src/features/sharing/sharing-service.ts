import { doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore'
import { getFirestoreDb } from '../../lib/firebase'
import { firestoreValue, workspaceStore, workspaceValue } from '../workspace/workspace-api'
import type { BoardScene } from '@agentic-whiteboard/storage'

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

const LOCAL_SHARE_PREFIX = 'agentic-whiteboard:share:'

function getLocalShare(boardId: string): BoardShareConfig | null {
  try {
    const raw = localStorage.getItem(`${LOCAL_SHARE_PREFIX}${boardId}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function setLocalShare(config: BoardShareConfig) {
  try {
    localStorage.setItem(`${LOCAL_SHARE_PREFIX}${config.boardId}`, JSON.stringify(config))
  } catch {
    // storage may be full or disabled
  }
}

async function getDocWithTimeout<T>(docRef: any, timeoutMs = 2500): Promise<T> {
  return Promise.race([
    getDoc(docRef) as Promise<T>,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Firestore getDoc timeout')), timeoutMs)),
  ])
}

export const sharingService = {
  hasLocalAccess(boardId: string): boolean {
    const cached = getLocalShare(boardId)
    return Boolean(cached && cached.generalAccess === 'anyone_with_link')
  },
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
          setLocalShare(data)
          return data
        }
      } catch {
        // Fall back to local share config if Firestore lookup fails (e.g. offline)
      }
    }

    const cached = getLocalShare(boardId)
    if (cached) {
      return {
        ...cached,
        boardName: fallback?.boardName ?? cached.boardName,
        ownerName: fallback?.ownerName ?? cached.ownerName,
        ownerEmail: fallback?.ownerEmail ?? cached.ownerEmail,
        ownerPhotoURL: fallback?.ownerPhotoURL ?? cached.ownerPhotoURL,
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
    if (!resolvedScene) {
      try {
        const localDoc = await workspaceStore.loadBoard(config.boardId)
        if (localDoc?.scene) {
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

    setLocalShare(normalizedConfig)

    const db = getFirestoreDb()
    if (db) {
      const ref = doc(db, 'boardShares', config.boardId)
      await setDoc(ref, firestoreValue(normalizedConfig) as Record<string, unknown>, { merge: true })
    }
  },

  async syncBoardSceneToShare(boardId: string, scene: BoardScene, boardName?: string): Promise<void> {
    const cached = getLocalShare(boardId)
    const db = getFirestoreDb()

    if (cached) {
      cached.scene = scene
      if (boardName) cached.boardName = boardName
      cached.updatedAt = new Date().toISOString()
      setLocalShare(cached)
    }

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
          setLocalShare(data)
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
          setLocalShare(remoteData)
        }
      } catch (err: any) {
        const localCached = getLocalShare(boardId)
        if (localCached && localCached.generalAccess === 'anyone_with_link') {
          return { status: 'allowed', config: localCached }
        }
        if (err?.code === 'permission-denied') {
          return { status: 'restricted' }
        }
      }
    }

    const config = remoteData ?? getLocalShare(boardId)
    if (!config) {
      return { status: 'not-found' }
    }

    // Permission checks
    if (config.generalAccess === 'anyone_with_link') {
      return { status: 'allowed', config }
    }

    if (currentUserId && config.ownerId === currentUserId) {
      return { status: 'allowed', config }
    }

    if (currentUserEmail) {
      const normalizedEmail = currentUserEmail.trim().toLowerCase()
      if (config.invitedEmails.some((e) => e.toLowerCase() === normalizedEmail)) {
        return { status: 'allowed', config }
      }
    }

    return { status: 'restricted', config }
  },
}
