/** Durable-state history integrity tests. Never run against a deployed project. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
if (
  process.env.GCLOUD_PROJECT !== 'demo-regression' ||
  !process.env.FIRESTORE_EMULATOR_HOST ||
  !process.env.FIREBASE_DATABASE_EMULATOR_HOST ||
  !process.env.FIREBASE_STORAGE_EMULATOR_HOST
)
  throw new Error('Requires isolated demo-regression Firestore and RTDB emulators.')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, Timestamp } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const { getDatabase } = require('firebase-admin/database')
const app = initializeApp({
  projectId: 'demo-regression',
  databaseURL: 'https://demo-regression-default-rtdb.firebaseio.com',
  storageBucket: 'demo-regression.appspot.com',
})
const { ensureScene, checkpointScene, commitSceneCandidate, loadSceneRevision } =
  await import('../functions/lib/board-scenes.js')
const { boardHistory, updateBoardContent, restoreVersion, importBoardVersion } =
  await import('../functions/lib/board-history.js')
const { loadNoteSnapshot } = await import('../functions/lib/board-history-notes.js')
const { boardAsset } = await import('../functions/lib/board-assets.js')
const { reserveBoardAssetUpload, completeBoardAssetUpload, assetResourceId } =
  await import('../functions/lib/board-history-assets.js')
const { slideNotes } = await import('../functions/lib/slide-notes.js')
const { packScene, assembleScene, paginateReferences, manifestDigest } = await import('../functions/lib/scene-codec.js')
const { eligibleVersion } = await import('../functions/lib/board-history-model.js')
const { cleanupHistoryPage, sweepBoardHistoryResources } = await import('../functions/lib/board-history-cleanup.js')
const db = getFirestore(),
  rtdb = getDatabase(),
  prefix = `history_${Date.now()}`,
  actor = { uid: `${prefix}_owner` },
  editor = { uid: `${prefix}_editor` },
  viewer = { uid: `${prefix}_viewer` },
  boardId = `${prefix}_board`,
  projectId = `${prefix}_project`,
  root = `boardScenes/${boardId}`
const scene = (name) => ({
  elements: [{ id: name, type: 'rectangle', x: 1, y: 2, width: 40, height: 30, version: 1, versionNonce: 3 }],
  appState: {},
  files: {},
})
const call = (fn, actor, data) => fn.run({ auth: { uid: actor.uid, token: {} }, data, rawRequest: {} })
const fails = (code) => (error) => {
  assert.equal(error.code, code, error.stack)
  return true
}
const head = async () => (await db.doc(root).get()).data()
await db.doc(`users/${actor.uid}/projects/${projectId}`).set({ ownerId: actor.uid, active: true })
await db
  .doc(`users/${actor.uid}/projects/${projectId}/boards/${boardId}`)
  .set({ name: 'Initial name', scene: scene('A'), active: true })
await db.doc(`boardShares/${boardId}`).set({
  ownerId: actor.uid,
  projectId,
  boardName: 'Initial name',
  generalAccess: 'anyone_with_link',
  generalRole: 'editor',
  inheritProjectAccess: false,
  pending: false,
})
await db.doc(`slideNotes/${boardId}/notes/A`).set({ text: 'Original protected notes', revision: 2, updatedAt: null })
await rtdb.ref(`boards/${boardId}/elements/B`).set({ data: JSON.stringify(scene('B').elements[0]), version: 1 })
await db.doc('system/boardHistoryRollout').set({ migrationEnabled: false })
await assert.rejects(ensureScene(boardId, actor), fails('unavailable'))
assert.equal((await db.doc(root).get()).exists, false, 'Closed rollout gate creates no partial head/history')
assert.equal((await rtdb.ref(`boards/${boardId}/elements/B`).get()).exists(), true)
await db.doc('system/boardHistoryRollout').set({ migrationEnabled: true })
await ensureScene(boardId, actor)
let current = await head()
assert.equal(current.historyProtocolVersion, 1)
assert.equal(current.restoreOperationId, null)
assert.equal((await rtdb.ref(`boards/${boardId}/historyProtocolVersion`).get()).val(), 1)
assert.equal((await rtdb.ref(`boards/${boardId}/elements`).get()).exists(), false)
await db.doc('system/boardHistoryRollout').set({ migrationEnabled: false })
assert.equal(
  (await ensureScene(boardId, actor)).currentVersionId,
  current.currentVersionId,
  'Closed gate preserves migrated-board current access',
)
await db.doc('system/boardHistoryRollout').set({ migrationEnabled: true })
assert.deepEqual((await loadSceneRevision(boardId, current)).scene.elements.map((e) => e.id).sort(), ['A', 'B'])
const initialVersion = current.currentVersionId
const manifest = await call(boardHistory, editor, { boardId, operation: 'manifest', versionId: initialVersion })
const sceneContext = await call(boardHistory, editor, { boardId, operation: 'current-scene', metadataOnly: true })
assert.equal(sceneContext.revisionId, current.headRevisionId)
assert.equal(sceneContext.generation, current.generation)
assert.equal(sceneContext.notesPageCount, 1)
assert.equal(typeof sceneContext.contextId, 'string')
assert.equal('chunks' in sceneContext, false, 'Metadata-only context must not duplicate the pinned scene payload.')
assert.equal('references' in sceneContext, false)
assert.equal(
  (await call(boardHistory, editor, { boardId, operation: 'notes', contextId: sceneContext.contextId, page: 0 })).notes.A.text,
  'Original protected notes',
)
const notes = await call(boardHistory, editor, { boardId, operation: 'notes', contextId: manifest.contextId, page: 0 })
assert.equal(notes.notes.A.text, 'Original protected notes')
const renamed = await call(updateBoardContent, editor, {
  boardId,
  mutationId: `${prefix}_rename`,
  generation: current.generation,
  expectedFence: current.restoreFence,
  nameRevision: current.nameRevision,
  name: 'Changed name',
})
assert.equal((await head()).boardName, 'Changed name')
const renamedAgain = await call(updateBoardContent, editor, {
  boardId,
  mutationId: `${prefix}_rename`,
  generation: current.generation,
  expectedFence: current.restoreFence,
  nameRevision: current.nameRevision,
  name: 'Changed name',
})
assert.equal(renamedAgain.versionId, renamed.versionId)
current = await head()
const noteWrite = await call(slideNotes, editor, {
  boardId,
  slideId: 'A',
  operation: 'write',
  text: 'Changed notes',
  revision: 2,
  mutationId: `${prefix}_notes`,
  generation: current.generation,
  expectedFence: current.restoreFence,
})
assert.equal(noteWrite.conflict, false)
await call(slideNotes, editor, {
  boardId,
  slideId: 'A',
  operation: 'write',
  text: 'A newer acknowledged note',
  revision: 3,
  mutationId: `${prefix}_notes_newer`,
  generation: current.generation,
  expectedFence: current.restoreFence,
})
assert.deepEqual(
  await call(slideNotes, editor, {
    boardId,
    slideId: 'A',
    operation: 'write',
    text: 'Changed notes',
    revision: 2,
    mutationId: `${prefix}_notes`,
    generation: current.generation,
    expectedFence: current.restoreFence,
  }),
  noteWrite,
)
assert.equal(
  (await call(slideNotes, editor, { boardId, slideId: 'A', operation: 'read' })).text,
  'A newer acknowledged note',
)
const laterVersion = (await head()).currentVersionId
const restored = await restoreVersion(
  boardId,
  `${prefix}_restore`,
  initialVersion,
  editor,
  current.generation,
  current.restoreFence,
)
current = await head()
assert.equal(current.generation, 2)
assert.equal(current.restoreOperationId, null)
assert.equal(current.boardName, 'Initial name')
assert.equal(
  (await call(slideNotes, editor, { boardId, slideId: 'A', operation: 'read' })).text,
  'Original protected notes',
)
assert.equal(
  await eligibleVersion(boardId, current, (await db.doc(`${root}/versions/${laterVersion}`).get()).data()),
  false,
)
assert.equal(
  (await call(boardHistory, editor, { boardId, operation: 'list' })).entries.some(
    (entry) => entry.versionId === laterVersion,
  ),
  false,
)
await assert.rejects(
  call(boardHistory, editor, { boardId, operation: 'manifest', versionId: laterVersion }),
  fails('not-found'),
)
await assert.rejects(
  call(boardHistory, editor, { boardId, operation: 'pages', contextId: manifest.contextId, page: 0 }),
  fails('aborted'),
)
await assert.rejects(
  call(slideNotes, editor, {
    boardId,
    slideId: 'A',
    operation: 'write',
    text: 'Old tab',
    revision: 2,
    mutationId: `${prefix}_stale`,
    generation: 1,
    expectedFence: 1,
  }),
  fails('aborted'),
)
const same = await restoreVersion(boardId, `${prefix}_restore`, initialVersion, editor, 1, 1)
assert.equal(same.versionId, restored.versionId)
assert.equal((await db.doc(`boardShares/${boardId}`).get()).data().generalRole, 'editor')
assert.equal((await rtdb.ref(`boards/${boardId}/generation`).get()).val(), 2)
// Offline snapshots preserve local ancestry without changing the canonical board.
async function imported(label, sequence, parentVersionId, alias = false) {
  const current = await head(),
    commitId = `${prefix}_import_${label}`,
    chunks = (await packScene(alias ? (await loadSceneRevision(boardId, current)).scene : scene(label))).map(
      (chunk, slot) => ({ ...chunk, chunkId: `${commitId}_${slot}` }),
    ),
    references = chunks.map(({ chunkId, digest }) => ({ chunkId, digest })),
    pages = paginateReferences(references)
  await db.doc(`${root}/uploads/${commitId}`).set({
    uploaderUid: editor.uid,
    generation: current.generation,
    expectedFence: current.restoreFence,
    expectedHeadRevisionId: current.headRevisionId,
    purpose: 'history-only',
    sourceBaseVersionId: restored.versionId,
    sceneFormatVersion: 1,
    pageCount: pages.length,
    chunkCount: chunks.length,
    newChunkCount: chunks.length,
    candidateDigest: await manifestDigest(references, current.generation),
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + 3600000),
  })
  for (const [slot, chunk] of chunks.entries())
    await db.doc(`${root}/chunks/${chunk.chunkId}`).set({
      payload: chunk.payload,
      digest: chunk.digest,
      kind: 'records',
      generation: current.generation,
      uploadId: commitId,
      uploaderUid: editor.uid,
      slot,
    })
  for (const [page, references] of pages.entries())
    await db.doc(`${root}/uploads/${commitId}/pages/${String(page).padStart(6, '0')}`).set({ references })
  const data = {
    boardId,
    commitId,
    captureMutationId: `${prefix}_capture_${label}`,
    localBranchId: `${prefix}_local_branch`,
    sourceBaseVersionId: restored.versionId,
    parentVersionId,
    branchSequence: sequence,
    boardName: alias ? current.boardName : `Local ${label}`,
    capturedAt: new Date().toISOString(),
    notes: alias ? { A: { text: 'Original protected notes', revision: 2, updatedAt: null } } : {},
    ...(alias ? { canonicalVersionId: current.currentVersionId } : {}),
  }
  const result = await call(importBoardVersion, editor, data)
  assert.equal((await head()).currentVersionId, restored.versionId)
  assert.deepEqual(await call(importBoardVersion, editor, data), result)
  await assert.rejects(
    call(importBoardVersion, editor, { ...data, boardName: 'Identity collision' }),
    fails('already-exists'),
  )
  const found = await call(boardHistory, editor, {
    boardId,
    operation: 'receipt',
    captureMutationId: data.captureMutationId,
  })
  assert.deepEqual(found.receipt, result)
  return result
}
const beforeAliasCount = (await db.collection(`${root}/versions`).get()).size
const aliasReceipt = await imported('alias', 1, restored.versionId, true)
assert.equal(aliasReceipt.canonicalVersionId, restored.versionId)
assert.equal((await db.collection(`${root}/versions`).get()).size, beforeAliasCount)
const local1 = await imported('L1', 1, restored.versionId),
  local2 = await imported('L2', 2, local1.localSnapshotVersionId)
assert.equal(
  (await call(boardHistory, editor, { boardId, operation: 'list' })).entries.some(
    (entry) => entry.versionId === local2.localSnapshotVersionId,
  ),
  true,
)
const beforeLocalRestore = await head()
await restoreVersion(
  boardId,
  `${prefix}_restore_local`,
  local1.localSnapshotVersionId,
  editor,
  beforeLocalRestore.generation,
  beforeLocalRestore.restoreFence,
)
assert.equal((await head()).boardName, 'Local L1')
assert.equal(
  await eligibleVersion(
    boardId,
    await head(),
    (await db.doc(`${root}/versions/${local2.localSnapshotVersionId}`).get()).data(),
  ),
  false,
)
// Empty local notes replace the entire prior protected note set.
assert.equal((await call(slideNotes, editor, { boardId, slideId: 'A', operation: 'read' })).text, '')
const emptyManifest = await call(boardHistory, editor, { boardId, operation: 'manifest' })
assert.equal(emptyManifest.notesPageCount, 0)
const now = await head(),
  notesRace = await Promise.all([
    call(slideNotes, editor, {
      boardId,
      slideId: 'A',
      operation: 'write',
      revision: 0,
      text: 'A independent',
      mutationId: `${prefix}_race_A`,
      generation: now.generation,
      expectedFence: now.restoreFence,
    }),
    call(slideNotes, editor, {
      boardId,
      slideId: 'B',
      operation: 'write',
      revision: 0,
      text: 'B independent',
      mutationId: `${prefix}_race_B`,
      generation: now.generation,
      expectedFence: now.restoreFence,
    }),
  ])
assert.equal(
  notesRace.every((result) => !result.conflict),
  true,
)
assert.equal((await call(slideNotes, editor, { boardId, slideId: 'A', operation: 'read' })).text, 'A independent')
assert.equal((await call(slideNotes, editor, { boardId, slideId: 'B', operation: 'read' })).text, 'B independent')
const raceHead = await head(),
  race = await Promise.allSettled([
    restoreVersion(
      boardId,
      `${prefix}_race_restore_1`,
      initialVersion,
      editor,
      raceHead.generation,
      raceHead.restoreFence,
    ),
    restoreVersion(
      boardId,
      `${prefix}_race_restore_2`,
      initialVersion,
      editor,
      raceHead.generation,
      raceHead.restoreFence,
    ),
  ])
assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1)
assert.equal((await head()).generation, raceHead.generation + 1)
// Simulate a worker killed after publication but before transport unlock.
const winner = race.find((result) => result.status === 'fulfilled').value
await db
  .doc(`${root}/restoreOperations/${winner.operationId}`)
  .update({ state: 'published', leaseUntil: Timestamp.fromMillis(0) })
await db.doc(root).update({ restoreOperationId: winner.operationId })
await rtdb.ref(`boards/${boardId}/restoreOperationId`).set(winner.operationId)
const recovered = await restoreVersion(
  boardId,
  winner.operationId,
  initialVersion,
  editor,
  raceHead.generation,
  raceHead.restoreFence,
)
assert.equal(recovered.versionId, winner.versionId)
assert.equal((await head()).restoreOperationId, null)
// Simulate a migrated room whose worker died between the two transport unlocks.
await db.doc(root).update({ restoreOperationId: `migration_${boardId}`, migrationLeaseUntil: Timestamp.fromMillis(0) })
await rtdb.ref(`boards/${boardId}/restoreOperationId`).set(`migration_${boardId}`)
await ensureScene(boardId, actor)
assert.equal((await head()).restoreOperationId, null)
assert.equal((await rtdb.ref(`boards/${boardId}/restoreOperationId`).get()).exists(), false)
// Reconstruct every currently eligible version through bounded callable pages/chunks/notes.
const expectedVisible = []
for (const row of (await db.collection(`${root}/versions`).get()).docs)
  if (await eligibleVersion(boardId, await head(), row.data())) expectedVisible.push(row.id)
const visible = []
let historyCursor = null
let lastManifest
do {
  const page = await call(boardHistory, editor, { boardId, operation: 'list', cursor: historyCursor })
  assert(page.entries.length <= 50)
  visible.push(...page.entries)
  historyCursor = page.cursor
} while (historyCursor)
assert.deepEqual(visible.map((entry) => entry.versionId).sort(), expectedVisible.sort())
for (const entry of visible) {
  const context = await call(boardHistory, editor, { boardId, operation: 'manifest', versionId: entry.versionId })
  lastManifest = context
  const references = [],
    chunks = [],
    snapshotNotes = Object.create(null)
  assert(context.pageCount <= 6)
  for (let page = 0; page < context.pageCount; page++)
    references.push(
      ...(await call(boardHistory, editor, { boardId, operation: 'pages', contextId: context.contextId, page }))
        .references,
    )
  assert.equal(references.length, context.chunkCount)
  assert.equal(await manifestDigest(references, context.generation), context.candidateDigest)
  for (let offset = 0; offset < references.length; offset += 3)
    chunks.push(
      ...(
        await call(boardHistory, editor, {
          boardId,
          operation: 'chunks',
          contextId: context.contextId,
          chunkIds: references.slice(offset, offset + 3).map((ref) => ref.chunkId),
        })
      ).chunks,
    )
  for (let page = 0; page < context.notesPageCount; page++)
    Object.assign(
      snapshotNotes,
      (await call(boardHistory, editor, { boardId, operation: 'notes', contextId: context.contextId, page })).notes,
    )
  const oracle = await loadSceneRevision(boardId, {
    headRevisionId: entry.sceneRevisionId,
    generation: entry.sceneGeneration,
  })
  assert.deepEqual(await assembleScene(chunks), oracle.scene)
  assert.equal(context.boardName, entry.boardName)
  assert.deepEqual({ ...snapshotNotes }, { ...(await loadNoteSnapshot(boardId, entry.notesRevisionId)) })
}
await assert.rejects(
  call(boardHistory, editor, {
    boardId,
    operation: 'chunks',
    contextId: lastManifest.contextId,
    chunkIds: ['not_in_fixed_manifest'],
  }),
  fails('permission-denied'),
)
await assert.rejects(
  call(boardHistory, editor, {
    boardId,
    operation: 'chunks',
    contextId: lastManifest.contextId,
    chunkIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  }),
  fails('invalid-argument'),
)
await assert.rejects(
  call(boardHistory, editor, { boardId, operation: 'pages', contextId: lastManifest.contextId, page: 6 }),
  fails('invalid-argument'),
)
console.log(
  `PASS every eligible version (${visible.length}) reconstructed through bounded fixed-manifest gateway with scene/name/notes oracle and membership/hash checks`,
)
const versionCount = (await db.collection(`${root}/versions`).get()).size
await db.doc(`boardShares/${boardId}`).update({ generalRole: 'viewer' })
await assert.rejects(call(boardHistory, viewer, { boardId, operation: 'list' }), fails('permission-denied'))
const viewerManifest = await call(boardHistory, viewer, { boardId, operation: 'manifest' })
await call(boardHistory, viewer, { boardId, operation: 'pages', contextId: viewerManifest.contextId, page: 0 })
await assert.rejects(
  call(boardHistory, viewer, { boardId, operation: 'notes', contextId: viewerManifest.contextId, page: 0 }),
  fails('permission-denied'),
)
await db.doc(`boardShares/${boardId}`).update({ generalRole: 'editor' })
await db.doc(`${root}/versions/${laterVersion}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) })
await cleanupHistoryPage()
assert.equal((await db.doc(`${root}/versions/${laterVersion}`).get()).exists, false)
await sweepBoardHistoryResources(boardId)
assert.deepEqual((await loadSceneRevision(boardId, await head())).scene.elements.map((e) => e.id).sort(), ['A', 'B'])
assert.equal((await db.collection(`${root}/versions`).get()).size, versionCount - 1)
const future = Date.now() + 31 * 24 * 60 * 60 * 1000
await cleanupHistoryPage(future)
const resourceStats = await sweepBoardHistoryResources(boardId, future)
assert.ok(resourceStats.revisions > 0)
assert.ok(resourceStats.chunks > 0)
assert.deepEqual((await loadSceneRevision(boardId, await head())).scene.elements.map((element) => element.id).sort(), [
  'A',
  'B',
])
// Real image object lifecycle: live/context pins retain it, abandoned expired history reclaims it.
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  imageId = `${prefix}_image`,
  imagePath = `users/${actor.uid}/boards/${boardId}/assets/${imageId}`,
  imageFile = getStorage().bucket().file(imagePath),
  preImage = await head()
await call(boardAsset, actor, {
  operation: 'upload',
  storagePath: imagePath,
  projectId,
  generation: preImage.generation,
  expectedFence: preImage.restoreFence,
  mimeType: 'image/png',
  dataURL: `data:image/png;base64,${pixel}`,
})
assert.equal((await db.doc(`${root}/assetResources/${assetResourceId(imagePath)}`).get()).data().state, 'ready')
const withImage = {
  ...scene('image_element'),
  files: { [imageId]: { id: imageId, mimeType: 'image/png', storagePath: imagePath, created: Date.now() } },
}
await checkpointScene(boardId, withImage, preImage, actor)
const imageHead = await head(),
  imageVersion = imageHead.currentVersionId,
  imageContext = await call(boardHistory, editor, { boardId, operation: 'manifest', versionId: imageVersion })
assert.match(
  (await call(boardAsset, editor, { operation: 'read', storagePath: imagePath, contextId: imageContext.contextId }))
    .dataURL,
  /^data:image\/png;base64,/,
)
await sweepBoardHistoryResources(boardId, Date.now() + 2 * 24 * 60 * 60 * 1000)
assert.equal((await imageFile.exists())[0], true)
await restoreVersion(
  boardId,
  `${prefix}_restore_pre_image`,
  preImage.currentVersionId,
  editor,
  imageHead.generation,
  imageHead.restoreFence,
)
await assert.rejects(
  call(boardAsset, editor, { operation: 'read', storagePath: imagePath, contextId: imageContext.contextId }),
  fails('aborted'),
)
await db.doc(`${root}/versions/${imageVersion}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) })
await cleanupHistoryPage()
assert.equal(
  (await db.doc(`${root}/versions/${imageVersion}`).get()).exists,
  true,
  'live physical preview lease pins expired metadata',
)
await db.doc(`${root}/readContexts/${imageContext.contextId}`).update({ expiresAt: Timestamp.fromMillis(0) })
await cleanupHistoryPage()
assert.equal((await db.doc(`${root}/versions/${imageVersion}`).get()).exists, false)
await sweepBoardHistoryResources(boardId, Date.now() + 2 * 24 * 60 * 60 * 1000)
assert.equal((await imageFile.exists())[0], false)
// An upload killed after GCS acceptance has no recorded object generation. Reconcile under deleting fence.
const orphanPath = `users/${actor.uid}/boards/${boardId}/assets/${prefix}_orphan`,
  orphanFile = getStorage().bucket().file(orphanPath),
  orphanHead = await head(),
  orphanReservation = await reserveBoardAssetUpload(boardId, orphanPath, orphanHead.generation, orphanHead.restoreFence)
await orphanFile.save(Buffer.from(pixel, 'base64'), {
  resumable: false,
  preconditionOpts: { ifGenerationMatch: 0 },
  metadata: { contentType: 'image/png' },
})
const orphanRef = db.doc(`${root}/assetResources/${assetResourceId(orphanPath)}`)
await orphanRef.update({ leaseUntil: Timestamp.fromMillis(0) })
await sweepBoardHistoryResources(boardId, Date.now() + 2 * 24 * 60 * 60 * 1000)
assert.equal((await orphanFile.exists())[0], false)
assert.equal((await orphanRef.get()).exists, false)
await assert.rejects(completeBoardAssetUpload(boardId, orphanPath, orphanReservation, '1'), fails('aborted'))
// Real failure before publication: generation/name/notes stay intact and both barriers unlock.
const failureBase = await head(),
  failureTarget = failureBase.currentVersionId
await checkpointScene(boardId, scene('failure-current'), failureBase, actor)
const preFailure = await head()
await assert.rejects(
  restoreVersion(
    boardId,
    `${prefix}_fail_before_publication`,
    failureTarget,
    editor,
    preFailure.generation,
    preFailure.restoreFence,
    {
      beforePublication: async () => {
        throw new Error('injected worker stage failure')
      },
    },
  ),
  /injected worker stage failure/,
)
assert.equal((await head()).generation, preFailure.generation)
assert.equal((await head()).currentVersionId, preFailure.currentVersionId)
assert.equal((await head()).restoreOperationId, null)
assert.equal((await rtdb.ref(`boards/${boardId}/restoreOperationId`).get()).exists(), false)
assert.equal((await db.doc(`${root}/restoreOperations/${prefix}_fail_before_publication`).get()).data().state, 'failed')
// A failed worker killed before unlock leaves a durable failure state which recovery can finish.
const pendingFailureHead = await head(),
  pendingFailureId = `${prefix}_failed_unlock_crash`
await assert.rejects(
  restoreVersion(
    boardId,
    pendingFailureId,
    failureTarget,
    editor,
    pendingFailureHead.generation,
    pendingFailureHead.restoreFence,
    {
      beforePublication: async () => {
        throw new Error('injected stage failure')
      },
      beforeFailedUnlock: async () => {
        throw new Error('injected failure-unlock crash')
      },
    },
  ),
  /injected failure-unlock crash/,
)
assert.equal((await head()).restoreOperationId, pendingFailureId)
assert.equal(
  (await db.doc(`${root}/restoreOperations/${pendingFailureId}`).get()).data().state,
  'failed-unlock-pending',
)
await db.doc(`${root}/restoreOperations/${pendingFailureId}`).update({ leaseUntil: Timestamp.fromMillis(0) })
await assert.rejects(
  restoreVersion(
    boardId,
    pendingFailureId,
    failureTarget,
    editor,
    pendingFailureHead.generation,
    pendingFailureHead.restoreFence,
    { recovering: true },
  ),
  fails('failed-precondition'),
)
assert.equal((await head()).restoreOperationId, null)
// Publication followed by worker death is completed mechanically even if the initiating editor loses access.
const publishedFailureHead = await head(),
  publishedFailureId = `${prefix}_published_crash`
await assert.rejects(
  restoreVersion(
    boardId,
    publishedFailureId,
    failureTarget,
    editor,
    publishedFailureHead.generation,
    publishedFailureHead.restoreFence,
    {
      afterPublication: async () => {
        throw new Error('injected published worker crash')
      },
    },
  ),
  /injected published worker crash/,
)
const publishedOperation = (await db.doc(`${root}/restoreOperations/${publishedFailureId}`).get()).data()
assert.equal(publishedOperation.state, 'published')
assert.equal((await head()).generation, publishedFailureHead.generation + 1)
await db.doc(`${root}/restoreOperations/${publishedFailureId}`).update({ leaseUntil: Timestamp.fromMillis(0) })
await db.doc(`boardShares/${boardId}`).update({ generalRole: 'viewer' })
const mechanical = await restoreVersion(
  boardId,
  publishedFailureId,
  failureTarget,
  editor,
  publishedFailureHead.generation,
  publishedFailureHead.restoreFence,
  { recovering: true },
)
assert.equal(mechanical.versionId, publishedOperation.result.versionId)
assert.equal((await head()).restoreOperationId, null)
await db.doc(`boardShares/${boardId}`).update({ generalRole: 'editor' })
// Identical canonical saves/checkpoints acknowledge without manufacturing history.
const noopHead = await head(),
  noopScene = await loadSceneRevision(boardId, noopHead),
  noopCount = (await db.collection(`${root}/versions`).count().get()).data().count
const checkpointNoop = await checkpointScene(boardId, noopScene.scene, noopHead, actor)
assert.equal(checkpointNoop.versionId, noopHead.currentVersionId)
assert.equal((await db.collection(`${root}/versions`).count().get()).data().count, noopCount)
const noopStage = `${prefix}_noop_stage`,
  noopReferences = noopScene.references
await db.doc(`${root}/uploads/${noopStage}`).set({
  uploaderUid: actor.uid,
  expectedHeadRevisionId: noopHead.headRevisionId,
  generation: noopHead.generation,
  expectedFence: noopHead.restoreFence,
  sceneFormatVersion: 1,
  sceneProtocolVersion: 2,
  pageCount: paginateReferences(noopReferences).length,
  chunkCount: noopReferences.length,
  newChunkCount: 0,
  maintenanceEpoch: (await db.doc(`${root}/maintenance/control`).get()).data().epoch,
  candidateDigest: await manifestDigest(noopReferences, noopHead.generation),
  createdAt: Timestamp.now(),
  expiresAt: Timestamp.fromMillis(Date.now() + 600000),
})
for (const [index, references] of paginateReferences(noopReferences).entries())
  await db.doc(`${root}/uploads/${noopStage}/pages/${String(index).padStart(6, '0')}`).set({ references })
const noopReceipt = await commitSceneCandidate(boardId, noopStage, actor)
assert.equal(noopReceipt.versionId, noopHead.currentVersionId)
assert.deepEqual(await commitSceneCandidate(boardId, noopStage, actor), noopReceipt)
assert.equal((await db.collection(`${root}/versions`).count().get()).data().count, noopCount)
const malformedStage = `${prefix}_bad_manifest`
await db.doc(`${root}/uploads/${malformedStage}`).set({
  ...(await db.doc(`${root}/uploads/${noopStage}`).get()).data(),
  receipt: null,
  status: 'staged',
  candidateDigest: '0'.repeat(64),
  leaseId: null,
  leaseUntil: null,
})
for (const [index, references] of paginateReferences(noopReferences).entries())
  await db.doc(`${root}/uploads/${malformedStage}/pages/${String(index).padStart(6, '0')}`).set({ references })
await assert.rejects(commitSceneCandidate(boardId, malformedStage, actor), fails('failed-precondition'))
assert.equal((await head()).currentVersionId, noopHead.currentVersionId)
assert.equal((await db.collection(`${root}/versions`).count().get()).data().count, noopCount)
assert.equal((await db.doc(`${root}/uploads/${malformedStage}`).get()).data().leaseId, null)
console.log('PASS identical canonical checkpoint/candidate produce no extra history and stable retry receipt')
// An expired worker must not unlock a successor holding the same durable operation.
const takeoverHead = await head(),
  takeoverTarget = (await call(boardHistory, editor, { boardId, operation: 'list' })).entries.find(
    (entry) => !entry.current,
  ).versionId,
  takeoverId = `${prefix}_lease_takeover`
let oldReady, oldRelease, successorReady, successorRelease
const oldStarted = new Promise((resolve) => {
    oldReady = resolve
  }),
  oldGate = new Promise((resolve) => {
    oldRelease = resolve
  }),
  successorStarted = new Promise((resolve) => {
    successorReady = resolve
  }),
  successorGate = new Promise((resolve) => {
    successorRelease = resolve
  })
const oldWorker = restoreVersion(
  boardId,
  takeoverId,
  takeoverTarget,
  editor,
  takeoverHead.generation,
  takeoverHead.restoreFence,
  {
    beforePublication: async () => {
      oldReady()
      await oldGate
    },
  },
)
await oldStarted
await db.doc(`${root}/restoreOperations/${takeoverId}`).update({ leaseUntil: Timestamp.fromMillis(0) })
const successor = restoreVersion(
  boardId,
  takeoverId,
  takeoverTarget,
  editor,
  takeoverHead.generation,
  takeoverHead.restoreFence,
  {
    recovering: true,
    beforePublication: async () => {
      successorReady()
      await successorGate
    },
  },
)
await successorStarted
oldRelease()
await assert.rejects(oldWorker, fails('aborted'))
assert.equal((await head()).restoreOperationId, takeoverId)
assert.equal((await rtdb.ref(`boards/${boardId}/restoreOperationId`).get()).val(), takeoverId)
successorRelease()
await successor
assert.equal((await head()).restoreOperationId, null)
// Closed generations and their presence are reclaimed, without removing current/lobby presence.
const roomsHead = await head(),
  oldRoom = roomsHead.generation - 1
await rtdb.ref(`boards/${boardId}/generations/${oldRoom}/elements/abandoned`).set({ data: '{}' })
await rtdb.ref(`presence/${boardId}/generations/${oldRoom}/old`).set({ uid: editor.uid })
await rtdb.ref(`presence/${boardId}/generations/${roomsHead.generation}/current`).set({ uid: actor.uid })
await rtdb.ref(`activeSessions/${boardId}/lobby`).set({ uid: actor.uid })
for (let page = 0; page < Math.ceil(roomsHead.generation / 2) + 1; page++) await sweepBoardHistoryResources(boardId)
assert.equal((await rtdb.ref(`boards/${boardId}/generations/${oldRoom}`).get()).exists(), false)
assert.equal((await rtdb.ref(`presence/${boardId}/generations/${oldRoom}`).get()).exists(), false)
assert.equal((await rtdb.ref(`presence/${boardId}/generations/${roomsHead.generation}/current`).get()).exists(), true)
assert.equal((await rtdb.ref(`activeSessions/${boardId}/lobby`).get()).exists(), true)
console.log('PASS expired worker cannot unlock successor; closed generation sweep preserves current presence and lobby')
// Abandoned futures do not produce hundreds of empty history pages.
const listingBoardId = `${prefix}_listing`,
  listingRoot = `boardScenes/${listingBoardId}`,
  listingBranch = 'listing_prefix',
  listingVersion = (await db.doc(`${root}/versions/${(await head()).currentVersionId}`).get()).data()
await db
  .doc(`users/${actor.uid}/projects/${projectId}/boards/${listingBoardId}`)
  .set({ name: 'Listing board', active: true })
await db.doc(listingRoot).set({
  ...(await head()),
  ownerId: actor.uid,
  currentBranchId: 'listing_current',
  currentVersionId: 'listing_current_version',
  branchSequence: 1,
  branchCeilings: { [listingBranch]: 60, listing_current: 1 },
})
await db.doc(`${listingRoot}/versions/listing_current_version`).set({
  ...listingVersion,
  branchId: 'listing_current',
  branchSequence: 1,
  serverCreatedAt: Timestamp.fromMillis(Date.now() + 1000),
})
for (let start = 1; start <= 560; start += 200) {
  const batch = db.batch()
  for (let seq = start; seq < Math.min(start + 200, 561); seq++)
    batch.set(db.doc(`${listingRoot}/versions/listing_${seq}`), {
      ...listingVersion,
      branchId: listingBranch,
      branchSequence: seq,
      serverCreatedAt: Timestamp.fromMillis(Date.now() - 10000 + seq),
    })
  await batch.commit()
}
const firstPage = await call(boardHistory, actor, { boardId: listingBoardId, operation: 'list' })
assert.equal(firstPage.entries.length, 50)
assert.equal(firstPage.entries[0].versionId, 'listing_current_version')
assert(firstPage.entries.every((version) => version.branchId === 'listing_current' || version.branchSequence <= 60))
const secondPage = await call(boardHistory, actor, {
  boardId: listingBoardId,
  operation: 'list',
  cursor: firstPage.cursor,
})
assert.equal(secondPage.entries.length, 11)
assert.equal(secondPage.cursor, null)
assert.equal(new Set([...firstPage.entries, ...secondPage.entries].map((row) => row.versionId)).size, 61)
await db.doc(listingRoot).update({ historyEpoch: ((await head()).historyEpoch ?? 0) + 1 })
await assert.rejects(
  call(boardHistory, actor, { boardId: listingBoardId, operation: 'list', cursor: firstPage.cursor }),
  fails('aborted'),
)
await db.recursiveDelete(db.doc(listingRoot))
console.log(
  'PASS bounded prefix pagination skips 500 abandoned saves, retains global acceptance order, fixes page snapshot and rejects restored cursors',
)
console.log(
  'PASS GCS resource reservation/history pin/expiry sweep/interrupted upload reconciliation, staged failure/unlock-crash recovery/postpublication revocation, canonical capture alias, receipt lookup, old note retry, aged chunk sweep, offline-import ancestry, immutable receipt identities, empty notes restore, concurrent notes, competing restores, published worker/migration recovery, history baseline, migration, protected notes, name retries, restore ancestry, stale fencing, viewer gateway, cleanup current protection',
)
await db.recursiveDelete(db.doc(root))
await rtdb.ref(`boards/${boardId}`).remove()

await db.terminate()
await app.delete()
