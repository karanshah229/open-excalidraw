import assert from 'node:assert/strict'
import {
  compactFencedTombstones,
  observeSceneTombstones,
} from '../functions/src/scene-deletion-ledger'

const deleted = { id: 'shape', version: 4, versionNonce: 7, isDeleted: true, x: 12, y: 18, width: 80, height: 50 }
const observedAt = Date.UTC(2026, 0, 1)
const firstObservation = observeSceneTombstones([deleted], [deleted], [], observedAt)
assert.deepEqual(firstObservation.deletionLedger, [{ id: 'shape', version: 4, versionNonce: 7,
  firstObservedDeletedAt: new Date(observedAt).toISOString(), compacted: false }])

const outOfOrder = observeSceneTombstones(firstObservation.elements,
  [{ ...deleted, version: 3, versionNonce: 1, isDeleted: false, x: 900 }], firstObservation.deletionLedger,
  observedAt + 1)
assert.deepEqual(outOfOrder.elements, [deleted], 'stale live save cannot beat the canonical full tombstone')
assert.equal(outOfOrder.deletionLedger[0].firstObservedDeletedAt, new Date(observedAt).toISOString(),
  'resaves cannot reset the server-observed clock')

const activeSession = compactFencedTombstones(outOfOrder.elements, outOfOrder.deletionLedger, [])
assert.deepEqual(activeSession.elements, [deleted], 'an active board session cannot authorize compaction')
assert.deepEqual(activeSession.compactedIds, [])
const atBoundary = compactFencedTombstones(outOfOrder.elements, outOfOrder.deletionLedger, ['shape'])
assert.deepEqual(atBoundary.elements, [], 'eligible tombstone geometry is removed from the new snapshot')
assert.deepEqual(atBoundary.compactedIds, ['shape'])
assert.equal(atBoundary.deletionLedger[0].compacted, true)

const undo = observeSceneTombstones([], [{ ...deleted, version: 5, versionNonce: 1, isDeleted: false }],
  atBoundary.deletionLedger, observedAt + 2)
assert.deepEqual(undo.elements, [{ ...deleted, version: 5, versionNonce: 1, isDeleted: false }])
assert.deepEqual(undo.deletionLedger, [], 'a comparator-winning recreation clears the compact marker')
console.log('Scene deletion ledger: server clock, session-fenced compaction, stale offline save, and valid undo passed.')
