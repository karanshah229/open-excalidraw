import assert from 'node:assert/strict'
import { groupHistory, mergeHistoryPages, type HistoryEntry } from '../apps/whiteboard/src/features/history/history-model'
const entry = (id: string, createdAt = '2026-10-01T12:00:00Z'): HistoryEntry => ({ id, createdAt, name: id, current: false, origin: 'cloud' })
const first = [entry('a'), entry('b')]
const second = [entry('b'), entry('c'), entry('c'), entry('d', '2026-09-01T12:00:00Z')]
const merged = mergeHistoryPages(first, second)
assert.deepEqual(merged.map((item) => item.id), ['a', 'b', 'c', 'd'])
const groups = groupHistory(merged)
assert.deepEqual(groups.flatMap((group) => group.entries.map((item) => item.id)), ['a', 'b', 'c', 'd'])
assert.equal(groups.length, 2)
assert.equal(groupHistory([entry('a'), entry('a')])[0].entries.length, 1)
assert.equal(groupHistory([entry('bad', 'invalid')])[0].day, 'Unknown date')
// Device-local capture date is a label only; authoritative source order is preserved.
assert.deepEqual(groupHistory([entry('newer'), { ...entry('offline'), capturedAt: '2026-09-01T12:00:00Z' }]).flatMap((group) => group.entries.map((item) => item.id)), ['newer', 'offline'])
console.log('Board history UI grouping and pagination assertions passed')
