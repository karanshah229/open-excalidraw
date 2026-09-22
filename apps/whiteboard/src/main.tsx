import { StrictMode, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { convertToExcalidrawElements, Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import './styles.css'

const LIBRARY_STORAGE_KEY = 'agentic-whiteboard-library'
const SCENE_STORAGE_KEY = 'agentic-whiteboard-scene'

const starterLibraries = [
  'https://libraries.excalidraw.com/libraries/youritjang/software-architecture.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/rohanp/system-design.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/anna-pastushko/architecture-diagram-components.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/childishgirl/aws-architecture-icons.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/aretecode/system-design-template.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/maeddes/technology-logos.excalidrawlib',
]

const loadLibraryItems = async () => {
  const saved = localStorage.getItem(LIBRARY_STORAGE_KEY)
  if (saved) return JSON.parse(saved)

  const imported = await Promise.all(
    starterLibraries.map(async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Could not load ${url}`)
      const library = await response.json()
      return library.libraryItems ?? library.library ?? []
    }),
  )

  return imported.flat()
}

const loadScene = () => {
  try {
    const stored = localStorage.getItem(SCENE_STORAGE_KEY)
    const parsed = stored ? JSON.parse(stored) : undefined
    return Array.isArray(parsed) ? parsed : undefined
  } catch { return undefined }
}

const bridgeDiagram = convertToExcalidrawElements([
  { type: 'text', x: 120, y: 72, text: 'How Pi edits', fontSize: 34, fontFamily: 2, strokeColor: '#1e1e1e' },
  { type: 'text', x: 120, y: 112, text: 'Agentic Whiteboard', fontSize: 34, fontFamily: 2, strokeColor: '#1e1e1e' },
  { type: 'text', x: 122, y: 164, text: 'A local MCP bridge keeps agent, validation, and libraries in sync.', fontSize: 18, fontFamily: 2, strokeColor: '#5c677d' },
  { type: 'text', x: 122, y: 190, text: 'The canvas stays fully editable for you.', fontSize: 18, fontFamily: 2, strokeColor: '#5c677d' },
  { type: 'rectangle', id: 'pi', x: 120, y: 250, width: 220, height: 120, backgroundColor: '#dbeafe', strokeColor: '#2563eb', roundness: { type: 3 }, label: { text: 'Pi agentic CLI\nMCP client', fontSize: 20, fontFamily: 2 } },
  { type: 'rectangle', id: 'bridge', x: 500, y: 220, width: 290, height: 180, backgroundColor: '#ede9fe', strokeColor: '#7c3aed', roundness: { type: 3 }, label: { text: 'Agentic Whiteboard\nMCP bridge', fontSize: 22, fontFamily: 2 } },
  { type: 'rectangle', id: 'adapter', x: 950, y: 250, width: 230, height: 120, backgroundColor: '#dcfce7', strokeColor: '#16a34a', roundness: { type: 3 }, label: { text: 'Browser adapter\nWebSocket / API', fontSize: 20, fontFamily: 2 } },
  { type: 'rectangle', id: 'canvas', x: 1340, y: 220, width: 280, height: 180, backgroundColor: '#fef3c7', strokeColor: '#d97706', roundness: { type: 3 }, label: { text: 'Excalidraw\neditable canvas', fontSize: 22, fontFamily: 2 } },
  { type: 'arrow', x: 340, y: 310, width: 160, height: 0, points: [[0, 0], [160, 0]], strokeColor: '#475569', endArrowhead: 'arrow', label: { text: 'MCP calls', fontSize: 16, fontFamily: 2 } },
  { type: 'arrow', x: 790, y: 310, width: 160, height: 0, points: [[0, 0], [160, 0]], strokeColor: '#475569', endArrowhead: 'arrow', label: { text: 'scene patch', fontSize: 16, fontFamily: 2 } },
  { type: 'arrow', x: 1180, y: 310, width: 160, height: 0, points: [[0, 0], [160, 0]], strokeColor: '#475569', endArrowhead: 'arrow', label: { text: 'live update', fontSize: 16, fontFamily: 2 } },
  { type: 'text', x: 500, y: 455, text: 'MCP tool surface', fontSize: 20, fontFamily: 2, strokeColor: '#5b21b6' },
  { type: 'rectangle', x: 500, y: 500, width: 185, height: 70, backgroundColor: '#f5f3ff', strokeColor: '#8b5cf6', roundness: { type: 3 }, label: { text: 'get_canvas\nget_selection', fontSize: 16, fontFamily: 2 } },
  { type: 'rectangle', x: 710, y: 500, width: 185, height: 70, backgroundColor: '#f5f3ff', strokeColor: '#8b5cf6', roundness: { type: 3 }, label: { text: 'add / update /\ndelete elements', fontSize: 16, fontFamily: 2 } },
  { type: 'rectangle', x: 920, y: 500, width: 185, height: 70, backgroundColor: '#f5f3ff', strokeColor: '#8b5cf6', roundness: { type: 3 }, label: { text: 'library tools\n(next)', fontSize: 16, fontFamily: 2 } },
  { type: 'rectangle', x: 1130, y: 500, width: 185, height: 70, backgroundColor: '#f5f3ff', strokeColor: '#8b5cf6', roundness: { type: 3 }, label: { text: 'validate DAG\nexport (next)', fontSize: 16, fontFamily: 2 } },
  { type: 'rectangle', x: 1385, y: 660, width: 190, height: 82, backgroundColor: '#f1f5f9', strokeColor: '#64748b', roundness: { type: 3 }, label: { text: 'Local persistence\nscene + library', fontSize: 18, fontFamily: 2 } },
  { type: 'arrow', x: 1480, y: 400, width: 0, height: 260, points: [[0, 0], [0, 260]], strokeColor: '#64748b', endArrowhead: 'arrow', label: { text: 'persist', fontSize: 16, fontFamily: 2 } },
  { type: 'text', x: 120, y: 650, text: 'Design principle:', fontSize: 18, fontFamily: 2, strokeColor: '#334155' },
  { type: 'text', x: 120, y: 678, text: 'MCP owns intent + validation; Excalidraw owns the editable scene.', fontSize: 18, fontFamily: 2, strokeColor: '#334155' },
], { regenerateIds: false })

const initialData = {
  libraryItems: loadLibraryItems(),
  elements: new URLSearchParams(window.location.search).get('diagram') === 'bridge' ? bridgeDiagram : loadScene(),
}

function App() {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const elementsRef = useRef<any[]>(initialData.elements ?? [])
  const appStateRef = useRef<Record<string, unknown>>({})
  const operationRef = useRef<string | null>(null)

  const sendScene = (elements = elementsRef.current, operationId?: string) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return
    socketRef.current.send(JSON.stringify({
      type: 'scene',
      operationId,
      scene: { elements, appState: appStateRef.current },
      selectionIds: Object.keys((appStateRef.current.selectedElementIds as Record<string, boolean> | undefined) ?? {}),
    }))
  }

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

      const { operation } = message
      operationRef.current = operation.id
      let next = elementsRef.current
      if (operation.type === 'add_elements') {
        next = [...next, ...convertToExcalidrawElements(operation.elements, { regenerateIds: true })]
      }
      if (operation.type === 'update_elements') {
        const patches = new Map(operation.patches.map((patch: any) => [patch.id, patch.changes]))
        next = next.map((element) => patches.has(element.id) ? { ...element, ...(patches.get(element.id) as Record<string, unknown>) } : element)
      }
      if (operation.type === 'delete_elements') {
        const ids = new Set(operation.ids)
        next = next.map((element) => ids.has(element.id) ? { ...element, isDeleted: true } : element)
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
    return () => { disposed = true; if (retryId) window.clearTimeout(retryId); socketRef.current?.close() }
  }, [])

  return (
    <main className="whiteboard">
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={(api) => { apiRef.current = api; sendScene() }}
        onChange={(elements, appState) => {
          elementsRef.current = [...elements]
          appStateRef.current = { theme: appState.theme, viewBackgroundColor: appState.viewBackgroundColor, selectedElementIds: appState.selectedElementIds }
          localStorage.setItem(SCENE_STORAGE_KEY, JSON.stringify(elements))
          if (!operationRef.current) sendScene()
        }}
        onLibraryChange={(items) => localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(items))}
      />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
