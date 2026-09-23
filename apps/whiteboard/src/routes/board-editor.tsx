import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, Loader2, Pencil } from 'lucide-react'
import { convertToExcalidrawElements, Excalidraw, MainMenu } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { BoardDocument, BoardScene, BoardSyncStatus } from '@agentic-whiteboard/storage'
import { workspaceApi } from '../features/workspace/workspace-api'
import { useTheme } from '../lib/theme-context'

const LIBRARY_STORAGE_KEY = 'agentic-whiteboard:library:v1'
const starterLibraries = [
  'https://libraries.excalidraw.com/libraries/youritjang/software-architecture.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/rohanp/system-design.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/childishgirl/aws-architecture-icons.excalidrawlib',
]

type EditorStatus = 'Loading board' | 'Saving locally' | 'Local only' | 'Pending sync' | 'Syncing' | 'Synced' | 'Sync failed' | 'Local save failed'
const statusLabel = (status: BoardSyncStatus): EditorStatus => {
  if (status === 'local-only') return 'Local only'
  if (status === 'pending-sync') return 'Pending sync'
  if (status === 'syncing') return 'Syncing'
  if (status === 'synced') return 'Synced'
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

export function BoardEditor() {
  const { boardId } = useParams({ from: '/boards/$boardId' })
  const queryClient = useQueryClient()
  const { resolvedTheme } = useTheme()
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const documentRef = useRef<BoardDocument | null>(null)
  const elementsRef = useRef<any[]>([])
  const appStateRef = useRef<Record<string, unknown>>({})
  const socketRef = useRef<WebSocket | null>(null)
  const operationRef = useRef<string | null>(null)
  const saveTimer = useRef<number>()
  const savedSignature = useRef<string>()
  const [state, setState] = useState<EditorStatus>('Loading board')
  const [boardMeta, setBoardMeta] = useState<{ boardName: string; projectId: string; projectName: string } | null>(null)
  const [isEditingName, setIsEditingName] = useState(false)
  const [tempName, setTempName] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)

  const startEditingName = useCallback(() => {
    if (!boardMeta) return
    setTempName(boardMeta.boardName)
    setIsEditingName(true)
    setTimeout(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }, 0)
  }, [boardMeta])

  const finishEditingName = useCallback(async () => {
    if (!isEditingName || !boardMeta) return
    setIsEditingName(false)
    const trimmed = tempName.trim() || 'Untitled'
    if (trimmed === boardMeta.boardName) return

    setBoardMeta((prev) => (prev ? { ...prev, boardName: trimmed } : prev))
    if (documentRef.current) {
      documentRef.current = { ...documentRef.current, name: trimmed }
    }
    try {
      await workspaceApi.renameBoard(boardId, trimmed)
      queryClient.invalidateQueries({ queryKey: ['workspace'] })
    } catch {
      setBoardMeta((prev) => (prev ? { ...prev, boardName: boardMeta.boardName } : prev))
      if (documentRef.current) {
        documentRef.current = { ...documentRef.current, name: boardMeta.boardName }
      }
    }
  }, [boardId, boardMeta, isEditingName, queryClient, tempName])

  const cancelEditingName = useCallback(() => {
    setIsEditingName(false)
    if (boardMeta) setTempName(boardMeta.boardName)
  }, [boardMeta])

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
    let active = true
    Promise.all([workspaceApi.loadBoardWithProject(boardId), loadLibraryItems()])
      .then(([details, libraryItems]) => {
        if (!active || !details) return
        const { document, project } = details
        documentRef.current = document
        elementsRef.current = document.scene.elements
        appStateRef.current = document.scene.appState
        savedSignature.current = JSON.stringify(document.scene)
        setBoardMeta({
          boardName: document.name,
          projectId: project.id,
          projectName: project.name,
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
      })
      .catch(() => active && setState('Local save failed'))
    return () => {
      active = false
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [boardId])

  useEffect(() => workspaceApi.subscribeToBoardSyncStatus(boardId, (status) => setState(statusLabel(status))), [boardId])

  const sendScene = useCallback((elements = elementsRef.current, operationId?: string) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return
    socketRef.current.send(
      JSON.stringify({
        type: 'scene',
        operationId,
        scene: { elements, appState: appStateRef.current },
        selectionIds: [],
      }),
    )
  }, [])

  useEffect(() => {
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
  }, [sendScene])

  const scheduleSave = useCallback(
    (scene: BoardScene) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      setState('Saving locally')
      saveTimer.current = window.setTimeout(async () => {
        const document = documentRef.current
        if (!document) return
        try {
          await workspaceApi.saveBoard({ ...document, scene })
          documentRef.current = { ...document, scene }
          queryClient.invalidateQueries({ queryKey: ['workspace'] })
          setState('Pending sync')
        } catch {
          setState('Local save failed')
        }
      }, 450)
    },
    [queryClient],
  )

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
      if (signature === savedSignature.current) return
      savedSignature.current = signature
      scheduleSave(scene)
      if (!operationRef.current) sendScene([...elements])
    },
    [scheduleSave, sendScene],
  )

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
                      className="breadcrumb-item breadcrumb-current"
                      title={boardMeta.boardName}
                      onDoubleClick={startEditingName}
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
                  </div>
                )}
              </>
            ) : (
              <span className="breadcrumb-item breadcrumb-current">Loading…</span>
            )}
          </nav>,
          navSlot,
        )}
      {statusSlot &&
        createPortal(
          <div
            className={`sync-status-pill sync-status-pill--${
              state === 'Synced' ? 'saved' : state === 'Sync failed' || state === 'Local save failed' ? 'error' : 'saving'
            }`}
          >
            {state === 'Synced' ? (
              <Check size={13} className="sync-status-icon sync-status-icon--saved" />
            ) : state === 'Sync failed' || state === 'Local save failed' ? (
              <AlertCircle size={13} className="sync-status-icon sync-status-icon--error" />
            ) : (
              <Loader2 size={13} className="sync-status-icon sync-status-icon--saving" />
            )}
            <span>{state}</span>
          </div>,
          statusSlot,
        )}
      <Excalidraw
        theme={resolvedTheme}
        initialData={initialData}
        onChange={onChange}
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
            changeViewBackgroundColor: true,
            clearCanvas: true,
            export: { saveFileToDisk: true },
            loadScene: true,
            saveToActiveFile: true,
            saveAsImage: true,
            toggleTheme: true,
          },
        }}
        excalidrawAPI={(api) => {
          apiRef.current = api
          sendScene()
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
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    </main>
  )
}
