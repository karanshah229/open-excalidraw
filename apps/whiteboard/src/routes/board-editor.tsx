import {
  createSlideDataHandler,
  slideDataOperations,
  describeSlides,
} from '../features/mcp-bridge/slide-data-operations'
import { PresentationView } from './presentation'
import { AccessDenied } from '../components/access-denied'
import { BoardLoading } from '../components/board-loading'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { doc, getDoc, getDocFromServer, onSnapshot, updateDoc } from 'firebase/firestore'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useParams, useBlocker } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Eye, History, Loader2, Pencil, Share2 } from 'lucide-react'
import {
  convertToExcalidrawElements,
  restoreElements,
  Excalidraw,
  MainMenu,
  exportToSvg,
  newElementWith,
  loadFromBlob,
  CaptureUpdateAction,
} from '@excalidraw/excalidraw'
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { BoardDocument, BoardScene, BoardSyncStatus } from '@agentic-whiteboard/storage'
import { projectCall } from '../features/sharing/project-service'
import { workspaceApi, workspaceStore } from '../features/workspace/workspace-api'
import { SceneGenerationError } from '../features/scenes/scene-service'
import { getSceneSignature } from '../features/scenes/scene-signature'
import { replaceSceneElements } from '../features/scenes/import-scene'
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
import { restoreSceneAssets } from '../features/assets/scene-assets'
import { sharingService, type BoardShareConfig } from '../features/sharing/sharing-service'
import { resolveBoardSharing } from '../features/workspace/board-loading'
import {
  readSharedSceneDraft,
  saveSharedSceneDraft,
  acknowledgeSharedSceneDraft,
  discardRestoredSharedSceneDraft,
} from '../features/sharing/shared-scene-drafts'
import {
  useCollaboration,
  CollaboratorBar,
  ensureAuthenticatedUser,
  generateSessionId,
  type ActiveSessionRecord,
} from '../features/collaboration'
import { reconcileElementsLWW } from '../features/collaboration/reconcile'
import { getFirebaseAuth, getFirestoreDb, isFirebaseConfigured } from '../lib/firebase'
import { createSceneSession } from '../features/scene/scene-session'
import { scheduleWhiteboardFontPreload } from '../features/fonts/font-loading'
import { getSlides, newSlideData, slideLabel, slideMetadata } from '../features/slides/slide-model'
import {
  commitSlideCommand,
  createSlide,
  duplicateSlide,
  normalizeDuplicatedSlides,
} from '../features/slides/slide-commands'
import { copySlideNotes, hasDirtyBoardNotes, replaceBoardNoteDrafts } from '../features/slides/notes-store'
import { boardHistoryStore } from '@agentic-whiteboard/storage'
import {
  cloudHistorySource,
  localHistorySource,
  readHistorySnapshot,
  recoverPendingCloudRestore,
} from '../features/history/history-service'
import {
  assertHistoryMutationAllowed,
  historyEditingState,
  setHistoryEditingState,
} from '../features/history/history-editing-gate'
import type { HistorySource } from '../features/history/history-model'
import { RestorationProgress } from '../features/history/restoration-progress'
const HistoryDialog = lazy(() => import('../features/history/history-dialog'))
import { readSidebarPinned } from '../features/sidebar/sidebar-preferences'
import { SlidesPanel } from '../features/slides/slides-panel'

const slideFrameTool = { label: 'Slide', createCustomData: newSlideData }

const LIBRARY_STORAGE_KEY = 'agentic-whiteboard:library:v1'
const starterLibraries = [
  'https://libraries.excalidraw.com/libraries/youritjang/software-architecture.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/rohanp/system-design.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/childishgirl/aws-architecture-icons.excalidrawlib',
]

type EditorStatus =
  | 'Loading board'
  | 'Saving'
  | 'Synced locally'
  | 'Synced'
  | 'Sync failed'
  | 'Conflict'
  | 'Local save failed'
  | 'Project deleted'

class BoardContextChangedError extends Error {}
const statusLabel = (status: BoardSyncStatus): EditorStatus => {
  if (status === 'local-only') return 'Synced locally'
  if (status === 'synced') return 'Synced'
  if (status === 'conflict') return 'Conflict'
  if (status === 'sync-blocked') return 'Project deleted'
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

function prepareInitialElements(elements: readonly any[] = []): any[] {
  // Persisted scenes contain native elements, not generation skeletons.
  // Restore preserves frameId membership, bindings, versions and tombstones.
  return restoreElements(elements as any, null)
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
  const resolvedThemeRef = useRef(resolvedTheme)
  resolvedThemeRef.current = resolvedTheme
  const { user: authUser, isLoading: isAuthLoading, signInWithGoogle, signOutUser } = useAuth()
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const importRequestRef = useRef(0)
  const [importError, setImportError] = useState<string | null>(null)
  const editorShellRef = useRef<HTMLElement | null>(null)
  const sceneSession = useMemo(createSceneSession, [boardId])
  const [isSlideStageOpen, setIsSlideStageOpen] = useState(false)
  const markSlideInteraction = useCallback(() => {
    userHasInteractedRef.current = true
    hasAutoZoomedRef.current = true
  }, [])
  const documentRef = useRef<BoardDocument | null>(null)
  const elementsRef = useRef<any[]>([])
  const filesRef = useRef<BinaryFiles>({})
  const appStateRef = useRef<Record<string, unknown>>({})
  const socketRef = useRef<WebSocket | null>(null)
  const operationRef = useRef<string | null>(null)
  const saveTimer = useRef<number>()
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const draftChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const [recoveredSharedScene, setRecoveredSharedScene] = useState<BoardScene | null>(null)
  const savedSignature = useRef<string>()
  const committedSignatureRef = useRef<string>()
  const applyingRemoteSceneRef = useRef(false)
  const pendingSceneRef = useRef<BoardScene | null>(null)
  const sceneGenerationRef = useRef<number>()
  const boardEpochRef = useRef(0)
  const generationConflictRef = useRef(false)
  const historyProtocolRef = useRef(false)
  const historyHeadRef = useRef<{
    generation: number
    restoreFence?: number
    restoreOperationId?: string | null
    currentVersionId?: string
    headRevisionId?: string
    nameRevision?: number
  }>()
  const restoreGateRef = useRef(false)
  const restoreHydrateRef = useRef<() => Promise<void>>(async () => {})
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historySource, setHistorySource] = useState<HistorySource>()
  const [restorationBlocked, setRestorationBlocked] = useState(false)
  const [restorationError, setRestorationError] = useState('')
  const [canvasEpoch, setCanvasEpoch] = useState(0)
  const [historyGeneration, setHistoryGeneration] = useState<number>()
  const [historyFence, setHistoryFence] = useState<number>()
  const hydrationInFlightRef = useRef<Promise<void>>()
  const baselineInFlightRef = useRef<Promise<unknown>>()
  const publishedHydrationGenerationRef = useRef<number>()
  const setRestorationGate = useCallback(
    (blocked: boolean) => {
      restoreGateRef.current = blocked
      const head = historyHeadRef.current
      setHistoryEditingState(boardId, {
        blocked,
        ...(historyProtocolRef.current ? { generation: head?.generation, restoreFence: head?.restoreFence } : {}),
      })
      setRestorationBlocked(blocked)
      if (blocked) {
        if (saveTimer.current) window.clearTimeout(saveTimer.current)
        saveTimer.current = undefined
        ++importRequestRef.current
      }
    },
    [boardId],
  )
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
      // Do not recenter a first frame while the user is actively drawing it.
      if (hasAutoZoomedRef.current || userHasInteractedRef.current) return
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
  const slideDataHandler = useMemo(createSlideDataHandler, [boardId, authUser?.uid])
  useEffect(() => () => slideDataHandler.clear(), [slideDataHandler])
  const [isReadOnly, setIsReadOnly] = useState(false)
  const [presentationConfig, setPresentationConfig] = useState<BoardShareConfig | undefined>()
  const [isSharedBoard, setIsSharedBoard] = useState(false)
  const ownedSyncBlockedRef = useRef(false)
  const canEditBoardRef = useRef(false)
  const isSharedBoardRef = useRef(isSharedBoard)
  isSharedBoardRef.current = isSharedBoard
  const [accessDenied, setAccessDenied] = useState(false)
  const accessDeniedRef = useRef(accessDenied)
  accessDeniedRef.current = accessDenied
  const [boardNotFound, setBoardNotFound] = useState(false)
  const [boardLoadFailed, setBoardLoadFailed] = useState(false)
  const [accessRevision, setAccessRevision] = useState(0)
  const [activeSessions, setActiveSessions] = useState<ActiveSessionRecord[]>([])

  // Per-page connection ID shared across RTDB activeSessions and presence.
  const sessionIdRef = useRef<string>(createConnectionSessionId())

  // Task 1: Register active session when board is open (1 write on open, 1 on close)
  useEffect(() => {
    if (!boardId || !isSharedBoard || accessDenied || boardNotFound || presentationConfig) return
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
  }, [boardId, isSharedBoard, authUser?.uid, accessDenied, boardNotFound, Boolean(presentationConfig)])

  // Task 1: Subscribe to active sessions on the board
  useEffect(() => {
    if (!boardId || !isSharedBoard || accessDenied || boardNotFound || presentationConfig) {
      setActiveSessions([])
      return
    }
    return sharingService.subscribeToActiveSessions(boardId, (sessions) => {
      setActiveSessions(sessions)
    })
  }, [boardId, isSharedBoard, accessDenied, boardNotFound, Boolean(presentationConfig)])

  // Lazy collab triggers when 2 or more active editor sessions are detected on the board
  const isLazyCollabActive = Boolean(activeSessions.length >= 2)
  const isLazyCollabActiveRef = useRef(isLazyCollabActive)
  isLazyCollabActiveRef.current = isLazyCollabActive
  const [isTransitioningCollab, setIsTransitioningCollab] = useState(false)
  const onRemoteSceneApply = useCallback((elements: readonly any[], phase: 'before' | 'after') => {
    if (phase === 'before') {
      applyingRemoteSceneRef.current = true
      return
    }
    // Excalidraw may normalize an incoming element while updateScene runs.
    // Read the post-update scene so remote normalization becomes the baseline,
    // without turning it into a local save. Preserve any queued local snapshot,
    // timer and committed signature.
    const rendered = apiRef.current?.getSceneElementsIncludingDeleted?.() ?? elements
    elementsRef.current = [...rendered]
    filesRef.current = apiRef.current?.getFiles() ?? filesRef.current
    const appState = apiRef.current?.getAppState() ?? appStateRef.current
    appStateRef.current = { ...appStateRef.current, selectedElementIds: appState.selectedElementIds }
    savedSignature.current = getSceneSignature({ elements: rendered, appState, files: filesRef.current })
    applyingRemoteSceneRef.current = false
  }, [])
  const { activeCollaborators, onPointerUpdate, broadcastChanges, isSpectator } = useCollaboration({
    boardId,
    enabled: Boolean(
      isFirebaseConfigured &&
      isSharedBoard &&
      boardId &&
      !accessDenied &&
      !boardNotFound &&
      !presentationConfig &&
      isLazyCollabActive,
    ),
    sessionId: sessionIdRef.current,
    authUser,
    isAuthLoading,
    isReadOnly: isReadOnly || isTransitioningCollab || restorationBlocked,
    generation: historyGeneration,
    expectedFence: historyFence,
    restorationBlocked,
    apiRef,
    elementsRef,
    appStateRef,
    onRemoteSceneApply,
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
    if (!boardMeta || isReadOnly || restoreGateRef.current) return
    setTempName(boardMeta.boardName)
    setIsEditingName(true)
    setTimeout(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }, 0)
  }, [boardMeta, isReadOnly])

  const finishEditingName = useCallback(async () => {
    if (!isEditingName || !boardMeta || isReadOnly || restoreGateRef.current) return
    setIsEditingName(false)
    const trimmed = tempName.trim() || 'Untitled'
    if (trimmed === boardMeta.boardName) return

    setBoardMeta((prev) => (prev ? { ...prev, boardName: trimmed } : prev))
    if (documentRef.current) {
      documentRef.current = { ...documentRef.current, name: trimmed }
    }
    const epoch = boardEpochRef.current
    try {
      assertHistoryMutationAllowed(boardId)
      const saved = documentRef.current
        ? await workspaceApi.renameBoard(boardId, trimmed, {
            nameRevision: historyHeadRef.current?.nameRevision,
            expectedFence: historyHeadRef.current?.restoreFence,
          })
        : null
      if (epoch !== boardEpochRef.current || restoreGateRef.current) return
      if (saved) {
        documentRef.current = saved
        setBoardMeta((prev) => (prev ? { ...prev, updatedAt: saved.updatedAt } : prev))
        void sharingService
          .syncBoardSceneToShare(boardId, saved.scene, trimmed, sceneGenerationRef.current)
          .catch(console.error)
      } else {
        if (historyProtocolRef.current) {
          let current = await boardHistoryStore.getCommittedContent(boardId)
          if (!current) {
            // A shared editor may have no local history record until their
            // first edit. Seed the version store from the authorized cloud
            // snapshot so a rename preserves the board and speaker notes.
            const cloud = await readHistorySnapshot(boardId, undefined, false, true)
            const head = historyHeadRef.current
            const document = documentRef.current ?? {
              id: boardId,
              projectId: boardMeta.projectId,
              name: cloud.entry.name,
              active: true,
              createdAt: boardMeta.createdAt ?? cloud.entry.createdAt,
              updatedAt: boardMeta.updatedAt ?? cloud.entry.createdAt,
              syncStatus: 'synced' as const,
              revision: 0,
              baseRevision: 0,
              syncAttempts: 0,
              nextSyncAt: null,
              lastSyncError: null,
              formatVersion: 1 as const,
              scene: cloud.scene,
            }
            current = await boardHistoryStore.initialize({
              ...document,
              name: cloud.entry.name,
              syncStatus: 'synced',
              cloudRevisionId: cloud.revisionId,
              cloudGeneration: cloud.generation,
              cloudVersionId: cloud.entry.id,
              cloudRestoreFence: head?.restoreFence ?? 0,
              cloudNameRevision: head?.nameRevision ?? 0,
            }, cloud.notes)
          }
          if (!current) throw new Error('Load the complete board before renaming it.')
          if (epoch !== boardEpochRef.current || restoreGateRef.current) return
          const head = historyHeadRef.current
          const capture = await boardHistoryStore.save(
            { ...current.document, name: trimmed },
            {
              changedFields: { name: true },
              fieldBases: { nameRevision: head?.nameRevision ?? 0 },
              expectedFence: head?.restoreFence ?? 0,
            },
          )
          window.dispatchEvent(new CustomEvent('board-history-local-save', { detail: { boardId } }))
          if (navigator.onLine)
            await projectCall('updateBoardContent', {
              boardId,
              name: trimmed,
              mutationId: capture.version.localVersionId,
              generation: head?.generation ?? 1,
              expectedFence: head?.restoreFence ?? 0,
              nameRevision: head?.nameRevision ?? 0,
            })
        } else {
          const db = getFirestoreDb()
          if (!db) throw new Error('Cloud board is unavailable.')
          await updateDoc(doc(db, 'boardShares', boardId), { boardName: trimmed, updatedAt: new Date().toISOString() })
        }
      }
      queryClient.invalidateQueries({ queryKey: ['workspace'] })
    } catch (error) {
      console.error('Board rename failed:', error)
      if (epoch !== boardEpochRef.current || restoreGateRef.current) return
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

  const historyIsLocal = boardMeta?.projectOwnerId === 'local-user' || !isFirebaseConfigured
  const noteIdentity =
    boardMeta?.projectOwnerId === 'local-user'
      ? 'local-user'
      : authUser?.uid || getFirebaseAuth()?.currentUser?.uid || 'local-user'
  useEffect(() => {
    if (
      !boardMeta ||
      accessDenied ||
      presentationConfig ||
      isReadOnly ||
      (!historyIsLocal && historyGeneration === undefined)
    )
      return
    let active = true
    if (historyIsLocal)
      void localHistorySource(boardId).then((source) => {
        if (active) setHistorySource(source)
      })
    else
      setHistorySource(
        cloudHistorySource(boardId, () => historyHeadRef.current ?? { generation: sceneGenerationRef.current ?? 1 }),
      )
    return () => {
      active = false
      setHistorySource(undefined)
    }
  }, [
    boardId,
    Boolean(boardMeta),
    historyIsLocal,
    historyGeneration !== undefined,
    authUser?.uid,
    accessDenied,
    Boolean(presentationConfig),
    isReadOnly,
  ])

  restoreHydrateRef.current = () => {
    if (hydrationInFlightRef.current) return hydrationInFlightRef.current
    const epoch = ++boardEpochRef.current
    const user = getFirebaseAuth()?.currentUser?.uid
    setRestorationGate(true)
    setRestorationError('')
    ++importRequestRef.current
    const task = (async () => {
      let head = historyHeadRef.current
      if (!historyIsLocal) {
        const db = getFirestoreDb()
        if (!db) throw new Error('Cloud board is unavailable.')
        const fresh = await getDocFromServer(doc(db, 'boardScenes', boardId))
        if (!fresh.exists()) throw new Error('This board is no longer available.')
        head = fresh.data() as any
        historyHeadRef.current = head
        if (head?.restoreOperationId)
          throw new Error('Restoration is still in progress. Waiting for the replacement to be published.')
      }
      const before = await boardHistoryStore.getCommittedContent(boardId)
      if (!historyIsLocal && head) {
        const generationAdvanced =
          (sceneGenerationRef.current !== undefined && head.generation > sceneGenerationRef.current) ||
          (before?.document.cloudGeneration !== undefined && head.generation > before.document.cloudGeneration)
        if (generationAdvanced) publishedHydrationGenerationRef.current = head.generation
        if (publishedHydrationGenerationRef.current !== head.generation) {
          // No successful replacement: a failed same-generation restore must preserve every draft.
          generationConflictRef.current = false
          setIsReadOnly(ownedSyncBlockedRef.current || accessDeniedRef.current || !canEditBoardRef.current)
          setRestorationGate(false)
          window.dispatchEvent(
            new CustomEvent('board-history-fence-refreshed', {
              detail: { boardId, generation: head.generation, restoreFence: head.restoreFence ?? 0 },
            }),
          )
          return
        }
      }
      const local = historyIsLocal ? await boardHistoryStore.getCommittedContent(boardId) : undefined
      const replacement = local
        ? {
            scene: local.document.scene,
            notes: local.notes,
            entry: { name: local.document.name },
            generation: local.version.generation,
            revisionId: '',
            noteRevisions: {},
          }
        : await readHistorySnapshot(boardId, undefined, true, canEditBoardRef.current)
      if (epoch !== boardEpochRef.current || user !== getFirebaseAuth()?.currentUser?.uid)
        throw new BoardContextChangedError()
      if (
        !historyIsLocal &&
        head &&
        (replacement.generation !== head.generation ||
          (historyHeadRef.current && historyHeadRef.current.generation !== replacement.generation))
      )
        throw new Error('A newer restoration is loading. Retry loading the board.')
      const ownedDocument = documentRef.current
      const nativeCurrent = await boardHistoryStore.getCommittedContent(boardId)
      const documentBase = ownedDocument ?? nativeCurrent?.document
      if (documentBase && !historyIsLocal && (documentBase.cloudGeneration ?? 1) < replacement.generation) {
        const verified = await getDocFromServer(doc(getFirestoreDb()!, 'boardScenes', boardId))
        const published = verified.data()
        if (
          !published ||
          published.restoreOperationId ||
          published.generation !== replacement.generation ||
          published.restoreFence !== head?.restoreFence
        )
          throw new Error('A newer restoration is being published. Waiting to reload the board.')
        const document = {
          ...documentBase,
          name: replacement.entry.name,
          scene: replacement.scene,
          cloudGeneration: replacement.generation,
          cloudRevisionId: replacement.revisionId,
          cloudVersionId: head?.currentVersionId,
          cloudRestoreFence: head?.restoreFence ?? 0,
          cloudNameRevision: head?.nameRevision ?? 0,
          syncStatus: 'synced' as const,
        }
        const committed = await boardHistoryStore.applyCloudRestore(document, {
          notes: replacement.notes,
          restoreFence: head?.restoreFence ?? 0,
          currentVersionId: head?.currentVersionId,
        })
        if (ownedDocument) documentRef.current = committed.document
      } else if (ownedDocument && local) documentRef.current = local.document
      if (user && !historyIsLocal) await discardRestoredSharedSceneDraft(boardId, user, replacement.generation)
      await replaceBoardNoteDrafts(noteIdentity, boardId, replacement.notes, replacement.noteRevisions)
      if (epoch !== boardEpochRef.current) throw new BoardContextChangedError()
      pendingSceneRef.current = null
      setRecoveredSharedScene(null)
      setIsEditingName(false)
      generationConflictRef.current = false
      sceneGenerationRef.current = historyIsLocal ? local?.document.cloudGeneration : replacement.generation
      elementsRef.current = prepareInitialElements(replacement.scene.elements)
      filesRef.current = (replacement.scene.files ?? {}) as BinaryFiles
      appStateRef.current = { ...replacement.scene.appState, theme: resolvedTheme }
      savedSignature.current = getSceneSignature(replacement.scene)
      committedSignatureRef.current = savedSignature.current
      awaitingInitialSceneRef.current = true
      userHasInteractedRef.current = false
      hasAutoZoomedRef.current = false
      apiRef.current?.history.clear()
      apiRef.current = null
      sceneSession.publish(elementsRef.current, appStateRef.current as any, filesRef.current)
      setInitialData({
        elements: elementsRef.current,
        appState: appStateRef.current,
        files: filesRef.current,
        libraryItems: initialData?.libraryItems ?? Promise.resolve([]),
        scrollToContent: true,
      })
      setBoardMeta((previous) => (previous ? { ...previous, boardName: replacement.entry.name } : previous))
      setCanvasEpoch((value) => value + 1)
      setHistoryOpen(false)
      queryClient.invalidateQueries({ queryKey: ['workspace'] })
      // Wait for the replacement canvas, not merely the network response, before enabling edits.
      await new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 15000
        const ready = () => {
          if (epoch !== boardEpochRef.current) {
            reject(new BoardContextChangedError())
            return
          }
          if (apiRef.current) {
            resolve()
            return
          }
          if (performance.now() > deadline) {
            reject(new Error('The restored canvas did not finish loading. Retry loading it.'))
            return
          }
          requestAnimationFrame(ready)
        }
        requestAnimationFrame(ready)
      })
      if (!historyIsLocal && historyHeadRef.current?.generation !== replacement.generation)
        throw new Error('A newer restoration replaced this board. Retry loading it.')
      if (!historyHeadRef.current?.restoreOperationId) {
        publishedHydrationGenerationRef.current = undefined
        setRestorationGate(false)
        setIsReadOnly(ownedSyncBlockedRef.current || accessDeniedRef.current || !canEditBoardRef.current)
        setState(historyIsLocal ? 'Synced locally' : 'Synced')
      }
    })()
      .catch((error) => {
        if (epoch === boardEpochRef.current && !(error instanceof BoardContextChangedError))
          setRestorationError(error instanceof Error ? error.message : 'Could not load the restored board.')
        throw error
      })
      .finally(() => {
        if (hydrationInFlightRef.current === task) hydrationInFlightRef.current = undefined
      })
    hydrationInFlightRef.current = task
    return task
  }

  useEffect(() => {
    if (!initialData || historyIsLocal || accessDenied || presentationConfig) return
    const db = getFirestoreDb()
    if (!db) return
    return onSnapshot(
      doc(db, 'boardScenes', boardId),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!snapshot.exists() || snapshot.metadata.fromCache) return
        const head = snapshot.data()
        if (head.historyProtocolVersion !== 1) return
        historyProtocolRef.current = true
        historyHeadRef.current = head as any
        if (!isReadOnly && !head.restoreOperationId && !baselineInFlightRef.current) {
          const baselineEpoch = boardEpochRef.current
          const baselineUser = getFirebaseAuth()?.currentUser?.uid
          const task = workspaceApi
            .loadDeferredCloudNotes(boardId)
            .then(() => {
              if (baselineEpoch !== boardEpochRef.current || baselineUser !== getFirebaseAuth()?.currentUser?.uid ||
                restoreGateRef.current) return
            })
            .catch((error) => console.error('Could not initialize complete board history:', error))
            .finally(() => {
              if (baselineInFlightRef.current === task) baselineInFlightRef.current = undefined
            })
          baselineInFlightRef.current = task
        }
        setHistoryGeneration(head.generation)
        setHistoryFence(head.restoreFence ?? 0)
        if (head.restoreOperationId) setRestorationGate(true)
        else if (
          (sceneGenerationRef.current !== undefined && sceneGenerationRef.current !== head.generation) ||
          (documentRef.current?.cloudGeneration !== undefined &&
            documentRef.current.cloudGeneration !== head.generation) ||
          generationConflictRef.current
        ) {
          void restoreHydrateRef.current().catch(() => {})
        } else if (restoreGateRef.current && !hydrationInFlightRef.current) {
          // A same-generation abort retains drafts. Refresh the fence before producers resume.
          generationConflictRef.current = false
          setIsReadOnly(ownedSyncBlockedRef.current || accessDeniedRef.current || !canEditBoardRef.current)
          setRestorationGate(false)
          window.dispatchEvent(
            new CustomEvent('board-history-fence-refreshed', {
              detail: { boardId, generation: head.generation, restoreFence: head.restoreFence ?? 0 },
            }),
          )
        } else
          setHistoryEditingState(boardId, {
            blocked: restoreGateRef.current,
            generation: head.generation,
            restoreFence: head.restoreFence ?? 0,
          })
      },
      (error) => {
        if ((error as { code?: string }).code === 'permission-denied')
          void workspaceApi.loadBoardWithProject(boardId).then((local) => {
            if (local?.document.syncStatus === 'sync-blocked') {
              ownedSyncBlockedRef.current = true
              setState('Project deleted')
              setIsReadOnly(true)
              setAccessDenied(false)
            } else setAccessDenied(true)
          }).catch(() => setAccessDenied(true))
        else if (restoreGateRef.current)
          setRestorationError('Connection lost while restoring. Waiting to verify the current board.')
      },
    )
  }, [boardId, Boolean(initialData), historyIsLocal, accessDenied, Boolean(presentationConfig), setRestorationGate])

  useEffect(() => {
    if (!initialData || historyIsLocal || accessDenied || presentationConfig) return
    // The canvas has committed its initial render before this effect runs;
    // protected speaker-note history is intentionally outside the drawing path.
    const load = () => void workspaceApi.loadDeferredCloudNotes(boardId)
    load()
    window.addEventListener('online', load)
    return () => window.removeEventListener('online', load)
  }, [boardId, Boolean(initialData), historyIsLocal, accessDenied, Boolean(presentationConfig)])

  useEffect(() => {
    const retry = () => {
      if (restoreGateRef.current && restorationError) void restoreHydrateRef.current().catch(() => {})
    }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [restorationError])

  useEffect(() => {
    boardEpochRef.current++
    historyProtocolRef.current = false
    historyHeadRef.current = undefined
    setHistoryGeneration(undefined)
    setHistoryFence(undefined)
    setHistoryOpen(false)
    setRestorationGate(false)
    hasAutoZoomedRef.current = false
    sceneGenerationRef.current = undefined
    generationConflictRef.current = false
    setInitialData(null)
    setRecoveredSharedScene(null)
    documentRef.current = null
    setIsSharedBoard(false)
    ownedSyncBlockedRef.current = false
    canEditBoardRef.current = false
    setPresentationConfig(undefined)
    setAccessDenied(false)
    setBoardNotFound(false)
    setBoardLoadFailed(false)
    setState('Loading board')
    let active = true
    const localDetails = workspaceApi.loadBoardWithProject(boardId)
    Promise.all([
      localDetails,
      localDetails.then((details) => {
        // A deleted project's scene reads are intentionally denied. Its retained
        // owner draft must still mount in the explicit read-only recovery view.
        if (details?.document.syncStatus === 'sync-blocked') return { status: 'not-found' as const }
        return resolveBoardSharing(details?.project.ownerId, authUser?.uid, () =>
          sharingService.getSharedBoard(
            boardId,
            authUser?.email,
            authUser?.uid,
            details?.document.scene.files,
            details?.document.cloudRevisionId && details.document.cloudGeneration !== undefined
              ? { scene: details.document.scene, revisionId: details.document.cloudRevisionId, generation: details.document.cloudGeneration }
              : undefined,
          ),
        )
      }),
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
            // The access snapshot may resolve after the parent-project
            // listener has already marked this owner's local copy recoverable.
            // Recheck durable local status before replacing it with denial UI.
            const refreshed = await workspaceApi.loadBoardWithProject(boardId).catch(() => null)
            if (!active) return
            if (refreshed?.document.syncStatus !== 'sync-blocked') {
              setAccessDenied(true)
              return
            }
            details = refreshed
            setAccessDenied(false)
            setBoardNotFound(false)
          }
        }

        // Case 1: Board exists in Firebase (authoritative single source of truth)
        if (shared.status === 'allowed' && shared.config) {
          const config = shared.config
          setPresentationConfig(config.effectiveRole === 'presentation' ? config : undefined)
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
          const ownedGenerationConflict = Boolean(
            details?.document &&
            (details.document.syncStatus === 'conflict' ||
              (config.sceneGeneration !== undefined &&
                (details.document.cloudGeneration ?? 1) !== config.sceneGeneration &&
                details.document.syncStatus !== 'synced')),
          )
          if (!ownedGenerationConflict && details?.document?.scene?.elements?.length) {
            const mergedElements = reconcileElementsLWW(details.document.scene.elements, cloudScene.elements ?? [])
            finalScene = {
              ...cloudScene,
              elements: mergedElements,
              files: { ...cloudScene.files, ...details.document.scene.files },
            }
          }
          // Shared recipients have no owned workspace document. Recover only
          // after the server has authorized this identity to read the board.
          const uid = getFirebaseAuth()?.currentUser?.uid
          const draft = !details?.document && uid ? await readSharedSceneDraft(boardId, uid) : undefined
          if (!active) return
          const draftConflict = Boolean(
            draft && config.sceneGeneration !== undefined && (draft.generation ?? 1) !== config.sceneGeneration,
          )
          generationConflictRef.current = draftConflict || ownedGenerationConflict
          if (draft && !draftConflict) {
            finalScene = {
              ...finalScene,
              elements: reconcileElementsLWW(finalScene.elements, draft.scene.elements),
              files: { ...finalScene.files, ...draft.scene.files },
            }
          }
          // Local cloud descriptors must not replace already-hydrated bytes.
          finalScene = await restoreSceneAssets(finalScene, cloudScene.files)

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

          ownedSyncBlockedRef.current = details?.document?.syncStatus === 'sync-blocked'
          canEditBoardRef.current = canEdit
          setIsReadOnly(ownedSyncBlockedRef.current || !canEdit || generationConflictRef.current)
          if (draft && !draftConflict) setRecoveredSharedScene(finalScene)
          awaitingInitialSceneRef.current = true
          savedSignature.current = getSceneSignature(finalScene)
          committedSignatureRef.current = savedSignature.current
          filesRef.current = (finalScene.files ?? {}) as BinaryFiles
          elementsRef.current = finalScene.elements
          appStateRef.current = finalScene.appState

          // Update local IndexedDB with authoritative cloud/merged state
          documentRef.current = details?.document ?? null
          sceneGenerationRef.current = config.sceneGeneration
          if (
            details?.document &&
            !ownedSyncBlockedRef.current &&
            !ownedGenerationConflict &&
            config.sceneRevisionId &&
            config.sceneGeneration !== undefined
          ) {
            saveChainRef.current = saveChainRef.current
              .then(async () => {
                await workspaceStore.applyCloudBoardScene(
                  details.document.id,
                  finalScene,
                  config.sceneRevisionId!,
                  config.sceneGeneration!,
                  { expectedCloudRevisionId: details.document.cloudRevisionId },
                )
                if (active) documentRef.current = await workspaceApi.loadBoard(details.document.id)
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
              theme: resolvedThemeRef.current,
              viewBackgroundColor: finalScene.appState?.viewBackgroundColor || 'transparent',
            },
            libraryItems: Promise.resolve(libraryItems),
          })
          triggerAutoCenter()
          setState(
            ownedSyncBlockedRef.current
              ? 'Project deleted'
              : generationConflictRef.current
                ? 'Conflict'
                : draft
                  ? 'Saving'
                  : 'Synced',
          )
          return
        }

        // Case 2: Board only in local IndexedDB (freshly created prior to cloud sync)
        if (details) {
          const { document, project } = details
          canEditBoardRef.current = true
          if (document.syncStatus !== 'sync-blocked') document.scene = await restoreSceneAssets(document.scene)
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
          sceneGenerationRef.current = document.cloudGeneration
          filesRef.current = (document.scene.files ?? {}) as BinaryFiles
          elementsRef.current = document.scene.elements
          appStateRef.current = document.scene.appState
          savedSignature.current = getSceneSignature(document.scene)
          committedSignatureRef.current = savedSignature.current
          awaitingInitialSceneRef.current = true
          generationConflictRef.current = document.syncStatus === 'conflict'
          ownedSyncBlockedRef.current = document.syncStatus === 'sync-blocked'
          setIsReadOnly(document.syncStatus === 'sync-blocked' || generationConflictRef.current)
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
              theme: resolvedThemeRef.current,
              viewBackgroundColor: document.scene.appState.viewBackgroundColor || 'transparent',
            },
            libraryItems: Promise.resolve(libraryItems),
          })
          triggerAutoCenter()
          setState(shared.status === 'unavailable' ? 'Synced locally' : statusLabel(document.syncStatus))
          if (
            shared.status !== 'unavailable' &&
            authUser &&
            !authUser.isAnonymous &&
            !generationConflictRef.current &&
            !ownedSyncBlockedRef.current
          )
            void sharingService
              .syncBoardSceneToShare(boardId, document.scene, document.name, document.cloudGeneration)
              .catch(console.error)
          return
        }

        // Case 3: Board not found in Firebase and not in local IndexedDB
        setBoardNotFound(true)
      })
      .catch((error) => {
        console.error('Failed to load board:', error)
        if (active) setBoardLoadFailed(true)
      })
    return () => {
      active = false
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [boardId, authUser?.email, authUser?.uid, accessRevision])

  // A recipient may already have a restricted link open when invited. The
  // denied Firestore listener needs reauthorization, just like a revoked one.
  useEffect(() => {
    if (!accessDenied || isSharedBoard) return
    return sharingService.subscribeToSharedBoard(boardId, () => setAccessRevision((revision) => revision + 1))
  }, [boardId, accessDenied, isSharedBoard, authUser?.uid])

  useEffect(() => {
    if (!isSharedBoard) return
    const unsubscribe = sharingService.subscribeToSharedBoard(
      boardId,
      (updatedConfig) => {
        const generationChanged =
          sceneGenerationRef.current !== undefined &&
          updatedConfig.sceneGeneration !== undefined &&
          updatedConfig.sceneGeneration !== sceneGenerationRef.current
        setPresentationConfig(updatedConfig.effectiveRole === 'presentation' ? updatedConfig : undefined)
        const recoveringAccess = accessDeniedRef.current
        const userEmail = authUser?.email?.trim().toLowerCase()
        const userUid = authUser?.uid
        const stillAllowed =
          Boolean(updatedConfig.effectiveRole) ||
          updatedConfig.generalAccess === 'anyone_with_link' ||
          (userUid && updatedConfig.ownerId === userUid) ||
          (userEmail && updatedConfig.invitedEmails?.map((e) => e.toLowerCase()).includes(userEmail))

        if (!stillAllowed) {
          // A project deletion can revoke the shared-scene listener at the
          // same time the owner workspace records its recoverable local copy.
          // Honor that verified owner tombstone instead of replacing it with
          // the generic access-denied screen.
          void workspaceApi.loadBoardWithProject(boardId).then((refreshed) => {
            if (refreshed?.document.syncStatus === 'sync-blocked') {
              ownedSyncBlockedRef.current = true
              canEditBoardRef.current = false
              setIsReadOnly(true)
              setState('Project deleted')
              setAccessDenied(false)
              return
            }
            canEditBoardRef.current = false
            setIsReadOnly(true)
            setHistoryOpen(false)
            setAccessDenied(true)
          }).catch((error) => console.error('Failed to confirm local board access:', error))
          return
        }

        const isOwner = Boolean(userUid && updatedConfig.ownerId === userUid)
        const isGeneralEditor =
          updatedConfig.generalAccess === 'anyone_with_link' && updatedConfig.generalRole === 'editor'
        const isCollabEditor = Boolean(userEmail && updatedConfig.collaborators?.[userEmail]?.role === 'editor')
        const canEdit = updatedConfig.effectiveRole
          ? updatedConfig.effectiveRole === 'owner' || updatedConfig.effectiveRole === 'editor'
          : isOwner || isGeneralEditor || isCollabEditor
        canEditBoardRef.current = canEdit
        setIsReadOnly(ownedSyncBlockedRef.current || !canEdit || generationConflictRef.current)
        if (!canEdit) setHistoryOpen(false)
        // Policy changes apply immediately; replacement content remains fenced.
        if (historyProtocolRef.current && (generationChanged || restoreGateRef.current)) return
        if (generationChanged && (pendingSceneRef.current || isLazyCollabActiveRef.current)) {
          generationConflictRef.current = true
          setState('Conflict')
          setIsReadOnly(true)
          return
        }
        if (updatedConfig.sceneGeneration !== undefined) sceneGenerationRef.current = updatedConfig.sceneGeneration

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
          const reconciledElements = generationChanged
            ? (updatedConfig.scene.elements ?? [])
            : reconcileElementsLWW(elementsRef.current, updatedConfig.scene.elements ?? [])
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
        if (error?.code === 'permission-denied' || error?.code === 'functions/permission-denied') {
          void workspaceApi.loadBoardWithProject(boardId).then((local) => {
            if (local?.document.syncStatus === 'sync-blocked') {
              ownedSyncBlockedRef.current = true
              setState('Project deleted')
              setIsReadOnly(true)
              setAccessDenied(false)
            } else setAccessDenied(true)
          }).catch(() => setAccessDenied(true))
        }
      },
      () => filesRef.current as BoardScene['files'],
      () => {
        const document = documentRef.current
        return document?.cloudRevisionId && document.cloudGeneration !== undefined
          ? { scene: document.scene, revisionId: document.cloudRevisionId, generation: document.cloudGeneration }
          : undefined
      },
    )
    return () => unsubscribe()
  }, [boardId, isSharedBoard, authUser?.email, authUser?.uid])

  useEffect(() => {
    // Owned shared boards also need durable local hydration for offline reopen.
    if (
      !initialData ||
      (isSharedBoard && !documentRef.current) ||
      !authUser ||
      authUser.isAnonymous ||
      accessDenied ||
      state === 'Project deleted' ||
      boardNotFound
    )
      return
    return workspaceApi.subscribeToCloudScene(
      boardId,
      (document) => {
        if (
          historyProtocolRef.current &&
          (restoreGateRef.current ||
            (sceneGenerationRef.current !== undefined && document.cloudGeneration !== sceneGenerationRef.current))
        )
          return
        documentRef.current = document
        if (document.syncStatus === 'conflict') {
          generationConflictRef.current = true
          setState('Conflict')
          setIsReadOnly(true)
          return
        }
        const generationChanged =
          sceneGenerationRef.current !== undefined &&
          document.cloudGeneration !== undefined &&
          sceneGenerationRef.current !== document.cloudGeneration
        if (historyProtocolRef.current && (generationChanged || restoreGateRef.current)) return
        if (generationChanged && (pendingSceneRef.current || isLazyCollabActiveRef.current)) {
          generationConflictRef.current = true
          setState('Conflict')
          setIsReadOnly(true)
          return
        }
        sceneGenerationRef.current = document.cloudGeneration
        if (isLazyCollabActiveRef.current) return
        const elements = generationChanged
          ? document.scene.elements
          : reconcileElementsLWW(elementsRef.current, document.scene.elements)
        elementsRef.current = elements
        filesRef.current = { ...filesRef.current, ...document.scene.files } as BinaryFiles
        apiRef.current?.addFiles(Object.values(filesRef.current))
        apiRef.current?.updateScene({ elements: elements as any })
        if (!pendingSceneRef.current && document.syncStatus === 'synced') {
          savedSignature.current = getSceneSignature({ ...document.scene, elements, files: filesRef.current })
          committedSignatureRef.current = savedSignature.current
          setState('Synced')
        }
      },
      (error) => {
        if (ownedSyncBlockedRef.current) return
        if ((error as { code?: string })?.code === 'permission-denied') setAccessDenied(true)
        else console.error('Failed to refresh board scene:', error)
      },
    )
  }, [
    boardId,
    Boolean(initialData),
    isSharedBoard,
    authUser?.uid,
    accessDenied,
    boardNotFound,
    state === 'Project deleted',
  ])

  useEffect(() => {
    let active = true
    const applySyncStatus = (status: BoardSyncStatus) => {
      // Registered owned boards also have shared scenes. Their private project
      // lifecycle still blocks edits and retains pending bytes until restoration.
      if (isSharedBoard && status !== 'sync-blocked' && !ownedSyncBlockedRef.current) return
      ownedSyncBlockedRef.current = status === 'sync-blocked'
      if (status === 'conflict') generationConflictRef.current = true
      setState(statusLabel(status))
      setIsReadOnly(ownedSyncBlockedRef.current || generationConflictRef.current)
      if (ownedSyncBlockedRef.current) setAccessDenied(false)
    }
    const unsubscribe = workspaceApi.subscribeToBoardSyncStatus(boardId, applySyncStatus)
    // A project tombstone can arrive while the route is mounting, before its
    // event listener exists. Reconcile the persisted status so the board cannot
    // remain editable just because that one event was missed.
    void workspaceApi
      .loadBoard(boardId)
      .then((document) => {
        if (active && document?.syncStatus === 'sync-blocked') applySyncStatus('sync-blocked')
      })
      .catch((error) => console.error('Failed to reconcile board sync status:', error))
    return () => {
      active = false
      unsubscribe()
    }
  }, [boardId, isSharedBoard])

  const sendScene = useCallback(
    (elements = elementsRef.current, operationId?: string, result?: unknown) => {
      if (socketRef.current?.readyState !== WebSocket.OPEN) return
      const selected = appStateRef.current?.selectedElementIds as Record<string, boolean> | undefined
      const selectionIds = selected ? Object.keys(selected).filter((id) => selected[id]) : []
      socketRef.current.send(
        JSON.stringify({
          type: 'scene',
          boardId,
          operationId,
          scene: { elements, appState: appStateRef.current },
          selectionIds,
          result,
        }),
      )
    },
    [boardId],
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
    if (presentationConfig || accessDenied || boardNotFound || !initialData) return
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
        if (message.type !== 'operation') return
        const operation = message.operation
        if (slideDataOperations.has(operation.type)) {
          try {
            const data = await slideDataHandler.handle(operation, {
              boardId,
              projectId: boardMeta?.projectId ?? '',
              identity: authUser?.uid ?? 'local-user',
              role: isReadOnly
                ? 'viewer'
                : !isSharedBoardRef.current || boardMeta?.projectOwnerId === authUser?.uid
                  ? 'owner'
                  : 'editor',
              local: !isFirebaseConfigured || (!isSharedBoardRef.current && (!authUser || authUser.isAnonymous)),
              scene: {
                elements: elementsRef.current,
                files: apiRef.current?.getFiles() ?? {},
                background: String(appStateRef.current.viewBackgroundColor ?? '#ffffff'),
                theme: resolvedTheme,
              },
            })
            const sharedCurrentBoard =
              operation.type === 'share_board' && (!operation.boardId || operation.boardId === boardId)
            if (sharedCurrentBoard && !isSharedBoardRef.current) {
              // A board opened before its share registration completed still uses
              // private saves. Publish its current scene once, then use live shared saves.
              await sharingService.updateSharedScene(
                boardId,
                {
                  elements: elementsRef.current,
                  files: apiRef.current?.getFiles() ?? {},
                  appState: {
                    theme: resolvedTheme,
                    viewBackgroundColor: appStateRef.current.viewBackgroundColor,
                    gridModeEnabled: appStateRef.current.gridModeEnabled,
                    objectsSnapModeEnabled: appStateRef.current.objectsSnapModeEnabled,
                  },
                },
                sceneGenerationRef.current,
              )
            }
            sendOperationResult(operation.id, true, data)
            if (sharedCurrentBoard) {
              isSharedBoardRef.current = true
              setIsSharedBoard(true)
            }
          } catch (error) {
            sendOperationResult(operation.id, false, undefined, error instanceof Error ? error.message : String(error))
          }
          return
        }
        if (isReadOnly || restoreGateRef.current || !apiRef.current) {
          sendOperationResult(
            operation.id,
            false,
            undefined,
            'Canvas mutations require editor access and a mounted editor.',
          )
          return
        }
        userHasInteractedRef.current = true
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
            patches.has(element.id) ? newElementWith(element, patches.get(element.id) as any) : element,
          )
          elementsRef.current = next
          apiRef.current.updateScene({ elements: next })
          sendScene(next, operation.id)
        } else if (operation.type === 'create_slide') {
          try {
            const slideId = createSlide(apiRef.current, operation)
            const elements = [...apiRef.current.getSceneElementsIncludingDeleted()]
            elementsRef.current = elements
            sendScene(elements, operation.id, {
              boardId,
              slide: describeSlides({ elements, files: {}, background: '#ffffff', theme: resolvedTheme }).find(
                (slide) => slide.id === slideId,
              ),
            })
          } catch (error) {
            sendOperationResult(operation.id, false, undefined, error instanceof Error ? error.message : String(error))
          }
        } else if (operation.type === 'slide_command') {
          const slide = getSlides(apiRef.current.getSceneElements()).find((entry) => entry.id === operation.slideId)
          if (!slide) sendOperationResult(operation.id, false, null, 'Slide not found.')
          else {
            if (operation.action === 'duplicate') {
              const copiedId = duplicateSlide(apiRef.current, slide.id)
              if (copiedId)
                void copySlideNotes(
                  {
                    identity: authUser?.uid || 'local-user',
                    boardId,
                    projectId: boardMeta?.projectId || '',
                    cloud: Boolean(
                      isFirebaseConfigured && (isSharedBoardRef.current || (authUser && !authUser.isAnonymous)),
                    ),
                  },
                  slide.id,
                  copiedId,
                ).catch(console.error)
            } else if (operation.action === 'earlier' || operation.action === 'later') {
              commitSlideCommand(apiRef.current, {
                type: 'move',
                id: slide.id,
                offset: operation.action === 'earlier' ? -1 : 1,
              })
            } else if (operation.action === 'move_before' || operation.action === 'move_after') {
              if (!getSlides(apiRef.current.getSceneElements()).some((entry) => entry.id === operation.targetSlideId)) {
                sendOperationResult(operation.id, false, undefined, 'Target slide not found.')
                operationRef.current = null
                return
              }
              commitSlideCommand(apiRef.current, {
                type: 'place',
                id: slide.id,
                targetId: operation.targetSlideId,
                after: operation.action === 'move_after',
              })
            } else if (operation.action === 'remove')
              commitSlideCommand(apiRef.current, { type: 'remove', id: slide.id })
            else {
              sendOperationResult(operation.id, false, null, 'Unsupported slide command.')
              return
            }
            sendScene([...apiRef.current.getSceneElementsIncludingDeleted()], operation.id)
          }
        } else if (operation.type === 'delete_elements') {
          const ids = new Set(operation.ids)
          next = next.map((element) => (ids.has(element.id) ? newElementWith(element, { isDeleted: true }) : element))
          elementsRef.current = next
          apiRef.current.updateScene({ elements: next })
          sendScene(next, operation.id)
        } else if (operation.type === 'clear_canvas') {
          const clearedCount = next.filter((e) => !e.isDeleted).length
          next = next.map((element) => newElementWith(element, { isDeleted: true }))
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
      } else {
        sendScene()
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
  }, [
    isReadOnly,
    sendScene,
    authUser,
    boardId,
    boardMeta?.projectId,
    Boolean(presentationConfig),
    accessDenied,
    boardNotFound,
    Boolean(initialData),
    slideDataHandler,
    resolvedTheme,
  ])

  /** Queue persistence for the captured board; late completions cannot mutate another editor. */
  const enqueueSceneSave = useCallback(
    (scene: BoardScene) => {
      const expectedGeneration = sceneGenerationRef.current
      const queuedDocument = documentRef.current
      const epoch = boardEpochRef.current
      const queuedUid = getFirebaseAuth()?.currentUser?.uid
      const interacted = userHasInteractedRef.current
      const checkIdentity = () => {
        if (getFirebaseAuth()?.currentUser?.uid !== queuedUid) throw new BoardContextChangedError()
        if (epoch !== boardEpochRef.current || restoreGateRef.current) throw new BoardContextChangedError()
      }
      const task = saveChainRef.current
        .then(async () => {
          checkIdentity()
          if (epoch !== boardEpochRef.current) throw new BoardContextChangedError()
          assertHistoryMutationAllowed(boardId)
          const document = queuedDocument
          if (document) {
            if (document.id !== boardId) throw new BoardContextChangedError()
            const latest = await workspaceApi.loadBoard(boardId)
            checkIdentity()
            if (latest?.cloudGeneration !== undefined && (expectedGeneration ?? 1) !== latest.cloudGeneration)
              throw new SceneGenerationError()
            const docToSave = {
              ...(latest ?? document),
              scene,
              revision: document.revision,
              cloudGeneration: expectedGeneration ?? document.cloudGeneration,
            }
            const saved = await workspaceApi.saveBoard(docToSave)
            checkIdentity()
            if (epoch === boardEpochRef.current) {
              documentRef.current = saved
              committedSignatureRef.current = getSceneSignature(saved.scene)
              setBoardMeta((prev) => (prev ? { ...prev, updatedAt: saved.updatedAt } : prev))
            }
            // The loaded board already established whether a share exists.
            // Avoid an extra Firestore existence read on every drag/save.
            if (isSharedBoard) await sharingService.updateSharedScene(boardId, scene, expectedGeneration)
            queryClient.invalidateQueries({ queryKey: ['workspace'] })
            if (epoch === boardEpochRef.current) setState(isSharedBoard ? 'Synced' : statusLabel(saved.syncStatus))
            return
          }

          if (!interacted && scene.elements.length === 0) {
            return
          }

          const uid = getFirebaseAuth()?.currentUser?.uid
          if (!uid) throw new Error('Shared edits require an authenticated guest session.')
          await draftChainRef.current
          checkIdentity()
          const draft = await saveSharedSceneDraft(boardId, uid, scene, expectedGeneration)
          checkIdentity()
          await baselineInFlightRef.current
          if (epoch !== boardEpochRef.current) throw new BoardContextChangedError()
          assertHistoryMutationAllowed(boardId)
          let baseline = await boardHistoryStore.getCommittedContent(boardId)
          checkIdentity()
          if (epoch !== boardEpochRef.current || restoreGateRef.current) throw new BoardContextChangedError()
          if (historyProtocolRef.current) {
            // A public-link editor may have no owner workspace row to seed
            // history during hydration. Before its first mutation, bind a
            // complete authoritative cloud snapshot (including readable
            // notes) as the local base so the save cannot silently skip
            // version capture or overwrite protected note content.
            if (!baseline) {
              const snapshot = await readHistorySnapshot(boardId, undefined, false, true)
              checkIdentity()
              if (epoch !== boardEpochRef.current || restoreGateRef.current) throw new BoardContextChangedError()
              const now = new Date().toISOString()
              await boardHistoryStore.initialize({
                id: boardId,
                projectId: boardMeta?.projectId ?? '',
                name: snapshot.entry.name,
                active: true,
                createdAt: boardMeta?.createdAt || now,
                updatedAt: boardMeta?.updatedAt || now,
                syncStatus: 'synced',
                revision: 0,
                baseRevision: 0,
                cloudRevisionId: snapshot.revisionId,
                cloudGeneration: snapshot.generation,
                cloudVersionId: snapshot.currentVersionId ?? undefined,
                cloudRestoreFence: snapshot.restoreFence ?? 0,
                cloudNameRevision: snapshot.nameRevision ?? 0,
                syncAttempts: 0,
                nextSyncAt: null,
                lastSyncError: null,
                formatVersion: 1,
                scene: snapshot.scene,
              }, snapshot.notes)
              baseline = await boardHistoryStore.getCommittedContent(boardId)
            }
            if (!baseline) throw new Error('Load the complete board history before saving.')
            await boardHistoryStore.save(
              { ...baseline.document, scene: draft.scene },
              {
                changedFields: { scene: true },
                expectedFence: historyHeadRef.current?.restoreFence ?? 0,
                sourceBaseVersionId: historyHeadRef.current?.currentVersionId,
              },
            )
            window.dispatchEvent(new CustomEvent('board-history-local-save', { detail: { boardId } }))
          }
          await sharingService.updateSharedScene(boardId, draft.scene, draft.generation)
          if (epoch !== boardEpochRef.current || restoreGateRef.current) throw new BoardContextChangedError()
          await acknowledgeSharedSceneDraft(draft)
          if (epoch === boardEpochRef.current) {
            committedSignatureRef.current = getSceneSignature(draft.scene)
            setState('Synced')
          }
        })
        .catch((error) => {
          if (epoch !== boardEpochRef.current || getFirebaseAuth()?.currentUser?.uid !== queuedUid)
            throw new BoardContextChangedError()
          throw error
        })

      // Keep the queue live after an error while preserving that error for the caller.
      saveChainRef.current = task.catch(() => {})
      return task
    },
    [boardId, isSharedBoard, queryClient],
  )

  const handleSaveFailure = useCallback(
    (scene: BoardScene, error: unknown) => {
      if (error instanceof BoardContextChangedError) return
      pendingSceneRef.current ??= scene
      console.error('Failed to save scene:', error)
      if (
        error instanceof SceneGenerationError ||
        (error instanceof Error && error.message === 'BOARD_GENERATION_CONFLICT')
      ) {
        generationConflictRef.current = true
        setState('Conflict')
        if (historyProtocolRef.current) {
          setRestorationGate(true)
          void restoreHydrateRef.current().catch(() => {})
          return
        }
        setIsReadOnly(true)
        return
      }
      setState(documentRef.current ? 'Local save failed' : 'Sync failed')
    },
    [setRestorationGate],
  )

  useEffect(() => {
    if (!recoveredSharedScene || !initialData || isReadOnly || accessDenied) return
    const scene = recoveredSharedScene
    setRecoveredSharedScene(null)
    pendingSceneRef.current = scene
    void enqueueSceneSave(scene)
      .then(() => {
        if (pendingSceneRef.current === scene) pendingSceneRef.current = null
      })
      .catch((error) => handleSaveFailure(scene, error))
  }, [recoveredSharedScene, initialData, isReadOnly, accessDenied, enqueueSceneSave, handleSaveFailure])

  const flushSave = useCallback(async () => {
    if (isReadOnly || restoreGateRef.current) return
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

  useEffect(() => {
    if (!initialData) return
    return scheduleWhiteboardFontPreload()
  }, [initialData])

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
      if (isReadOnly || isTransitioningCollab || restoreGateRef.current) return
      pendingSceneRef.current = scene
      // Journal bytes immediately; the network save remains debounced.
      const uid = getFirebaseAuth()?.currentUser?.uid
      const generation = sceneGenerationRef.current
      if (!documentRef.current && uid) {
        draftChainRef.current = draftChainRef.current
          .catch(() => {})
          .then(() => saveSharedSceneDraft(boardId, uid, scene, generation))
        void draftChainRef.current.catch((error) => handleSaveFailure(scene, error))
      }
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      setState('Saving')
      saveTimer.current = window.setTimeout(async () => {
        saveTimer.current = undefined
        if (restoreGateRef.current) return
        pendingSceneRef.current = null
        try {
          await enqueueSceneSave(scene)
        } catch (error) {
          handleSaveFailure(scene, error)
        }
      }, 450)
    },
    [boardId, enqueueSceneSave, handleSaveFailure, isReadOnly, isTransitioningCollab],
  )

  useEffect(() => {
    if (!restorationBlocked && pendingSceneRef.current && !isReadOnly) scheduleSave(pendingSceneRef.current)
  }, [restorationBlocked, isReadOnly, scheduleSave])

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
      // Slides have derived numbers, so the native Frame title editor does not apply.
      if (
        appState.editingFrame &&
        elements.some((element) => element.id === appState.editingFrame && slideMetadata(element))
      ) {
        apiRef.current?.updateScene({ appState: { editingFrame: null } })
      }
      // Read-only clients and remote updates still publish current slide content.
      sceneSession.publish(elements as any, appState as any, files)
      if (isReadOnly || isTransitioningCollab || restoreGateRef.current) return
      elementsRef.current = [...elements]
      filesRef.current = files
      appStateRef.current = { ...appStateRef.current, selectedElementIds: appState.selectedElementIds }
      if (applyingRemoteSceneRef.current) return
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
        if (!hasAutoZoomedRef.current) {
          triggerAutoCenter()
        }
        // A fast image-picker interaction can precede Excalidraw's first
        // normalized onChange. Preserve that edit instead of absorbing it.
        if (!userHasInteractedRef.current) {
          savedSignature.current = signature
          committedSignatureRef.current ??= signature
          return
        }
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
      // Excalidraw's onChange element list may omit deleted elements. RTDB
      // collaboration must still receive their tombstones so peers cannot
      // resurrect stale copies, and can apply a later undo as a newer update.
      broadcastChanges(apiRef.current?.getSceneElementsIncludingDeleted?.() ?? elements)

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
      sceneSession,
    ],
  )

  const canImportRef = useRef(false)
  canImportRef.current = Boolean(
    initialData &&
    !isReadOnly &&
    !isSpectator &&
    !isTransitioningCollab &&
    !accessDenied &&
    !presentationConfig &&
    !boardNotFound,
  )
  const importSceneFile = useCallback(
    async (file: File) => {
      const api = apiRef.current
      if (!api || !canImportRef.current || restoreGateRef.current) return
      const epoch = boardEpochRef.current
      const request = ++importRequestRef.current
      const uid = getFirebaseAuth()?.currentUser?.uid
      const generation = sceneGenerationRef.current
      setImportError(null)
      try {
        // Passing no local elements keeps the file's bindings and dependencies intact.
        // Replacement versions are derived from the latest canvas after parsing.
        const imported = await loadFromBlob(file, api.getAppState(), null)
        if (
          epoch !== boardEpochRef.current ||
          request !== importRequestRef.current ||
          uid !== getFirebaseAuth()?.currentUser?.uid ||
          generation !== sceneGenerationRef.current ||
          !canImportRef.current ||
          restoreGateRef.current ||
          api !== apiRef.current
        )
          return
        const elements = replaceSceneElements(api.getSceneElementsIncludingDeleted(), imported.elements ?? [])
        const files = { ...api.getFiles(), ...imported.files }
        userHasInteractedRef.current = true
        awaitingInitialSceneRef.current = false
        appStateRef.current = { ...appStateRef.current, ...imported.appState }
        api.addFiles(Object.values(files))
        api.updateScene({
          elements,
          appState: { ...imported.appState, theme: resolvedTheme },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        })
        onChange(elements, api.getAppState(), files)
        api.scrollToContent(
          elements.filter((element) => !element.isDeleted),
          { fitToContent: true },
        )
      } catch (error) {
        if (epoch === boardEpochRef.current && request === importRequestRef.current)
          setImportError(error instanceof Error ? error.message : 'Could not open this board file.')
      }
    },
    [onChange, resolvedTheme],
  )

  useEffect(() => {
    const openFile = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o' && canImportRef.current) {
        event.preventDefault()
        event.stopImmediatePropagation()
        importInputRef.current?.click()
      }
    }
    window.addEventListener('keydown', openFile, { capture: true })
    return () => window.removeEventListener('keydown', openFile, { capture: true })
  }, [])

  const hasUnsavedChanges =
    !isReadOnly &&
    !presentationConfig &&
    !accessDenied &&
    (state === 'Saving' ||
      state === 'Sync failed' ||
      state === 'Local save failed' ||
      state === 'Conflict' ||
      pendingSceneRef.current !== null ||
      (!isSharedBoard && Boolean(authUser && !authUser.isAnonymous) && state === 'Synced locally'))

  const hasUnsavedChangesRef = useRef(hasUnsavedChanges)
  hasUnsavedChangesRef.current = hasUnsavedChanges

  useEffect(() => {
    if (initialData?.elements && initialData.elements.length > 0 && !hasAutoZoomedRef.current) {
      triggerAutoCenter()
    }
  }, [initialData, triggerAutoCenter])

  useEffect(() => {
    if (isReadOnly || presentationConfig || accessDenied) return
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      void flushSave()
      if (hasUnsavedChangesRef.current) {
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
  }, [flushSave, isReadOnly, Boolean(presentationConfig), accessDenied])

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

  // Header and Slides share one board-access dialog.
  const shareDialog = boardMeta && (
    <ShareModal
      open={isShareModalOpen && !boardNotFound && (!accessDenied || boardMeta.projectOwnerId === authUser?.uid)}
      onOpenChange={setIsShareModalOpen}
      onShareConfigSaved={() => setIsSharedBoard(true)}
      boardId={boardId}
      boardName={boardMeta.boardName}
      ownerId={boardMeta.projectOwnerId}
      scene={{ elements: elementsRef.current, appState: appStateRef.current, files: filesRef.current }}
    />
  )
  const withShareDialog = (content: ReactNode) => (
    <>
      {content}
      {shareDialog}
      {historySource ? (
        <Suspense fallback={null}>
          <HistoryDialog
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            source={historySource}
            canRestore={!isReadOnly && !accessDenied && !presentationConfig && !restorationBlocked}
            isDirty={async () =>
              Boolean(
                pendingSceneRef.current ||
                isEditingName ||
                (!historyIsLocal && documentRef.current && documentRef.current.syncStatus !== 'synced') ||
                (await hasDirtyBoardNotes(noteIdentity, boardId)) ||
                (!historyIsLocal && (await boardHistoryStore.listOutbox(boardId)).length),
              )
            }
            onRestoreStart={() => setRestorationGate(true)}
            onRestoreComplete={() => restoreHydrateRef.current()}
            onRestoreFailed={() => {
              if (historyIsLocal) {
                setRestorationGate(false)
                return
              }
              const db = getFirestoreDb()
              if (db)
                void recoverPendingCloudRestore(boardId)
                  .then(() => getDocFromServer(doc(db, 'boardScenes', boardId)))
                  .then((snapshot) => {
                    const head = snapshot.data()
                    if (head && !head.restoreOperationId && head.generation === sceneGenerationRef.current)
                      setRestorationGate(false)
                    else if (head) {
                      historyHeadRef.current = head as any
                      if (!head.restoreOperationId) void restoreHydrateRef.current().catch(() => {})
                    }
                  })
                  .catch(() =>
                    setRestorationError(
                      'Could not verify restore status. Editing remains paused until the board is verified.',
                    ),
                  )
            }}
          />
        </Suspense>
      ) : null}
      <RestorationProgress
        open={restorationBlocked}
        error={restorationError || undefined}
        onRetry={() => void restoreHydrateRef.current().catch(() => {})}
      />
    </>
  )

  if (presentationConfig && !accessDenied) return <PresentationView boardId={boardId} config={presentationConfig} />

  if (accessDenied) {
    const isUserSignedIn = Boolean((authUser && !authUser.isAnonymous) || isSwitchingAccount)
    const displayEmail = isSwitchingAccount ? (lastUserEmailRef.current ?? authUser?.email) : authUser?.email

    return withShareDialog(
      <AccessDenied
        email={displayEmail}
        signedIn={isUserSignedIn}
        busy={isSigningIn || isSwitchingAccount}
        onSignIn={handleSignIn}
        onSwitchAccount={handleSwitchAccount}
      />,
    )
  }

  if (boardNotFound) {
    return withShareDialog(
      <div className="access-denied-container">
        <div className="access-denied-card animate-scale-in">
          <h2 className="access-denied-title">Board not found</h2>
          <p className="access-denied-desc">The board you are looking for does not exist or may have been deleted.</p>
          <Link to="/" className="google-share-done-btn" style={{ textDecoration: 'none' }}>
            Go to workspace
          </Link>
        </div>
      </div>,
    )
  }

  if (!initialData && boardLoadFailed) {
    return withShareDialog(
      <div className="access-denied-container">
        <div className="access-denied-card">
          <h2 className="access-denied-title">Could not load board</h2>
          <p className="access-denied-desc">Check your connection and try again. Your local data has been kept.</p>
          <button className="google-share-done-btn" onClick={() => setAccessRevision((revision) => revision + 1)}>
            Retry
          </button>
        </div>
      </div>,
    )
  }
  if (!initialData) return withShareDialog(<BoardLoading />)

  return withShareDialog(
    <main ref={editorShellRef} className="editor-shell">
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
              </>
            ) : (
              <>
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

            {isReadOnly && state !== 'Project deleted' ? (
              <BoardInfoDropdown
                boardName={boardMeta?.boardName || 'Untitled'}
                createdAt={boardMeta?.createdAt}
                updatedAt={boardMeta?.updatedAt}
                projectOwnerId={boardMeta?.projectOwnerId}
                projectOwnerName={boardMeta?.projectOwnerName}
                projectOwnerEmail={boardMeta?.projectOwnerEmail}
                getSceneSize={getSceneSize}
              />
            ) : (
              <SyncStatusDropdown
                state={state}
                boardId={boardId}
                cloudHistoryEnabled={!historyIsLocal}
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
        <div
          className="board-canvas"
          onDropCapture={(event) => {
            const file = Array.from(event.dataTransfer.files).find((item) => /\.(excalidraw|json)$/i.test(item.name))
            if (!file) return
            event.preventDefault()
            event.stopPropagation()
            void importSceneFile(file)
          }}
        >
          <input
            ref={importInputRef}
            type="file"
            accept=".excalidraw,.json,.png,.svg"
            aria-label="Import board file"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) void importSceneFile(file)
            }}
          />
          {importError && <div role="alert">{importError}</div>}
          <Excalidraw
            key={`${boardId}:${canvasEpoch}`}
            theme={resolvedTheme}
            initialData={{
              ...initialData,
              appState: { ...initialData.appState, defaultSidebarDockedPreference: readSidebarPinned() },
            }}
            onChange={onChange}
            onPointerUpdate={onPointerUpdate}
            frameTool={slideFrameTool}
            getFrameLabel={slideLabel}
            onDuplicate={(next, previous) => {
              const known = new Set(previous.map((element) => element.id))
              for (const copy of getSlides(next).filter((slide) => !known.has(slide.id))) {
                const source = getSlides(previous).find(
                  (slide) => slideMetadata(slide)!.orderKey === slideMetadata(copy)!.orderKey,
                )
                if (source)
                  void copySlideNotes(
                    {
                      identity: authUser?.uid || 'local-user',
                      boardId,
                      projectId: boardMeta?.projectId || '',
                      cloud: Boolean(isFirebaseConfigured && (isSharedBoard || (authUser && !authUser.isAnonymous))),
                    },
                    source.id,
                    copy.id,
                  ).catch(console.error)
              }
              return normalizeDuplicatedSlides(next, previous)
            }}
            viewModeEnabled={isReadOnly || isSpectator || isTransitioningCollab || restorationBlocked}
            detectScroll
            autoFocus={!isShareModalOpen && !historyOpen && !restorationBlocked}
            handleKeyboardGlobally={!isShareModalOpen && !isSlideStageOpen && !historyOpen && !restorationBlocked}
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
                loadScene: false,
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
              {!isReadOnly && !isSpectator && (
                <MainMenu.Item onSelect={() => importInputRef.current?.click()}>Open file</MainMenu.Item>
              )}
              {!isReadOnly && !isSpectator && <MainMenu.DefaultItems.SaveToActiveFile />}
              <MainMenu.DefaultItems.Export />
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.DefaultItems.SearchMenu />
              <MainMenu.DefaultItems.Help />
              {!isReadOnly && !isSpectator && <MainMenu.DefaultItems.ClearCanvas />}
              {!isReadOnly && !isSpectator && <MainMenu.Separator />}
              {!isReadOnly && !isSpectator && <MainMenu.DefaultItems.ChangeCanvasBackground />}
            </MainMenu>
            <SlidesPanel
              key={`${boardId}:${canvasEpoch}`}
              onSharePresentation={() => setIsShareModalOpen(true)}
              footerActions={
                <>
                  {!isReadOnly && !presentationConfig && (historySource || !historyIsLocal) && (
                    <button
                      type="button"
                      className="sidebar-trigger board-panel-button"
                      data-testid="board-history-open"
                      aria-label="Board history"
                      onClick={() => setHistoryOpen(true)}
                      disabled={restorationBlocked || !historySource}
                      title={historySource ? 'Board history' : 'Board history requires a server update'}
                    >
                      <History size={19} />
                    </button>
                  )}
                </>
              }
              session={sceneSession}
              containerRef={editorShellRef}
              apiRef={apiRef}
              boardId={boardId}
              projectId={boardMeta?.projectId || ''}
              identity={
                boardMeta?.projectOwnerId === 'local-user'
                  ? 'local-user'
                  : authUser?.uid || getFirebaseAuth()?.currentUser?.uid || 'local-user'
              }
              cloud={Boolean(
                isFirebaseConfigured &&
                boardMeta?.projectOwnerId !== 'local-user' &&
                (authUser || getFirebaseAuth()?.currentUser),
              )}
              canEdit={!isReadOnly && !isSpectator && !isTransitioningCollab && !accessDenied && !restorationBlocked}
              onInteraction={markSlideInteraction}
              onStageChange={setIsSlideStageOpen}
            />
          </Excalidraw>
        </div>
      )}
    </main>,
  )
}
