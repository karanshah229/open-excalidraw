import assert from 'node:assert/strict'
import { replaceSceneElements, replaceSceneElementsAndDeletionLedger } from '../apps/whiteboard/src/features/scenes/import-scene'
import { reconcileElementsLWW, reconcileElementsAndDeletionLedger } from '../apps/whiteboard/src/features/collaboration/reconcile'

const original = Array.from({ length: 2000 }, (_, index) => ({
  id: `shape-${index}`,
  type: 'rectangle',
  version: 30,
  versionNonce: 0,
  x: index,
  isDeleted: false,
}))
const imported = original.slice(0, 80).map((element) => ({ ...element, version: 1, x: -10 }))
imported[0] = { ...imported[0], frameId: 'shape-1', boundElements: [{ id: 'shape-2', type: 'arrow' }] } as any
const replacement = replaceSceneElements(original, imported, 123)
assert.equal(replacement.filter((element) => !element.isDeleted).length, 80)
assert.equal(replacement.filter((element) => element.isDeleted).length, 1920)
assert.equal(replacement[0].version, 31)
assert.equal(replacement[0].frameId, 'shape-1')
assert.deepEqual(replacement[0].boundElements, [{ id: 'shape-2', type: 'arrow' }])
assert.equal(replacement[0].updated, 123)
assert.equal(original[0].version, 30, 'Original scene is not mutated')
for (const merged of [reconcileElementsLWW(replacement, original), reconcileElementsLWW(original, replacement)]) {
  assert.equal(merged.filter((element) => !element.isDeleted).length, 80)
  assert.equal(merged.find((element) => element.id === 'shape-0')?.x, -10)
}
const existingDeleted = { id: 'deleted', version: 10, isDeleted: true }
assert.equal(replaceSceneElements([existingDeleted], [])[0], existingDeleted)
assert.equal(replaceSceneElements(original, []).filter((element) => !element.isDeleted).length, 0)
assert.equal(replaceSceneElements([], [{ id: 'new', version: 2 }])[0].version, 3)
const compactDelete = { id: 'compacted', version: 8, versionNonce: 20, firstObservedDeletedAt: '2026-01-01T00:00:00.000Z', compacted: true }
const staleLiveMerge = reconcileElementsAndDeletionLedger([], [{ id: 'compacted', version: 7, versionNonce: 1, isDeleted: false }], [compactDelete], [])
assert.deepEqual(staleLiveMerge.elements, [], 'stale offline live records must not beat a compacted deletion')
assert.deepEqual(staleLiveMerge.deletionLedger, [compactDelete])
const importedOverCompact = replaceSceneElementsAndDeletionLedger(
  [], [{ id: 'compacted', version: 1, versionNonce: 1, isDeleted: false }], [compactDelete], 123,
)
assert.equal(importedOverCompact.elements[0].version, 10, 'explicit import must beat prior compact marker')
assert.deepEqual(importedOverCompact.deletionLedger, [], 'winning import clears only its matching compact marker')
const retainedCompact = replaceSceneElementsAndDeletionLedger(
  [], [{ id: 'new', version: 1, versionNonce: 1 }], [compactDelete], 123,
)
assert.deepEqual(retainedCompact.deletionLedger, [compactDelete], 'replacement preserves unrelated compact markers')
const validUndoMerge = reconcileElementsAndDeletionLedger([], [{ id: 'compacted', version: 9, versionNonce: 99, isDeleted: false }], [compactDelete], [])
assert.deepEqual(validUndoMerge.elements, [{ id: 'compacted', version: 9, versionNonce: 99, isDeleted: false }])
assert.deepEqual(validUndoMerge.deletionLedger, [], 'a comparator-winning resurrection clears its compact marker')
const nonceTieMerge = reconcileElementsAndDeletionLedger(
  [], [{ id: 'compacted', version: 8, versionNonce: 20, isDeleted: false }], [compactDelete], [],
)
assert.deepEqual(nonceTieMerge.elements, [], 'equal version uses the existing lower-nonce winner')
assert.deepEqual(nonceTieMerge.deletionLedger, [compactDelete])
const fullTombstoneWins = reconcileElementsAndDeletionLedger(
  [], [{ id: 'compacted', version: 9, versionNonce: 20, isDeleted: true }], [compactDelete], [],
)
assert.deepEqual(fullTombstoneWins.elements, [{ id: 'compacted', version: 9, versionNonce: 20, isDeleted: true }])
assert.deepEqual(fullTombstoneWins.deletionLedger, [])
console.log('Explicit import replacement: lower versions, tombstones, bindings, and LWW convergence passed.')
