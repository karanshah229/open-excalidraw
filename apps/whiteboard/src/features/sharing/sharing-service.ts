import { doc, getDoc, onSnapshot, updateDoc } from 'firebase/firestore'
import { onDisconnect, onValue, ref, remove, set } from 'firebase/database'
import { projectService } from './project-service'
import { getFirebaseAuth, getFirebaseRtdb, getFirestoreDb } from '../../lib/firebase'
import { restoreSceneAssets, storeSceneAssets } from '../assets/scene-assets'
import { firestoreValue, workspaceStore, workspaceValue } from '../workspace/workspace-api'
import type { BoardScene } from '@agentic-whiteboard/storage'
import type { ActiveSessionRecord } from '../collaboration/types'

export type ShareAccessLevel = 'restricted' | 'anyone_with_link'
export type ShareRole = 'viewer' | 'editor'

export interface BoardCollaborator {
  email: string
  role: ShareRole
  addedAt: string
}

export interface BoardShareConfig {
  boardId: string
  projectId?: string
  inheritProjectAccess?: boolean
  effectiveRole?: 'owner' | ShareRole | null
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

function withFirestoreWriteTimeout<T>(operation: Promise<T>, timeoutMs = 15_000): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Firestore write acknowledgement timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
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
        if (data.scene) data.scene = await restoreSceneAssets(data.scene)
        return data
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

    // Legacy local workspaces used the placeholder owner `local-user`. A new
    // share must be claimed by the signed-in Firebase identity before rules
    // permit it; never persist that placeholder as a cloud owner.
    const authenticatedOwnerId = getFirebaseAuth()?.currentUser?.uid
    const ownerId = config.ownerId === 'local-user' && authenticatedOwnerId ? authenticatedOwnerId : config.ownerId
    const normalizedConfig: BoardShareConfig = {
      ...config,
      ownerId,
      scene: resolvedScene,
      updatedAt: new Date().toISOString(),
      invitedEmails: Array.from(new Set(config.invitedEmails.map((e) => e.trim().toLowerCase()))),
    }

    const db = getFirestoreDb()
    if (db) {
      const local = await workspaceStore.loadBoard(config.boardId)
      const projectId = config.projectId ?? local?.projectId
      if (!projectId) throw new Error('Board ownership could not be verified. Reload the board.')
      const { workspaceApi } = await import('../workspace/workspace-api')
      await workspaceApi.flushCloud()
      await projectService.boardAccess(config.boardId, projectId, 'share', normalizedConfig)
      // Policy changes must never overwrite a newer scene with the modal's snapshot.
    }
  },

  async syncBoardSceneToShare(boardId: string, scene: BoardScene, boardName?: string): Promise<void> {
    const db = getFirestoreDb()
    if (db) {
      try {
        const ref = doc(db, 'boardShares', boardId)
        if (!(await getDoc(ref)).exists()) return
        const updatePayload: Record<string, unknown> = {
          scene: firestoreValue(await storeSceneAssets(scene, `boards/${boardId}/assets`)),
          updatedAt: new Date().toISOString(),
        }
        if (boardName) updatePayload.boardName = boardName
        await withFirestoreWriteTimeout(updateDoc(ref, updatePayload))
      } catch (error: any) {
        // An unshared board has no share document. Surface actual upload failures.
        if (error?.code !== 'not-found') throw error
      }
    }
  },

  async updateSharedScene(boardId: string, scene: BoardScene): Promise<void> {
    const db = getFirestoreDb()
    if (db) {
      const ref = doc(db, 'boardShares', boardId)
      await withFirestoreWriteTimeout(
        updateDoc(ref, {
          scene: firestoreValue(await storeSceneAssets(scene, `boards/${boardId}/assets`)),
          updatedAt: new Date().toISOString(),
        }),
      )
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
    let generation = 0
    let knownFiles: BoardScene['files'] = {}
    let parentUnsubscribe: (() => void) | undefined
    let parentId: string | undefined
    const refresh = () => {
      const current = ++generation
      const user = getFirebaseAuth()?.currentUser
      void sharingService
        .getSharedBoard(boardId, user?.email, user?.uid)
        .then((result) => {
          if (current !== generation) return
          if (result.status !== 'allowed' || !result.config) {
            onError?.({ code: 'permission-denied' })
            return
          }
          knownFiles = result.config.scene?.files ?? knownFiles
          onUpdate(result.config)
          if (result.config.projectId && parentId !== result.config.projectId) {
            parentUnsubscribe?.()
            parentId = result.config.projectId
            parentUnsubscribe = onSnapshot(doc(db, 'projectShares', parentId), refresh, () => refresh())
          }
        })
        .catch((error) => onError?.(error))
    }
    const unsubscribe = onSnapshot(ref, refresh, (error) => {
      generation++
      onError?.(error)
    })
    return () => {
      generation++
      unsubscribe()
      parentUnsubscribe?.()
    }
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
        throw err
      }
    }

    if (!remoteData) {
      return { status: 'not-found' }
    }

    const allowed = async () => {
      if (remoteData!.scene) remoteData!.scene = await restoreSceneAssets(remoteData!.scene)
      return { status: 'allowed' as const, config: remoteData! }
    }

    let inheritedRole: ShareRole | 'owner' | null = null
    if (remoteData.projectId && remoteData.inheritProjectAccess !== false && db) {
      const parent = await getDoc(doc(db, 'projectShares', remoteData.projectId)).catch(() => null)
      if (parent?.exists()) {
        const policy = parent.data()
        const email = getFirebaseAuth()?.currentUser?.emailVerified ? currentUserEmail?.toLowerCase() : null
        inheritedRole =
          policy.ownerId === currentUserId
            ? 'owner'
            : policy.generalAccess === 'anyone_with_link' && policy.generalRole === 'editor'
              ? 'editor'
              : email && policy.collaborators?.[email]?.role === 'editor'
                ? 'editor'
                : 'viewer'
      }
    }
    const email = getFirebaseAuth()?.currentUser?.emailVerified ? currentUserEmail?.toLowerCase() : null
    remoteData.effectiveRole =
      remoteData.ownerId === currentUserId
        ? 'owner'
        : remoteData.generalAccess === 'anyone_with_link' && remoteData.generalRole === 'editor'
          ? 'editor'
          : email && remoteData.invitedEmails?.includes(email) && remoteData.collaborators?.[email]?.role === 'editor'
            ? 'editor'
            : inheritedRole === 'editor' || inheritedRole === 'owner'
              ? inheritedRole
              : 'viewer'
    return allowed()
  },

  async registerActiveSession(boardId: string, sessionId: string, userId: string): Promise<() => void> {
    const regKey = `${boardId}:${sessionId}`
    activeSessionRefCount.set(regKey, (activeSessionRefCount.get(regKey) ?? 0) + 1)

    const sessionData: ActiveSessionRecord = {
      userId,
      sessionId,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    }

    // Session presence is deliberately kept in RTDB, not Firestore. A Firestore
    // heartbeat costs one document write every 15 seconds per open tab and can
    // exhaust the Spark daily quota even when nobody edits a board.
    const rtdb = getFirebaseRtdb()
    const sessionRef = rtdb ? ref(rtdb, `activeSessions/${boardId}/${sessionId}`) : undefined
    let released = false
    let unsubscribeConnection = () => {}
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryAttempt = 0
    let publishing = false
    if (sessionRef) {
      const schedulePublicationRetry = () => {
        // A board can be opened just before its Firestore access policy is
        // mirrored into RTDB. Retrying this one-time bootstrap is not a
        // heartbeat: it stops on the first successful publish (or release).
        if (released || retryTimer || retryAttempt >= 9) return
        const delayMs = Math.min(200 * 2 ** retryAttempt, 15_000)
        retryAttempt += 1
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          void publishOnConnection()
        }, delayMs)
      }

      const publishOnConnection = async () => {
        if (publishing || released) return
        publishing = true
        try {
          // Attach cleanup before publishing, otherwise a crash in between can
          // leave a ghost session that no other user is allowed to remove.
          const disconnect = onDisconnect(sessionRef)
          await disconnect.remove()
          if (released) {
            await disconnect.cancel()
            return
          }
          await set(sessionRef, sessionData)
          retryAttempt = 0
          if (retryTimer) {
            clearTimeout(retryTimer)
            retryTimer = undefined
          }
        } catch (err: any) {
          console.warn('[Collab] Could not publish RTDB active session:', err?.message)
          schedulePublicationRetry()
        } finally {
          publishing = false
        }
      }

      // RTDB transport liveness is authoritative. Fires once initially and on
      // every reconnection after sleep, a network change, or a socket drop.
      unsubscribeConnection = onValue(ref(rtdb!, '.info/connected'), (snap) => {
        if (snap.val() === true && !released) void publishOnConnection()
      })
    }

    // Cleanup logic
    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      released = true
      unsubscribeConnection()
      if (retryTimer) clearTimeout(retryTimer)
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
    const rtdb = getFirebaseRtdb()
    if (rtdb) {
      try {
        await remove(ref(rtdb, `activeSessions/${boardId}/${sessionId}`))
      } catch (err: any) {
        console.warn('[Collab] Could not remove RTDB active session:', err?.message)
      }
    }
  },

  subscribeToActiveSessions(
    boardId: string,
    onActiveSessionsChange: (activeSessions: ActiveSessionRecord[]) => void,
  ): () => void {
    const rtdb = getFirebaseRtdb()
    if (!rtdb) {
      onActiveSessionsChange([])
      return () => {}
    }

    const sessionsRef = ref(rtdb, `activeSessions/${boardId}`)
    let stopped = false
    let unsubscribe = () => {}
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryAttempt = 0

    const attach = () => {
      if (stopped) return
      unsubscribe()
      unsubscribe = onValue(
        sessionsRef,
        (snap) => {
          retryAttempt = 0
          const list: ActiveSessionRecord[] = []
          const sessions = snap.val() as Record<string, Partial<ActiveSessionRecord>> | null
          for (const [sessionId, data] of Object.entries(sessions ?? {})) {
            if (data) {
              if (typeof data.userId !== 'string' || !data.userId) continue
              const joinedAt = Number(data.joinedAt ?? Date.now())
              const lastSeen = Number(data.lastSeen ?? joinedAt)
              list.push({ userId: data.userId, sessionId, joinedAt, lastSeen })
            }
          }
          onActiveSessionsChange(list)
        },
        (err) => {
          console.warn('[Collab] RTDB activeSessions subscription warning:', err?.message)
          onActiveSessionsChange([])
          // RTDB cancels a denied listener. A just-created board can receive
          // its server-authorized ACL moments later, so reattach with bounded
          // backoff instead of permanently treating the room as solo.
          if (!stopped && retryAttempt < 9) {
            const delayMs = Math.min(200 * 2 ** retryAttempt, 15_000)
            retryAttempt += 1
            retryTimer = setTimeout(() => {
              retryTimer = undefined
              attach()
            }, delayMs)
          }
        },
      )
    }

    try {
      attach()
    } catch {
      onActiveSessionsChange([])
    }

    return () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      unsubscribe()
    }
  },
}
