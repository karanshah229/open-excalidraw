import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertGenerationResetAdvance, nextGenerationResetAction } from '../functions/lib/scene-generation-transition.js'

const record = {
  operationId: 'reset-1', token: 'token-1', phase: 'prepared',
  sourceGeneration: 1, targetGeneration: 2, sourceHeadRevisionId: 'revision-1',
}
const observation = (overrides = {}) => ({
  headGeneration: 1, headRevisionId: 'revision-1', roomGeneration: 1,
  admissionClosed: false, admissionOwner: null, ...overrides,
})

test('prepared reset closes admission before fencing the old room', () => {
  assert.equal(nextGenerationResetAction(record, observation()), 'close-admission')
  assert.equal(nextGenerationResetAction(record, observation({ admissionClosed: true, admissionOwner: 'token-1' })), 'fence-room')
})

test('fenced reset publishes only while the old head and owned RTDB gate remain intact', () => {
  const fenced = { ...record, phase: 'fenced' }
  assert.equal(nextGenerationResetAction(fenced, observation({ admissionClosed: true, admissionOwner: 'token-1', roomGeneration: 2 })), 'publish-target')
  assert.throws(() => nextGenerationResetAction(fenced, observation({ admissionClosed: false })), /lost RTDB admission ownership/)
  assert.throws(() => nextGenerationResetAction(fenced, observation({ admissionClosed: true, admissionOwner: 'token-1', headRevisionId: 'newer' })), /does not match source or prepared target/)
})

test('published reset always finishes target activation and never rolls Firestore back', () => {
  const published = { ...record, phase: 'published', targetHeadRevisionId: 'revision-2' }
  const targetHead = observation({ headGeneration: 2, headRevisionId: 'revision-2', admissionClosed: true, admissionOwner: 'token-1' })
  assert.equal(nextGenerationResetAction(published, targetHead), 'activate-target')
  assert.equal(nextGenerationResetAction(published, { ...targetHead, roomGeneration: 2 }), 'reopen-admission')
  assert.throws(() => nextGenerationResetAction(published, { ...targetHead, headGeneration: 1, headRevisionId: 'revision-1' }), /published target does not match Firestore head/)
})

test('activated reset verifies Firestore and RTDB generations agree before completion', () => {
  const activated = { ...record, phase: 'activated', targetHeadRevisionId: 'revision-2' }
  const target = observation({ headGeneration: 2, headRevisionId: 'revision-2', roomGeneration: 2 })
  assert.equal(nextGenerationResetAction(activated, target), 'complete')
  assert.equal(nextGenerationResetAction(activated, { ...target, admissionClosed: true, admissionOwner: 'token-1' }), 'reopen-admission')
  assert.throws(() => nextGenerationResetAction(activated, { ...target, roomGeneration: 1 }), /inconsistent across stores/)
})

test('phase advancement is token-fenced, monotonic, and idempotent for retries', () => {
  assertGenerationResetAdvance(record, 'token-1', 'fenced')
  assertGenerationResetAdvance(record, 'token-1', 'prepared')
  assert.throws(() => assertGenerationResetAdvance(record, 'stale-token', 'fenced'), /does not own operation/)
  assert.throws(() => assertGenerationResetAdvance({ ...record, phase: 'published' }, 'token-1', 'cancelled'), /cannot advance published to cancelled/)
})

test('pre-publication cancellation can reopen only the unchanged source generation', () => {
  const cancelled = { ...record, phase: 'cancelled' }
  assert.equal(nextGenerationResetAction(cancelled, observation()), 'complete')
  assert.equal(nextGenerationResetAction(cancelled, observation({ admissionClosed: true, admissionOwner: 'token-1' })), 'reopen-admission')
  assert.throws(() => nextGenerationResetAction(cancelled, observation({ headGeneration: 2, headRevisionId: 'revision-2' })), /cannot follow a published head/)
})
