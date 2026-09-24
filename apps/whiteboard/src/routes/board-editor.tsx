import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useParams, useBlocker } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Eye, Lock, Pencil, Share2 } from 'lucide-react'
import { convertToExcalidrawElements, Excalidraw, MainMenu } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { BoardDocument, BoardScene, BoardSyncStatus } from '@agentic-whiteboard/storage'
import { workspaceApi } from '../features/workspace/workspace-api'
import { useTheme } from '../lib/theme-context'
import { useAuth } from '../lib/auth-context'
import { BoardInfoDropdown } from '../components/board-info-dropdown'
import { SyncStatusDropdown } from '../components/sync-status-dropdown'
import { ShareModal } from '../components/share-modal'
import { sharingService } from '../features/sharing/sharing-service'

const LIBRARY_STORAGE_KEY = 'agentic-whiteboard:library:v1'
const starterLibraries = [
  'https://libraries.excalidraw.com/libraries/youritjang/software-architecture.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/rohanp/system-design.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/childishgirl/aws-architecture-icons.excalidrawlib',
]

type EditorStatus = 'Loading board' | 'Saving' | 'Synced locally' | 'Synced' | 'Sync failed' | 'Conflict' | 'Local save failed'
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
  const horizontal = Math.min(80, Math.max(32, Math.round(w * 0.08)))
  const vertical = Math.min(80, Math.max(32, Math.round(h * 0.08)))
  return {
    top: vertical,
    bottom: vertical,
    left: horizontal,
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

export function BoardEditor() {
  const { boardId } = useParams({ from: '/boards/$boardId' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { resolvedTheme } = useTheme()
  const { user: authUser, signInWithGoogle, signOutUser } = useAuth()
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const documentRef = useRef<BoardDocument | null>(null)
  const elementsRef = useRef<any[]>([])
  const appStateRef = useRef<Record<string, unknown>>({})
  const socketRef = useRef<WebSocket | null>(null)
  const operationRef = useRef<string | null>(null)
  const saveTimer = useRef<number>()
  const savedSignature = useRef<string>()
  const pendingSceneRef = useRef<BoardScene | null>(null)
  const awaitingInitialSceneRef = useRef(true)
  const hasAutoZoomedRef = useRef(false)
  const [state, setState] = useState<EditorStatus>('Loading board')

  const zoomToContentWithPadding = useCallback(
    (api: ExcalidrawImperativeAPI, elements?: readonly any[], animate = false) => {
      const targetElements = (elements ?? api.getSceneElements()).filter((e) => !e.isDeleted)
      if (targetElements.length === 0) return
      const appState = api.getAppState()
      const offsets = getCanvasOffsets(appState.width, appState.height)
      api.scrollToContent(targetElements, {
        fitToContent: true,
        animate,
        maxZoom: 1,
        canvasOffsets: offsets,
      })
    },
    [],
  )
  const [isReadOnly, setIsReadOnly] = useState(false)
  const [isSharedBoard, setIsSharedBoard] = useState(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const [boardNotFound, setBoardNotFound] = useState(false)
  const [isShareModalOpen, setIsShareModalOpen] = useState(false)
  const [isCopyingBoard, setIsCopyingBoard] = useState(false)
  const [boardMeta, setBoardMeta] = useState<{
    boardName: string
    projectId: string
    projectName: string
    projectOwnerId?: string
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
        void sharingService.syncBoardSceneToShare(boardId, saved.scene, trimmed)
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

  const [navSlot, setNavSlot] = useState<HTMLElement | null>(null)
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setNavSlot(document.getElementById('header-nav-slot'))
    setStatusSlot(document.getElementById('header-status-slot'))
  }, [])

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
    libraryItems: Promise<any[]>
  } | null>(null)

  useEffect(() => {
    hasAutoZoomedRef.current = false
    let active = true
    Promise.all([workspaceApi.loadBoardWithProject(boardId), loadLibraryItems()])
      .then(async ([details, libraryItems]) => {
        if (!active) return
        if (details) {
          const { document, project } = details
          documentRef.current = document
          elementsRef.current = document.scene.elements
          appStateRef.current = document.scene.appState
          savedSignature.current = JSON.stringify(document.scene)
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
            elements: document.scene.elements,
            appState: {
              ...document.scene.appState,
              theme: resolvedTheme,
              viewBackgroundColor: document.scene.appState.viewBackgroundColor || 'transparent',
            },
            libraryItems: Promise.resolve(libraryItems),
          })
          setState(statusLabel(document.syncStatus))
        } else {
          // Board not found in local workspace; check remote share permissions
          const shared = await sharingService.getSharedBoard(boardId, authUser?.email, authUser?.uid)
          if (!active) return

          if (shared.status === 'not-found') {
            setBoardNotFound(true)
            return
          }
          if (shared.status === 'restricted') {
            setAccessDenied(true)
            return
          }
          if (shared.status === 'allowed' && shared.config) {
            const config = shared.config
            const sharedScene = config.scene ?? {
              elements: [],
              appState: { viewBackgroundColor: 'transparent' },
            }
            setIsSharedBoard(true)

            const isOwner = Boolean(
              (authUser?.uid && config.ownerId === authUser.uid) ||
              (config.ownerId === 'local-user' && !authUser)
            )
            const isGeneralEditor =
              config.generalAccess === 'anyone_with_link' && config.generalRole === 'editor'
            const userEmail = authUser?.email?.trim().toLowerCase()
            const isCollabEditor = Boolean(
              userEmail && config.collaborators?.[userEmail]?.role === 'editor',
            )
            const canEdit = isOwner || isGeneralEditor || isCollabEditor

            setIsReadOnly(!canEdit)
            awaitingInitialSceneRef.current = true
            savedSignature.current = JSON.stringify(sharedScene)
            elementsRef.current = sharedScene.elements
            appStateRef.current = sharedScene.appState
            setBoardMeta({
              boardName: config.boardName,
              projectId: '',
              projectName: 'Shared board',
              projectOwnerId: config.ownerId,
              createdAt: config.createdAt,
              updatedAt: config.updatedAt,
            })
            setInitialData({
              elements: sharedScene.elements,
              appState: {
                ...sharedScene.appState,
                theme: resolvedTheme,
                viewBackgroundColor: sharedScene.appState?.viewBackgroundColor || 'transparent',
              },
              libraryItems: Promise.resolve(libraryItems),
            })
            setState('Synced')
          }
        }
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
        const userEmail = authUser?.email?.trim().toLowerCase()
        const userUid = authUser?.uid
        const stillAllowed =
          updatedConfig.generalAccess === 'anyone_with_link' ||
          (userUid && updatedConfig.ownerId === userUid) ||
          (userEmail &&
            updatedConfig.invitedEmails?.map((e) => e.toLowerCase()).includes(userEmail))

        if (!stillAllowed) {
          setAccessDenied(true)
          return
        }

        const isOwner = Boolean(userUid && updatedConfig.ownerId === userUid)
        const isGeneralEditor =
          updatedConfig.generalAccess === 'anyone_with_link' && updatedConfig.generalRole === 'editor'
        const isCollabEditor = Boolean(
          userEmail && updatedConfig.collaborators?.[userEmail]?.role === 'editor',
        )
        const canEdit = isOwner || isGeneralEditor || isCollabEditor
        setIsReadOnly(!canEdit)

        setBoardMeta((prev) =>
          prev
            ? {
                ...prev,
                boardName: updatedConfig.boardName,
                updatedAt: updatedConfig.updatedAt,
              }
            : prev,
        )

        if (updatedConfig.scene && !pendingSceneRef.current) {
          const newSignature = JSON.stringify(updatedConfig.scene)
          if (newSignature !== savedSignature.current) {
            savedSignature.current = newSignature
            elementsRef.current = updatedConfig.scene.elements
            appStateRef.current = updatedConfig.scene.appState
            apiRef.current?.updateScene({
              elements: updatedConfig.scene.elements as any,
            })
          }
        }
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
    (elements = elementsRef.current, operationId?: string) => {
      if (isReadOnly) return
      if (socketRef.current?.readyState !== WebSocket.OPEN) return
      socketRef.current.send(
        JSON.stringify({
          type: 'scene',
          operationId,
          scene: { elements, appState: appStateRef.current },
          selectionIds: [],
        }),
      )
    },
    [isReadOnly],
  )

  useEffect(() => {
    if (isReadOnly) return
    let disposed = false
    let retryId: number | undefined
    const connect = () => {
      const socket = new WebSocket(import.meta.env.VITE_MCP_BRIDGE_URL ?? 'ws://127.0.0.1:8787')
      socketRef.current = socket
      socket.onopen = () => sendScene()
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data) as { type?: string; operation?: any }
        if (message.type !== 'operation' || !apiRef.current) return
        const operation = message.operation
        operationRef.current = operation.id
        const wasEmpty = elementsRef.current.length === 0
        let next = elementsRef.current
        if (operation.type === 'add_elements')
          next = [...next, ...convertToExcalidrawElements(operation.elements, { regenerateIds: true })]
        if (operation.type === 'update_elements') {
          const patches = new Map(operation.patches.map((patch: any) => [patch.id, patch.changes]))
          next = next.map((element) =>
            patches.has(element.id) ? { ...element, ...(patches.get(element.id) as Record<string, unknown>) } : element,
          )
        }
        if (operation.type === 'delete_elements') {
          const ids = new Set(operation.ids)
          next = next.map((element) => (ids.has(element.id) ? { ...element, isDeleted: true } : element))
        }
        elementsRef.current = next
        apiRef.current.updateScene({ elements: next })
        sendScene(next, operation.id)
        if (wasEmpty && operation.type === 'add_elements' && apiRef.current) {
          requestAnimationFrame(() => {
            zoomToContentWithPadding(apiRef.current!, next, true)
          })
        }
        operationRef.current = null
      }
      socket.onclose = () => {
        if (!disposed) retryId = window.setTimeout(connect, 1_000)
      }
    }
    connect()
    return () => {
      disposed = true
      if (retryId) window.clearTimeout(retryId)
      socketRef.current?.close()
    }
  }, [isReadOnly, sendScene])

  const flushSave = useCallback(async () => {
    if (isReadOnly) return
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = undefined
    }
    const scene = pendingSceneRef.current
    if (!scene) return
    pendingSceneRef.current = null

    const document = documentRef.current
    if (document) {
      try {
        const saved = await workspaceApi.saveBoard({ ...document, scene })
        documentRef.current = saved
        setBoardMeta((prev) => (prev ? { ...prev, updatedAt: saved.updatedAt } : prev))
        void sharingService.syncBoardSceneToShare(boardId, scene, saved.name)
        queryClient.invalidateQueries({ queryKey: ['workspace'] })
      } catch {
        setState('Local save failed')
      }
    } else {
      try {
        await sharingService.updateSharedScene(boardId, scene)
        setState('Synced')
      } catch (err) {
        console.error('Failed to sync shared scene:', err)
        setState('Sync failed')
      }
    }
  }, [boardId, isReadOnly, queryClient])

  const scheduleSave = useCallback(
    (scene: BoardScene) => {
      if (isReadOnly) return
      pendingSceneRef.current = scene
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      setState('Saving')
      saveTimer.current = window.setTimeout(async () => {
        saveTimer.current = undefined
        pendingSceneRef.current = null
        const document = documentRef.current
        if (document) {
          try {
            const saved = await workspaceApi.saveBoard({ ...document, scene })
            documentRef.current = saved
            setBoardMeta((prev) => (prev ? { ...prev, updatedAt: saved.updatedAt } : prev))
            void sharingService.syncBoardSceneToShare(boardId, scene, saved.name)
            queryClient.invalidateQueries({ queryKey: ['workspace'] })
          } catch {
            setState('Local save failed')
          }
        } else {
          try {
            await sharingService.updateSharedScene(boardId, scene)
            setState('Synced')
          } catch (err) {
            console.error('Failed to sync shared scene:', err)
            setState('Sync failed')
          }
        }
      }, 450)
    },
    [boardId, isReadOnly, queryClient],
  )

  const getSceneSize = useCallback(() => {
    const elements = elementsRef.current.filter((e) => !e.isDeleted)
    const scene = {
      elements: elementsRef.current,
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
    (elements: readonly any[], appState: Record<string, any>) => {
      elementsRef.current = [...elements]
      appStateRef.current = { ...appStateRef.current, selectedElementIds: appState.selectedElementIds }
      const scene = {
        elements: [...elements],
        appState: {
          theme: appState.theme,
          viewBackgroundColor: appState.viewBackgroundColor,
          gridModeEnabled: appState.gridModeEnabled,
          objectsSnapModeEnabled: appState.objectsSnapModeEnabled,
        },
      }
      const signature = JSON.stringify(scene)
      // Excalidraw emits an onChange while applying initialData. It is not a
      // user edit and must not enter the durable outbox on every reload.
      if (awaitingInitialSceneRef.current) {
        awaitingInitialSceneRef.current = false
        savedSignature.current = signature
        if (!hasAutoZoomedRef.current && apiRef.current) {
          hasAutoZoomedRef.current = true
          zoomToContentWithPadding(apiRef.current, elements, false)
        }
        return
      }
      if (signature === savedSignature.current) return
      savedSignature.current = signature
      scheduleSave(scene)
      if (!operationRef.current) sendScene([...elements])
    },
    [scheduleSave, sendScene],
  )

  const hasUnsavedChanges =
    state === 'Saving' ||
    state === 'Local save failed' ||
    state === 'Conflict' ||
    pendingSceneRef.current !== null

  const hasUnsavedChangesRef = useRef(hasUnsavedChanges)
  hasUnsavedChangesRef.current = hasUnsavedChanges

  useEffect(() => {
    if (!apiRef.current || hasAutoZoomedRef.current) return
    const elements = initialData?.elements?.filter((e: any) => !e.isDeleted)
    if (!elements || elements.length === 0) return

    const timer = setTimeout(() => {
      if (!hasAutoZoomedRef.current && apiRef.current) {
        hasAutoZoomedRef.current = true
        zoomToContentWithPadding(apiRef.current, elements, false)
      }
    }, 60)
    return () => clearTimeout(timer)
  }, [initialData, zoomToContentWithPadding])

  useEffect(() => {
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
  }, [flushSave])

  const handleMakeCopy = useCallback(async () => {
    if (!authUser) {
      await signInWithGoogle()
      return
    }
    setIsCopyingBoard(true)
    try {
      const { projects } = await workspaceApi.listWorkspace()
      const targetProjectId = projects[0]?.id
      if (!targetProjectId) return
      const copyName = `Copy of ${boardMeta?.boardName || 'Untitled'}`
      const newBoard = await workspaceApi.createBoard(targetProjectId, copyName)
      await workspaceApi.saveBoard({
        ...newBoard,
        scene: {
          elements: elementsRef.current,
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
        return !window.confirm(
          'You have changes that are still saving or in conflict.\n\nLeave anyway?',
        )
      }
      return false
    },
    enableBeforeUnload: false,
    disabled: isReadOnly || !hasUnsavedChanges,
  })

  if (accessDenied) {
    return (
      <div className="access-denied-container">
        <div className="access-denied-card animate-scale-in">
          <div className="access-denied-icon-wrap">
            <Lock size={26} />
          </div>
          <h2 className="access-denied-title">You need access</h2>
          <p className="access-denied-desc">
            Ask for access, or switch to an account with access to this board.
          </p>
          <div className="access-denied-user-info">
            {authUser?.email ? `Signed in as ${authUser.email}` : 'You are not signed in'}
          </div>
          <div className="access-denied-actions">
            {authUser ? (
              <>
                <button
                  type="button"
                  className="google-share-copy-btn"
                  onClick={signOutUser}
                >
                  Switch account
                </button>
                <Link to="/" className="google-share-done-btn" style={{ textDecoration: 'none' }}>
                  Go to workspace
                </Link>
              </>
            ) : (
              <button
                type="button"
                className="google-share-done-btn"
                onClick={signInWithGoogle}
              >
                Sign in with Google
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (boardNotFound) {
    return (
      <div className="access-denied-container">
        <div className="access-denied-card animate-scale-in">
          <h2 className="access-denied-title">Board not found</h2>
          <p className="access-denied-desc">
            The board you are looking for does not exist or may have been deleted.
          </p>
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
      {navSlot &&
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
                    {copiedFilename ? (
                      <Check size={12} className="breadcrumb-copy-check" />
                    ) : (
                      <Copy size={12} />
                    )}
                  </button>
                </div>
              ) : (
                <>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: boardMeta.projectId }}
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
                        {copiedFilename ? (
                          <Check size={12} className="breadcrumb-copy-check" />
                        ) : (
                          <Copy size={12} />
                        )}
                      </button>
                    </div>
                  )}
                </>
              )
            ) : (
              <span className="breadcrumb-item breadcrumb-current">Loading…</span>
            )}
          </nav>,
          navSlot,
        )}
      {statusSlot &&
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
          </div>,
          statusSlot,
        )}
      <Excalidraw
        theme={resolvedTheme}
        initialData={initialData}
        onChange={onChange}
        viewModeEnabled={isReadOnly}
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
            changeViewBackgroundColor: !isReadOnly,
            clearCanvas: !isReadOnly,
            export: { saveFileToDisk: true },
            loadScene: !isReadOnly,
            saveToActiveFile: !isReadOnly,
            saveAsImage: true,
            toggleTheme: false,
          },
        }}
        excalidrawAPI={(api) => {
          apiRef.current = api
          sendScene()
          requestAnimationFrame(() => {
            if (!hasAutoZoomedRef.current) {
              const nonDeleted = api.getSceneElements().filter((e) => !e.isDeleted)
              if (nonDeleted.length > 0) {
                hasAutoZoomedRef.current = true
                zoomToContentWithPadding(api, nonDeleted, false)
              }
            }
          })
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
          {!isReadOnly && <MainMenu.DefaultItems.LoadScene />}
          {!isReadOnly && <MainMenu.DefaultItems.SaveToActiveFile />}
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          {!isReadOnly && <MainMenu.DefaultItems.ClearCanvas />}
          {!isReadOnly && <MainMenu.Separator />}
          {!isReadOnly && <MainMenu.DefaultItems.ChangeCanvasBackground />}
        </MainMenu>
      </Excalidraw>

      {boardMeta && (
        <ShareModal
          open={isShareModalOpen}
          onOpenChange={setIsShareModalOpen}
          boardId={boardId}
          boardName={boardMeta.boardName}
          ownerId={boardMeta.projectOwnerId}
          scene={{ elements: elementsRef.current, appState: appStateRef.current }}
        />
      )}
    </main>
  )
}
