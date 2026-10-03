import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { onDisconnect, onValue, ref, remove, set } from 'firebase/database'
import {
  getFirebaseAuth,
  getFirebaseRtdb,
  getFirestoreDb,
} from '../../lib/firebase'
import { restoreSceneAssets, storeSceneAssets } from '../assets/scene-assets'
import { firestoreValue, workspaceStore, workspaceValue } from '../workspace/workspace-api'
import type { BoardScene } from '@agentic-whiteboard/storage'
import type { ActiveSessionRecord } from '../collaboration/types'
import { cloudCall } from '../account/cloud-api'
import { readGuestRecovery } from './guest-recovery'
import { reconcileElementsLWW } from '../collaboration/reconcile'

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
  hasLocalRecovery?: boolean
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
      hasLocalRecovery?: boolean
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
          if (data.scene) data.scene = await restoreSceneAssets(data.scene)
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
      const { scene: _scene, ...metadata } = normalizedConfig
      await cloudCall('commitCloudBoard', { mode: 'share-config', boardId: config.boardId,
        operationId: crypto.randomUUID(), document: firestoreValue(metadata) })
      await cloudCall('syncBoardAccessToRtdb', { boardId: config.boardId })
      if (resolvedScene) await sharingService.updateSharedScene(config.boardId, resolvedScene)
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
        await cloudCall('commitCloudBoard', { mode: 'shared-scene', boardId, operationId: crypto.randomUUID(), document: updatePayload })
      } catch (error: any) {
        // An unshared board has no share document. Surface actual upload failures.
        if (!['not-found', 'permission-denied', 'functions/not-found', 'functions/permission-denied'].includes(error?.code)) throw error
      }
    }
  },

  async updateSharedScene(boardId: string, scene: BoardScene): Promise<void> {
    const db = getFirestoreDb()
    if (db) {
      await cloudCall('commitCloudBoard', { mode: 'shared-scene', boardId, operationId: crypto.randomUUID(),
        document: { scene: firestoreValue(await storeSceneAssets(scene, `boards/${boardId}/assets`)) } })
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
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const data = workspaceValue(snap.data()) as BoardShareConfig
          const current = ++generation
          void (async () => {
            if (data.scene) data.scene = await restoreSceneAssets(data.scene, knownFiles)
            if (current === generation) {
              knownFiles = data.scene?.files ?? {}
              onUpdate(data)
            }
          })().catch((error) => onError?.(error))
        }
      },
      (error) => {
        generation += 1
        onError?.(error)
      },
    )
    return () => {
      generation += 1
      unsubscribe()
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
      }
    }

    if (!remoteData) {
      return { status: 'not-found' }
    }

    const allowed = async () => {
      if (remoteData!.scene) remoteData!.scene = await restoreSceneAssets(remoteData!.scene)
      const recovery = await readGuestRecovery(`${getFirebaseAuth()?.currentUser?.uid ?? 'guest'}:${boardId}`)
      if (recovery && remoteData!.scene) {
        remoteData!.scene = { ...recovery.scene, elements: reconcileElementsLWW(recovery.scene.elements, remoteData!.scene.elements), files: { ...remoteData!.scene.files, ...recovery.scene.files } }
        remoteData!.hasLocalRecovery = true
      }
      return { status: 'allowed' as const, config: remoteData! }
    }

    // Permission checks
    if (remoteData.generalAccess === 'anyone_with_link') {
      return allowed()
    }

    if (currentUserId && remoteData.ownerId === currentUserId) {
      return allowed()
    }

    if (currentUserEmail) {
      const normalizedEmail = currentUserEmail.trim().toLowerCase()
      if (remoteData.invitedEmails.some((e) => e.toLowerCase() === normalizedEmail)) {
        return allowed()
      }
    }

    return { status: 'restricted', config: remoteData }
  },

  async registerActiveSession(boardId: string, sessionId: string, userId: string): Promise<() => void> {
    await cloudCall('admitCloudSession', { boardId, sessionId })
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
    const renewal = window.setInterval(() => { if (!released) void cloudCall('admitCloudSession', { boardId, sessionId }).catch(() => {}) }, 30 * 60 * 1000)
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
          await cloudCall('admitCloudSession', { boardId, sessionId })
          const grantRef = ref(rtdb!, `sessionGrants/${boardId}/${sessionId}`)
          await onDisconnect(grantRef).remove()
          await set(sessionRef, sessionData)
          retryAttempt = 0
          if (retryTimer) {
            clearTimeout(retryTimer)
            retryTimer = undefined
          }
        } catch (err: any) {
          console.warn('[Collab] Could not publish RTDB active session:', err?.message)
          if (err?.code !== 'functions/resource-exhausted') schedulePublicationRetry()
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
      window.clearInterval(renewal)
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
        await remove(ref(rtdb, `sessionGrants/${boardId}/${sessionId}`))
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
