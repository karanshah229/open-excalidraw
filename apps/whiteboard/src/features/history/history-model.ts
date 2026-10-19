import type { BoardScene } from '@agentic-whiteboard/storage'

/** UI projection of authorized history. Eligibility remains a server/storage decision. */
export type HistoryEntry = {
  id: string
  name: string
  createdAt: string
  capturedAt?: string
  current: boolean
  restorable?: boolean
  origin: 'cloud' | 'offline-import' | 'local'
  actorLabel?: string
  expiresAt?: string
}
export type HistorySnapshot = {
  entry: HistoryEntry
  scene: BoardScene
  notes: Record<string, string>
}
export type HistoryPage = { entries: HistoryEntry[]; cursor?: string }
export type HistoryRestoreResult = { operationId: string; generation: number }
export interface HistorySource {
  list(cursor?: string): Promise<HistoryPage>
  /** Complete, independently hydrated snapshot. Never inject it into the live editor. */
  preview(id: string, signal?: AbortSignal): Promise<HistorySnapshot>
  restore(id: string, operationId: string): Promise<HistoryRestoreResult>
}
export type HistoryGroup = { day: string; entries: HistoryEntry[] }

/** Day grouping retains every entry and the authoritative source order. */
export function groupHistory(entries: readonly HistoryEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  const byDay = new Map<string, HistoryGroup>()
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    const timestamp = new Date(entry.capturedAt ?? entry.createdAt)
    const day = Number.isNaN(timestamp.getTime()) ? 'Unknown date' : timestamp.toLocaleDateString()
    let group = byDay.get(day)
    if (!group) {
      group = { day, entries: [] }
      byDay.set(day, group)
      groups.push(group)
    }
    group.entries.push(entry)
  }
  return groups
}
export function mergeHistoryPages(previous: HistoryEntry[], incoming: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set(previous.map((entry) => entry.id))
  return [...previous, ...incoming.filter((entry) => !seen.has(entry.id) && !!seen.add(entry.id))]
}
