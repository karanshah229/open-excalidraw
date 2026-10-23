import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import test from 'node:test'

const requireFromFunctions = createRequire(new URL('../functions/package.json', import.meta.url))
const { getApps, initializeApp } = requireFromFunctions('firebase-admin/app')
const { getFirestore } = requireFromFunctions('firebase-admin/firestore')
const { manifestDigest, SCENE_PROTOCOL_VERSION } = await import('../functions/lib/scene-codec.js')

test('dry-run CLI emits a persisted valid-board report without authorizing deletion', async (t) => {
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-regression')
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST)
  if (getApps().length === 0) initializeApp({ projectId: 'demo-regression' })
  const db = getFirestore()
  const boardId = `dry_run_${randomUUID().replaceAll('-', '')}`
  const ownerId = 'dry-run-owner'
  const root = `boardScenes/${boardId}`
  const payload = JSON.stringify([{ key: 'element', kind: 'extra', value: { text: 'reachable' } }])
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex')
  const references = [{ chunkId: 'chunk_000000', digest }]
  const candidateDigest = await manifestDigest(references, 1)
  const tempDir = await mkdtemp(join(tmpdir(), 'scene-maintenance-dry-run-'))
  const outputPath = join(tempDir, 'report.json')
  t.after(async () => {
    await db.recursiveDelete(db.doc(root))
    await db.doc(`boardShares/${boardId}`).delete()
    await rm(tempDir, { recursive: true, force: true })
  })

  await db.doc(root).set({ ownerId, projectId: null, headRevisionId: 'r1', generation: 1, sceneFormatVersion: 1 })
  await db.doc(`boardShares/${boardId}`).set({
    boardId, ownerId, projectId: null, pending: false, active: true, generalAccess: 'restricted', generalRole: 'owner',
  })
  await db.doc(`${root}/revisions/r1`).set({
    generation: 1, sceneFormatVersion: 1, sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
    pageCount: 1, chunkCount: 1, candidateDigest,
  })
  await db.doc(`${root}/revisions/r1/pages/000000`).set({ references })
  await db.doc(`${root}/chunks/chunk_000000`).set({
    payload, digest, generation: 1, kind: 'records', uploadId: 'r1', slot: 0, uploaderUid: ownerId,
  })

  const run = spawnSync(process.execPath, [
    'scripts/scene-maintenance-dry-run.mjs', '--project', 'demo-regression', '--board', boardId, '--output', outputPath,
  ], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: process.env })
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)
  const report = JSON.parse(await readFile(outputPath, 'utf8'))
  assert.equal(report.canAuthorizeDeletion, false)
  assert.equal(report.censusComplete, true)
  assert.equal(report.payloadBytes.stored, Buffer.byteLength(payload, 'utf8'))
  assert.equal(report.payloadBytes.reachable, Buffer.byteLength(payload, 'utf8'))
  assert.equal(report.counts.writerProtocolVersions[`v${SCENE_PROTOCOL_VERSION}`], 1)
  assert.equal(report.plan.safeToCollect, true)
  assert.deepEqual(report.plan.candidateOrphans, [])
})
