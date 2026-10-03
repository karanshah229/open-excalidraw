import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { Collaborator } from '@excalidraw/excalidraw/types'
import { reconcileElements } from '@excalidraw/excalidraw'
import { type User } from 'firebase/auth'
import { getFirebaseAuth, getFirebaseRtdb, getFirebaseStorage } from '../../lib/firebase'
import { ensureAuthenticatedUser, generateSessionId, resolveCollabUser, getAnonymousProfile } from './anonymous-user'
import {
  CollaborationService,
  applyDeltaPatch,
  computeSessionEditorStatus,
  haveElementPropertiesChanged,
  isValidExcalidrawElement,
} from './collaboration-service'
import type { CollaboratorPresence, CollabUser } from './types'

export interface UseCollaborationOptions {
  boardId: string
  enabled: boolean
  sessionId?: string
  authUser?: User | null
  isAuthLoading?: boolean
  isReadOnly: boolean
  apiRef: React.RefObject<ExcalidrawImperativeAPI | null>
  elementsRef: React.MutableRefObject<any[]>
  appStateRef: React.MutableRefObject<Record<string, unknown>>
}

export function getFullSceneElements(
  api: ExcalidrawImperativeAPI | null | undefined,
  fallback: readonly any[] = [],
): any[] {
  if (!api) return [...fallback]
  if (typeof (api as any).getSceneElementsIncludingDeleted === 'function') {
    return [...(api as any).getSceneElementsIncludingDeleted()]
  }
  return [...api.getSceneElements()]
}

export function useCollaboration({
  boardId,
  enabled,
  sessionId,
  authUser,
  isAuthLoading,
  isReadOnly,
  apiRef,
  elementsRef,
  appStateRef,
}: UseCollaborationOptions) {
  // Session ID stays fixed for the lifetime of this tab
  const sessionIdRef = useRef<string>(sessionId || generateSessionId())
  const sessionJoinedAtRef = useRef<number>(Date.now())

  const [collabUser, setCollabUser] = useState<CollabUser>(() => {
    const sid = sessionIdRef.current
    if (authUser) {
      const resolved = resolveCollabUser(authUser, sid)
      return { ...resolved, joinedAt: sessionJoinedAtRef.current }
    }
    const profile = getAnonymousProfile(sid)
    return {
      uid: sid,
      sessionId: sid,
      displayName: profile.displayName,
      color: profile.color,
      isAnonymous: true,
      joinedAt: sessionJoinedAtRef.current,
    }
  })
  const [activeCollaborators, setActiveCollaborators] = useState<CollaboratorPresence[]>([])
  const collabUserRef = useRef(collabUser)
  collabUserRef.current = collabUser

  // Task 4: Spectator mode calculation (capped at 10 active editors)
  const { isEditor, editorCount, totalCount } = useMemo(() => {
    return computeSessionEditorStatus(activeCollaborators, sessionIdRef.current, sessionJoinedAtRef.current, 10)
  }, [activeCollaborators])
  const isSpectator = !isEditor
  const isSpectatorRef = useRef(isSpectator)
  isSpectatorRef.current = isSpectator

  // Collaboration service singleton ref
  const collabServiceRef = useRef<CollaborationService>(new CollaborationService())

  // Keep track of known element versions to only broadcast actual deltas
  const knownElementVersionsRef = useRef<Map<string, { version: number; versionNonce: number }>>(new Map())

  // Task 2 & 3: Dragging pixel storm suppression & delta patch baselines
  const isDraggingRef = useRef<boolean>(false)
  const pendingDragElementsRef = useRef<Map<string, any>>(new Map())
  const lastBroadcastElementsRef = useRef<Map<string, any>>(new Map())
  const seededBoardIdRef = useRef<string | null>(null)

  // Seed known element versions and snapshot baselines from initial elements
  useEffect(() => {
    const sourceElements = apiRef.current?.getSceneElementsIncludingDeleted() || elementsRef.current || []
    if (sourceElements && sourceElements.length > 0) {
      for (const elem of sourceElements) {
        if (elem?.id) {
          const existing = knownElementVersionsRef.current.get(elem.id)
          const elemVersion = Number(elem.version ?? 1)
          if (!existing || elemVersion >= existing.version) {
            knownElementVersionsRef.current.set(elem.id, {
              version: elemVersion,
              versionNonce: Number(elem.versionNonce ?? 0),
            })
          }
          lastBroadcastElementsRef.current.set(elem.id, { ...elem })
        }
      }
    }
  }, [enabled, elementsRef, apiRef])

  // Throttling pointer updates (max 30 updates per second / 33ms)
  const lastPointerBroadcastRef = useRef<number>(0)
  const pendingPointerRef = useRef<{ x: number; y: number } | null>(null)
  const pointerTimerRef = useRef<number | null>(null)
  const idlePointerTimerRef = useRef<number | null>(null)

  const [isAuthReady, setIsAuthReady] = useState(false)

  // Initialize the collaboration service. The shared RTDB client must remain
  // online in solo mode so the connection-owned active-session lobby can
  // discover a second participant.
  useEffect(() => {
    const rtdb = getFirebaseRtdb()
    const storage = getFirebaseStorage()
    if (rtdb) {
      collabServiceRef.current.setDatabase(rtdb)
    }
    if (storage) collabServiceRef.current.setStorage(storage)
  }, [])

  // The active-session lobby also uses this RTDB client. Never call goOffline
  // while collaboration is lazy-disabled: that would disconnect the very
  // connection whose session record is needed to detect a second participant.
  // Scene/presence listeners are independently attached only when `enabled`.
  useEffect(() => {
    if (enabled) {
      collabServiceRef.current.goOnline()
    }
  }, [enabled])

  // 1. Maintain authenticated user identity (Google or Anonymous fallback)
  useEffect(() => {
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
  }, [authUser, isAuthLoading])

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
      setActiveCollaborators([])
    }
  }, [enabled, collabUser, boardId, isAuthReady])

  // 3. Subscribe to remote element deltas and reconcile
  useEffect(() => {
    if (!enabled || !boardId || !isAuthReady) return

    const service = collabServiceRef.current
    const unsubElements = service.subscribeToElements(boardId, (remotePatch, meta) => {
      if (!remotePatch || !remotePatch.id) return

      // Don't reconcile if we already have this exact version or newer
      const known = knownElementVersionsRef.current.get(remotePatch.id)
      if (known) {
        if (remotePatch.version < known.version) return
        // Align with Excalidraw engine standard: lowest versionNonce wins deterministic tie-break
        if (remotePatch.version === known.version && remotePatch.versionNonce >= known.versionNonce) {
          if (known.versionNonce < remotePatch.versionNonce) {
            const localList = getFullSceneElements(apiRef.current, elementsRef.current)
            const localEl = localList.find((e: any) => e.id === remotePatch.id)
            const cu = collabUserRef.current
            if (localEl && cu && !isSpectatorRef.current) {
              void service.broadcastElementDeltas(boardId, [localEl], cu.uid)
            }
          }
          return
        }
      }

      knownElementVersionsRef.current.set(remotePatch.id, {
        version: remotePatch.version,
        versionNonce: remotePatch.versionNonce,
      })

      // Task 3: Merge incoming patch over existing local element (including tombstones)
      const local = getFullSceneElements(apiRef.current, elementsRef.current)
      const existingEl = local.find((e: any) => e.id === remotePatch.id)

      // Guard: If element is not in local scene, reject if it's an incomplete delta patch
      if (!existingEl && !isValidExcalidrawElement(remotePatch)) {
        return
      }

      const mergedElement = { ...applyDeltaPatch(existingEl, remotePatch), lastModifiedBy: meta.lastModifiedBy }
      if (!isValidExcalidrawElement(mergedElement)) {
        return
      }

      // Cache merged element for subsequent local patch comparisons
      lastBroadcastElementsRef.current.set(mergedElement.id, { ...mergedElement })

      // Reconcile with live scene elements using Excalidraw's engine
      const appState = appStateRef.current
      const reconciled = reconcileElements(local, [mergedElement], appState as any)

      elementsRef.current = reconciled
      // Remote state is authoritative for rendering but must never become a
      // local undo/redo entry in Excalidraw's multiplayer history.
      apiRef.current?.updateScene({ elements: reconciled, captureUpdate: 'NEVER' })
    })

    return () => {
      unsubElements()
    }
  }, [enabled, boardId, isAuthReady, elementsRef, appStateRef, apiRef])

  // A late joiner may start from a Firestore snapshot that predates this live
  // room. Seed full elements once per room entry so RTDB never contains only a
  // delta patch for an element the joiner has not seen before.
  useEffect(() => {
    if (!enabled) {
      seededBoardIdRef.current = null
      return
    }
    if (!isAuthReady || !collabUser || isSpectatorRef.current || seededBoardIdRef.current === boardId) return

    const scene = getFullSceneElements(apiRef.current, elementsRef.current)
    seededBoardIdRef.current = boardId
    if (scene.length > 0) {
      void collabServiceRef.current.broadcastElementDeltas(boardId, scene, collabUser.uid)
    }
  }, [enabled, isAuthReady, collabUser, boardId, apiRef, elementsRef])

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

  // Task 2: Commit pending drag elements on pointerUp / drag completion
  const commitPendingDrag = useCallback(() => {
    if (pendingDragElementsRef.current.size === 0 || !collabUserRef.current || isSpectatorRef.current || isReadOnly) {
      return
    }
    const pending = Array.from(pendingDragElementsRef.current.values())
    pendingDragElementsRef.current.clear()
    void collabServiceRef.current.broadcastElementDeltas(
      boardId,
      pending,
      collabUserRef.current.uid,
      lastBroadcastElementsRef.current,
    )
    for (const elem of pending) {
      lastBroadcastElementsRef.current.set(elem.id, { ...elem })
    }
  }, [boardId, isReadOnly])

  // Global window pointerup to catch drag release outside canvas
  useEffect(() => {
    const handleGlobalPointerUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        commitPendingDrag()
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerup', handleGlobalPointerUp)
      window.addEventListener('mouseup', handleGlobalPointerUp)
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointerup', handleGlobalPointerUp)
        window.removeEventListener('mouseup', handleGlobalPointerUp)
      }
    }
  }, [commitPendingDrag])

  // 5. Throttled Pointer / Cursor broadcasting & Drag State Tracking
  const clearCursor = useCallback(() => {
    if (!enabled || !collabUserRef.current || !boardId) return
    if (pointerTimerRef.current) {
      window.clearTimeout(pointerTimerRef.current)
      pointerTimerRef.current = null
    }
    if (idlePointerTimerRef.current) {
      window.clearTimeout(idlePointerTimerRef.current)
      idlePointerTimerRef.current = null
    }
    pendingPointerRef.current = null
    const selectedIds = Object.keys(appStateRef.current.selectedElementIds || {})
    void collabServiceRef.current.updatePresence(boardId, collabUserRef.current.sessionId, null, selectedIds)
  }, [enabled, boardId, appStateRef])

  // Clear cursor on window blur, mouse leaving viewport, or tab visibility hidden
  useEffect(() => {
    if (!enabled || !collabUser) return

    const handleWindowBlur = () => {
      clearCursor()
    }

    const handleMouseLeave = (e: MouseEvent) => {
      if (!e.relatedTarget) {
        clearCursor()
      }
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearCursor()
      }
    }

    window.addEventListener('blur', handleWindowBlur)
    document.addEventListener('mouseleave', handleMouseLeave)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.removeEventListener('blur', handleWindowBlur)
      document.removeEventListener('mouseleave', handleMouseLeave)
      document.removeEventListener('visibilitychange', handleVisibility)
      if (idlePointerTimerRef.current) {
        window.clearTimeout(idlePointerTimerRef.current)
        idlePointerTimerRef.current = null
      }
    }
  }, [enabled, collabUser, clearCursor])

  const onPointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number }; button: 'down' | 'up' }) => {
      if (!enabled || !collabUser) return
      if (!payload.pointer || !Number.isFinite(payload.pointer.x) || !Number.isFinite(payload.pointer.y)) {
        return
      }

      // Spectators do not broadcast cursor/presence packets
      if (isSpectatorRef.current) return

      if (payload.button === 'down') {
        isDraggingRef.current = true
      } else if (payload.button === 'up') {
        const wasDragging = isDraggingRef.current
        isDraggingRef.current = false
        if (wasDragging) {
          commitPendingDrag()
        }
      }

      // Reset idle timer: if user doesn't move mouse on canvas for 8 seconds, clear cursor
      if (idlePointerTimerRef.current) {
        window.clearTimeout(idlePointerTimerRef.current)
      }
      idlePointerTimerRef.current = window.setTimeout(clearCursor, 8000)

      const now = Date.now()
      pendingPointerRef.current = payload.pointer

      if (now - lastPointerBroadcastRef.current >= 100) {
        lastPointerBroadcastRef.current = now
        const selectedIds = Object.keys(appStateRef.current.selectedElementIds || {})
        void collabServiceRef.current.updatePresence(boardId, collabUser.sessionId, payload.pointer, selectedIds)
      } else if (!pointerTimerRef.current) {
        pointerTimerRef.current = window.setTimeout(() => {
          pointerTimerRef.current = null
          if (!pendingPointerRef.current || !collabUser || isSpectatorRef.current) return
          lastPointerBroadcastRef.current = Date.now()
          const selectedIds = Object.keys(appStateRef.current.selectedElementIds || {})
          void collabServiceRef.current.updatePresence(
            boardId,
            collabUser.sessionId,
            pendingPointerRef.current,
            selectedIds,
          )
        }, 100)
      }
    },
    [enabled, collabUser, boardId, appStateRef, commitPendingDrag, clearCursor],
  )

  // 6. Broadcast local changes (called from Excalidraw onChange)
  const broadcastChanges = useCallback(
    (currentElements: readonly any[]) => {
      if (!enabled || !collabUser || isReadOnly || isSpectatorRef.current) {
        // Even when dormant (solo mode), track latest element snapshots and versions
        // so that when collaboration activates, our baseline is 100% accurate and
        // subsequent local edits, undos, or redos detect accurate deltas.
        for (const elem of currentElements) {
          if (!elem || !elem.id) continue
          const existing = knownElementVersionsRef.current.get(elem.id)
          const elemVersion = Number(elem.version ?? 1)
          if (!existing || elemVersion >= existing.version) {
            knownElementVersionsRef.current.set(elem.id, {
              version: elemVersion,
              versionNonce: Number(elem.versionNonce ?? 0),
            })
          }
          lastBroadcastElementsRef.current.set(elem.id, { ...elem })
        }
        return
      }

      const changedElements: any[] = []
      const known = knownElementVersionsRef.current
      let hasVersionBumps = false

      for (const elem of currentElements) {
        if (!elem || !elem.id) continue
        const prev = known.get(elem.id)
        const last = lastBroadcastElementsRef.current.get(elem.id)

        const isForwardVersion =
          !prev ||
          elem.version > prev.version ||
          (elem.version === prev.version && elem.versionNonce !== prev.versionNonce)

        if (isForwardVersion) {
          changedElements.push(elem)
          known.set(elem.id, { version: Number(elem.version ?? 1), versionNonce: Number(elem.versionNonce ?? 0) })
        } else if (last) {
          // Detect if an element was resurrected or reverted locally (e.g. via Undo)
          // where Excalidraw restored an older or matching version number
          const isResurrected = Boolean(last.isDeleted) && !elem.isDeleted
          const hasStateChanged = haveElementPropertiesChanged(last, elem)

          if (isResurrected || hasStateChanged) {
            const bumpedVersion = Math.max(Number(elem.version ?? 1), Number(prev?.version ?? 1)) + 1
            const bumpedNonce = Math.floor(Math.random() * 1000000)
            const bumpedElem = { ...elem, version: bumpedVersion, versionNonce: bumpedNonce }
            changedElements.push(bumpedElem)
            known.set(elem.id, { version: bumpedVersion, versionNonce: bumpedNonce })
            hasVersionBumps = true
          }
        }
      }

      if (hasVersionBumps && apiRef.current) {
        // Keep Excalidraw's internal scene elements in sync with the bumped versions
        const fullScene = getFullSceneElements(apiRef.current, elementsRef.current)
        const updatedScene = fullScene.map((el) => {
          const bumped = changedElements.find((b) => b.id === el.id)
          return bumped || el
        })

        // `updateScene()` can synchronously re-enter Excalidraw's onChange.
        // Establish the new baseline first, otherwise that nested onChange sees
        // the same mutation against the old baseline, bumps it again, and loops.
        for (const element of changedElements) {
          lastBroadcastElementsRef.current.set(element.id, { ...element })
        }
        elementsRef.current = updatedScene
        apiRef.current.updateScene({ elements: updatedScene, captureUpdate: 'NEVER' })
      }

      if (changedElements.length > 0) {
        const authoredChanges = changedElements.map((element) => ({ ...element, lastModifiedBy: collabUser.uid }))
        if (isDraggingRef.current) {
          // Task 2: Suppress RTDB element write storm during active drag.
          // Buffer latest mutated elements for atomic commit on pointerUp.
          for (const elem of authoredChanges) {
            pendingDragElementsRef.current.set(elem.id, elem)
          }
        } else {
          // Task 3: Broadcast stripped delta patches against previous known state
          void collabServiceRef.current.broadcastElementDeltas(
            boardId,
            authoredChanges,
            collabUser.uid,
            lastBroadcastElementsRef.current,
          )
          for (const elem of authoredChanges) {
            lastBroadcastElementsRef.current.set(elem.id, { ...elem })
          }
        }
      }
    },
    [enabled, collabUser, isReadOnly, boardId, apiRef, elementsRef],
  )

  if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;(window as any).__collab = {
      collabUser,
      activeCollaborators,
      excalidrawCollaborators,
      service: collabServiceRef.current,
      broadcastChanges,
      isEditor,
      isSpectator,
      editorCount,
      totalCount,
      commitPendingDrag,
      isDraggingRef,
      pendingDragElementsRef,
      lastBroadcastElementsRef,
      simulateSleepWipe: async (bid: string) => {
        const rtdb = getFirebaseRtdb()
        const sid = collabUserRef.current?.sessionId
        if (rtdb && sid) {
          const { ref, remove } = await import('firebase/database')
          await remove(ref(rtdb, `presence/${bid}/${sid}`))
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
    isEditor,
    isSpectator,
    editorCount,
    totalCollaboratorCount: totalCount,
    sessionId: sessionIdRef.current,
    commitPendingDrag,
    isDraggingRef,
    pendingDragElementsRef,
    lastBroadcastElementsRef,
    clearBoardElements: useCallback((bid: string) => collabServiceRef.current.clearBoardElements(bid), []),
  }
}
