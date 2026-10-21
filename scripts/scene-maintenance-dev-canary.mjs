import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = 'open-excalidraw-dev-2'
const CANARY_PREFIX = 'scene_maintenance_canary_'
const CANARY_URL = 'https://us-central1-open-excalidraw-dev-2.cloudfunctions.net/sceneMaintenanceCanary'
const rootDir = fileURLToPath(new URL('..', import.meta.url))
const auditPathFor = (boardId) => resolve(rootDir, `docs/handoffs/scene-maintenance-dev-canary-${boardId}.json`)
const requireFromFunctions = createRequire(resolve(rootDir, 'functions/package.json'))
const { applicationDefault, getApps, initializeApp } = requireFromFunctions('firebase-admin/app')
const { Timestamp, getFirestore } = requireFromFunctions('firebase-admin/firestore')
const { manifestDigest, SCENE_FORMAT_VERSION, SCENE_PROTOCOL_VERSION } =
  await import('../functions/lib/scene-codec.js')

function parseArgs(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!['--prepare', '--collect', '--board', '--job'].includes(key)) throw new Error(`Unknown argument: ${key}`)
    if (args.has(key)) throw new Error(`Duplicate argument: ${key}`)
    if (key === '--prepare' || key === '--collect') args.set(key, true)
    else if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${key} needs a value`)
    else args.set(key, argv[++index])
  }
  if (args.get('--prepare') === args.get('--collect')) throw new Error('Choose exactly one of --prepare or --collect.')
  if (args.get('--prepare') && (args.has('--board') || args.has('--job'))) throw new Error('--prepare creates its own board.')
  if (args.get('--collect') && (!args.has('--board') || !args.has('--job'))) throw new Error('--collect requires --board and --job.')
  return args
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function invokeCloudCanary(action, boardId, jobId) {
  const token = execFileSync('gcloud', ['auth', 'print-identity-token'], { encoding: 'utf8' }).trim()
  const response = await fetch(CANARY_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action, boardId, ...(jobId ? { jobId } : {}) }),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Private dev canary returned HTTP ${response.status}: ${body.slice(0, 500)}`)
  return JSON.parse(body)
}

async function oracle(db, boardId, now) {
  const root = `boardScenes/${boardId}`
  const revisions = await db.collection(`${root}/revisions`).get()
  const reachable = new Set()
  for (const revision of revisions.docs) {
    const pages = await db.collection(`${root}/revisions/${revision.id}/pages`).get()
    for (const page of pages.docs) for (const ref of page.data().references ?? []) reachable.add(ref.chunkId)
  }
  for (const version of (await db.collection(`${root}/versions`).get()).docs) {
    const revision = revisions.docs.find((item) => item.id === version.data().revisionId)
    if (revision) {
      const pages = await db.collection(`${root}/revisions/${revision.id}/pages`).get()
      for (const page of pages.docs) for (const ref of page.data().references ?? []) reachable.add(ref.chunkId)
    }
  }
  for (const pin of (await db.collection(`${root}/readerPins`).get()).docs) {
    const value = pin.data()
    if (value.expiresAt?.toMillis?.() > now) for (const revisionId of value.revisionIds ?? []) {
      const pages = await db.collection(`${root}/revisions/${revisionId}/pages`).get()
      for (const page of pages.docs) for (const ref of page.data().references ?? []) reachable.add(ref.chunkId)
    }
  }
  for (const job of (await db.collection(`${root}/maintenanceJobs`).get()).docs) {
    const value = job.data()
    if (value.status === 'complete' || value.status === 'cancelled') continue
    for (const chunkId of value.protectedChunkIds ?? []) reachable.add(chunkId)
    for (const revisionId of value.protectedRevisionIds ?? []) {
      const pages = await db.collection(`${root}/revisions/${revisionId}/pages`).get()
      for (const page of pages.docs) for (const ref of page.data().references ?? []) reachable.add(ref.chunkId)
    }
  }
  for (const upload of (await db.collection(`${root}/uploads`).get()).docs) {
    const revisionId = upload.data().receipt?.revisionId
    if (!revisionId) continue
    const pages = await db.collection(`${root}/revisions/${revisionId}/pages`).get()
    for (const page of pages.docs) for (const ref of page.data().references ?? []) reachable.add(ref.chunkId)
  }
  return reachable
}

async function prepare(db) {
  const boardId = `${CANARY_PREFIX}${randomUUID().replaceAll('-', '')}`
  const ownerId = `canary_owner_${randomUUID().replaceAll('-', '')}`
  const root = `boardScenes/${boardId}`
  const now = Date.now()
  const livePayload = JSON.stringify([{ key: 'canary-live', kind: 'extra', value: { purpose: 'retain' } }])
  const orphanPayload = JSON.stringify([{ key: 'canary-orphan', kind: 'extra', value: { purpose: 'collect' } }])
  const liveRef = { chunkId: 'canary_live_chunk', digest: digest(livePayload) }
  const candidateDigest = await manifestDigest([liveRef], 1)

  console.log(JSON.stringify({ phase: 'creating-dedicated-dev-canary', projectId: PROJECT, boardId }))
  await db.doc(root).create({ ownerId, projectId: null, headRevisionId: 'canary_revision', generation: 1,
    sceneMaintenanceCanary: true,
    sceneFormatVersion: SCENE_FORMAT_VERSION })
  await db.doc(`boardShares/${boardId}`).create({ boardId, ownerId, projectId: null, pending: false, active: true })
  await db.doc(`${root}/revisions/canary_revision`).create({ generation: 1, sceneFormatVersion: SCENE_FORMAT_VERSION,
    sceneProtocolVersion: SCENE_PROTOCOL_VERSION, pageCount: 1, chunkCount: 1, candidateDigest, parentRevisionId: null })
  await db.doc(`${root}/revisions/canary_revision/pages/000000`).create({ references: [liveRef] })
  await db.doc(`${root}/chunks/canary_live_chunk`).create({ payload: livePayload, digest: liveRef.digest,
    uploadId: 'canary_revision', slot: 0, uploaderUid: ownerId, generation: 1, kind: 'records' })
  await db.doc(`${root}/uploads/canary_revision`).create({ uploaderUid: ownerId, expectedHeadRevisionId: 'canary_revision',
    generation: 1, sceneFormatVersion: SCENE_FORMAT_VERSION, sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
    pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest,
    createdAt: Timestamp.fromMillis(now - 2 * 60 * 60_000), expiresAt: Timestamp.fromMillis(now - 60 * 60_000),
    status: 'committed', receipt: { revisionId: 'canary_revision', generation: 1, candidateDigest } })

  const orphanUploadId = 'canary_orphan_upload'
  const orphanCreatedAt = Timestamp.fromMillis(now - 100 * 60 * 60_000)
  const orphanExpiresAt = Timestamp.fromMillis(now - 90 * 60 * 60_000)
  await db.doc(`${root}/uploads/${orphanUploadId}`).create({ uploaderUid: ownerId,
    expectedHeadRevisionId: 'canary_revision', generation: 1, sceneFormatVersion: SCENE_FORMAT_VERSION,
    sceneProtocolVersion: SCENE_PROTOCOL_VERSION, pageCount: 1, chunkCount: 1, newChunkCount: 1,
    candidateDigest: digest('canary-orphan-manifest'), createdAt: orphanCreatedAt, expiresAt: orphanExpiresAt })
  await db.doc(`${root}/chunks/canary_orphan_chunk`).create({ payload: orphanPayload, digest: digest(orphanPayload),
    uploadId: orphanUploadId, slot: 0, uploaderUid: ownerId, generation: 1, kind: 'records' })

  const tempDir = await mkdtemp(join(tmpdir(), 'scene-maintenance-canary-'))
  const reportPath = join(tempDir, 'dry-run.json')
  try {
    const run = spawnSync(process.execPath, ['scripts/scene-maintenance-dry-run.mjs', '--project', PROJECT,
      '--board', boardId, '--output', reportPath], { cwd: rootDir, encoding: 'utf8', env: process.env })
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    const reachable = await oracle(db, boardId, now)
    const chunks = await db.collection(`${root}/chunks`).get()
    const persistedIds = chunks.docs.map((item) => item.id)
    const oracleCandidates = persistedIds.filter((id) => !reachable.has(id)).sort()
    const plannerReachable = report.plan.reachableChunks.map((item) => item.id).sort()
    const plannerCandidates = report.plan.candidateOrphans.map((item) => item.id).sort()
    assert.equal(report.censusComplete, true)
    assert.equal(report.plan.safeToCollect, true)
    assert.deepEqual(plannerReachable, [...reachable].sort(), 'planner reachable set must match independent persisted-data oracle')
    assert.deepEqual(plannerCandidates, oracleCandidates, 'planner candidates must match independent persisted-data oracle')
    assert.deepEqual(plannerCandidates, ['canary_orphan_chunk'], 'canary must propose only its synthetic orphan')

    const proposal = await invokeCloudCanary('quarantine', boardId)
    assert.equal(proposal.status, 'proposal-only')
    assert.equal(proposal.candidateCount, 1)
    const control = (await db.doc(`${root}/maintenance/control`).get()).data()
    assert.equal(control.admission, 'open', 'quarantine must reopen writer admission')
    const pages = await db.collection(`${root}/maintenanceJobs/${proposal.jobId}/quarantinePages`).get()
    const entries = pages.docs.flatMap((page) => page.data().entries ?? [])
    assert.deepEqual(entries.map((entry) => entry.chunkId), ['canary_orphan_chunk'])
    const notBefore = entries[0].deleteNotBefore.toDate().toISOString()
    const auditPath = auditPathFor(boardId)
    const audit = { status: 'quarantined-awaiting-collection-verification', projectId: PROJECT, boardId, ownerId,
      quarantineJobId: proposal.jobId, epoch: proposal.epoch, candidateChunkIds: plannerCandidates,
      candidateBytes: proposal.candidateBytes, reachableChunkIds: plannerReachable,
      censusComplete: report.censusComplete, ownershipVerified: report.censusErrors.length === 0,
      independentOracleMatched: true, gateClosedDurationMs: proposal.gateClosedDurationMs,
      deleteNotBefore: notBefore, collectionCommand: `node scripts/scene-maintenance-dev-canary.mjs --collect --board ${boardId} --job ${proposal.jobId}` }
    await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`)
    console.log(JSON.stringify(audit))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function collect(db, boardId, jobId) {
  if (!boardId.startsWith(CANARY_PREFIX) || !/^gc_[A-Za-z0-9_-]+$/.test(jobId))
    throw new Error('Collection is restricted to generated dev-canary boards and quarantine jobs.')
  const root = `boardScenes/${boardId}`
  const [headSnapshot, shareSnapshot] = await Promise.all([
    db.doc(root).get(), db.doc(`boardShares/${boardId}`).get(),
  ])
  const head = headSnapshot.data(), share = shareSnapshot.data()
  assert(head && share && head.ownerId === share.ownerId && head.projectId == null && share.projectId == null,
    'synthetic canary ownership must match its standalone sharing record')
  if (head.sceneMaintenanceCanary !== true) {
    assert(/^scene_maintenance_canary_[a-f0-9]{32}$/.test(boardId), 'legacy fast-track accepts only generated canary IDs')
    assert(/^canary_owner_[a-f0-9]{32}$/.test(head.ownerId), 'legacy fast-track accepts only synthetic canary owners')
    assert.equal(head.headRevisionId, 'canary_revision', 'legacy fast-track accepts only the dedicated canary fixture revision')
    const chunks = (await db.collection(`${root}/chunks`).get()).docs.map((chunk) => chunk.id).sort()
    assert.deepEqual(chunks, ['canary_live_chunk', 'canary_orphan_chunk'], 'legacy canary must contain only its known live and orphan chunks')
    await db.doc(root).update({ sceneMaintenanceCanary: true })
  }
  const job = (await db.doc(`boardScenes/${boardId}/maintenanceJobs/${jobId}`).get()).data()
  assert.equal(job?.kind, 'orphan-quarantine', 'job must be an orphan-quarantine proposal')
  const result = await invokeCloudCanary('collect', boardId, jobId)
  const auditPath = auditPathFor(boardId)
  const audit = JSON.parse(await readFile(auditPath, 'utf8'))
  assert.equal(audit.projectId, PROJECT)
  assert.equal(audit.boardId, boardId)
  assert.equal(audit.quarantineJobId, jobId)
  if (result.status === 'complete') {
    assert.equal((await db.doc(`boardScenes/${boardId}/chunks/canary_live_chunk`).get()).exists, true)
    assert.equal((await db.doc(`boardScenes/${boardId}/chunks/canary_orphan_chunk`).get()).exists, false)
    assert.equal((await db.doc(`boardScenes/${boardId}/maintenanceJobs/${jobId}/collectionReceipts/canary_orphan_chunk`).get()).exists, true)
    const [chunks, reachable, control, completedJob] = await Promise.all([
      db.collection(`boardScenes/${boardId}/chunks`).get(),
      oracle(db, boardId, Date.now()),
      db.doc(`boardScenes/${boardId}/maintenance/control`).get(),
      db.doc(`boardScenes/${boardId}/maintenanceJobs/${result.jobId}`).get(),
    ])
    const remainingChunkIds = new Set(chunks.docs.map((item) => item.id))
    assert.equal(control.data()?.admission, 'open', 'collection must reopen board admission')
    assert.equal(completedJob.data()?.status, 'complete')
    assert.equal(completedJob.data()?.syntheticCanaryFastTrack, true)
    for (const chunkId of reachable)
      assert.equal(remainingChunkIds.has(chunkId), true, `reachable chunk ${chunkId} must remain after collection`)
    audit.status = 'collected-and-verified'
    audit.collection = { jobId: result.jobId, deletedChunkCount: result.deletedChunkCount,
      gateClosedDurationMs: result.gateClosedDurationMs, independentPostCollectionOracleMatched: true,
      admissionReopened: true, completedAt: new Date().toISOString() }
    await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`)
  }
  console.log(JSON.stringify({ boardId, quarantineJobId: jobId, result }))
}

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`${error.message}\nUsage: node scripts/scene-maintenance-dev-canary.mjs --prepare | --collect --board <canary-board-id> --job <quarantine-job-id>`)
  process.exitCode = 2
}

if (args) {
  if (getApps().length === 0) initializeApp({ credential: applicationDefault(), projectId: PROJECT })
  const actualProject = process.env.GCLOUD_PROJECT ?? getApps()[0]?.options?.projectId
  if (actualProject && actualProject !== PROJECT) throw new Error(`Refusing to run outside ${PROJECT}.`)
  const db = getFirestore()
  if (args.has('--prepare')) await prepare(db)
  else await collect(db, args.get('--board'), args.get('--job'))
}
