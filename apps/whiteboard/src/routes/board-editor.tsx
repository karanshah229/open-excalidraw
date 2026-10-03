import { AccessDenied } from '../components/access-denied'
import { useCallback, useEffect, useRef, useState } from 'react'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useParams, useBlocker } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Eye, Loader2, Pencil, Share2 } from 'lucide-react'
import { convertToExcalidrawElements, Excalidraw, MainMenu, exportToSvg } from '@excalidraw/excalidraw'
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { BoardDocument, BoardScene, BoardSyncStatus } from '@agentic-whiteboard/storage'
import { workspaceApi } from '../features/workspace/workspace-api'
import {
  generateArchitecturalTemplate,
  computeAutoLayout,
  type ArchitectureTemplateType,
} from '../features/mcp-bridge/mcp-operations'
import { useTheme } from '../lib/theme-context'
import { useAuth } from '../lib/auth-context'
import { BoardInfoDropdown } from '../components/board-info-dropdown'
import { SyncStatusDropdown } from '../components/sync-status-dropdown'
import { ShareModal } from '../components/share-modal'
import { sharingService } from '../features/sharing/sharing-service'
import {
  useCollaboration,
  CollaboratorBar,
  ensureAuthenticatedUser,
  generateSessionId,
  type ActiveSessionRecord,
} from '../features/collaboration'
import { reconcileElementsLWW } from '../features/collaboration/reconcile'
import { getFirebaseAuth, getFirestoreDb, isFirebaseConfigured } from '../lib/firebase'

const LIBRARY_STORAGE_KEY = 'agentic-whiteboard:library:v1'
const starterLibraries = [
  'https://libraries.excalidraw.com/libraries/youritjang/software-architecture.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/rohanp/system-design.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/childishgirl/aws-architecture-icons.excalidrawlib',
]

type EditorStatus =
  'Loading board' | 'Saving' | 'Synced locally' | 'Synced' | 'Sync failed' | 'Conflict' | 'Local save failed'
const statusLabel = (status: BoardSyncStatus): EditorStatus => {
  if (status === 'local-only') return 'Synced locally'
  if (status === 'synced') return 'Synced'
  if (status === 'conflict') return 'Conflict'
  return 'Sync failed'
}

async function loadLibraryItems() {
  try {
    const saved = localStorage.getItem(LIBRARY_STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch {
    /* storage may be unavailable */
  }
  const libraries = await Promise.all(
    starterLibraries.map(async (url) => {
      try {
        const response = await fetch(url)
        const library = response.ok ? await response.json() : {}
        return library.libraryItems ?? library.library ?? []
      } catch {
        return []
      }
    }),
  )
  return libraries.flat()
}

function getCanvasOffsets(width?: number, height?: number) {
  const w = width && width > 0 ? width : typeof window !== 'undefined' ? window.innerWidth : 1200
  const h = height && height > 0 ? height : typeof window !== 'undefined' ? window.innerHeight - 51 : 800
  const horizontal = Math.min(120, Math.max(64, Math.round(w * 0.08)))
  const vertical = Math.min(100, Math.max(64, Math.round(h * 0.08)))
  return {
    top: vertical + 40,
    bottom: vertical + 20,
    left: horizontal + 24,
    right: horizontal,
  }
}

function getFilenameWithExtension(name: string): string {
  const trimmed = (name || 'Untitled').trim()
  return trimmed.toLowerCase().endsWith('.excalidraw') ? trimmed : `${trimmed}.excalidraw`
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* clipboard unavailable or denied */
  }

  try {
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.style.position = 'fixed'
    textArea.style.left = '-9999px'
    textArea.style.top = '0'
    textArea.setAttribute('readonly', '')
    document.body.appendChild(textArea)
    textArea.select()
    const successful = document.execCommand('copy')
    document.body.removeChild(textArea)
    return successful
  } catch {
    return false
  }
}

function getSceneSignature(
  scene?: { elements?: readonly any[]; appState?: any; files?: BoardScene['files'] } | null,
): string {
  if (!scene) return ''
  const normalizedAppState = {
    theme: scene.appState?.theme,
    viewBackgroundColor: scene.appState?.viewBackgroundColor,
    gridModeEnabled: scene.appState?.gridModeEnabled,
    objectsSnapModeEnabled: scene.appState?.objectsSnapModeEnabled,
  }
  return JSON.stringify(
    {
      elements: scene.elements || [],
      appState: normalizedAppState,
      // File IDs identify immutable content; avoid serializing image bytes on every change.
      files: Object.keys(scene.files ?? {})
        .sort()
        .map((id) => {
          const file = scene.files![id]
          return [id, file.mimeType, Boolean(file.dataURL)]
        }),
    },
    (key, value) => (key === 'updated' || key === 'versionNonce' ? undefined : value),
  )
}

function prepareInitialElements(elements: readonly any[] = []): any[] {
  if (!elements || elements.length === 0) return []
  const converted = convertToExcalidrawElements(elements as any, { regenerateIds: false })
  const deletedIds = new Set(elements.filter((e) => e?.isDeleted).map((e) => e.id))
  return converted.map((el) => (deletedIds.has(el.id) ? { ...el, isDeleted: true } : el))
}

function createConnectionSessionId(): string {
  // A prior connection's onDisconnect must never remove a session published by
  // a page reload.
  return generateSessionId()
}

export function BoardEditor() {
  const { boardId } = useParams({ from: '/boards/$boardId' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { resolvedTheme } = useTheme()
  const { user: authUser, isLoading: isAuthLoading, signInWithGoogle, signOutUser } = useAuth()
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const documentRef = useRef<BoardDocument | null>(null)
  const elementsRef = useRef<any[]>([])
  const filesRef = useRef<BinaryFiles>({})
  const appStateRef = useRef<Record<string, unknown>>({})
  const socketRef = useRef<WebSocket | null>(null)
  const operationRef = useRef<string | null>(null)
  const saveTimer = useRef<number>()
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const savedSignature = useRef<string>()
  const committedSignatureRef = useRef<string>()
  const pendingSceneRef = useRef<BoardScene | null>(null)
  const awaitingInitialSceneRef = useRef(true)
  const hasAutoZoomedRef = useRef(false)
  const userHasInteractedRef = useRef(false)
  const [state, setState] = useState<EditorStatus>('Loading board')

  useEffect(() => {
    userHasInteractedRef.current = false
    hasAutoZoomedRef.current = false
  }, [boardId])

  useEffect(() => {
    const handleUserInteraction = () => {
      userHasInteractedRef.current = true
    }
    window.addEventListener('pointerdown', handleUserInteraction, { capture: true })
    window.addEventListener('keydown', handleUserInteraction, { capture: true })
    window.addEventListener('drop', handleUserInteraction, { capture: true })
    window.addEventListener('paste', handleUserInteraction, { capture: true })
    return () => {
      window.removeEventListener('pointerdown', handleUserInteraction, { capture: true })
      window.removeEventListener('keydown', handleUserInteraction, { capture: true })
      window.removeEventListener('drop', handleUserInteraction, { capture: true })
      window.removeEventListener('paste', handleUserInteraction, { capture: true })
    }
  }, [boardId])

  const zoomToContentWithPadding = useCallback(
    (api: ExcalidrawImperativeAPI, elements?: readonly any[], animate = false): boolean => {
      const targetElements = (elements ?? api.getSceneElements()).filter((e) => !e.isDeleted)
      if (targetElements.length === 0) return false
      const appState = api.getAppState()
      // Guard: must have positive container dimensions measured by the DOM
      if (!appState.width || !appState.height || appState.width <= 100 || appState.height <= 100) {
        return false
      }
      const offsets = getCanvasOffsets(appState.width, appState.height)
      api.scrollToContent(targetElements, {
        fitToContent: true,
        animate,
        maxZoom: 1,
        canvasOffsets: offsets,
      })
      return true
    },
    [],
  )

  const triggerAutoCenter = useCallback(() => {
    if (hasAutoZoomedRef.current) return
    let attempts = 0
    const checkAndZoom = () => {
      if (hasAutoZoomedRef.current) return
      const api = apiRef.current
      if (!api) {
        if (attempts++ < 100) setTimeout(checkAndZoom, 40)
        return
      }
      const sceneElements = api.getSceneElements().filter((e: any) => !e.isDeleted)
      const appState = api.getAppState()
      if (
        sceneElements.length === 0 ||
        !appState.width ||
        !appState.height ||
        appState.width <= 100 ||
        appState.height <= 100
      ) {
        if (attempts++ < 100) setTimeout(checkAndZoom, 40)
        return
      }

      zoomToContentWithPadding(api, sceneElements, false)

      // Excalidraw state updates asynchronously. Verify on next tick that the
      // canvas has scrolled away from the default un-centered (0, 0) origin.
      setTimeout(() => {
        if (hasAutoZoomedRef.current) return
        const nextState = api.getAppState()
        if (nextState.scrollX === 0 && nextState.scrollY === 0 && sceneElements.length > 0) {
          if (attempts++ < 100) {
            setTimeout(checkAndZoom, 40)
          }
          return
        }
        hasAutoZoomedRef.current = true
      }, 50)
    }
    checkAndZoom()
  }, [zoomToContentWithPadding])
  const [isReadOnly, setIsReadOnly] = useState(false)
  const [isSharedBoard, setIsSharedBoard] = useState(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const accessDeniedRef = useRef(accessDenied)
  accessDeniedRef.current = accessDenied
  const [boardNotFound, setBoardNotFound] = useState(false)
  const [activeSessions, setActiveSessions] = useState<ActiveSessionRecord[]>([])

  // Per-page connection ID shared across RTDB activeSessions and presence.
  const sessionIdRef = useRef<string>(createConnectionSessionId())

  // Task 1: Register active session when board is open (1 write on open, 1 on close)
  useEffect(() => {
    if (!boardId || !isSharedBoard || accessDenied || boardNotFound) return
    let cancelled = false
    let cleanupSession: (() => void) | undefined
    void (async () => {
      const auth = getFirebaseAuth()
      const user = authUser ?? auth?.currentUser ?? (auth ? await ensureAuthenticatedUser(auth) : null)
      if (!user || cancelled) return
      const cleanup = await sharingService.registerActiveSession(boardId, sessionIdRef.current, user.uid)
      if (cancelled) cleanup()
      else cleanupSession = cleanup
    })()
    return () => {
      cancelled = true
      if (cleanupSession) cleanupSession()
    }
  }, [boardId, isSharedBoard, authUser?.uid, accessDenied, boardNotFound])

  // Task 1: Subscribe to active sessions on the board
  useEffect(() => {
    if (!boardId || !isSharedBoard || accessDenied || boardNotFound) {
      setActiveSessions([])
      return
    }
    return sharingService.subscribeToActiveSessions(boardId, (sessions) => {
      setActiveSessions(sessions)
    })
  }, [boardId, isSharedBoard, accessDenied, boardNotFound])

  // Lazy collab triggers when 2 or more active editor sessions are detected on the board
  const isLazyCollabActive = Boolean(activeSessions.length >= 2)
  const isLazyCollabActiveRef = useRef(isLazyCollabActive)
  isLazyCollabActiveRef.current = isLazyCollabActive
  const [isTransitioningCollab, setIsTransitioningCollab] = useState(false)
  const { activeCollaborators, onPointerUpdate, broadcastChanges, isSpectator } = useCollaboration({
    boardId,
    enabled: Boolean(
      isFirebaseConfigured && isSharedBoard && boardId && !accessDenied && !boardNotFound && isLazyCollabActive,
    ),
    sessionId: sessionIdRef.current,
    authUser,
    isAuthLoading,
    isReadOnly: isReadOnly || isTransitioningCollab,
    apiRef,
    elementsRef,
    appStateRef,
  })

  if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;(window as any).__lazyCollab = {
      isLazyCollabActive,
      isTransitioningCollab,
      activeSessions,
      activeCollaborators,
    }
  }

  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const lastUserEmailRef = useRef<string | null>(null)
  if (authUser?.email) {
    lastUserEmailRef.current = authUser.email
  }

  const handleSwitchAccount = useCallback(async () => {
    if (isSwitchingAccount) return
    setIsSwitchingAccount(true)
    try {
      await signOutUser()
      await navigate({ to: '/' })
    } catch (err) {
      console.error('Failed to switch account:', err)
      setIsSwitchingAccount(false)
    }
  }, [isSwitchingAccount, signOutUser, navigate])

  const handleSignIn = useCallback(async () => {
    if (isSigningIn) return
    setIsSigningIn(true)
    try {
      await signInWithGoogle()
    } finally {
      setIsSigningIn(false)
    }
  }, [isSigningIn, signInWithGoogle])

  const [isShareModalOpen, setIsShareModalOpen] = useState(false)
  const [isCopyingBoard, setIsCopyingBoard] = useState(false)
  const [boardMeta, setBoardMeta] = useState<{
    boardName: string
    projectId: string
    projectName: string
    projectOwnerId?: string
    projectOwnerName?: string
    projectOwnerEmail?: string
    createdAt?: string
    updatedAt?: string
  } | null>(null)
  const [isEditingName, setIsEditingName] = useState(false)
  const [tempName, setTempName] = useState('')
  const [copiedFilename, setCopiedFilename] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const handleCopyFilename = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!boardMeta?.boardName) return
      const filename = getFilenameWithExtension(boardMeta.boardName)
      const success = await copyToClipboard(filename)
      if (success) {
        setCopiedFilename(true)
        setTimeout(() => setCopiedFilename(false), 1500)
      }
    },
    [boardMeta?.boardName],
  )

  const startEditingName = useCallback(() => {
    if (!boardMeta || isReadOnly) return
    setTempName(boardMeta.boardName)
    setIsEditingName(true)
    setTimeout(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }, 0)
  }, [boardMeta, isReadOnly])

  const finishEditingName = useCallback(async () => {
    if (!isEditingName || !boardMeta || isReadOnly) return
    setIsEditingName(false)
    const trimmed = tempName.trim() || 'Untitled'
    if (trimmed === boardMeta.boardName) return

    setBoardMeta((prev) => (prev ? { ...prev, boardName: trimmed } : prev))
    if (documentRef.current) {
      documentRef.current = { ...documentRef.current, name: trimmed }
    }
    try {
      const saved = await workspaceApi.renameBoard(boardId, trimmed)
      if (saved) {
        documentRef.current = saved
        setBoardMeta((prev) => (prev ? { ...prev, updatedAt: saved.updatedAt } : prev))
        void sharingService.syncBoardSceneToShare(boardId, saved.scene, trimmed).catch(console.error)
      } else {
        const db = getFirestoreDb()
        if (!db) throw new Error('Cloud board is unavailable.')
        await updateDoc(doc(db, 'boardShares', boardId), { boardName: trimmed, updatedAt: new Date().toISOString() })
      }
      queryClient.invalidateQueries({ queryKey: ['workspace'] })
    } catch {
      setBoardMeta((prev) => (prev ? { ...prev, boardName: boardMeta.boardName } : prev))
      if (documentRef.current) {
        documentRef.current = { ...documentRef.current, name: boardMeta.boardName }
      }
    }
  }, [boardId, boardMeta, isEditingName, isReadOnly, queryClient, tempName])

  const cancelEditingName = useCallback(() => {
    setIsEditingName(false)
    if (boardMeta) setTempName(boardMeta.boardName)
  }, [boardMeta])

  const keepLocalConflict = useCallback(async () => {
    await workspaceApi.keepLocalConflict(boardId)
    queryClient.invalidateQueries({ queryKey: ['workspace'] })
  }, [boardId, queryClient])

  const [, setSlotTick] = useState(0)
  useEffect(() => {
    // Trigger re-render to connect portals once header slots mount or re-mount on auth change
    setSlotTick((t) => t + 1)
  }, [authUser])

  const currentNavSlot = typeof document !== 'undefined' ? document.getElementById('header-nav-slot') : null
  const currentStatusSlot = typeof document !== 'undefined' ? document.getElementById('header-status-slot') : null

  useEffect(() => {
    if (apiRef.current) {
      apiRef.current.updateScene({
        appState: {
          theme: resolvedTheme,
        },
      })
    }
  }, [resolvedTheme])

  const [initialData, setInitialData] = useState<{
    elements: any[]
    appState: any
    files?: BinaryFiles
    libraryItems: Promise<any[]>
    scrollToContent?: boolean
  } | null>(null)

  useEffect(() => {
    hasAutoZoomedRef.current = false
    setInitialData(null)
    documentRef.current = null
    setIsSharedBoard(false)
    setAccessDenied(false)
    setBoardNotFound(false)
    let active = true
    Promise.all([
      workspaceApi.loadBoardWithProject(boardId),
      sharingService.getSharedBoard(boardId, authUser?.email, authUser?.uid),
      loadLibraryItems(),
    ])
      .then(async ([details, shared, libraryItems]) => {
        if (!active) return

        if (shared.status === 'restricted') {
          const isLocalOwner = Boolean(
            details &&
            (!shared.config ||
              shared.config.ownerId === details.project.ownerId ||
              details.project.ownerId === 'local-user'),
          )
          if (!isLocalOwner) {
            setAccessDenied(true)
            return
          }
        }

        // Case 1: Board exists in Firebase (authoritative single source of truth)
        if (shared.status === 'allowed' && shared.config) {
          const config = shared.config
          const db = getFirestoreDb()
          const parent =
            config.projectId && db ? await getDoc(doc(db, 'projectShares', config.projectId)).catch(() => null) : null
          if (!active) return
          const cloudScene = config.scene ?? {
            elements: [],
            appState: { viewBackgroundColor: 'transparent' },
          }

          // If local edits also exist, reconcile elements via LWW
          let finalScene = cloudScene
          if (details?.document?.scene?.elements?.length) {
            const mergedElements = reconcileElementsLWW(details.document.scene.elements, cloudScene.elements ?? [])
            finalScene = {
              ...cloudScene,
              elements: mergedElements,
              files: { ...cloudScene.files, ...details.document.scene.files },
            }
          }

          setIsSharedBoard(true)
          const isOwner = Boolean(
            (authUser?.uid && config.ownerId === authUser.uid) || (config.ownerId === 'local-user' && !authUser),
          )
          const isGeneralEditor = config.generalAccess === 'anyone_with_link' && config.generalRole === 'editor'
          const userEmail = authUser?.email?.trim().toLowerCase()
          const isCollabEditor = Boolean(userEmail && config.collaborators?.[userEmail]?.role === 'editor')
          const canEdit = config.effectiveRole
            ? config.effectiveRole === 'owner' || config.effectiveRole === 'editor'
            : isOwner || isGeneralEditor || isCollabEditor

          setIsReadOnly(!canEdit)
          awaitingInitialSceneRef.current = true
          savedSignature.current = getSceneSignature(finalScene)
          committedSignatureRef.current = savedSignature.current
          filesRef.current = (finalScene.files ?? {}) as BinaryFiles
          elementsRef.current = finalScene.elements
          appStateRef.current = finalScene.appState

          // Update local IndexedDB with authoritative cloud/merged state
          if (details?.document) {
            documentRef.current = details.document
            saveChainRef.current = saveChainRef.current
              .then(async () => {
                const latest = await workspaceApi.loadBoard(details.document.id)
                const docToSave = latest
                  ? { ...latest, name: details.document.name, scene: finalScene }
                  : { ...details.document, scene: finalScene }
                const saved = await workspaceApi.saveBoard(docToSave)
                documentRef.current = saved
              })
              .catch((err) => {
                console.error('Failed to update local board on mount:', err)
              })
          }

          setBoardMeta({
            boardName: config.boardName,
            projectId: details?.project.id ?? config.projectId ?? '',
            projectName: details?.project.name ?? parent?.data()?.name ?? 'Shared board',
            projectOwnerId: config.ownerId,
            projectOwnerName: config.ownerName,
            projectOwnerEmail: config.ownerEmail,
            createdAt: config.createdAt,
            updatedAt: config.updatedAt,
          })

          setInitialData({
            elements: prepareInitialElements(finalScene.elements),
            files: (finalScene.files ?? {}) as BinaryFiles,
            appState: {
              ...finalScene.appState,
              theme: resolvedTheme,
              viewBackgroundColor: finalScene.appState?.viewBackgroundColor || 'transparent',
            },
            libraryItems: Promise.resolve(libraryItems),
          })
          triggerAutoCenter()
          setState('Synced')
          return
        }

        // Case 2: Board only in local IndexedDB (freshly created prior to cloud sync)
        if (details) {
          const { document, project } = details
          // The board read already established that no sharing document exists.
          // Keep this verified default so opening Share needs no second read.
          if (shared.status === 'not-found')
            sharingService.rememberShareConfig(
              {
                boardId: document.id,
                projectId: project.id,
                boardName: document.name,
                ownerId: project.ownerId,
                ownerName: '',
                generalAccess: 'restricted',
                generalRole: 'viewer',
                collaborators: {},
                invitedEmails: [],
                inheritProjectAccess: true,
                createdAt: document.createdAt,
                updatedAt: document.updatedAt,
              },
              authUser?.uid ?? 'local-user',
            )
          documentRef.current = document
          filesRef.current = (document.scene.files ?? {}) as BinaryFiles
          elementsRef.current = document.scene.elements
          appStateRef.current = document.scene.appState
          savedSignature.current = getSceneSignature(document.scene)
          committedSignatureRef.current = savedSignature.current
          awaitingInitialSceneRef.current = true
          setIsReadOnly(false)
          setBoardMeta({
            boardName: document.name,
            projectId: project.id,
            projectName: project.name,
            projectOwnerId: project.ownerId,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
          })

          setInitialData({
            elements: prepareInitialElements(document.scene.elements),
            files: (document.scene.files ?? {}) as BinaryFiles,
            appState: {
              ...document.scene.appState,
              theme: resolvedTheme,
              viewBackgroundColor: document.scene.appState.viewBackgroundColor || 'transparent',
            },
            libraryItems: Promise.resolve(libraryItems),
          })
          triggerAutoCenter()
          setState(statusLabel(document.syncStatus))
          void sharingService.syncBoardSceneToShare(boardId, document.scene, document.name).catch(console.error)
          return
        }

        // Case 3: Board not found in Firebase and not in local IndexedDB
        setBoardNotFound(true)
      })
      .catch(() => active && setState('Local save failed'))
    return () => {
      active = false
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [boardId, authUser?.email, authUser?.uid, resolvedTheme])

  useEffect(() => {
    if (!isSharedBoard) return
    const unsubscribe = sharingService.subscribeToSharedBoard(
      boardId,
      (updatedConfig) => {
        const recoveringAccess = accessDeniedRef.current
        const userEmail = authUser?.email?.trim().toLowerCase()
        const userUid = authUser?.uid
        const stillAllowed =
          Boolean(updatedConfig.effectiveRole) ||
          updatedConfig.generalAccess === 'anyone_with_link' ||
          (userUid && updatedConfig.ownerId === userUid) ||
          (userEmail && updatedConfig.invitedEmails?.map((e) => e.toLowerCase()).includes(userEmail))

        if (!stillAllowed) {
          setAccessDenied(true)
          return
        }

        const isOwner = Boolean(userUid && updatedConfig.ownerId === userUid)
        const isGeneralEditor =
          updatedConfig.generalAccess === 'anyone_with_link' && updatedConfig.generalRole === 'editor'
        const isCollabEditor = Boolean(userEmail && updatedConfig.collaborators?.[userEmail]?.role === 'editor')
        const canEdit = updatedConfig.effectiveRole
          ? updatedConfig.effectiveRole === 'owner' || updatedConfig.effectiveRole === 'editor'
          : isOwner || isGeneralEditor || isCollabEditor
        setIsReadOnly(!canEdit)

        setBoardMeta((prev) =>
          prev
            ? {
                ...prev,
                boardName: updatedConfig.boardName,
                projectOwnerName: updatedConfig.ownerName ?? prev.projectOwnerName,
                projectOwnerEmail: updatedConfig.ownerEmail ?? prev.projectOwnerEmail,
                updatedAt: updatedConfig.updatedAt,
              }
            : prev,
        )

        // Image bytes arrive through durable snapshots even during live element sync.
        if (updatedConfig.scene?.files) {
          filesRef.current = { ...filesRef.current, ...updatedConfig.scene.files } as BinaryFiles
          apiRef.current?.addFiles(Object.values(filesRef.current))
        }
        if (updatedConfig.scene && !pendingSceneRef.current && !isLazyCollabActiveRef.current) {
          // Firestore is a durable snapshot, not an authority allowed to roll
          // back newer local elements. Reconcile per element before rendering.
          const reconciledElements = reconcileElementsLWW(elementsRef.current, updatedConfig.scene.elements ?? [])
          const reconciledScene = {
            ...updatedConfig.scene,
            elements: reconciledElements,
            files: { ...filesRef.current, ...updatedConfig.scene.files },
          }
          const newSignature = getSceneSignature(reconciledScene)
          if (newSignature !== savedSignature.current) {
            savedSignature.current = newSignature
            committedSignatureRef.current = newSignature
            elementsRef.current = reconciledElements
            filesRef.current = (reconciledScene.files ?? {}) as BinaryFiles
            appStateRef.current = updatedConfig.scene.appState
            apiRef.current?.updateScene({
              elements: reconciledElements as any,
            })
          }
        }
        if (recoveringAccess) {
          // The denied view unmounts the canvas. Restore current local elements,
          // including pending edits, rather than its original mount snapshot.
          setInitialData((previous) =>
            previous
              ? {
                  ...previous,
                  elements: prepareInitialElements(elementsRef.current),
                  appState: { ...appStateRef.current, theme: resolvedTheme },
                  files: filesRef.current,
                }
              : previous,
          )
        }
        setAccessDenied(false)
      },
      (error) => {
        if (error?.code === 'permission-denied') {
          setAccessDenied(true)
        }
      },
    )
    return () => unsubscribe()
  }, [boardId, isSharedBoard, authUser?.email, authUser?.uid])

  useEffect(() => {
    if (isReadOnly || isSharedBoard) return
    return workspaceApi.subscribeToBoardSyncStatus(boardId, (status) => setState(statusLabel(status)))
  }, [boardId, isReadOnly, isSharedBoard])

  const sendScene = useCallback(
    (elements = elementsRef.current, operationId?: string, result?: unknown) => {
      if (isReadOnly) return
      if (socketRef.current?.readyState !== WebSocket.OPEN) return
      const selected = appStateRef.current?.selectedElementIds as Record<string, boolean> | undefined
      const selectionIds = selected ? Object.keys(selected).filter((id) => selected[id]) : []
      socketRef.current.send(
        JSON.stringify({
          type: 'scene',
          operationId,
          scene: { elements, appState: appStateRef.current },
          selectionIds,
          result,
        }),
      )
    },
    [isReadOnly],
  )

  const sendOperationResult = useCallback((operationId: string, ok: boolean, data?: unknown, error?: string) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return
    socketRef.current.send(
      JSON.stringify({
        type: 'operation_result',
        operationId,
        ok,
        data,
        error,
      }),
    )
  }, [])

  useEffect(() => {
    if (isReadOnly) return
    let disposed = false
    let retryId: number | undefined
    let retryDelay = 5_000
    let failedAttempts = 0

    const connect = async () => {
      if (disposed) return

      const socket = new WebSocket(import.meta.env.VITE_MCP_BRIDGE_URL ?? 'ws://127.0.0.1:8787')
      socketRef.current = socket
      socket.onopen = () => {
        failedAttempts = 0
        retryDelay = 5_000
        sendScene()
      }
      socket.onmessage = async ({ data }) => {
        const message = JSON.parse(data) as { type?: string; operation?: any }
        if (message.type !== 'operation' || !apiRef.current) return
        userHasInteractedRef.current = true
        const operation = message.operation
        operationRef.current = operation.id
        const wasEmpty = elementsRef.current.length === 0
        let next = elementsRef.current

        if (operation.type === 'add_elements') {
          next = [...next, ...convertToExcalidrawElements(operation.elements, { regenerateIds: true })]
          elementsRef.current = next
          apiRef.current.updateScene({ elements: next })
          sendScene(next, operation.id)
          if (wasEmpty && apiRef.current) {
            requestAnimationFrame(() => {
              zoomToContentWithPadding(apiRef.current!, next, true)
            })
          }
        } else if (operation.type === 'update_elements') {
          const patches = new Map(operation.patches.map((patch: any) => [patch.id, patch.changes]))
          next = next.map((element) =>
            patches.has(element.id) ? { ...element, ...(patches.get(element.id) as Record<string, unknown>) } : element,
          )
          elementsRef.current = next
          apiRef.current.updateScene({ elements: next })
          sendScene(next, operation.id)
        } else if (operation.type === 'delete_elements') {
          const ids = new Set(operation.ids)
          next = next.map((element) => (ids.has(element.id) ? { ...element, isDeleted: true } : element))
          elementsRef.current = next
          apiRef.current.updateScene({ elements: next })
          sendScene(next, operation.id)
        } else if (operation.type === 'clear_canvas') {
          const clearedCount = next.filter((e) => !e.isDeleted).length
          next = next.map((element) => ({ ...element, isDeleted: true }))
          elementsRef.current = next
          apiRef.current.updateScene({ elements: next })
          sendScene(next, operation.id, { ok: true, clearedCount })
        } else if (operation.type === 'set_selection') {
          const ids: string[] = Array.isArray(operation.ids) ? operation.ids : []
          const selectedMap: Record<string, true> = {}
          for (const id of ids) selectedMap[id] = true
          apiRef.current.updateScene({
            appState: {
              selectedElementIds: selectedMap,
            },
          })
          appStateRef.current = {
            ...appStateRef.current,
            selectedElementIds: selectedMap,
          }
          sendOperationResult(operation.id, true, { ok: true, selectedCount: ids.length, selectedIds: ids })
        } else if (operation.type === 'zoom_to_content') {
          const targetIds: string[] | undefined = operation.targetIds
          const animate = Boolean(operation.animate ?? true)
          if (targetIds && targetIds.length > 0) {
            const targetSet = new Set(targetIds)
            const targets = apiRef.current.getSceneElements().filter((e) => targetSet.has(e.id) && !e.isDeleted)
            if (targets.length > 0) {
              const appState = apiRef.current.getAppState()
              const offsets = getCanvasOffsets(appState.width, appState.height)
              apiRef.current.scrollToContent(targets, {
                fitToContent: true,
                animate,
                maxZoom: 1,
                canvasOffsets: offsets,
              })
            }
          } else {
            zoomToContentWithPadding(apiRef.current, undefined, animate)
          }
          sendOperationResult(operation.id, true, { ok: true, message: 'Viewport updated' })
        } else if (operation.type === 'find_elements') {
          const query = (operation.query ?? '').toLowerCase().trim()
          const filterType = operation.elementType ? String(operation.elementType).toLowerCase().trim() : undefined
          const nonDeleted = elementsRef.current.filter((e) => !e.isDeleted)
          const matches = nonDeleted
            .filter((e) => {
              if (filterType && e.type !== filterType) return false
              if (!query) return true
              const idMatch = String(e.id || '')
                .toLowerCase()
                .includes(query)
              const textMatch = typeof e.text === 'string' && e.text.toLowerCase().includes(query)
              const labelMatch =
                e.label && typeof e.label.text === 'string' && e.label.text.toLowerCase().includes(query)
              return idMatch || textMatch || labelMatch
            })
            .map((e) => ({
              id: e.id,
              type: e.type,
              x: e.x,
              y: e.y,
              width: e.width,
              height: e.height,
              text: e.text || e.label?.text || undefined,
              strokeColor: e.strokeColor,
              backgroundColor: e.backgroundColor,
              groupIds: e.groupIds || [],
            }))
          sendOperationResult(operation.id, true, { ok: true, count: matches.length, elements: matches })
        } else if (operation.type === 'group_elements') {
          const ids = new Set<string>(operation.ids || [])
          const newGroupId = `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
          next = next.map((el) => {
            if (ids.has(el.id)) {
              const groupIds = Array.isArray(el.groupIds) ? [...el.groupIds] : []
              if (!groupIds.includes(newGroupId)) groupIds.push(newGroupId)
              return { ...el, groupIds, version: (el.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 1e9) }
            }
            return el
          })
          elementsRef.current = next
          apiRef.current.updateScene({ elements: next })
          sendScene(next, operation.id, { ok: true, groupId: newGroupId, groupedCount: ids.size })
        } else if (operation.type === 'ungroup_elements') {
          const ids = new Set<string>(operation.ids || [])
          const targetGroupId = operation.groupId as string | undefined
          next = next.map((el) => {
            if (
              ids.has(el.id) ||
              (targetGroupId && Array.isArray(el.groupIds) && el.groupIds.includes(targetGroupId))
            ) {
              const groupIds = Array.isArray(el.groupIds)
                ? targetGroupId
                  ? el.groupIds.filter((g: string) => g !== targetGroupId)
                  : []
                : []
              return { ...el, groupIds, version: (el.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 1e9) }
            }
            return el
          })
          elementsRef.current = next
          apiRef.current.updateScene({ elements: next })
          sendScene(next, operation.id, { ok: true, message: 'Elements ungrouped' })
        } else if (operation.type === 'export_image') {
          try {
            const elements = elementsRef.current.filter((e) => !e.isDeleted)
            const svgEl = await exportToSvg({
              elements: elements as any,
              appState: {
                exportBackground: operation.exportBackground ?? true,
                exportWithDarkMode: operation.darkMode ?? resolvedTheme === 'dark',
                theme: resolvedTheme,
              },
              files: filesRef.current,
              exportPadding: operation.exportPadding ?? 16,
              skipInliningFonts: true,
              renderEmbeddables: false,
            })
            sendOperationResult(operation.id, true, {
              ok: true,
              format: 'svg',
              elementCount: elements.length,
              svg: svgEl.outerHTML,
            })
          } catch (err: any) {
            sendOperationResult(operation.id, false, null, err?.message || 'Failed to export SVG')
          }
        } else if (operation.type === 'insert_library_item') {
          const template = operation.template as ArchitectureTemplateType
          const x = typeof operation.x === 'number' ? operation.x : 200
          const y = typeof operation.y === 'number' ? operation.y : 200
          const label = operation.label as string | undefined
          const skeletons = generateArchitecturalTemplate(template, x, y, label)
          const converted = convertToExcalidrawElements(skeletons as any, { regenerateIds: true })
          next = [...next, ...converted]
          elementsRef.current = next
          apiRef.current.updateScene({ elements: next })
          sendScene(next, operation.id, {
            ok: true,
            template,
            insertedCount: converted.length,
            insertedIds: converted.map((e) => e.id),
          })
          requestAnimationFrame(() => {
            zoomToContentWithPadding(apiRef.current!, next, true)
          })
        } else if (operation.type === 'auto_layout') {
          next = computeAutoLayout(next, {
            layout: operation.layout || 'horizontal',
            ids: operation.ids,
            spacing: operation.spacing,
            columns: operation.columns,
            startX: operation.startX,
            startY: operation.startY,
          })
          elementsRef.current = next
          apiRef.current.updateScene({ elements: next })
          sendScene(next, operation.id, { ok: true, layout: operation.layout || 'horizontal' })
          requestAnimationFrame(() => {
            zoomToContentWithPadding(apiRef.current!, next, true)
          })
        } else if (operation.type === 'set_canvas_background') {
          const color = String(operation.color || 'transparent')
          appStateRef.current = {
            ...appStateRef.current,
            viewBackgroundColor: color,
          }
          apiRef.current.updateScene({
            appState: {
              viewBackgroundColor: color,
            },
          })
          sendScene(next, operation.id, { ok: true, viewBackgroundColor: color })
        } else if (operation.type === 'list_projects') {
          try {
            const data = await workspaceApi.listWorkspace()
            sendOperationResult(operation.id, true, {
              ok: true,
              projects: data.projects.map((p) => ({
                id: p.id,
                name: p.name,
                ownerId: p.ownerId,
                createdAt: p.createdAt,
                updatedAt: p.updatedAt,
              })),
            })
          } catch (err: any) {
            sendOperationResult(operation.id, false, null, err?.message || 'Failed to list projects')
          }
        } else if (operation.type === 'list_boards') {
          try {
            const data = await workspaceApi.listWorkspace()
            let boards = data.boards
            if (operation.projectId) {
              boards = boards.filter((b) => b.projectId === operation.projectId)
            }
            sendOperationResult(operation.id, true, {
              ok: true,
              boards: boards.map((b) => ({
                id: b.id,
                name: b.name,
                projectId: b.projectId,
                projectName: b.project?.name,
                updatedAt: b.updatedAt,
                syncStatus: b.syncStatus,
              })),
            })
          } catch (err: any) {
            sendOperationResult(operation.id, false, null, err?.message || 'Failed to list boards')
          }
        } else if (operation.type === 'create_board') {
          try {
            const name = String(operation.name || 'Untitled')
            let projectId = operation.projectId
            if (!projectId) {
              const data = await workspaceApi.listWorkspace()
              projectId = data.projects[0]?.id
              if (!projectId) {
                const proj = await workspaceApi.createProject('General')
                projectId = proj.id
              }
            }
            const newBoard = await workspaceApi.createBoard(projectId, name)
            queryClient.invalidateQueries({ queryKey: ['workspace'] })
            if (operation.openBoard) {
              void navigate({ to: '/boards/$boardId', params: { boardId: newBoard.id } })
            }
            sendOperationResult(operation.id, true, {
              ok: true,
              board: {
                id: newBoard.id,
                name: newBoard.name,
                projectId: newBoard.projectId,
              },
            })
          } catch (err: any) {
            sendOperationResult(operation.id, false, null, err?.message || 'Failed to create board')
          }
        } else if (operation.type === 'rename_board') {
          try {
            const targetBoardId = (operation.boardId as string) || boardId
            const newName = String(operation.name || 'Untitled').trim()
            await workspaceApi.renameBoard(targetBoardId, newName)
            if (targetBoardId === boardId) {
              setBoardMeta((prev) => (prev ? { ...prev, boardName: newName } : prev))
              if (documentRef.current) {
                documentRef.current = { ...documentRef.current, name: newName }
              }
            }
            queryClient.invalidateQueries({ queryKey: ['workspace'] })
            sendOperationResult(operation.id, true, {
              ok: true,
              boardId: targetBoardId,
              name: newName,
            })
          } catch (err: any) {
            sendOperationResult(operation.id, false, null, err?.message || 'Failed to rename board')
          }
        } else if (operation.type === 'switch_board') {
          try {
            const targetBoardId = String(operation.boardId)
            void navigate({ to: '/boards/$boardId', params: { boardId: targetBoardId } })
            sendOperationResult(operation.id, true, { ok: true, boardId: targetBoardId })
          } catch (err: any) {
            sendOperationResult(operation.id, false, null, err?.message || 'Failed to switch board')
          }
        } else if (operation.type === 'get_share_info') {
          try {
            const targetBoardId = (operation.boardId as string) || boardId
            const config = await sharingService.getShareConfig(targetBoardId, {
              boardName: boardMeta?.boardName,
              ownerId: boardMeta?.projectOwnerId,
            })
            const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173'
            sendOperationResult(operation.id, true, {
              ok: true,
              boardId: targetBoardId,
              boardName: config.boardName,
              shareUrl: `${origin}/boards/${targetBoardId}`,
              generalAccess: config.generalAccess,
              generalRole: config.generalRole,
              invitedEmails: config.invitedEmails,
              collaborators: config.collaborators,
            })
          } catch (err: any) {
            sendOperationResult(operation.id, false, null, err?.message || 'Failed to get share info')
          }
        } else if (operation.type === 'share_board') {
          try {
            const targetBoardId = (operation.boardId as string) || boardId
            const currentConfig = await sharingService.getShareConfig(targetBoardId, {
              boardName: boardMeta?.boardName,
              ownerId: boardMeta?.projectOwnerId,
            })
            const updated = {
              ...currentConfig,
              generalAccess: operation.generalAccess ?? currentConfig.generalAccess,
              generalRole: operation.generalRole ?? currentConfig.generalRole,
            }
            if (operation.inviteEmail) {
              const email = String(operation.inviteEmail).trim().toLowerCase()
              if (!updated.invitedEmails.includes(email)) {
                updated.invitedEmails = [...updated.invitedEmails, email]
              }
              updated.collaborators = {
                ...updated.collaborators,
                [email]: {
                  email,
                  role: operation.inviteRole || 'editor',
                  addedAt: new Date().toISOString(),
                },
              }
            }
            await sharingService.saveShareConfig(updated)
            const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173'
            sendOperationResult(operation.id, true, {
              ok: true,
              boardId: targetBoardId,
              shareUrl: `${origin}/boards/${targetBoardId}`,
              generalAccess: updated.generalAccess,
              generalRole: updated.generalRole,
              invitedEmails: updated.invitedEmails,
              collaborators: updated.collaborators,
            })
          } catch (err: any) {
            sendOperationResult(operation.id, false, null, err?.message || 'Failed to update sharing')
          }
        }
        operationRef.current = null
      }
      socket.onclose = () => {
        if (!disposed) {
          failedAttempts++
          const delay = Math.min(retryDelay * Math.pow(1.5, Math.min(failedAttempts, 5)), 60_000)
          retryId = window.setTimeout(connect, delay)
        }
      }
    }

    const onFocus = () => {
      if (!socketRef.current || socketRef.current.readyState === WebSocket.CLOSED) {
        if (retryId) window.clearTimeout(retryId)
        failedAttempts = 0
        retryDelay = 5_000
        void connect()
      }
    }

    window.addEventListener('focus', onFocus)
    void connect()

    return () => {
      disposed = true
      window.removeEventListener('focus', onFocus)
      if (retryId) window.clearTimeout(retryId)
      socketRef.current?.close()
    }
  }, [isReadOnly, sendScene])

  /**
   * Saves use optimistic revisions, so concurrent writes with the same stale
   * revision are treated as conflicts by the store. Queue them and read the
   * document ref inside the queued task, after the preceding save has updated it.
   */
  const enqueueSceneSave = useCallback(
    (scene: BoardScene) => {
      const task = saveChainRef.current.then(async () => {
        const document = documentRef.current
        if (document) {
          // If the document in local storage has been updated (e.g. by background sync or initial mount),
          // refresh its revision so we don't hit a false revision conflict.
          const latest = await workspaceApi.loadBoard(document.id)
          const docToSave = latest ? { ...latest, name: document.name, scene } : { ...document, scene }
          const saved = await workspaceApi.saveBoard(docToSave)
          documentRef.current = saved
          committedSignatureRef.current = getSceneSignature(scene)
          setBoardMeta((prev) => (prev ? { ...prev, updatedAt: saved.updatedAt } : prev))
          await sharingService.syncBoardSceneToShare(boardId, scene, saved.name)
          queryClient.invalidateQueries({ queryKey: ['workspace'] })
          setState(isSharedBoard ? 'Synced' : statusLabel(saved.syncStatus))
          return
        }

        if (!userHasInteractedRef.current && scene.elements.length === 0) {
          return
        }

        await sharingService.updateSharedScene(boardId, scene)
        committedSignatureRef.current = getSceneSignature(scene)
        setState('Synced')
      })

      // Keep the queue live after an error while preserving that error for the caller.
      saveChainRef.current = task.catch(() => {})
      return task
    },
    [boardId, isSharedBoard, queryClient],
  )

  const handleSaveFailure = useCallback((scene: BoardScene, error: unknown) => {
    pendingSceneRef.current ??= scene
    console.error('Failed to save scene:', error)
    setState(documentRef.current ? 'Local save failed' : 'Sync failed')
  }, [])

  const flushSave = useCallback(async () => {
    if (isReadOnly) return
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = undefined
    }
    const scene = pendingSceneRef.current
    if (!scene) return
    pendingSceneRef.current = null

    try {
      await enqueueSceneSave(scene)
    } catch (error) {
      handleSaveFailure(scene, error)
    }
  }, [enqueueSceneSave, handleSaveFailure, isReadOnly])

  // Task 1: Auto-downgrade & state persistence when room membership changes
  const prevLazyActiveRef = useRef(false)
  const hasEstablishedSoloRef = useRef(false)
  const transitionTimerRef = useRef<number | null>(null)

  // Track established solo mode: only trigger the "Connecting to live collaboration..." transition
  // banner if the user was actively working in solo mode and another collaborator joins.
  // Never trigger on initial page load / refresh.
  useEffect(() => {
    if (!initialData) return
    if (!isLazyCollabActive) {
      const timer = window.setTimeout(() => {
        hasEstablishedSoloRef.current = true
      }, 1000)
      return () => window.clearTimeout(timer)
    } else {
      hasEstablishedSoloRef.current = false
    }
  }, [initialData, isLazyCollabActive])

  // Cleanup transition timer on unmount
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        window.clearTimeout(transitionTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (isLazyCollabActive && !prevLazyActiveRef.current) {
      prevLazyActiveRef.current = true

      // Flipping from individual to collab mode:
      // 1. Temporarily put board in read-only mode so user cannot make edits in between,
      //    ONLY if the user was already established in solo mode.
      if (hasEstablishedSoloRef.current) {
        setIsTransitioningCollab(true)
        if (transitionTimerRef.current) {
          window.clearTimeout(transitionTimerRef.current)
        }
        transitionTimerRef.current = window.setTimeout(() => {
          setIsTransitioningCollab(false)
          transitionTimerRef.current = null
        }, 700)
      }

      // 2. Flush any pending local save so peers get latest state
      if (pendingSceneRef.current) {
        void flushSave()
      }
    } else if (!isLazyCollabActive && prevLazyActiveRef.current) {
      prevLazyActiveRef.current = false
      if (transitionTimerRef.current) {
        window.clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = null
      }
      setIsTransitioningCollab(false)

      // Transitioning back to solo: flush the collab scene to storage so it is persisted
      if (elementsRef.current && elementsRef.current.length > 0) {
        const scene: BoardScene = {
          elements: elementsRef.current,
          files: filesRef.current,
          appState: {
            theme: appStateRef.current.theme,
            viewBackgroundColor: appStateRef.current.viewBackgroundColor,
            gridModeEnabled: appStateRef.current.gridModeEnabled,
            objectsSnapModeEnabled: appStateRef.current.objectsSnapModeEnabled,
          },
        }
        void enqueueSceneSave(scene)
      }
    }
  }, [isLazyCollabActive, flushSave, enqueueSceneSave])

  const scheduleSave = useCallback(
    (scene: BoardScene) => {
      if (isReadOnly || isTransitioningCollab) return
      pendingSceneRef.current = scene
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      setState('Saving')
      saveTimer.current = window.setTimeout(async () => {
        saveTimer.current = undefined
        pendingSceneRef.current = null
        try {
          await enqueueSceneSave(scene)
        } catch (error) {
          handleSaveFailure(scene, error)
        }
      }, 450)
    },
    [enqueueSceneSave, handleSaveFailure, isReadOnly, isTransitioningCollab],
  )

  const getSceneSize = useCallback(() => {
    const elements = elementsRef.current.filter((e) => !e.isDeleted)
    const scene = {
      elements: elementsRef.current,
      files: filesRef.current,
      appState: appStateRef.current,
    }
    const payload = documentRef.current ? { ...documentRef.current, scene } : scene
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length
    return {
      bytes,
      elementsCount: elements.length,
    }
  }, [])

  const onChange = useCallback(
    (
      elements: readonly any[],
      appState: Record<string, any>,
      files: BinaryFiles = apiRef.current?.getFiles() ?? {},
    ) => {
      if (isReadOnly || isTransitioningCollab) return
      elementsRef.current = [...elements]
      filesRef.current = files
      appStateRef.current = { ...appStateRef.current, selectedElementIds: appState.selectedElementIds }
      const scene = {
        elements: [...elements],
        files,
        appState: {
          theme: appState.theme,
          viewBackgroundColor: appState.viewBackgroundColor,
          gridModeEnabled: appState.gridModeEnabled,
          objectsSnapModeEnabled: appState.objectsSnapModeEnabled,
        },
      }
      const signature = getSceneSignature(scene)
      // 1. Initial scene mount absorption & auto-zoom
      if (awaitingInitialSceneRef.current) {
        awaitingInitialSceneRef.current = false
        savedSignature.current = signature
        committedSignatureRef.current ??= signature
        if (!hasAutoZoomedRef.current) {
          triggerAutoCenter()
        }
        return
      }

      // 2. If the user has not interacted with the canvas/keyboard yet,
      // any onChange is purely internal Excalidraw normalization, font loading,
      // or layout stabilization. Absorb it and update savedSignature without triggering a save.
      if (!userHasInteractedRef.current) {
        savedSignature.current = signature
        committedSignatureRef.current ??= signature
        return
      }

      // 3. If there are no real changes from the last saved signature, skip
      if (signature === savedSignature.current) return
      savedSignature.current = signature
      broadcastChanges(elements)

      // 4. Check if current scene is back to committed state (e.g. reverted via Cmd+Z)
      const isBackToCommitted = signature === committedSignatureRef.current
      if (isBackToCommitted) {
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
          saveTimer.current = undefined
        }
        pendingSceneRef.current = null
      } else {
        scheduleSave(scene)
      }
      if (!operationRef.current) sendScene([...elements])
    },
    [
      scheduleSave,
      sendScene,
      broadcastChanges,
      isLazyCollabActive,
      isReadOnly,
      isTransitioningCollab,
      triggerAutoCenter,
    ],
  )

  const hasUnsavedChanges =
    !isLazyCollabActive &&
    (state === 'Saving' || state === 'Local save failed' || state === 'Conflict' || pendingSceneRef.current !== null)

  const hasUnsavedChangesRef = useRef(hasUnsavedChanges)
  hasUnsavedChangesRef.current = hasUnsavedChanges

  useEffect(() => {
    if (initialData?.elements && initialData.elements.length > 0 && !hasAutoZoomedRef.current) {
      triggerAutoCenter()
    }
  }, [initialData, triggerAutoCenter])

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      void flushSave()
      if (!isLazyCollabActive && hasUnsavedChangesRef.current) {
        e.preventDefault()
        e.returnValue = ''
        return ''
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void flushSave()
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [flushSave])

  const handleMakeCopy = useCallback(async () => {
    if (!authUser) {
      await signInWithGoogle()
      return
    }
    setIsCopyingBoard(true)
    try {
      const { projects } = await workspaceApi.listWorkspace()
      let targetProjectId = projects[0]?.id
      if (!targetProjectId) {
        const newProj = await workspaceApi.createProject('General')
        targetProjectId = newProj.id
      }
      const copyName = `Copy of ${boardMeta?.boardName || 'Untitled'}`
      const newBoard = await workspaceApi.createBoard(targetProjectId, copyName)
      await workspaceApi.saveBoard({
        ...newBoard,
        scene: {
          elements: elementsRef.current,
          files: filesRef.current,
          appState: appStateRef.current,
        },
      })
      queryClient.invalidateQueries({ queryKey: ['workspace'] })
      navigate({ to: '/boards/$boardId', params: { boardId: newBoard.id } })
    } catch (err) {
      console.error('Failed to make copy:', err)
    } finally {
      setIsCopyingBoard(false)
    }
  }, [authUser, boardMeta?.boardName, navigate, queryClient, signInWithGoogle])

  useBlocker({
    shouldBlockFn: async () => {
      await flushSave()
      if (hasUnsavedChangesRef.current) {
        return !window.confirm('You have changes that are still saving or in conflict.\n\nLeave anyway?')
      }
      return false
    },
    enableBeforeUnload: false,
    disabled: isReadOnly || !hasUnsavedChanges || accessDenied,
  })

  if (accessDenied) {
    const isUserSignedIn = Boolean((authUser && !authUser.isAnonymous) || isSwitchingAccount)
    const displayEmail = isSwitchingAccount ? (lastUserEmailRef.current ?? authUser?.email) : authUser?.email

    return (
      <AccessDenied
        email={displayEmail}
        signedIn={isUserSignedIn}
        busy={isSigningIn || isSwitchingAccount}
        onSignIn={handleSignIn}
        onSwitchAccount={handleSwitchAccount}
      />
    )
  }

  if (boardNotFound) {
    return (
      <div className="access-denied-container">
        <div className="access-denied-card animate-scale-in">
          <h2 className="access-denied-title">Board not found</h2>
          <p className="access-denied-desc">The board you are looking for does not exist or may have been deleted.</p>
          <Link to="/" className="google-share-done-btn" style={{ textDecoration: 'none' }}>
            Go to workspace
          </Link>
        </div>
      </div>
    )
  }

  if (!initialData) return <div className="workspace-loading">{state}…</div>
  return (
    <main className="editor-shell">
      {currentNavSlot &&
        createPortal(
          <nav className="header-breadcrumb" aria-label="Breadcrumb">
            <Link to="/" className="breadcrumb-item breadcrumb-link" title="Workspace">
              Workspace
            </Link>
            <span className="breadcrumb-separator" aria-hidden="true">
              /
            </span>
            {boardMeta ? (
              isReadOnly ? (
                <div className="breadcrumb-current-group">
                  <span className="breadcrumb-item breadcrumb-current" title={boardMeta.boardName}>
                    {boardMeta.boardName}
                  </span>
                  <button
                    type="button"
                    className="breadcrumb-copy-btn"
                    onClick={handleCopyFilename}
                    title={copiedFilename ? 'Copied!' : 'Copy file name'}
                    aria-label="Copy file name"
                  >
                    {copiedFilename ? <Check size={12} className="breadcrumb-copy-check" /> : <Copy size={12} />}
                  </button>
                </div>
              ) : (
                <>
                  <Link
                    to="/"
                    search={{ projectId: boardMeta.projectId || undefined }}
                    className="breadcrumb-item breadcrumb-link"
                    title={`Filter by ${boardMeta.projectName}`}
                  >
                    {boardMeta.projectName}
                  </Link>
                  <span className="breadcrumb-separator" aria-hidden="true">
                    /
                  </span>
                  {isEditingName ? (
                    <form
                      className="breadcrumb-name-form"
                      onSubmit={(e) => {
                        e.preventDefault()
                        finishEditingName()
                      }}
                    >
                      <input
                        ref={nameInputRef}
                        type="text"
                        className="breadcrumb-name-input"
                        value={tempName}
                        onChange={(e) => setTempName(e.target.value)}
                        onBlur={finishEditingName}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelEditingName()
                          }
                        }}
                        maxLength={60}
                        aria-label="Edit board name"
                      />
                    </form>
                  ) : (
                    <div className="breadcrumb-current-group">
                      <span
                        className="breadcrumb-item breadcrumb-current breadcrumb-current--clickable"
                        title={boardMeta.boardName}
                        onClick={startEditingName}
                      >
                        {boardMeta.boardName}
                      </span>
                      <button
                        type="button"
                        className="breadcrumb-edit-btn"
                        onClick={startEditingName}
                        title="Edit board name"
                        aria-label="Edit board name"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        className="breadcrumb-copy-btn"
                        onClick={handleCopyFilename}
                        title={copiedFilename ? 'Copied!' : 'Copy file name'}
                        aria-label="Copy file name"
                      >
                        {copiedFilename ? <Check size={12} className="breadcrumb-copy-check" /> : <Copy size={12} />}
                      </button>
                    </div>
                  )}
                </>
              )
            ) : (
              <span className="breadcrumb-item breadcrumb-current">Loading…</span>
            )}
          </nav>,
          currentNavSlot,
        )}
      {currentStatusSlot &&
        createPortal(
          <div className="header-status-group">
            {isReadOnly ? (
              <>
                <span className="view-only-badge">
                  <Eye size={13} />
                  <span>View only</span>
                </span>

                <button
                  type="button"
                  className="make-copy-btn"
                  onClick={handleMakeCopy}
                  disabled={isCopyingBoard}
                  title="Make a copy in your workspace"
                >
                  <Copy size={13} />
                  <span>{isCopyingBoard ? 'Copying…' : 'Make a copy'}</span>
                </button>

                <BoardInfoDropdown
                  boardName={boardMeta?.boardName || 'Untitled'}
                  createdAt={boardMeta?.createdAt}
                  updatedAt={boardMeta?.updatedAt}
                  projectOwnerId={boardMeta?.projectOwnerId}
                  projectOwnerName={boardMeta?.projectOwnerName}
                  projectOwnerEmail={boardMeta?.projectOwnerEmail}
                  getSceneSize={getSceneSize}
                />
              </>
            ) : (
              <>
                <SyncStatusDropdown
                  state={state}
                  onKeepLocalConflict={keepLocalConflict}
                  lastSyncError={documentRef.current?.lastSyncError}
                  boardName={boardMeta?.boardName || documentRef.current?.name || 'Untitled'}
                  createdAt={boardMeta?.createdAt || documentRef.current?.createdAt}
                  updatedAt={boardMeta?.updatedAt || documentRef.current?.updatedAt}
                  projectOwnerId={boardMeta?.projectOwnerId}
                  projectOwnerName={boardMeta?.projectOwnerName}
                  projectOwnerEmail={boardMeta?.projectOwnerEmail}
                  version={documentRef.current?.revision}
                  getSceneSize={getSceneSize}
                />

                {(!isSharedBoard || (authUser?.uid && boardMeta?.projectOwnerId === authUser.uid)) && (
                  <button
                    type="button"
                    className="header-share-btn"
                    onClick={() => setIsShareModalOpen(true)}
                    title="Share board"
                  >
                    <Share2 size={13} />
                    <span>Share</span>
                  </button>
                )}
              </>
            )}

            <CollaboratorBar collaborators={activeCollaborators} />
          </div>,
          currentStatusSlot,
        )}
      {isSpectator && (
        <div
          className="spectator-mode-banner animate-fade-in"
          role="alert"
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
            backgroundColor: 'rgba(24, 24, 27, 0.85)',
            backdropFilter: 'blur(8px)',
            color: '#e4e4e7',
            padding: '6px 14px',
            borderRadius: '20px',
            fontSize: '12px',
            fontWeight: 500,
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <Eye size={13} style={{ color: '#38bdf8' }} />
          <span>Viewing mode (Room at editor capacity: 10/10)</span>
        </div>
      )}
      {isTransitioningCollab && (
        <div
          className="collab-transition-banner animate-fade-in"
          role="status"
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
            backgroundColor: 'rgba(24, 24, 27, 0.85)',
            backdropFilter: 'blur(8px)',
            color: '#e4e4e7',
            padding: '6px 14px',
            borderRadius: '20px',
            fontSize: '12px',
            fontWeight: 500,
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <Loader2 size={13} className="animate-spin text-blue-400" />
          <span>Connecting to live collaboration...</span>
        </div>
      )}
      {!initialData ? (
        <div className="flex h-full w-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Excalidraw
          key={boardId}
          theme={resolvedTheme}
          initialData={initialData}
          onChange={onChange}
          onPointerUpdate={onPointerUpdate}
          viewModeEnabled={isReadOnly || isSpectator || isTransitioningCollab}
          detectScroll
          handleKeyboardGlobally
          objectsSnapModeEnabled
          aiEnabled={false}
          validateEmbeddable={(url) => {
            try {
              return new URL(url).protocol === 'https:'
            } catch {
              return false
            }
          }}
          UIOptions={{
            tools: { image: true },
            canvasActions: {
              changeViewBackgroundColor: !isReadOnly && !isSpectator && !isTransitioningCollab,
              clearCanvas: !isReadOnly && !isSpectator,
              export: { saveFileToDisk: true },
              loadScene: !isReadOnly && !isSpectator,
              saveToActiveFile: !isReadOnly && !isSpectator,
              saveAsImage: true,
              toggleTheme: false,
            },
          }}
          excalidrawAPI={(api) => {
            apiRef.current = api
            if (import.meta.env.DEV) {
              ;(window as any).__excalidrawAPI = api
              ;(window as any).__centerBoardContent = () => {
                hasAutoZoomedRef.current = false
                triggerAutoCenter()
              }
              ;(window as any).__setUserInteracted = () => {
                userHasInteractedRef.current = true
              }
              ;(window as any).__hasUnsavedChanges = () => hasUnsavedChangesRef.current
              ;(window as any).__pendingScene = () => pendingSceneRef.current
              ;(window as any).__triggerSceneChange = (elements: any[]) => {
                userHasInteractedRef.current = true
                onChange(elements, api.getAppState())
              }
            }
            sendScene()
            triggerAutoCenter()
          }}
          onLibraryChange={(items) => {
            try {
              localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(items))
            } catch {
              /* storage may be unavailable */
            }
          }}
        >
          <MainMenu>
            {!isReadOnly && !isSpectator && <MainMenu.DefaultItems.LoadScene />}
            {!isReadOnly && !isSpectator && <MainMenu.DefaultItems.SaveToActiveFile />}
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.Help />
            {!isReadOnly && !isSpectator && <MainMenu.DefaultItems.ClearCanvas />}
            {!isReadOnly && !isSpectator && <MainMenu.Separator />}
            {!isReadOnly && !isSpectator && <MainMenu.DefaultItems.ChangeCanvasBackground />}
          </MainMenu>
        </Excalidraw>
      )}

      {boardMeta && (
        <ShareModal
          open={isShareModalOpen}
          onOpenChange={setIsShareModalOpen}
          onShareConfigSaved={() => setIsSharedBoard(true)}
          boardId={boardId}
          boardName={boardMeta.boardName}
          ownerId={boardMeta.projectOwnerId}
          scene={{ elements: elementsRef.current, appState: appStateRef.current }}
        />
      )}
    </main>
  )
}
