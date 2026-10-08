import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WebSocketServer, WebSocket } from 'ws'
import { z } from 'zod'

type Scene = { elements: Record<string, unknown>[]; appState: Record<string, unknown> }

const bridgePort = Number(process.env.AGENTIC_WHITEBOARD_BRIDGE_PORT ?? 8787)
let scene: Scene | null = null
let revision = 0
let selectionIds: string[] = []
const adapters = new Set<WebSocket>()
const pending = new Map<string, { resolve: (value?: unknown) => void; reject: (error: Error) => void }>()

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

const dispatch = async (operation: Record<string, unknown>, expectedRevision?: number, timeoutMs = 12_000) => {
  const conflict = assertRevision(expectedRevision)
  if (conflict) return conflict
  if (adapters.size === 0) {
    return failure('whiteboard_offline', {
      message: 'Start the whiteboard and connect its browser adapter before issuing operations.',
    })
  }

  const id = randomUUID()
  const message = JSON.stringify({ type: 'operation', operation: { ...operation, id } })
  for (const adapter of adapters) {
    if (adapter.readyState === WebSocket.OPEN) adapter.send(message)
  }

  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`The browser adapter did not acknowledge the operation '${String(operation.type)}' in time.`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (val) => {
          clearTimeout(timeout)
          resolve(val)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
    })
    return json(result ?? { ok: true, operationId: id, ...summarize() })
  } catch (error) {
    return failure('operation_failed', {
      operation: operation.type,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

const mcp = new McpServer({ name: 'open-excalidraw', version: '0.2.0' })

// ==========================================
// 1. CAPABILITIES, STATUS & SCHEMA INTROSPECTION
// ==========================================

mcp.registerTool(
  'get_capabilities',
  {
    description: 'Return the bridge status, write guarantees, and the complete suite of supported operations.',
  },
  async () =>
    json({
      whiteboardConnected: adapters.size > 0,
      revision,
      writeGuarantee: 'Writes return only after the browser adapter acknowledges the applied Excalidraw scene.',
      tools: [
        'get_capabilities',
        'get_canvas',
        'get_selection',
        'get_schema',
        'add_elements',
        'update_elements',
        'get_slides',
        'slide_command',
        'delete_elements',
        'clear_canvas',
        'set_selection',
        'zoom_to_content',
        'find_elements',
        'group_elements',
        'ungroup_elements',
        'export_image',
        'insert_library_item',
        'auto_layout',
        'set_canvas_background',
        'list_projects',
        'list_boards',
        'create_board',
        'rename_board',
        'switch_board',
        'get_share_info',
        'share_board',
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
    description: 'Return the supported Excalidraw skeleton formats and operational rules for live write operations.',
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
      supportedTemplates: [
        'microservice',
        'database_cluster',
        'api_gateway',
        'queue',
        'client_frontend',
        'auth_service',
        'cloud_storage',
      ],
      supportedLayouts: ['horizontal', 'vertical', 'grid'],
      rule: 'Read get_canvas first, pass expectedRevision for optimistic concurrency, and use element IDs returned by the canvas.',
    }),
)

// ==========================================
// 2. ELEMENT CREATION, MUTATION & DELETION
// ==========================================

mcp.registerTool(
  'add_elements',
  {
    description:
      'Append Excalidraw element skeletons to the live canvas. The browser normalizes skeletons into valid Excalidraw JSON.',
    inputSchema: {
      elements: z.array(z.record(z.unknown())).min(1).describe('Array of Excalidraw element skeletons to append.'),
      expectedRevision: z.number().int().nonnegative().optional().describe('Optimistic concurrency revision check.'),
    },
  },
  async ({ elements, expectedRevision }) => dispatch({ type: 'add_elements', elements }, expectedRevision),
)

mcp.registerTool(
  'update_elements',
  {
    description: 'Patch existing live-canvas elements by ID. IDs and element types cannot be changed.',
    inputSchema: {
      patches: z
        .array(z.object({ id: z.string().min(1), changes: z.record(z.unknown()) }))
        .min(1)
        .describe('Array of patches with target element id and dictionary of changed properties.'),
      expectedRevision: z.number().int().nonnegative().optional().describe('Optimistic concurrency revision check.'),
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
  'get_slides',
  { description: 'List ordered Slides on the current board. Speaker notes are never included.' },
  async () => dispatch({ type: 'get_slides' }),
)

mcp.registerTool(
  'slide_command',
  {
    description: 'Reorder, duplicate or remove a Slide boundary without deleting its drawings.',
    inputSchema: {
      slideId: z.string().min(1),
      action: z.enum(['earlier', 'later', 'duplicate', 'remove']),
      expectedRevision: z.number().int().nonnegative().optional(),
    },
  },
  async ({ slideId, action, expectedRevision }) => {
    return dispatch({ type: 'slide_command', slideId, action }, expectedRevision)
  },
)

mcp.registerTool(
  'delete_elements',
  {
    description: 'Soft-delete elements by ID from the live Excalidraw scene.',
    inputSchema: {
      ids: z.array(z.string().min(1)).min(1).describe('Array of element IDs to delete.'),
      expectedRevision: z.number().int().nonnegative().optional().describe('Optimistic concurrency revision check.'),
    },
  },
  async ({ ids, expectedRevision }) => dispatch({ type: 'delete_elements', ids }, expectedRevision),
)

mcp.registerTool(
  'clear_canvas',
  {
    description: 'Remove all elements from the active canvas, resetting the board to a clean state.',
    inputSchema: {
      expectedRevision: z.number().int().nonnegative().optional().describe('Optimistic concurrency revision check.'),
    },
  },
  async ({ expectedRevision }) => dispatch({ type: 'clear_canvas' }, expectedRevision),
)

// ==========================================
// 3. SELECTION, VIEWPORT & SEARCH
// ==========================================

mcp.registerTool(
  'set_selection',
  {
    description: 'Set or clear the selected elements on the live canvas to guide the user visually.',
    inputSchema: {
      ids: z.array(z.string()).describe('List of element IDs to select, or empty array to clear selection.'),
    },
  },
  async ({ ids }) => dispatch({ type: 'set_selection', ids }),
)

mcp.registerTool(
  'zoom_to_content',
  {
    description:
      'Fit and center the canvas viewport to all content or to specific element IDs with responsive padding.',
    inputSchema: {
      targetIds: z
        .array(z.string())
        .optional()
        .describe('Optional list of element IDs to focus on. If omitted, fits all content.'),
      animate: z.boolean().default(true).describe('Whether to smoothly animate the viewport transition.'),
    },
  },
  async ({ targetIds, animate }) => dispatch({ type: 'zoom_to_content', targetIds, animate }),
)

mcp.registerTool(
  'find_elements',
  {
    description: 'Search canvas elements by text query, label, or element type without pulling the entire canvas JSON.',
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('Text query to match against text elements, container labels, or element IDs.'),
      type: z
        .string()
        .optional()
        .describe('Filter by Excalidraw element type (e.g. rectangle, ellipse, diamond, text, arrow, line).'),
    },
  },
  async ({ query, type }) => dispatch({ type: 'find_elements', query, elementType: type }),
)

// ==========================================
// 4. GROUPING & COMPOSITION
// ==========================================

mcp.registerTool(
  'group_elements',
  {
    description: 'Group multiple elements together by IDs so they move and interact as a single unit.',
    inputSchema: {
      ids: z.array(z.string()).min(2).describe('IDs of elements to group together.'),
      expectedRevision: z.number().int().nonnegative().optional().describe('Optimistic concurrency revision check.'),
    },
  },
  async ({ ids, expectedRevision }) => dispatch({ type: 'group_elements', ids }, expectedRevision),
)

mcp.registerTool(
  'ungroup_elements',
  {
    description: 'Ungroup previously grouped elements by their IDs or a specific groupId.',
    inputSchema: {
      ids: z.array(z.string()).optional().describe('IDs of elements to remove from their groups.'),
      groupId: z.string().optional().describe('Optional specific groupId to dissolve.'),
      expectedRevision: z.number().int().nonnegative().optional().describe('Optimistic concurrency revision check.'),
    },
  },
  async ({ ids, groupId, expectedRevision }) => dispatch({ type: 'ungroup_elements', ids, groupId }, expectedRevision),
)

// ==========================================
// 5. EXPORT & VISUAL ASSETS
// ==========================================

mcp.registerTool(
  'export_image',
  {
    description: 'Export the current canvas as a standalone SVG vector image string for inspection or documentation.',
    inputSchema: {
      darkMode: z.boolean().optional().describe('Whether to export in dark mode. Defaults to active canvas theme.'),
      exportBackground: z.boolean().default(true).describe('Whether to include background in the exported SVG.'),
      exportPadding: z.number().default(16).describe('Padding around exported elements in pixels.'),
    },
  },
  async ({ darkMode, exportBackground, exportPadding }) =>
    dispatch({ type: 'export_image', darkMode, exportBackground, exportPadding }),
)

mcp.registerTool(
  'set_canvas_background',
  {
    description: "Set the background color of the canvas (e.g. hex code like '#121212', '#f8fafc', or 'transparent').",
    inputSchema: {
      color: z.string().describe("Hex color code (e.g. '#ffffff', '#1e1e24') or 'transparent'."),
      expectedRevision: z.number().int().nonnegative().optional().describe('Optimistic concurrency revision check.'),
    },
  },
  async ({ color, expectedRevision }) => dispatch({ type: 'set_canvas_background', color }, expectedRevision),
)

// ==========================================
// 6. ARCHITECTURAL TEMPLATES & AUTO-LAYOUT
// ==========================================

mcp.registerTool(
  'insert_library_item',
  {
    description: 'Insert a pre-built architectural pattern, service block, cloud icon, or template onto the canvas.',
    inputSchema: {
      template: z
        .enum([
          'microservice',
          'database_cluster',
          'api_gateway',
          'queue',
          'client_frontend',
          'auth_service',
          'cloud_storage',
        ])
        .describe('The architectural pattern to insert.'),
      x: z.number().default(200).describe('X coordinate on canvas.'),
      y: z.number().default(200).describe('Y coordinate on canvas.'),
      label: z.string().optional().describe('Custom text label for the inserted template.'),
      expectedRevision: z.number().int().nonnegative().optional().describe('Optimistic concurrency revision check.'),
    },
  },
  async ({ template, x, y, label, expectedRevision }) =>
    dispatch({ type: 'insert_library_item', template, x, y, label }, expectedRevision),
)

mcp.registerTool(
  'auto_layout',
  {
    description:
      'Automatically arrange elements into a clean, aligned layout (horizontal pipeline, vertical hierarchy, or grid) and update connector paths.',
    inputSchema: {
      layout: z
        .enum(['horizontal', 'vertical', 'grid'])
        .default('horizontal')
        .describe('Layout orientation: horizontal (left-to-right), vertical (top-to-bottom), or grid.'),
      ids: z
        .array(z.string())
        .optional()
        .describe('Specific element IDs to layout. If omitted, layouts all non-arrow shapes.'),
      spacing: z.number().default(80).describe('Spacing gap between shapes in pixels.'),
      columns: z.number().default(3).describe('Number of columns when using grid layout.'),
      startX: z.number().optional().describe('Starting X position. Defaults to current leftmost element.'),
      startY: z.number().optional().describe('Starting Y position. Defaults to current topmost element.'),
      expectedRevision: z.number().int().nonnegative().optional().describe('Optimistic concurrency revision check.'),
    },
  },
  async ({ layout, ids, spacing, columns, startX, startY, expectedRevision }) =>
    dispatch({ type: 'auto_layout', layout, ids, spacing, columns, startX, startY }, expectedRevision),
)

// ==========================================
// 7. WORKSPACE, PROJECTS & BOARDS MANAGEMENT
// ==========================================

mcp.registerTool(
  'list_projects',
  {
    description: 'List all workspace projects with their IDs, names, and timestamps.',
  },
  async () => dispatch({ type: 'list_projects' }),
)

mcp.registerTool(
  'list_boards',
  {
    description: 'List boards in the workspace, optionally filtered by projectId.',
    inputSchema: {
      projectId: z.string().optional().describe('Optional projectId to filter boards.'),
    },
  },
  async ({ projectId }) => dispatch({ type: 'list_boards', projectId }),
)

mcp.registerTool(
  'create_board',
  {
    description: 'Create a new board in the workspace and optionally navigate the browser to it.',
    inputSchema: {
      name: z.string().min(1).describe('Name for the new board.'),
      projectId: z
        .string()
        .optional()
        .describe('Project ID to place the board in. Defaults to the active or default project.'),
      openBoard: z.boolean().default(true).describe('Whether to immediately open the new board in the browser.'),
    },
  },
  async ({ name, projectId, openBoard }) => dispatch({ type: 'create_board', name, projectId, openBoard }),
)

mcp.registerTool(
  'rename_board',
  {
    description: 'Rename a board.',
    inputSchema: {
      name: z.string().min(1).describe('New name for the board.'),
      boardId: z.string().optional().describe('Board ID to rename. Defaults to currently open board.'),
    },
  },
  async ({ name, boardId }) => dispatch({ type: 'rename_board', name, boardId }),
)

mcp.registerTool(
  'switch_board',
  {
    description: 'Navigate the active browser whiteboard to a different board by ID.',
    inputSchema: {
      boardId: z.string().min(1).describe('Board ID to navigate to.'),
    },
  },
  async ({ boardId }) => dispatch({ type: 'switch_board', boardId }),
)

// ==========================================
// 8. SHARING & PERMISSIONS
// ==========================================

mcp.registerTool(
  'get_share_info',
  {
    description: 'Get the shareable URL, general access permissions, and collaborator list for the current board.',
    inputSchema: {
      boardId: z.string().optional().describe('Board ID to inspect. Defaults to currently open board.'),
    },
  },
  async ({ boardId }) => dispatch({ type: 'get_share_info', boardId }),
)

mcp.registerTool(
  'share_board',
  {
    description:
      "Update sharing settings for the board (e.g., set public link access to 'anyone_with_link' or invite collaborators by email).",
    inputSchema: {
      boardId: z.string().optional().describe('Board ID to update. Defaults to currently open board.'),
      generalAccess: z
        .enum(['restricted', 'anyone_with_link'])
        .optional()
        .describe("Access level: 'restricted' or 'anyone_with_link'."),
      generalRole: z.enum(['viewer', 'editor']).optional().describe("Role for link visitors: 'viewer' or 'editor'."),
      inviteEmail: z.string().email().optional().describe('Email address to invite to this board.'),
      inviteRole: z
        .enum(['viewer', 'editor'])
        .default('editor')
        .describe("Role to grant the invited email: 'viewer' or 'editor'."),
    },
  },
  async ({ boardId, generalAccess, generalRole, inviteEmail, inviteRole }) =>
    dispatch({ type: 'share_board', boardId, generalAccess, generalRole, inviteEmail, inviteRole }),
)

// ==========================================
// 9. GRAPH & DAG ANALYSIS
// ==========================================

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

// ==========================================
// 10. WEBSOCKET SERVER INITIALIZATION
// ==========================================

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
        result?: unknown
        ok?: boolean
        data?: unknown
        error?: string
      }
      if (message.type === 'scene' && message.scene && Array.isArray(message.scene.elements)) {
        scene = message.scene
        selectionIds = Array.isArray(message.selectionIds) ? message.selectionIds : []
        revision += 1
        if (message.operationId) {
          pending
            .get(message.operationId)
            ?.resolve(message.result ?? { ok: true, operationId: message.operationId, ...summarize() })
          pending.delete(message.operationId)
        }
      } else if (message.type === 'operation_result' && message.operationId) {
        if (message.ok) {
          pending.get(message.operationId)?.resolve(message.data ?? { ok: true, operationId: message.operationId })
        } else {
          pending.get(message.operationId)?.reject(new Error(message.error || 'Operation failed in browser adapter'))
        }
        pending.delete(message.operationId)
      }
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid bridge message.' }))
    }
  })

  socket.on('close', () => adapters.delete(socket))
})

await mcp.connect(new StdioServerTransport())
console.error(`OpenExcalidraw MCP is ready; browser adapter WebSocket on ws://127.0.0.1:${bridgePort}`)
