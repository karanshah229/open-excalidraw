import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { Collaborator } from '@excalidraw/excalidraw/types'
import { reconcileElements } from '@excalidraw/excalidraw'
import { type User } from 'firebase/auth'
import { getFirebaseAuth, getFirebaseRtdb, getFirebaseStorage } from '../../lib/firebase'
import { ensureAuthenticatedUser, generateSessionId, resolveCollabUser, getAnonymousProfile } from './anonymous-user'
import { CollaborationService } from './collaboration-service'
import type { CollaboratorPresence, CollabUser } from './types'

export interface UseCollaborationOptions {
  boardId: string
  enabled: boolean
  authUser?: User | null
  isAuthLoading?: boolean
  isReadOnly: boolean
  apiRef: React.RefObject<ExcalidrawImperativeAPI | null>
  elementsRef: React.MutableRefObject<any[]>
  appStateRef: React.MutableRefObject<Record<string, unknown>>
}

export function useCollaboration({
  boardId,
  enabled,
  authUser,
  isAuthLoading,
  isReadOnly,
  apiRef,
  elementsRef,
  appStateRef,
}: UseCollaborationOptions) {
  // Session ID stays fixed for the lifetime of this tab
  const sessionIdRef = useRef<string>(generateSessionId())

  const [collabUser, setCollabUser] = useState<CollabUser>(() => {
    const sid = sessionIdRef.current
    if (authUser) {
      return resolveCollabUser(authUser, sid)
    }
    const profile = getAnonymousProfile(sid)
    return {
      uid: sid,
      sessionId: sid,
      displayName: profile.displayName,
      color: profile.color,
      isAnonymous: true,
    }
  })
  const [activeCollaborators, setActiveCollaborators] = useState<CollaboratorPresence[]>([])
  const collabUserRef = useRef(collabUser)
  collabUserRef.current = collabUser

  // Collaboration service singleton ref
  const collabServiceRef = useRef<CollaborationService>(new CollaborationService())

  // Keep track of known element versions to only broadcast actual deltas
  const knownElementVersionsRef = useRef<Map<string, { version: number; versionNonce: number }>>(new Map())

  // Scoped undo / redo stacks for current user
  const userUndoStackRef = useRef<any[][]>([])
  const userRedoStackRef = useRef<any[][]>([])

  // Seed known element versions from initial elements to prevent false-positive delta broadcasts on load
  useEffect(() => {
    if (elementsRef.current && elementsRef.current.length > 0) {
      for (const elem of elementsRef.current) {
        if (elem?.id && !knownElementVersionsRef.current.has(elem.id)) {
          knownElementVersionsRef.current.set(elem.id, {
            version: Number(elem.version ?? 1),
            versionNonce: Number(elem.versionNonce ?? 0),
          })
        }
      }
    }
  }, [elementsRef])

  // Throttling pointer updates (max 30 updates per second / 33ms)
  const lastPointerBroadcastRef = useRef<number>(0)
  const pendingPointerRef = useRef<{ x: number; y: number } | null>(null)
  const pointerTimerRef = useRef<number | null>(null)

  const [isAuthReady, setIsAuthReady] = useState(false)

  // Initialize service with Firebase instances
  useEffect(() => {
    const rtdb = getFirebaseRtdb()
    const storage = getFirebaseStorage()
    if (rtdb) collabServiceRef.current.setDatabase(rtdb)
    if (storage) collabServiceRef.current.setStorage(storage)
  }, [])

  // 1. Maintain authenticated user identity (Google or Anonymous fallback)
  useEffect(() => {
    if (!enabled) return
    if (isAuthLoading) return

    let cancelled = false
    const auth = getFirebaseAuth()
    if (!auth) return

    // 1. If an authenticated user is provided directly, resolve it for presence & UI
    if (authUser) {
      const resolved = resolveCollabUser(authUser, sessionIdRef.current)
      setCollabUser(resolved)
      setIsAuthReady(true)
      return
    }

    // 2. Ensure Firebase Auth session is active so RTDB rules (auth != null) permit access
    if (!auth.currentUser) {
      void ensureAuthenticatedUser(auth).then((user) => {
        if (cancelled) return
        if (user) {
          const resolved = resolveCollabUser(user, sessionIdRef.current)
          setCollabUser(resolved)
          setIsAuthReady(true)
        }
      })
    } else {
      const resolved = resolveCollabUser(auth.currentUser, sessionIdRef.current)
      setCollabUser(resolved)
      setIsAuthReady(true)
    }

    return () => {
      cancelled = true
    }
  }, [enabled, authUser, isAuthLoading])

  // 2. Join presence and subscribe to remote collaborators
  useEffect(() => {
    if (!enabled || !collabUser || !boardId || !isAuthReady) return

    const service = collabServiceRef.current
    let isCancelled = false
    let leavePresence: (() => void) | undefined

    void service.joinBoardPresence(boardId, collabUser).then((cleanup) => {
      if (isCancelled) {
        if (cleanup) cleanup()
      } else {
        leavePresence = cleanup
      }
    })

    const unsubPresence = service.subscribeToPresence(boardId, collabUser.sessionId, (collaborators) => {
      setActiveCollaborators(collaborators)
    })

    return () => {
      isCancelled = true
      unsubPresence()
      if (leavePresence) leavePresence()
    }
  }, [enabled, collabUser, boardId, isAuthReady])

  // 3. Subscribe to remote element deltas and reconcile
  useEffect(() => {
    if (!enabled || !boardId || !isAuthReady) return

    const service = collabServiceRef.current
    const unsubElements = service.subscribeToElements(boardId, (remoteElement) => {
      if (!remoteElement || !remoteElement.id) return

      // Don't reconcile if we already have this exact version or newer
      const known = knownElementVersionsRef.current.get(remoteElement.id)
      if (known) {
        if (remoteElement.version < known.version) return
        // Align with Excalidraw engine standard: lowest versionNonce wins deterministic tie-break
        if (remoteElement.version === known.version && remoteElement.versionNonce >= known.versionNonce) {
          // If local version is strictly superior (lower nonce), re-assert to RTDB
          // so all peers and the database converge deterministically to the winner
          if (known.versionNonce < remoteElement.versionNonce) {
            const localList = apiRef.current ? apiRef.current.getSceneElements() : elementsRef.current
            const localEl = localList.find((e: any) => e.id === remoteElement.id)
            const cu = collabUserRef.current
            if (localEl && cu) {
              void service.broadcastElementDeltas(boardId, [localEl], cu.uid)
            }
          }
          return
        }
      }

      knownElementVersionsRef.current.set(remoteElement.id, {
        version: remoteElement.version,
        versionNonce: remoteElement.versionNonce,
      })

      // Reconcile with live scene elements using Excalidraw's engine
      const local = apiRef.current ? apiRef.current.getSceneElements() : elementsRef.current
      const appState = appStateRef.current
      const reconciled = reconcileElements(local, [remoteElement], appState as any)

      elementsRef.current = reconciled
      apiRef.current?.updateScene({ elements: reconciled })
    })

    return () => {
      unsubElements()
    }
  }, [enabled, boardId, isAuthReady, elementsRef, appStateRef, apiRef])

  // 4. Convert active collaborators to Excalidraw's native Collaborator Map
  const excalidrawCollaborators = useMemo(() => {
    const map = new Map<string, Collaborator>()

    for (const collab of activeCollaborators) {
      if (!collab.cursor) continue
      map.set(collab.sessionId, {
        pointer: {
          x: collab.cursor.x,
          y: collab.cursor.y,
          tool: 'pointer',
        },
        button: 'up',
        username: collab.displayName,
        color: {
          background: collab.color,
          stroke: collab.color,
        },
        avatarUrl: collab.avatarUrl,
        selectedElementIds: (collab.selectedElementIds || []).reduce((acc, id) => ({ ...acc, [id]: true }), {}),
      })
    }

    return map
  }, [activeCollaborators])

  // Sync collaborators into Excalidraw's canvas renderer
  useEffect(() => {
    if (!apiRef.current) return
    apiRef.current.updateScene({
      collaborators: excalidrawCollaborators as any,
    })
  }, [excalidrawCollaborators, apiRef])

  // 5. Throttled Pointer / Cursor broadcasting
  const onPointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number }; button: 'down' | 'up' }) => {
      if (!enabled || !collabUser) return

      const now = Date.now()
      pendingPointerRef.current = payload.pointer

      if (now - lastPointerBroadcastRef.current >= 33) {
        lastPointerBroadcastRef.current = now
        const selectedIds = Object.keys(appStateRef.current.selectedElementIds || {})
        void collabServiceRef.current.updatePresence(boardId, collabUser.sessionId, payload.pointer, selectedIds)
      } else if (!pointerTimerRef.current) {
        pointerTimerRef.current = window.setTimeout(() => {
          pointerTimerRef.current = null
          if (!pendingPointerRef.current || !collabUser) return
          lastPointerBroadcastRef.current = Date.now()
          const selectedIds = Object.keys(appStateRef.current.selectedElementIds || {})
          void collabServiceRef.current.updatePresence(
            boardId,
            collabUser.sessionId,
            pendingPointerRef.current,
            selectedIds,
          )
        }, 33)
      }
    },
    [enabled, collabUser, isReadOnly, boardId, appStateRef],
  )

  // 6. Broadcast local changes (called from Excalidraw onChange)
  const broadcastChanges = useCallback(
    (currentElements: readonly any[]) => {
      if (!enabled || !collabUser || isReadOnly) return

      const changedElements: any[] = []
      const known = knownElementVersionsRef.current

      for (const elem of currentElements) {
        if (!elem || !elem.id) continue
        const prev = known.get(elem.id)
        if (!prev || elem.version > prev.version) {
          changedElements.push(elem)
          known.set(elem.id, { version: Number(elem.version ?? 1), versionNonce: Number(elem.versionNonce ?? 0) })
        }
      }

      if (changedElements.length > 0) {
        // Tag with author UID and broadcast
        void collabServiceRef.current.broadcastElementDeltas(boardId, changedElements, collabUser.uid)
      }
    },
    [enabled, collabUser, isReadOnly, boardId],
  )

  // 7. Scoped Undo for current user: records history snapshot
  const recordUserAction = useCallback(
    (previousElements: any[]) => {
      if (!collabUser) return
      userUndoStackRef.current.push(previousElements)
      userRedoStackRef.current = [] // clear redo stack on new action
    },
    [collabUser],
  )

  // 8. User-Scoped Undo: only rolls back mutations authored by the current user
  const performScopedUndo = useCallback(() => {
    if (!collabUser || userUndoStackRef.current.length === 0) return null
    const priorState = userUndoStackRef.current.pop()
    if (!priorState) return null

    const currentScene = [...(apiRef.current ? apiRef.current.getSceneElements() : elementsRef.current)]
    userRedoStackRef.current.push(currentScene)

    // Roll back elements authored by current user
    const updated = currentScene.map((el: any) => {
      const priorEl = priorState.find((p: any) => p.id === el.id)
      if (priorEl && (el.lastModifiedBy === collabUser.uid || priorEl.lastModifiedBy === collabUser.uid)) {
        return { ...priorEl, version: (el.version || 1) + 1, versionNonce: Date.now() % 1000000 }
      }
      return el
    })

    // If an element was created in this action (not in priorState), mark it deleted
    for (const el of currentScene) {
      if (!priorState.some((p: any) => p.id === el.id) && el.lastModifiedBy === collabUser.uid) {
        const idx = updated.findIndex((u: any) => u.id === el.id)
        if (idx !== -1) {
          updated[idx] = {
            ...updated[idx],
            isDeleted: true,
            version: (updated[idx].version || 1) + 1,
            versionNonce: Date.now() % 1000000,
          }
        }
      }
    }

    elementsRef.current = updated
    apiRef.current?.updateScene({ elements: updated })
    broadcastChanges(updated)
    return updated
  }, [collabUser, apiRef, elementsRef, broadcastChanges])

  if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;(window as any).__collab = {
      collabUser,
      activeCollaborators,
      excalidrawCollaborators,
      service: collabServiceRef.current,
      broadcastChanges,
      userUndoStack: userUndoStackRef.current,
      userRedoStack: userRedoStackRef.current,
      recordUserAction,
      performScopedUndo,
      simulateSleepWipe: async (bid: string) => {
        const rtdb = getFirebaseRtdb()
        if (rtdb && collabUser?.sessionId) {
          const { ref, remove } = await import('firebase/database')
          await remove(ref(rtdb, `presence/${bid}/${collabUser.sessionId}`))
        }
      },
    }
  }

  return {
    collabUser,
    activeCollaborators,
    excalidrawCollaborators,
    onPointerUpdate,
    broadcastChanges,
    recordUserAction,
    performScopedUndo,
  }
}
