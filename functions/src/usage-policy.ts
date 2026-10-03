export const KiB = 1024
export const MiB = KiB * 1024
export const GiB = MiB * 1024

export type Plan = 'free' | 'pro'
export type Limits = {
  boards: number | null
  assetBytes: number
  imageBytes: number
  documentBytes: number
  currentDocumentBytes: number
  sessions: number
  dailySaves: number
  historyCount: number
  historyDays: number
  historyBytes: number
}

export const PLAN_LIMITS: Record<Plan, Limits> = {
  free: {
    boards: 3,
    assetBytes: 25 * MiB,
    imageBytes: 5 * MiB,
    documentBytes: 900 * KiB,
    currentDocumentBytes: 6 * 900 * KiB,
    sessions: 3,
    dailySaves: 1000,
    historyCount: 10,
    historyDays: 7,
    historyBytes: 30 * 900 * KiB,
  },
  pro: {
    boards: null,
    assetBytes: GiB,
    imageBytes: 10 * MiB,
    documentBytes: 900 * KiB,
    currentDocumentBytes: 100 * MiB,
    sessions: 10,
    dailySaves: 5000,
    historyCount: 50,
    historyDays: 30,
    historyBytes: 250 * MiB,
  },
}

/** Firestore counts UTF-8 fields/values and document path overhead, not JSON bytes. */
export function firestoreDocumentBytes(path: string, data: Record<string, unknown>): number {
  const stringBytes = (value: string) => Buffer.byteLength(value, 'utf8') + 1
  function valueBytes(value: unknown): number {
    if (value === null || typeof value === 'boolean') return 1
    if (typeof value === 'number') return 8
    if (typeof value === 'string') return stringBytes(value)
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + valueBytes(item), 0)
    if (value && typeof value === 'object') return mapBytes(value as Record<string, unknown>) + 32
    throw new Error('Cloud documents must contain only JSON values.')
  }
  function mapBytes(value: Record<string, unknown>): number {
    return Object.entries(value).reduce((sum, [key, item]) => sum + stringBytes(key) + valueBytes(item), 0)
  }
  return path.split('/').reduce((sum, part) => sum + stringBytes(part), 16) + mapBytes(data) + 32
}

export function normalizeEmail(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase() : null
}

export function complimentaryPlan(email: unknown, verified: boolean, list: unknown[]): Plan {
  const normalized = normalizeEmail(email)
  return verified && normalized && list.some((item) => normalizeEmail(item) === normalized) ? 'pro' : 'free'
}

export function periodAt(now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10)
  return { day, resetsAt: new Date(Date.parse(day) + 86400000).toISOString() }
}
