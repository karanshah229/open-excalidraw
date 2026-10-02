import type { BoardShareConfig } from '../sharing/sharing-service'

export type ArchitectureTemplateType =
  'microservice' | 'database_cluster' | 'api_gateway' | 'queue' | 'client_frontend' | 'auth_service' | 'cloud_storage'

export interface AutoLayoutOptions {
  layout: 'horizontal' | 'vertical' | 'grid'
  ids?: string[]
  spacing?: number
  columns?: number
  startX?: number
  startY?: number
}

export function generateArchitecturalTemplate(
  template: ArchitectureTemplateType,
  x = 200,
  y = 200,
  customLabel?: string,
): Array<Record<string, unknown>> {
  const seed = Math.floor(Math.random() * 1e6)

  switch (template) {
    case 'microservice':
      return [
        {
          type: 'rectangle',
          x,
          y,
          width: 220,
          height: 100,
          strokeColor: '#2563eb',
          backgroundColor: '#eff6ff',
          fillStyle: 'solid',
          strokeWidth: 2,
          roughness: 1,
          roundness: { type: 3 },
          label: { text: customLabel || 'Microservice', fontSize: 16 },
          seed,
        },
        {
          type: 'text',
          x: x + 16,
          y: y + 68,
          text: 'Service · REST / gRPC API',
          fontSize: 12,
          strokeColor: '#64748b',
          seed: seed + 1,
        },
      ]

    case 'database_cluster':
      return [
        {
          type: 'rectangle',
          x,
          y,
          width: 200,
          height: 110,
          strokeColor: '#059669',
          backgroundColor: '#ecfdf5',
          fillStyle: 'solid',
          strokeWidth: 2,
          roughness: 1,
          roundness: { type: 3 },
          label: { text: customLabel || 'Database Cluster', fontSize: 16 },
          seed,
        },
        {
          type: 'text',
          x: x + 16,
          y: y + 74,
          text: 'PostgreSQL · Primary/Replica',
          fontSize: 12,
          strokeColor: '#047857',
          seed: seed + 1,
        },
      ]

    case 'api_gateway':
      return [
        {
          type: 'rectangle',
          x,
          y,
          width: 240,
          height: 90,
          strokeColor: '#7c3aed',
          backgroundColor: '#f5f3ff',
          fillStyle: 'solid',
          strokeWidth: 2,
          roughness: 1,
          roundness: { type: 3 },
          label: { text: customLabel || 'API Gateway', fontSize: 16 },
          seed,
        },
        {
          type: 'text',
          x: x + 16,
          y: y + 56,
          text: 'Reverse Proxy · Auth · Rate Limit',
          fontSize: 12,
          strokeColor: '#6d28d9',
          seed: seed + 1,
        },
      ]

    case 'queue':
      return [
        {
          type: 'rectangle',
          x,
          y,
          width: 210,
          height: 85,
          strokeColor: '#d97706',
          backgroundColor: '#fffbeb',
          fillStyle: 'solid',
          strokeWidth: 2,
          roughness: 1,
          roundness: { type: 3 },
          label: { text: customLabel || 'Message Queue', fontSize: 16 },
          seed,
        },
        {
          type: 'text',
          x: x + 16,
          y: y + 54,
          text: 'Event Bus · Kafka / RabbitMQ',
          fontSize: 12,
          strokeColor: '#b45309',
          seed: seed + 1,
        },
      ]

    case 'client_frontend':
      return [
        {
          type: 'rectangle',
          x,
          y,
          width: 190,
          height: 95,
          strokeColor: '#0284c7',
          backgroundColor: '#f0f9ff',
          fillStyle: 'solid',
          strokeWidth: 2,
          roughness: 1,
          roundness: { type: 3 },
          label: { text: customLabel || 'Frontend Client', fontSize: 16 },
          seed,
        },
        {
          type: 'text',
          x: x + 16,
          y: y + 62,
          text: 'Web / Mobile Application',
          fontSize: 12,
          strokeColor: '#0369a1',
          seed: seed + 1,
        },
      ]

    case 'auth_service':
      return [
        {
          type: 'rectangle',
          x,
          y,
          width: 210,
          height: 95,
          strokeColor: '#dc2626',
          backgroundColor: '#fef2f2',
          fillStyle: 'solid',
          strokeWidth: 2,
          roughness: 1,
          roundness: { type: 3 },
          label: { text: customLabel || 'Auth & Identity', fontSize: 16 },
          seed,
        },
        {
          type: 'text',
          x: x + 16,
          y: y + 62,
          text: 'OAuth2 · OIDC · JWT Tokens',
          fontSize: 12,
          strokeColor: '#b91c1c',
          seed: seed + 1,
        },
      ]

    case 'cloud_storage':
      return [
        {
          type: 'rectangle',
          x,
          y,
          width: 190,
          height: 90,
          strokeColor: '#0891b2',
          backgroundColor: '#ecfeff',
          fillStyle: 'solid',
          strokeWidth: 2,
          roughness: 1,
          roundness: { type: 3 },
          label: { text: customLabel || 'Object Storage', fontSize: 16 },
          seed,
        },
        {
          type: 'text',
          x: x + 16,
          y: y + 56,
          text: 'S3 / GCS · Media Assets',
          fontSize: 12,
          strokeColor: '#0e7490',
          seed: seed + 1,
        },
      ]

    default:
      return [
        {
          type: 'rectangle',
          x,
          y,
          width: 200,
          height: 100,
          strokeColor: '#334155',
          backgroundColor: '#f8fafc',
          fillStyle: 'solid',
          strokeWidth: 2,
          label: { text: customLabel || 'Component', fontSize: 16 },
          seed,
        },
      ]
  }
}

export function computeAutoLayout(allElements: any[], options: AutoLayoutOptions): any[] {
  const targetIds = options.ids && options.ids.length > 0 ? new Set(options.ids) : null
  const nodes = allElements.filter((e) => !e.isDeleted && e.type !== 'arrow' && (!targetIds || targetIds.has(e.id)))
  if (nodes.length === 0) return allElements

  const spacing = options.spacing ?? 80
  const minX = Math.min(...nodes.map((n) => n.x))
  const minY = Math.min(...nodes.map((n) => n.y))
  const startX = options.startX ?? minX
  const startY = options.startY ?? minY

  const maxW = Math.max(...nodes.map((n) => n.width || 150))
  const maxH = Math.max(...nodes.map((n) => n.height || 100))

  const newPositions = new Map<string, { x: number; y: number }>()

  if (options.layout === 'horizontal') {
    let currX = startX
    for (const node of nodes) {
      newPositions.set(node.id, { x: currX, y: startY + (maxH - (node.height || 100)) / 2 })
      currX += (node.width || 150) + spacing
    }
  } else if (options.layout === 'vertical') {
    let currY = startY
    for (const node of nodes) {
      newPositions.set(node.id, { x: startX + (maxW - (node.width || 150)) / 2, y: currY })
      currY += (node.height || 100) + spacing
    }
  } else if (options.layout === 'grid') {
    const cols = Math.max(1, options.columns ?? 3)
    nodes.forEach((node, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      newPositions.set(node.id, {
        x: startX + col * (maxW + spacing),
        y: startY + row * (maxH + spacing),
      })
    })
  }

  return allElements.map((el) => {
    if (newPositions.has(el.id)) {
      const pos = newPositions.get(el.id)!
      return {
        ...el,
        x: pos.x,
        y: pos.y,
        version: (el.version ?? 1) + 1,
        versionNonce: Math.floor(Math.random() * 1e9),
      }
    }
    return el
  })
}
