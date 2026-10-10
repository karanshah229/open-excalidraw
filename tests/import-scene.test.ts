import assert from 'node:assert/strict'
import { replaceSceneElements } from '../apps/whiteboard/src/features/scenes/import-scene'
import { reconcileElementsLWW } from '../apps/whiteboard/src/features/collaboration/reconcile'

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
console.log('Explicit import replacement: lower versions, tombstones, bindings, and LWW convergence passed.')
