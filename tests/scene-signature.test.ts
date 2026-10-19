import assert from 'node:assert/strict'
import { getSceneSignature } from '../apps/whiteboard/src/features/scenes/scene-signature.js'
import { reconcileElementsLWW } from '../apps/whiteboard/src/features/collaboration/reconcile.js'

const element = { id: 'remote', version: 9, versionNonce: 486027608, updated: 10, x: 100, y: 200 }
const scene = (item: typeof element) => ({ elements: [item], appState: { viewBackgroundColor: '#fff' }, files: {} })

const winner = reconcileElementsLWW([element], [{ ...element, versionNonce: 241402669 }])[0]
assert.deepEqual(
  [winner.version, winner.versionNonce, winner.x, winner.y],
  [element.version, 241402669, element.x, element.y],
  'Equal-version, same-geometry collaboration conflict selects the lower nonce',
)
assert.notEqual(
  getSceneSignature(scene(element)),
  getSceneSignature(scene(winner)),
  'The same-version remote LWW winner must mark the persisted scene dirty',
)
assert.equal(
  getSceneSignature(scene(element)),
  getSceneSignature(scene({ ...element, updated: 11 })),
  'Transport timestamp changes alone do not mark the scene dirty',
)
console.log('Scene signature preserves versionNonce changes and ignores updated metadata.')
