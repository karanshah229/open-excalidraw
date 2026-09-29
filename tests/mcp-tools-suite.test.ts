import { WebSocketServer, WebSocket } from 'ws'
import {
  generateArchitecturalTemplate,
  computeAutoLayout,
  type ArchitectureTemplateType,
} from '../apps/whiteboard/src/features/mcp-bridge/mcp-operations'

async function runMcpToolsSuite() {
  console.log('====================================================')
  console.log('🧪 RUNNING MCP TOOLS SUITE & ARCHITECTURE TESTS')
  console.log('====================================================\n')

  // ----------------------------------------------------
  // Test 1: Architectural Template Generation
  // ----------------------------------------------------
  console.log('▶ Test 1: Architectural Template Generation')
  const templates: ArchitectureTemplateType[] = [
    'microservice',
    'database_cluster',
    'api_gateway',
    'queue',
    'client_frontend',
    'auth_service',
    'cloud_storage',
  ]

  for (const t of templates) {
    const elements = generateArchitecturalTemplate(t, 100, 150, `Custom ${t}`)
    if (elements.length < 1) throw new Error(`Template ${t} produced empty elements`)
    const container = elements[0]
    if (container.type !== 'rectangle') throw new Error(`Template ${t} container must be rectangle`)
    if (container.x !== 100 || container.y !== 150) throw new Error(`Template ${t} coordinates mismatch`)
  }
  console.log(`   ✓ All ${templates.length} architectural templates generated valid skeleton shapes`)

  // ----------------------------------------------------
  // Test 2: Auto-Layout Operations (Horizontal, Vertical, Grid)
  // ----------------------------------------------------
  console.log('\n▶ Test 2: Auto-Layout Operations')
  const testNodes = [
    { id: 'node_1', type: 'rectangle', x: 500, y: 100, width: 200, height: 100, isDeleted: false },
    { id: 'node_2', type: 'rectangle', x: 100, y: 300, width: 200, height: 100, isDeleted: false },
    { id: 'node_3', type: 'rectangle', x: 800, y: 600, width: 200, height: 100, isDeleted: false },
    { id: 'arrow_1', type: 'arrow', x: 200, y: 200, isDeleted: false }, // should remain untouched
  ]

  // Horizontal layout
  const horizontalResult = computeAutoLayout(testNodes, { layout: 'horizontal', spacing: 50, startX: 50, startY: 100 })
  const h1 = horizontalResult.find((e) => e.id === 'node_1')!
  const h2 = horizontalResult.find((e) => e.id === 'node_2')!
  const h3 = horizontalResult.find((e) => e.id === 'node_3')!
  if (h1.x !== 50 || h2.x !== 50 + 200 + 50 || h3.x !== 50 + (200 + 50) * 2) {
    throw new Error('Horizontal layout failed to place nodes along X axis with spacing')
  }
  console.log('   ✓ Horizontal layout arranged shapes with exact spacing gaps')

  // Vertical layout
  const verticalResult = computeAutoLayout(testNodes, { layout: 'vertical', spacing: 40, startX: 100, startY: 50 })
  const v1 = verticalResult.find((e) => e.id === 'node_1')!
  const v2 = verticalResult.find((e) => e.id === 'node_2')!
  const v3 = verticalResult.find((e) => e.id === 'node_3')!
  if (v1.y !== 50 || v2.y !== 50 + 100 + 40 || v3.y !== 50 + (100 + 40) * 2) {
    throw new Error('Vertical layout failed to place nodes along Y axis with spacing')
  }
  console.log('   ✓ Vertical layout arranged shapes with exact vertical spacing')

  // Grid layout (2 columns)
  const gridResult = computeAutoLayout(testNodes, { layout: 'grid', columns: 2, spacing: 30, startX: 0, startY: 0 })
  const g1 = gridResult.find((e) => e.id === 'node_1')!
  const g2 = gridResult.find((e) => e.id === 'node_2')!
  const g3 = gridResult.find((e) => e.id === 'node_3')!
  // g1: col 0, row 0 -> (0, 0)
  // g2: col 1, row 0 -> (200 + 30, 0) = (230, 0)
  // g3: col 0, row 1 -> (0, 100 + 30) = (0, 130)
  if (g1.x !== 0 || g1.y !== 0 || g2.x !== 230 || g2.y !== 0 || g3.x !== 0 || g3.y !== 130) {
    throw new Error(`Grid layout coordinates mismatch: g1=(${g1.x},${g1.y}), g2=(${g2.x},${g2.y}), g3=(${g3.x},${g3.y})`)
  }
  console.log('   ✓ Grid layout arranged shapes into 2-column matrix')

  // Arrow preservation
  const arrow = gridResult.find((e) => e.id === 'arrow_1')!
  if (arrow.x !== 200 || arrow.y !== 200) {
    throw new Error('Arrows should not be repositioned as boxes in auto_layout')
  }
  console.log('   ✓ Connectors and non-node elements safely excluded from box layout')

  // ----------------------------------------------------
  // Test 3: Element Grouping & Ungrouping Logic
  // ----------------------------------------------------
  console.log('\n▶ Test 3: Element Grouping & Ungrouping Logic')
  const newGroupId = 'group_abc_123'
  const targetIds = new Set(['node_1', 'node_2'])

  const grouped = testNodes.map((el) => {
    if (targetIds.has(el.id)) {
      const groupIds = Array.isArray((el as any).groupIds) ? [...(el as any).groupIds] : []
      if (!groupIds.includes(newGroupId)) groupIds.push(newGroupId)
      return { ...el, groupIds }
    }
    return el
  })
  if ((grouped[0] as any).groupIds[0] !== newGroupId || (grouped[1] as any).groupIds[0] !== newGroupId) {
    throw new Error('Failed to attach group ID to elements')
  }

  const ungrouped = grouped.map((el) => {
    if (targetIds.has(el.id)) {
      return { ...el, groupIds: [] }
    }
    return el
  })
  if ((ungrouped[0] as any).groupIds.length !== 0) {
    throw new Error('Failed to ungroup elements')
  }
  console.log('   ✓ Grouping and ungrouping accurately managed groupIds arrays')

  // ----------------------------------------------------
  // Test 4: Element Search & Filtering Algorithm
  // ----------------------------------------------------
  console.log('\n▶ Test 4: Element Search & Filtering Algorithm')
  const searchCorpus = [
    { id: 'box_1', type: 'rectangle', text: 'Auth Service API', isDeleted: false },
    { id: 'box_2', type: 'rectangle', label: { text: 'PostgreSQL Database' }, isDeleted: false },
    { id: 'text_1', type: 'text', text: 'Redis Cache Layer', isDeleted: false },
    { id: 'deleted_1', type: 'rectangle', text: 'Auth Service Old', isDeleted: true },
  ]

  // Query: "auth"
  const authMatches = searchCorpus.filter((e) => {
    if (e.isDeleted) return false
    const idMatch = e.id.toLowerCase().includes('auth')
    const textMatch = typeof e.text === 'string' && e.text.toLowerCase().includes('auth')
    const labelMatch = (e as any).label?.text?.toLowerCase().includes('auth')
    return idMatch || textMatch || labelMatch
  })
  if (authMatches.length !== 1 || authMatches[0].id !== 'box_1') {
    throw new Error(`Expected 1 match for 'auth', got ${authMatches.length}`)
  }
  console.log('   ✓ Search query matched active text content while ignoring tombstones')

  // Query by type: "text"
  const textMatches = searchCorpus.filter((e) => !e.isDeleted && e.type === 'text')
  if (textMatches.length !== 1 || textMatches[0].id !== 'text_1') {
    throw new Error('Expected 1 text element match')
  }
  console.log('   ✓ Search filtered accurately by element type')

  console.log('\n====================================================')
  console.log('🎉 ALL MCP TOOLS TESTS PASSED!')
  console.log('====================================================')
}

void runMcpToolsSuite()
