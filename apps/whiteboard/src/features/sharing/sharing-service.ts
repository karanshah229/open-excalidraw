import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { onDisconnect, onValue, ref, remove, set } from 'firebase/database'
import { projectService, type ProjectPolicy } from './project-service'
import { getFirebaseAuth, getFirebaseRtdb, getFirestoreDb } from '../../lib/firebase'
import { restoreSceneAssets, storeSceneAssets } from '../assets/scene-assets'
import { workspaceStore, workspaceValue } from '../workspace/workspace-api'
import type { BoardScene } from '@agentic-whiteboard/storage'
import type { ActiveSessionRecord } from '../collaboration/types'
import { sceneService } from '../scenes/scene-service'

export type ShareAccessLevel = 'restricted' | 'anyone_with_link'
export type ShareRole = 'viewer' | 'editor' | 'presentation'

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
  sceneRevisionId?: string
  sceneGeneration?: number
  createdAt: string
  updatedAt: string
  accessRevision?: number
  projectPolicy?: ProjectPolicy
  projectRole?: 'owner' | ShareRole | null
}

/** Matches the strongest grant used when opening a shared board. */
export function policyRole(
  policy?: ProjectPolicy & { ownerId?: string; pending?: boolean; deletedAt?: unknown },
  user = getFirebaseAuth()?.currentUser,
): 'owner' | ShareRole | null {
  if (!policy || policy.deletedAt) return null
  if (user?.uid && policy.ownerId === user.uid) return 'owner'
  if (policy.pending) return null
  const email = user?.emailVerified ? user.email?.trim().toLowerCase() : undefined
  const publicRole = policy.generalAccess === 'anyone_with_link' ? (policy.generalRole ?? 'viewer') : null
  const invited =
    email && policy.invitedEmails?.includes(email) ? (policy.collaborators?.[email]?.role ?? 'viewer') : null
  return strongestRole(publicRole, invited || null)
}
export function strongestRole(a: 'owner' | ShareRole | null, b: 'owner' | ShareRole | null) {
  const rank = { owner: 4, editor: 3, viewer: 2, presentation: 1 }
  return a && (!b || rank[a] >= rank[b]) ? a : b
}

async function getDocWithTimeout<T>(docRef: any, timeoutMs = 3000): Promise<T> {
  return Promise.race([
    getDoc(docRef) as Promise<T>,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Firestore getDoc timeout')), timeoutMs)),
  ])
}

const policyCache = new Map<string, BoardShareConfig>()
const policyUser = () => getFirebaseAuth()?.currentUser?.uid ?? 'local-user'
const policyKey = (id: string, uid = policyUser()) => `${uid}:${id}`
const activeSessionRefCount = new Map<string, number>()

// Owner and shared saves can run concurrently. Give new owner files the same
// destination as private workspace sync so only one immutable upload is needed.
async function storeSharedAssets(boardId: string, scene: BoardScene) {
  const uid = getFirebaseAuth()?.currentUser?.uid
  const local = uid ? await workspaceStore.loadBoard(boardId) : null
  const owner = local && (await workspaceStore.listProjects(true)).find((project) => project.id === local.projectId)
  return local && uid && owner?.ownerId === uid
    ? storeSceneAssets(scene, `users/${uid}/boards/${boardId}/assets`, local.projectId)
    : storeSceneAssets(scene, `boards/${boardId}/assets`)
}

export const sharingService = {
  cachedShareConfig(boardId: string) {
    return policyCache.get(policyKey(boardId))
  },
  rememberShareConfig(config: BoardShareConfig, expectedUser = policyUser()) {
    const { scene: _scene, ...policy } = config
    if (expectedUser === policyUser()) policyCache.set(policyKey(config.boardId, expectedUser), policy)
    return policy
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
    const requestUser = policyUser()
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
        return sharingService.rememberShareConfig(data, requestUser)
      }
    }

    // Default restricted configuration
    const defaultConfig: BoardShareConfig = {
      boardId,
      projectId: (await workspaceStore.loadBoard(boardId))?.projectId,
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

    return sharingService.rememberShareConfig(defaultConfig, requestUser)
  },

  async saveShareConfig(
    config: BoardShareConfig,
    _options?: { workspaceFlushed?: boolean },
  ): Promise<BoardShareConfig> {
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

      const {
        scene: _scene,
        projectPolicy: _parent,
        projectRole: _role,
        effectiveRole: _effective,
        ...policy
      } = normalizedConfig
      const result = await projectService.boardAccess(config.boardId, projectId, 'share', policy)
      const committed = { ...normalizedConfig, ...result.policy, scene: resolvedScene }
      sharingService.rememberShareConfig(committed, authenticatedOwnerId ?? 'local-user')
      return committed
    }
    return normalizedConfig
  },

  async syncBoardSceneToShare(
    boardId: string,
    scene: BoardScene,
    _boardName?: string,
    expectedGeneration?: number,
  ): Promise<void> {
    const db = getFirestoreDb()
    const uid = getFirebaseAuth()?.currentUser?.uid
    if (!db || !(await getDoc(doc(db, 'boardShares', boardId))).exists()) return
    const stored = await storeSharedAssets(boardId, scene)
    if (!uid || getFirebaseAuth()?.currentUser?.uid !== uid) throw new Error('Account changed while saving the board.')
    await sceneService.commit(boardId, stored, { expectedGeneration })
    window.dispatchEvent(new Event('workspace-changed'))
  },

  async updateSharedScene(boardId: string, scene: BoardScene, expectedGeneration?: number): Promise<void> {
    if (!getFirestoreDb()) return
    const uid = getFirebaseAuth()?.currentUser?.uid
    const stored = await storeSharedAssets(boardId, scene)
    if (!uid || getFirebaseAuth()?.currentUser?.uid !== uid) throw new Error('Account changed while saving the board.')
    await sceneService.commit(boardId, stored, { expectedGeneration })
    window.dispatchEvent(new Event('workspace-changed'))
  },

  subscribeToSharedBoard(
    boardId: string,
    onUpdate: (config: BoardShareConfig) => void,
    onError?: (error: any) => void,
    getKnownFiles?: () => BoardScene['files'],
  ): () => void {
    const db = getFirestoreDb()
    if (!db) return () => {}
    const boardRef = doc(db, 'boardShares', boardId)
    let generation = 0
    let knownFiles: BoardScene['files'] = getKnownFiles?.() ?? {}
    let hydration = Promise.resolve()
    let disposed = false
    let boardUnsubscribe: (() => void) | undefined
    let sceneUnsubscribe: (() => void) | undefined
    let parentUnsubscribe: (() => void) | undefined
    let parentId: string | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryAttempt = 0
    const scheduleRetry = () => {
      if (disposed || retryTimer) return
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined
          refresh()
        },
        Math.min(250 * 2 ** retryAttempt++, 5000),
      )
    }
    const denied = (error: any) => {
      if (disposed) return
      generation++
      onError?.(error)
      scheduleRetry()
    }
    const attachBoard = () => {
      if (disposed || boardUnsubscribe) return
      boardUnsubscribe = onSnapshot(boardRef, refresh, (error) => {
        boardUnsubscribe = undefined // Firestore terminates a denied listener.
        denied(error)
      })
    }
    const attachScene = () => {
      if (disposed || sceneUnsubscribe) return
      sceneUnsubscribe = sceneService.subscribeHead(boardId, refresh, (error) => {
        // Firestore terminates denied listeners. Recovery must reattach the
        // scene head as well as policy listeners, or later drawing commits disappear.
        sceneUnsubscribe = undefined
        denied(error)
      })
    }
    const refresh = () => {
      if (disposed) return
      const current = ++generation
      const user = getFirebaseAuth()?.currentUser
      hydration = hydration
        .catch(() => {})
        .then(async () => {
          if (disposed || current !== generation) return
          const result = await sharingService.getSharedBoard(boardId, user?.email, user?.uid, {
            ...knownFiles,
            ...getKnownFiles?.(),
          })
          // Retain the first transfer for queued snapshots of immutable image bytes.
          knownFiles = { ...knownFiles, ...result.config?.scene?.files }

          if (disposed || current !== generation) return
          if (result.status !== 'allowed' || !result.config) {
            onError?.({ code: 'permission-denied' })
            scheduleRetry()
            return
          }
          retryAttempt = 0
          if (retryTimer) clearTimeout(retryTimer)
          retryTimer = undefined
          onUpdate(result.config)
          attachBoard()
          attachScene()
          if (
            result.config.projectId &&
            result.config.projectRole &&
            (parentId !== result.config.projectId || !parentUnsubscribe)
          ) {
            parentUnsubscribe?.()
            parentId = result.config.projectId
            parentUnsubscribe = onSnapshot(doc(db, 'projectShares', parentId), refresh, () => {
              parentUnsubscribe = undefined
              // A direct board grant can survive loss of project membership.
              // Reauthorize the board rather than treating the parent as its ACL.
              scheduleRetry()
            })
          }
        })
        .catch((error) => {
          if (disposed || current !== generation) return
          onError?.(error)
          scheduleRetry()
        })
    }
    attachBoard()
    attachScene()
    return () => {
      disposed = true
      generation++
      if (retryTimer) clearTimeout(retryTimer)
      boardUnsubscribe?.()
      sceneUnsubscribe?.()
      parentUnsubscribe?.()
    }
  },

  async getSharedBoard(
    boardId: string,
    _currentUserEmail?: string | null,
    _currentUserId?: string | null,
    knownFiles: BoardScene['files'] = {},
  ): Promise<{
    status: 'allowed' | 'restricted' | 'not-found'
    config?: BoardShareConfig
  }> {
    const db = getFirestoreDb()
    const requestUser = policyUser()
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
      sharingService.rememberShareConfig(remoteData!, requestUser)
      try {
        // A committed empty scene is authoritative; never substitute legacy content.
        let canonical = await sceneService.load(boardId)
        if (!canonical) {
          await sceneService.ensure(boardId, remoteData!.projectId)
          canonical = await sceneService.load(boardId)
        }
        if (canonical) {
          remoteData!.scene = await restoreSceneAssets(canonical.scene, knownFiles)
          remoteData!.sceneRevisionId = canonical.revisionId
          remoteData!.sceneGeneration = canonical.generation
        } else if (remoteData!.scene) remoteData!.scene = await restoreSceneAssets(remoteData!.scene, knownFiles)
      } catch (error: any) {
        if (error?.code === 'functions/permission-denied' || error?.code === 'permission-denied') {
          return { status: 'restricted' as const }
        }
        throw error
      }
      return { status: 'allowed' as const, config: remoteData! }
    }

    let parent: (ProjectPolicy & { ownerId?: string; pending?: boolean; deletedAt?: unknown }) | undefined
    if (remoteData.projectId && db) {
      const snapshot = await getDoc(doc(db, 'projectShares', remoteData.projectId)).catch(() => null)
      if (snapshot?.exists()) parent = snapshot.data() as typeof parent
    }
    remoteData.projectPolicy = parent
    const inheritedRole = remoteData.inheritProjectAccess !== false ? policyRole(parent) : null
    remoteData.projectRole = inheritedRole
    const directRole = policyRole(remoteData)
    remoteData.effectiveRole = strongestRole(directRole, inheritedRole)
    if (!remoteData.effectiveRole) return { status: 'restricted' }
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
