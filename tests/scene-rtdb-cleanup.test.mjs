/** Real SDK regression: cold transaction caches and exact captured-record cleanup. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIREBASE_DATABASE_EMULATOR_HOST)
  throw new Error('RTDB cleanup tests require disposable demo-regression emulators.')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getDatabase } = require('firebase-admin/database')
const { pruneCheckpointedRecords } = await import('../functions/lib/scene-compaction-cleanup.js')
const options = { projectId: 'demo-regression', databaseURL: 'https://demo-regression.firebaseio.com' }
const writerApp = initializeApp(options, 'cleanup-writer'),
  coldApp = initializeApp(options, 'cleanup-reader')
const writer = getDatabase(writerApp),
  cold = getDatabase(coldApp),
  root = `cleanup-fixture/${Date.now()}`
const original = { id: 'x', version: 1, versionNonce: 2, data: '{"id":"x","version":1}' }
const initialCallbacks = []
try {
  await writer.ref(`${root}/elements/x`).set(original)
  const captured = (await cold.ref(`${root}/elements`).get()).val()
  const oldAttempt = await cold.ref(`${root}/elements/x`).transaction((current) => {
    initialCallbacks.push(current === null ? 'null' : 'object')
    // Reproduce pre-fix behavior so the test demonstrates the actual fault.
    if (current && JSON.stringify(current) === JSON.stringify(captured.x)) return null
    return undefined
  })
  assert.equal(oldAttempt.committed, false)
  assert((await writer.ref(`${root}/elements/x`).get()).exists())
  assert(initialCallbacks.includes('null'), 'real SDK must expose the cold-cache boundary')
  await pruneCheckpointedRecords(cold.ref(`${root}/elements`), cold.ref(`${root}/presence`), captured)
  assert(!(await writer.ref(`${root}/elements/x`).get()).exists())
  await writer.ref(`${root}/elements/x`).set({ ...original, version: 2 })
  await pruneCheckpointedRecords(cold.ref(`${root}/elements`), cold.ref(`${root}/presence`), captured)
  assert.equal((await writer.ref(`${root}/elements/x`).get()).val().version, 2)
  await writer.ref(`${root}/presence/reconnected`).set({ uid: 'active' })
  await pruneCheckpointedRecords(cold.ref(`${root}/elements`), cold.ref(`${root}/presence`), {
    x: { ...original, version: 2 },
  })
  assert.equal((await writer.ref(`${root}/elements/x`).get()).val().version, 2)
  const result = {
    passed: [
      'real cold SDK old callback abort reproduced; exact unchanged record pruned',
      'newer replacement retained',
      'reconnected participant retains record',
    ],
    initialCallbacks,
  }
  const artifacts = process.env.E2E_ARTIFACT_DIR || '.system_generated/scene-backend'
  await mkdir(artifacts, { recursive: true })
  await writeFile(`${artifacts}/rtdb-cleanup.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  await writer.ref(root).remove()
  await Promise.all([deleteApp(writerApp), deleteApp(coldApp)])
}
