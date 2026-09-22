import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WebSocketServer, WebSocket } from 'ws'
import { z } from 'zod'

type Scene = { elements: Record<string, unknown>[]; appState: Record<string, unknown> }
type Operation = {
  id: string
  type: 'add_elements' | 'update_elements' | 'delete_elements'
  elements?: Record<string, unknown>[]
  patches?: Array<{ id: string; changes: Record<string, unknown> }>
  ids?: string[]
}

const bridgePort = Number(process.env.AGENTIC_WHITEBOARD_BRIDGE_PORT ?? 8787)
let scene: Scene | null = null
let revision = 0
let selectionIds: string[] = []
const adapters = new Set<WebSocket>()
const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
const failure = (error: string, detail?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error, ...detail }, null, 2) }],
  isError: true,
})

const summarize = () => {
  const elements = scene?.elements ?? []
  const byType = elements.reduce<Record<string, number>>((counts, element) => {
    const type = typeof element.type === 'string' ? element.type : 'unknown'
    counts[type] = (counts[type] ?? 0) + 1
    return counts
  }, {})
  return { revision, elementCount: elements.length, byType }
}

const assertRevision = (expectedRevision?: number) => {
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    return failure('revision_conflict', { expectedRevision, currentRevision: revision })
  }
  return null
}

const dispatch = async (operation: Omit<Operation, 'id'>, expectedRevision?: number) => {
  const conflict = assertRevision(expectedRevision)
  if (conflict) return conflict
  if (!scene || adapters.size === 0) {
    return failure('whiteboard_offline', {
      message: 'Start the whiteboard and connect its browser adapter before issuing write operations.',
    })
  }

  const id = randomUUID()
  const message = JSON.stringify({ type: 'operation', operation: { ...operation, id } })
  for (const adapter of adapters) {
    if (adapter.readyState === WebSocket.OPEN) adapter.send(message)
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error('The browser adapter did not acknowledge the canvas write in time.'))
      }, 8_000)
      pending.set(id, {
        resolve: () => {
          clearTimeout(timeout)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
    })
    return json({ ok: true, operationId: id, ...summarize() })
  } catch (error) {
    return failure('write_not_acknowledged', { message: error instanceof Error ? error.message : String(error) })
  }
}

const mcp = new McpServer({ name: 'open-excalidraw', version: '0.1.0' })

mcp.registerTool(
  'get_capabilities',
  {
    description: 'Return the bridge status, write guarantees, and supported operations.',
  },
  async () =>
    json({
      whiteboardConnected: adapters.size > 0,
      revision,
      writeGuarantee: 'Writes return only after the browser adapter acknowledges the applied Excalidraw scene.',
      tools: [
        'get_canvas',
        'get_selection',
        'get_schema',
        'add_elements',
        'update_elements',
        'delete_elements',
        'validate_dag',
      ],
    }),
)

mcp.registerTool(
  'get_canvas',
  {
    description: 'Read the current Excalidraw JSON scene or a compact summary.',
    inputSchema: { detail: z.enum(['summary', 'full']).default('summary') },
  },
  async ({ detail }) => {
    if (!scene) return failure('whiteboard_offline', { message: 'No browser scene has connected yet.' })
    return json(detail === 'full' ? { revision, scene } : summarize())
  },
)

mcp.registerTool(
  'get_selection',
  {
    description: 'Read the currently selected live-canvas elements.',
  },
  async () => {
    if (!scene) return failure('whiteboard_offline', { message: 'No browser scene has connected yet.' })
    return json({
      revision,
      selectionIds,
      elements: scene.elements.filter((element) => selectionIds.includes(String(element.id))),
    })
  },
)

mcp.registerTool(
  'get_schema',
  {
    description: 'Return the supported Excalidraw skeleton format for live write operations.',
  },
  async () =>
    json({
      addElements: {
        elements: [{ type: 'rectangle', x: 120, y: 120, width: 220, height: 100, label: { text: 'Service' } }],
      },
      updateElements: {
        patches: [{ id: 'existing-element-id', changes: { x: 160, y: 120, backgroundColor: '#dbeafe' } }],
      },
      deleteElements: { ids: ['existing-element-id'] },
      supportedSkeletonTypes: ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'freedraw', 'image'],
      rule: 'Read get_canvas first, pass expectedRevision for optimistic concurrency, and use element IDs returned by the canvas.',
    }),
)

mcp.registerTool(
  'add_elements',
  {
    description:
      'Append Excalidraw element skeletons to the live canvas. The browser normalizes skeletons into valid Excalidraw JSON.',
    inputSchema: {
      elements: z.array(z.record(z.unknown())).min(1),
      expectedRevision: z.number().int().nonnegative().optional(),
    },
  },
  async ({ elements, expectedRevision }) => dispatch({ type: 'add_elements', elements }, expectedRevision),
)

mcp.registerTool(
  'update_elements',
  {
    description: 'Patch existing live-canvas elements by ID. IDs and element types cannot be changed.',
    inputSchema: {
      patches: z.array(z.object({ id: z.string().min(1), changes: z.record(z.unknown()) })).min(1),
      expectedRevision: z.number().int().nonnegative().optional(),
    },
  },
  async ({ patches, expectedRevision }) => {
    const safePatches = patches.map(({ id, changes }) => {
      const { id: _ignoredId, type: _ignoredType, ...safeChanges } = changes
      return { id, changes: safeChanges }
    })
    return dispatch({ type: 'update_elements', patches: safePatches }, expectedRevision)
  },
)

mcp.registerTool(
  'delete_elements',
  {
    description: 'Soft-delete elements by ID from the live Excalidraw scene.',
    inputSchema: {
      ids: z.array(z.string().min(1)).min(1),
      expectedRevision: z.number().int().nonnegative().optional(),
    },
  },
  async ({ ids, expectedRevision }) => dispatch({ type: 'delete_elements', ids }, expectedRevision),
)

mcp.registerTool(
  'validate_dag',
  {
    description: 'Validate that arrows between Excalidraw elements do not contain directed cycles.',
  },
  async () => {
    if (!scene) return failure('whiteboard_offline', { message: 'No browser scene has connected yet.' })
    const arrows = scene.elements.filter((element) => element.type === 'arrow')
    const edges = arrows.flatMap((arrow) => {
      const start = (arrow.startBinding as { elementId?: string } | null)?.elementId
      const end = (arrow.endBinding as { elementId?: string } | null)?.elementId
      return start && end ? [[start, end] as const] : []
    })
    const graph = new Map<string, string[]>()
    for (const [from, to] of edges) graph.set(from, [...(graph.get(from) ?? []), to])
    const visiting = new Set<string>(),
      visited = new Set<string>(),
      cycles: string[][] = []
    const visit = (node: string, trail: string[]) => {
      if (visiting.has(node)) {
        cycles.push([...trail, node])
        return
      }
      if (visited.has(node)) return
      visiting.add(node)
      for (const child of graph.get(node) ?? []) visit(child, [...trail, node])
      visiting.delete(node)
      visited.add(node)
    }
    for (const node of graph.keys()) visit(node, [])
    return json({ valid: cycles.length === 0, cycles, inspectedBoundArrows: edges.length, revision })
  },
)

const socketServer = new WebSocketServer({ port: bridgePort })
socketServer.on('connection', (socket) => {
  adapters.add(socket)
  console.error(`Browser adapter connected (${adapters.size} active).`)
  socket.send(JSON.stringify({ type: 'bridge_status', connected: true, revision }))
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as {
        type?: string
        scene?: Scene
        operationId?: string
        selectionIds?: string[]
      }
      if (message.type !== 'scene' || !message.scene || !Array.isArray(message.scene.elements)) return
      scene = message.scene
      selectionIds = Array.isArray(message.selectionIds) ? message.selectionIds : []
      revision += 1
      if (message.operationId) pending.get(message.operationId)?.resolve()
      if (message.operationId) pending.delete(message.operationId)
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid bridge message.' }))
    }
  })
  socket.on('close', () => adapters.delete(socket))
})

await mcp.connect(new StdioServerTransport())
console.error(`OpenExcalidraw MCP is ready; browser adapter WebSocket on ws://127.0.0.1:${bridgePort}`)
