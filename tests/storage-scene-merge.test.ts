import assert from 'node:assert/strict'
import { mergeBoardScenes } from '../packages/storage/src/index'

const compact = { id: 'shape', version: 8, versionNonce: 20, firstObservedDeletedAt: '2026-01-01T00:00:00.000Z', compacted: true }
const staleLocal = mergeBoardScenes({ elements: [{ id: 'shape', version: 7, versionNonce: 1 }], appState: {} }, {
  elements: [], appState: {}, deletionLedger: [compact],
})
assert.deepEqual(staleLocal.elements, [])
assert.deepEqual(staleLocal.deletionLedger, [compact])

const validResurrection = mergeBoardScenes({ elements: [{ id: 'shape', version: 9, versionNonce: 1, isDeleted: false }], appState: {} }, {
  elements: [], appState: {}, deletionLedger: [compact],
})
assert.deepEqual(validResurrection.elements, [{ id: 'shape', version: 9, versionNonce: 1, isDeleted: false }])
assert.deepEqual(validResurrection.deletionLedger, [])

const equivalentOfflineTombstone = mergeBoardScenes({ elements: [{ id: 'shape', version: 8, versionNonce: 20, isDeleted: true }], appState: {} }, {
  elements: [], appState: {}, deletionLedger: [compact],
})
assert.deepEqual(equivalentOfflineTombstone.elements, [])
assert.deepEqual(equivalentOfflineTombstone.deletionLedger, [compact])

const observed = { ...compact, compacted: false }
const fullUndoState = mergeBoardScenes({ elements: [{ id: 'shape', version: 8, versionNonce: 20, isDeleted: true }], appState: {} }, {
  elements: [{ id: 'shape', version: 8, versionNonce: 20, isDeleted: true }], appState: {}, deletionLedger: [observed],
})
assert.deepEqual(fullUndoState.elements, [{ id: 'shape', version: 8, versionNonce: 20, isDeleted: true }])
assert.deepEqual(fullUndoState.deletionLedger, [observed])

assert.throws(() => mergeBoardScenes({ elements: [], appState: {}, deletionLedger: [compact, compact] }, {
  elements: [], appState: {},
}), /Invalid board scene deletion ledger/)
console.log('Local scene storage preserves compact deletions, LWW resurrection, and full undo state.')
