/** Untrusted authenticated wire requests, against disposable real security rules. */
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'

if (
  process.env.GCLOUD_PROJECT !== 'demo-regression' ||
  !process.env.FIRESTORE_EMULATOR_HOST ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST
)
  throw new Error('History rules tests require disposable demo-regression emulators.')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const app = initializeApp({ projectId: 'demo-regression', storageBucket: 'demo-regression.appspot.com' })
const db = getFirestore(app)
const bucket = getStorage(app).bucket()
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const ownerContext = await browser.createBrowserContext(),
  guestContext = await browser.createBrowserContext()
const owner = await ownerContext.newPage(),
  guest = await guestContext.newPage()
const requests = []
const documents = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-regression/databases/(default)/documents`
async function request(method, url, token, body) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = await response.json().catch(() => null)
  requests.push({ method, path: new URL(url).pathname, status: response.status, code: result?.error?.status })
  return { status: response.status, result }
}
const read = (path, token) => request('GET', `${documents}/${path}`, token)
const write = (path, token, fields) => request('PATCH', `${documents}/${path}`, token, { fields })
const string = (value) => ({ stringValue: value })
const integer = (value) => ({ integerValue: String(value) })
const callable = (name, token, data) =>
  request('POST', `http://127.0.0.1:45001/demo-regression/us-central1/${name}`, token, { data })
try {
  await owner.goto(base)
  const seed = await owner.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const { user } = await signInOwner(getFirebaseAuth())
    const project = await workspaceApi.createProject('History rules fixture')
    const board = await workspaceApi.createBoard(project.id, 'Protected history')
    await workspaceApi.flushCloud()
    const config = await sharingService.getShareConfig(board.id, {
      ownerId: user.uid,
      boardName: board.name,
      scene: board.scene,
    })
    await sharingService.saveShareConfig({ ...config, generalAccess: 'anyone_with_link', generalRole: 'editor' })
    return { id: board.id, projectId: project.id, uid: user.uid, token: await user.getIdToken() }
  })
  await guest.goto(base)
  const guestToken = await guest.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInAnonymously } = await import('/tests/regression-fixture.ts')
    return (await signInAnonymously(getFirebaseAuth())).user.getIdToken()
  })
  const root = `boardScenes/${seed.id}`,
    headRef = db.doc(root)
  const head = (await headRef.get()).data()
  assert.equal(head.historyProtocolVersion, 1)
  assert.equal(head.maintenanceAdmission ?? 'open', 'open')
  assert.equal(head.maintenanceEpoch ?? 1, 1)
  const revision = (await db.doc(`${root}/revisions/${head.headRevisionId}/pages/000000`).get()).data()
  const chunkId = revision.references[0].chunkId
  await db.doc(`boardShares/${seed.id}/history/legacy-secret`).set({ scene: { secret: true } })
  for (const token of [seed.token, guestToken]) {
    assert.equal((await read(root, token)).status, 200, 'Current head metadata is readable')
    for (const path of [
      `${root}/versions/${head.currentVersionId}`,
      `${root}/revisions/${head.headRevisionId}`,
      `${root}/revisions/${head.headRevisionId}/pages/000000`,
      `${root}/chunks/${chunkId}`,
      `boardShares/${seed.id}/history/legacy-secret`,
      `${root}/legacyArchive/private`,
      `slideNotes/${seed.id}/notes/secret`,
    ])
      assert.equal((await read(path, token)).status, 403, `Raw payload should be protected: ${path}`)
  }
  assert.equal(
    (
      await write(`users/${seed.uid}/projects/${seed.projectId}/boards/${seed.id}`, seed.token, {
        name: string('Bypass'),
      })
    ).status,
    403,
    'Name cannot bypass content version publication',
  )
  const commitId = `rules_${crypto.randomUUID()}`,
    uploadPath = `${root}/uploads/${commitId}`
  const candidate = {
    uploaderUid: string(seed.uid),
    expectedHeadRevisionId: string(head.headRevisionId),
    generation: integer(head.generation),
    expectedFence: integer(head.restoreFence ?? 0),
    maintenanceEpoch: integer(head.maintenanceEpoch ?? 1),
    sceneFormatVersion: integer(1),
    pageCount: integer(1),
    chunkCount: integer(1),
    newChunkCount: integer(1),
    candidateDigest: string('a'.repeat(64)),
    createdAt: { timestampValue: new Date().toISOString() },
    expiresAt: { timestampValue: new Date(Date.now() + 3600000).toISOString() },
  }
  assert.equal((await write(uploadPath, seed.token, candidate)).status, 200, 'Owner can stage a current fenced upload')
  assert.equal((await read(uploadPath, guestToken)).status, 403, 'Another editor cannot inspect someone else’s staging')
  const stagedChunk = {
    payload: string('[]'),
    digest: string('b'.repeat(64)),
    uploadId: string(commitId),
    slot: integer(0),
    uploaderUid: string(seed.uid),
    generation: integer(head.generation),
    kind: string('records'),
  }
  assert.equal((await write(`${root}/chunks/${commitId}_0`, seed.token, stagedChunk)).status, 200)
  assert.equal(
    (await read(`${root}/chunks/${commitId}_0`, seed.token)).status,
    200,
    'Own active candidate is resumable',
  )
  assert.equal((await read(`${root}/chunks/${commitId}_0`, guestToken)).status, 403)
  const closedCommitId = `${commitId}_closed`,
    closedCandidate = { ...candidate, maintenanceEpoch: integer(head.maintenanceEpoch ?? 1) }
  await headRef.update({ maintenanceAdmission: 'closed', maintenanceEpoch: (head.maintenanceEpoch ?? 1) + 1 })
  assert.equal((await write(`${root}/uploads/${closedCommitId}`, seed.token, closedCandidate)).status, 403,
    'Maintenance closure blocks direct client upload admission')
  assert.equal((await write(`${root}/chunks/${commitId}_1`, seed.token, stagedChunk)).status, 403,
    'Maintenance epoch invalidates in-flight chunk writes')
  await headRef.update({ maintenanceAdmission: 'open' })
  assert.equal((await write(`${root}/chunks/${commitId}_1`, seed.token, stagedChunk)).status, 403,
    'Reopening admission does not revive an old upload epoch')
  await headRef.update({ restoreOperationId: 'rules_blocked', restoreFence: (head.restoreFence ?? 0) + 1 })
  assert.equal(
    (await write(`${root}/chunks/${commitId}_1`, seed.token, stagedChunk)).status,
    403,
    'Restore blocks in-flight candidate writes',
  )
  assert.equal(
    (await read(`${root}/chunks/${commitId}_0`, seed.token)).status,
    403,
    'Stale candidate no longer authorizes payload reads',
  )
  await headRef.update({ restoreOperationId: null })
  assert.equal(
    (await write(`${root}/uploads/${commitId}_stale`, seed.token, candidate)).status,
    403,
    'Failed-restore fence still invalidates old staging',
  )
  await db.doc(`boardShares/${seed.id}`).update({ generalRole: 'viewer' })
  assert.equal(
    (await callable('boardHistory', guestToken, { boardId: seed.id, operation: 'list' })).status,
    403,
    'Viewer cannot browse history',
  )
  const manifest = await callable('boardHistory', guestToken, { boardId: seed.id, operation: 'manifest' })
  assert.equal(manifest.status, 200, 'Viewer can read the current board through a context')
  const contextId = manifest.result.result.contextId
  assert.equal(
    (await callable('boardHistory', guestToken, { boardId: seed.id, operation: 'pages', contextId, page: 0 })).status,
    200,
  )
  const foreignContext = await callable('boardHistory', seed.token, { boardId: seed.id, operation: 'pages', contextId, page: 0 })
  assert.equal(foreignContext.status, 400, 'A foreign read context is unavailable')
  assert.equal(foreignContext.result.error.status, 'FAILED_PRECONDITION', 'Foreign and expired contexts share a non-disclosing error')
  assert.equal(
    (
      await callable('restoreBoardVersion', guestToken, {
        boardId: seed.id,
        versionId: head.currentVersionId,
        operationId: `rules_restore_${crypto.randomUUID()}`,
        expectedGeneration: head.generation,
        expectedFence: (head.restoreFence ?? 0) + 1,
      })
    ).status,
    403,
  )
  const assetPath = `users/${seed.uid}/boards/${seed.id}/assets/rules-secret`,
    snapshotPath = `boards/${seed.id}/snapshots/rules-secret`
  for (const path of [assetPath, snapshotPath]) {
    await bucket.file(path).save(Buffer.from('protected'), { metadata: { contentType: 'image/png' } })
    const response = await fetch(
      `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`,
      {
        headers: { Authorization: `Firebase ${seed.token}` },
      },
    )
    requests.push({ method: 'GET', path, status: response.status })
    assert.equal(response.status, 403, 'Storage snapshots/assets cannot bypass the history gateway')
    await bucket.file(path).delete()
  }
  console.log(
    'PASS real authenticated rules: protected raw history/notes/chunks, editor staging ownership, restoration barriers, failed fence, viewer current-only gateway, actor contexts and Storage bypass denial',
  )
} finally {
  await writeFile(
    `${process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'}/board-history-rules-network.json`,
    JSON.stringify({ requests }, null, 2),
  )
  await ownerContext.close()
  await guestContext.close()
  await browser.close()
  await deleteApp(app)
}
