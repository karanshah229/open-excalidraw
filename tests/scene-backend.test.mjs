/** Independent server integrity probes; only the disposable regression emulators. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Backend scene tests require isolated demo-regression emulators.')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, Timestamp } = require('firebase-admin/firestore')
const { getDatabase } = require('firebase-admin/database')
const adminApp = initializeApp({
  projectId: 'demo-regression',
  databaseURL: 'https://demo-regression-default-rtdb.firebaseio.com',
})
const { ensureScene, commitSceneCandidate, loadSceneRevision, checkpointScene } =
  await import('../functions/lib/board-scenes.js')
const { packScene, manifestDigest, paginateReferences, canonicalStringify, digestString } =
  await import('../functions/lib/scene-codec.js')
const { pruneCheckpointedRecords } = await import('../functions/lib/scene-compaction-cleanup.js')
const { runWithAbandonedRoomFence } = await import('../functions/lib/scene-collaboration-fence.js')
const rtdb = getDatabase()
const db = getFirestore(),
  prefix = `backend_${Date.now()}`,
  passed = []
const actor = { uid: `${prefix}_owner` },
  stranger = { uid: `${prefix}_stranger` }
const scene = (label) => ({
  elements: [{ id: label, type: 'rectangle', x: 1, y: 2, width: 30, height: 40, version: 1, versionNonce: 4 }],
  appState: {},
  files: {},
})
const pageId = (index) => String(index).padStart(6, '0')
const assertCode = (code) => (error) => {
  assert.equal(error.code, code, error.stack)
  return true
}
async function seed(name, { standalone = false, publicRole = null } = {}) {
  const boardId = `${prefix}_${name}`,
    projectId = standalone ? null : `${prefix}_project_${name}`
  if (projectId) {
    await db.doc(`users/${actor.uid}/projects/${projectId}`).set({ id: projectId, ownerId: actor.uid, deletedAt: null })
    await db
      .doc(`users/${actor.uid}/projects/${projectId}/boards/${boardId}`)
      .set({ id: boardId, projectId, active: true, name, scene: scene(name) })
  }
  await db.doc(`boardShares/${boardId}`).set({
    ownerId: actor.uid,
    boardId,
    projectId,
    generalAccess: publicRole ? 'anyone_with_link' : 'restricted',
    generalRole: publicRole ?? 'viewer',
    inheritProjectAccess: false,
    pending: false,
    scene: scene(name),
  })
  return { boardId, projectId }
}
async function stage(boardId, head, payload, suffix, sourceChunks) {
  const commitId = `${prefix}_commit_${suffix}`,
    root = `boardScenes/${boardId}`
  const maintenanceControl = (await db.doc(`${root}/maintenance/control`).get()).data()
  assert(maintenanceControl && Number.isSafeInteger(maintenanceControl.epoch))
  const chunks = (sourceChunks ?? (await packScene(payload))).map((chunk, slot) => ({
    ...chunk,
    chunkId: `${commitId}_${pageId(slot)}`,
  }))
  const references = chunks.map(({ chunkId, digest }) => ({ chunkId, digest })),
    pages = paginateReferences(references),
    now = Timestamp.now()
  await db.doc(`${root}/uploads/${commitId}`).create({
    uploaderUid: actor.uid,
    expectedHeadRevisionId: head.headRevisionId,
    generation: head.generation,
    sceneFormatVersion: 1,
    sceneProtocolVersion: 2,
    expectedFence: head.restoreFence ?? 0,
    pageCount: pages.length,
    chunkCount: chunks.length,
    newChunkCount: chunks.length,
    candidateDigest: await manifestDigest(references, head.generation),
    maintenanceEpoch: maintenanceControl.epoch,
    createdAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + 3600000),
  })
  for (let slot = 0; slot < chunks.length; slot++) {
    const chunk = chunks[slot]
    await db.doc(`${root}/chunks/${chunk.chunkId}`).create({
      payload: chunk.payload,
      digest: chunk.digest,
      uploadId: commitId,
      slot,
      uploaderUid: actor.uid,
      generation: head.generation,
      kind: 'records',
    })
  }
  for (let slot = 0; slot < pages.length; slot++)
    await db.doc(`${root}/uploads/${commitId}/pages/${pageId(slot)}`).create({ references: pages[slot] })
  return { commitId, chunks }
}
try {
  // Run this case with Firestore ONLY: no publisher trigger can pre-claim the ID.
  // Both bootstrap attempts reach reservation before either may publish a binding.
  const unsharedId = `${prefix}_unshared_collision`,
    contenders = [actor, stranger]
  for (const contender of contenders) {
    await db.doc(`users/${contender.uid}/projects/${prefix}_unshared`).set({ ownerId: contender.uid })
    await db
      .doc(`users/${contender.uid}/projects/${prefix}_unshared/boards/${unsharedId}`)
      .set({ active: true, scene: scene(`${contender.uid}_secret`) })
  }
  assert(
    !(await db.doc(`boardShares/${unsharedId}`).get()).exists,
    'reservation test requires no publishing function emulator',
  )
  const originalReservationTransaction = db.runTransaction.bind(db)
  let reservations = 0,
    releaseReservations
  const reservationBarrier = new Promise((resolve) => {
    releaseReservations = resolve
  })
  db.runTransaction = async (...args) => {
    reservations++
    if (reservations <= 2) {
      if (reservations === 2) releaseReservations()
      await Promise.race([
        reservationBarrier,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Both private contenders must reach reservation')), 10000)
          timer.unref()
        }),
      ])
    }
    return originalReservationTransaction(...args)
  }
  let unsharedOutcomes
  try {
    unsharedOutcomes = await Promise.allSettled(
      contenders.map((contender) => ensureScene(unsharedId, contender, `${prefix}_unshared`)),
    )
  } finally {
    db.runTransaction = originalReservationTransaction
  }
  assert.equal(unsharedOutcomes.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(unsharedOutcomes.find((result) => result.status === 'rejected').reason.code, 'permission-denied')
  const registered = (await db.doc(`boardScenes/${unsharedId}`).get()).data(),
    loser = contenders.find((contender) => contender.uid !== registered.ownerId)
  const stagedSecrets = await db.collection(`boardScenes/${unsharedId}/chunks`).get()
  assert(stagedSecrets.size > 0)
  assert(stagedSecrets.docs.every((doc) => doc.data().uploaderUid === registered.ownerId))
  assert(stagedSecrets.docs.every((doc) => !doc.data().payload.includes(`${loser.uid}_secret`)))
  passed.push('simultaneous unshared private owner reservation yields one binding and zero losing secret chunks')

  // A supplied private path can never reassociate an existing global scene binding.
  const collision = await seed('collision')
  await db.doc(`users/${stranger.uid}/projects/${collision.projectId}`).set({ ownerId: stranger.uid })
  await db
    .doc(`users/${stranger.uid}/projects/${collision.projectId}/boards/${collision.boardId}`)
    .set({ active: true, scene: scene('private-secret') })
  const outcomes = await Promise.allSettled([
    ensureScene(collision.boardId, actor, collision.projectId),
    ensureScene(collision.boardId, stranger, collision.projectId),
  ])
  assert.equal(outcomes[0].status, 'fulfilled')
  assert.equal(outcomes[1].status, 'rejected')
  assert.equal(outcomes[1].reason.code, 'permission-denied')
  const chunks = await db.collection(`boardScenes/${collision.boardId}/chunks`).get()
  assert(chunks.size > 0)
  assert(chunks.docs.every((doc) => doc.data().uploaderUid === actor.uid))
  assert(!chunks.docs.some((doc) => doc.data().payload.includes('private-secret')))
  passed.push('ownership collision rejected before private orphan bytes are staged')

  // Server migration reads trusted legacy payload; read role never authorizes scene publication.
  for (const role of ['viewer', 'presentation']) {
    const standalone = await seed(`standalone_${role}`, { standalone: true, publicRole: role })
    const head = await ensureScene(standalone.boardId, stranger)
    assert.equal(head.projectId, null)
    const loaded = await loadSceneRevision(standalone.boardId, head)
    assert.equal(loaded.scene.elements[0].id, `standalone_${role}`)
    const upload = await stage(standalone.boardId, head, scene('unauthorized'), role)
    await assert.rejects(
      commitSceneCandidate(standalone.boardId, upload.commitId, stranger),
      assertCode('permission-denied'),
    )
    assert.equal((await db.doc(`boardScenes/${standalone.boardId}`).get()).data().headRevisionId, head.headRevisionId)
    passed.push(`standalone ${role} bootstrap preserves trusted source; publication denied`)
  }

  // The trusted abandoned-room path passes a transform into checkpointScene so the
  // exact base is pinned before the first revision/page/chunk read.
  const pinnedCheckpoint = await seed('pinned_checkpoint')
  const pinnedHead = await ensureScene(pinnedCheckpoint.boardId, actor, pinnedCheckpoint.projectId)
  const originalGetAll = db.getAll.bind(db)
  const originalCollection = db.collection.bind(db)
  let protectedReads = 0
  db.getAll = async (...references) => {
    if (references.some((reference) => /\/revisions\/|\/chunks\//.test(reference.path))) {
      const pins = await originalCollection(`boardScenes/${pinnedCheckpoint.boardId}/readerPins`).get()
      if (pins.docs.some((pin) => pin.data().purpose === 'checkpoint-base')) protectedReads++
    }
    return originalGetAll(...references)
  }
  try {
    await checkpointScene(
      pinnedCheckpoint.boardId,
      (base) => ({ ...base, elements: [...base.elements, { ...scene('checkpoint-added').elements[0] }] }),
      pinnedHead,
      actor,
    )
  } finally {
    db.getAll = originalGetAll
  }
  assert(protectedReads > 0, 'checkpoint reads must observe their pin before loading pages/chunks')
  assert.equal((await db.collection(`boardScenes/${pinnedCheckpoint.boardId}/readerPins`).get()).size, 0)
  passed.push('abandoned-room checkpoint pins its exact base before trusted payload reads')

  // Repacking preserves logical data and refuses to publish a stale layout over an intervening edit.
  const fragmented = await seed('repack_conflict'),
    fragmentedHead = await ensureScene(fragmented.boardId, actor, fragmented.projectId)
  const fragmentedScene = {
    elements: Array.from({ length: 6 }, (_, index) => ({
      id: `repack-element-${index}`,
      type: 'rectangle',
      x: index * 40,
      y: 10,
      width: 30,
      height: 20,
      version: 1,
      versionNonce: index + 10,
      isDeleted: index === 5,
      customData: { semanticType: 'UMLClass', index },
    })),
    appState: { viewBackgroundColor: '#ffffff', gridSize: null },
    files: {},
    semanticModel: { schemaVersion: 1, diagramType: 'class', nodes: [{ id: 'node-1', type: 'class' }] },
  }
  const fragmentedRecords = [
    [{ key: '$header', kind: 'header', value: { hasFiles: true } }],
    [{ key: '$appState', kind: 'appState', value: fragmentedScene.appState }],
    ...fragmentedScene.elements.map((value, order) => [{ key: `element:${value.id}`, kind: 'element', value, order }]),
    [{ key: 'extra:semanticModel', kind: 'extra', value: fragmentedScene.semanticModel }],
  ]
  const fragmentedChunks = await Promise.all(
    fragmentedRecords.map(async (records) => {
      const payload = canonicalStringify(records)
      return { payload, digest: await digestString(payload) }
    }),
  )
  const fragmentedUpload = await stage(
    fragmented.boardId,
    fragmentedHead,
    fragmentedScene,
    'repack-fragmented',
    fragmentedChunks,
  )
  await commitSceneCandidate(fragmented.boardId, fragmentedUpload.commitId, actor)
  const layoutHead = (await db.doc(`boardScenes/${fragmented.boardId}`).get()).data()
  const beforeRepack = await loadSceneRevision(fragmented.boardId, layoutHead)
  assert.equal(beforeRepack.references.length, 9, 'fixture deliberately splits records across nine chunks')
  const { repackBoardSceneNow, repackBoardScene } = await import('../functions/lib/board-scenes.js')
  let reachedStage
  let releaseStage
  const stageReady = new Promise((resolve) => {
    reachedStage = resolve
  })
  const continueStage = new Promise((resolve) => {
    releaseStage = resolve
  })
  const originalBulkWriter = db.bulkWriter.bind(db)
  db.bulkWriter = () => {
    const writer = originalBulkWriter()
    return {
      create: (...args) => writer.create(...args),
      close: async () => {
        reachedStage()
        await continueStage
        return writer.close()
      },
    }
  }
  const repackInFlight = repackBoardSceneNow(fragmented.boardId, actor)
  let editedScene
  let barrierTimer
  try {
    await Promise.race([
      stageReady,
      new Promise((_, reject) => {
        barrierTimer = setTimeout(() => reject(new Error('repack staging did not reach barrier')), 10000)
      }),
    ])
    clearTimeout(barrierTimer)
    db.bulkWriter = originalBulkWriter
    editedScene = {
      ...fragmentedScene,
      elements: fragmentedScene.elements.map((element, index) =>
        index === 0 ? { ...element, x: element.x + 99, version: element.version + 1 } : element,
      ),
    }
    await checkpointScene(
      fragmented.boardId,
      (base) => ({ ...base, elements: editedScene.elements }),
      layoutHead,
      actor,
    )
  } finally {
    clearTimeout(barrierTimer)
    releaseStage()
    db.bulkWriter = originalBulkWriter
  }
  await assert.rejects(repackInFlight, assertCode('aborted'))
  const winningHead = (await db.doc(`boardScenes/${fragmented.boardId}`).get()).data()
  assert.match(winningHead.headRevisionId, /^checkpoint_/)
  const winningScene = (await loadSceneRevision(fragmented.boardId, winningHead)).scene
  assert.deepEqual(winningScene.elements, editedScene.elements)
  assert.equal(winningScene.deletionLedger[0].id, editedScene.elements.find((element) => element.isDeleted).id)
  passed.push(
    'active-collaboration checkpoint wins a head race; stale layout repack aborts and preserves the acknowledged edit',
  )

  const compactable = await seed('repack_success'),
    compactableHead = await ensureScene(compactable.boardId, actor, compactable.projectId)
  const compactableUpload = await stage(
    compactable.boardId,
    compactableHead,
    fragmentedScene,
    'repack-success-fragmented',
    fragmentedChunks,
  )
  await commitSceneCandidate(compactable.boardId, compactableUpload.commitId, actor)
  const repackBase = (await db.doc(`boardScenes/${compactable.boardId}`).get()).data()
  const beforeLayout = await loadSceneRevision(compactable.boardId, repackBase)
  await assert.rejects(
    repackBoardScene.run({
      data: { boardId: compactable.boardId, sceneProtocolVersion: 2 },
      auth: { uid: stranger.uid, token: { email_verified: false } },
    }),
    assertCode('permission-denied'),
  )
  const repackReceipt = await repackBoardSceneNow(compactable.boardId, actor)
  assert.equal(repackReceipt.generation, repackBase.generation)
  const repackedHead = (await db.doc(`boardScenes/${compactable.boardId}`).get()).data()
  const afterLayout = await loadSceneRevision(compactable.boardId, repackedHead)
  assert.deepEqual(afterLayout.scene.elements, beforeLayout.scene.elements)
  assert.equal(afterLayout.scene.deletionLedger.length, 1)
  assert.equal(
    afterLayout.scene.deletionLedger[0].id,
    beforeLayout.scene.elements.find((element) => element.isDeleted).id,
  )
  assert.deepEqual(afterLayout.scene.appState, beforeLayout.scene.appState)
  assert.deepEqual(afterLayout.scene.semanticModel, beforeLayout.scene.semanticModel)
  assert.equal(afterLayout.references.length, 1)
  assert.equal(repackedHead.generation, repackBase.generation)
  assert(
    (await db.doc(`boardScenes/${compactable.boardId}/revisions/${repackReceipt.revisionId}`).get()).data().reason ===
      'maintenance',
  )
  assert(
    (await db.doc(`boardScenes/${compactable.boardId}/revisions/${repackReceipt.revisionId}`).get()).data()
      .repackBytesAfter <
      (await db.doc(`boardScenes/${compactable.boardId}/revisions/${repackReceipt.revisionId}`).get()).data()
        .repackBytesBefore,
  )
  await assert.rejects(
    checkpointScene(
      compactable.boardId,
      (base) => ({ ...base, elements: [...base.elements, { id: 'stale-room-edit', version: 1, versionNonce: 1 }] }),
      repackBase,
      actor,
    ),
    assertCode('aborted'),
  )
  await assert.rejects(
    repackBoardSceneNow(compactable.boardId, actor),
    (error) => error.details?.reason === 'repack-cooldown',
  )
  assert.equal(
    (await db.doc(`boardScenes/${compactable.boardId}`).get()).data().headRevisionId,
    repackReceipt.revisionId,
    'cooldown prevents a maintenance revision loop',
  )
  passed.push('layout repack preserves semantic scene fields, reduces chunks and bytes, and enforces cooldown')

  const alreadyPacked = await seed('repack-noop'),
    alreadyPackedHead = await ensureScene(alreadyPacked.boardId, actor, alreadyPacked.projectId),
    beforeNoopJobs = await db.collection(`boardScenes/${alreadyPacked.boardId}/maintenanceJobs`).get()
  const noOpOne = await repackBoardSceneNow(alreadyPacked.boardId, actor)
  const noOpTwo = await repackBoardSceneNow(alreadyPacked.boardId, actor)
  assert.equal(noOpOne.status, 'no-op')
  assert.equal(noOpTwo.status, 'no-op')
  assert.equal(
    (await db.doc(`boardScenes/${alreadyPacked.boardId}`).get()).data().headRevisionId,
    alreadyPackedHead.headRevisionId,
  )
  assert.equal(
    (await db.collection(`boardScenes/${alreadyPacked.boardId}/maintenanceJobs`).get()).size,
    beforeNoopJobs.size,
    'an unchanged layout creates no maintenance jobs or revisions',
  )
  passed.push('repeated repack requests on an already-packed scene are idempotent no-ops')

  // Old writers cannot enter the scene API after deletion-ledger support is enabled.
  const { beginBoardSceneUpload } = await import('../functions/lib/board-scenes.js')
  await assert.rejects(
    beginBoardSceneUpload.run({
      data: {
        boardId: alreadyPacked.boardId,
        commitId: `${prefix}_old_protocol`,
        expectedHeadRevisionId: alreadyPackedHead.headRevisionId,
        sceneProtocolVersion: 1,
      },
      auth: { uid: actor.uid, token: { email_verified: false } },
    }),
    (error) => error.code === 'failed-precondition' && error.details?.minimumSceneProtocolVersion === 2,
  )
  passed.push('server rejects old scene writers below the deletion-ledger protocol capability')

  // Client timestamps are rejected. Trusted checkpoints assign the server clock and
  // stale/offline elements cannot reset the first observation.
  const deletionBoard = await seed('server_tombstone_observation')
  let deletionHead = await ensureScene(deletionBoard.boardId, actor, deletionBoard.projectId)
  const deletionBase = await loadSceneRevision(deletionBoard.boardId, deletionHead)
  const original = deletionBase.scene.elements[0]
  const clientTimestamp = '2000-01-01T00:00:00.000Z'
  const deletedScene = {
    ...deletionBase.scene,
    elements: [
      { ...original, isDeleted: true, version: original.version + 1, versionNonce: original.versionNonce + 1 },
    ],
    deletionLedger: [
      {
        id: original.id,
        version: original.version + 1,
        versionNonce: original.versionNonce + 1,
        firstObservedDeletedAt: clientTimestamp,
        compacted: false,
      },
    ],
  }
  const deletedUpload = await stage(deletionBoard.boardId, deletionHead, deletedScene, 'server-tombstone')
  await assert.rejects(
    commitSceneCandidate(deletionBoard.boardId, deletedUpload.commitId, actor),
    (error) => error.code === 'failed-precondition',
  )
  await checkpointScene(
    deletionBoard.boardId,
    (base) => ({
      ...base,
      elements: [
        {
          ...base.elements[0],
          isDeleted: true,
          version: base.elements[0].version + 1,
          versionNonce: base.elements[0].versionNonce + 1,
        },
      ],
    }),
    deletionHead,
    actor,
  )
  deletionHead = (await db.doc(`boardScenes/${deletionBoard.boardId}`).get()).data()
  const deleted = (await loadSceneRevision(deletionBoard.boardId, deletionHead)).scene
  const firstClock = deleted.deletionLedger.find((entry) => entry.id === original.id)
  assert(firstClock)
  assert.notEqual(firstClock.firstObservedDeletedAt, clientTimestamp)
  assert(Date.now() - Date.parse(firstClock.firstObservedDeletedAt) < 60_000)

  const staleHead = deletionHead
  await checkpointScene(deletionBoard.boardId, (base) => ({ ...base, elements: [original] }), staleHead, actor)
  const afterStale = (
    await loadSceneRevision(deletionBoard.boardId, (await db.doc(`boardScenes/${deletionBoard.boardId}`).get()).data())
  ).scene
  assert.equal(afterStale.elements.find((element) => element.id === original.id).isDeleted, true)
  assert.equal(
    afterStale.deletionLedger.find((entry) => entry.id === original.id).firstObservedDeletedAt,
    firstClock.firstObservedDeletedAt,
  )

  const tombstoneActiveRef = rtdb.ref(`activeSessions/${deletionBoard.boardId}/session`)
  await tombstoneActiveRef.set({ userId: actor.uid, sessionId: 'session' })
  const blockedCompactionHead = (await db.doc(`boardScenes/${deletionBoard.boardId}`).get()).data()
  const blockedCompaction = await runWithAbandonedRoomFence({
    rtdb,
    boardId: deletionBoard.boardId,
    lockToken: `${prefix}_tombstone_active`,
    lockDurationMs: 180_000,
    work: async () =>
      checkpointScene(deletionBoard.boardId, (base) => base, blockedCompactionHead, actor, { compactTombstones: true }),
  })
  assert.equal(
    blockedCompaction.status,
    'active-sessions',
    'an active board session must retain full tombstones and undo',
  )
  assert.equal(
    (await db.doc(`boardScenes/${deletionBoard.boardId}`).get()).data().headRevisionId,
    blockedCompactionHead.headRevisionId,
  )
  await tombstoneActiveRef.remove()

  const compactionSourceHead = (await db.doc(`boardScenes/${deletionBoard.boardId}`).get()).data()
  const compactedFence = await runWithAbandonedRoomFence({
    rtdb,
    boardId: deletionBoard.boardId,
    lockToken: `${prefix}_tombstone_compact`,
    lockDurationMs: 180_000,
    work: async () => {
      assert.equal(
        (await rtdb.ref(`system/sceneMaintenance/${deletionBoard.boardId}/admissionClosed`).get()).val(),
        true,
      )
      return checkpointScene(deletionBoard.boardId, (base) => base, compactionSourceHead, actor, {
        compactTombstones: true,
      })
    },
  })
  assert.equal(compactedFence.status, 'completed')
  const compactedHead = (await db.doc(`boardScenes/${deletionBoard.boardId}`).get()).data()
  const compactedScene = (await loadSceneRevision(deletionBoard.boardId, compactedHead)).scene
  assert.equal(
    compactedScene.elements.some((element) => element.id === original.id),
    false,
  )
  assert.deepEqual(
    compactedScene.deletionLedger.find((entry) => entry.id === original.id),
    {
      ...firstClock,
      compacted: true,
    },
  )
  assert.equal(
    (await db.doc(`boardScenes/${deletionBoard.boardId}/revisions/${compactedHead.headRevisionId}`).get()).data()
      .maintenanceReason,
    'tombstone-compaction',
  )
  const historicalDeletedScene = await loadSceneRevision(deletionBoard.boardId, compactionSourceHead)
  assert.equal(
    historicalDeletedScene.scene.elements.find((element) => element.id === original.id).isDeleted,
    true,
    'compaction must retain historical full tombstone revisions',
  )
  passed.push(
    'server observes tombstone time, blocks compaction during active sessions, and compacts only under the RTDB fence',
  )

  // Browser payload access is routed through protocol-versioned callables bound to a pin.
  const callableReads = await seed('callable_pinned_reads')
  const callableHead = await ensureScene(callableReads.boardId, actor, callableReads.projectId)
  const { acquireBoardSceneReadPin, readBoardScenePage, readBoardSceneChunks } =
    await import('../functions/lib/board-scenes.js')
  const ownerAuth = { uid: actor.uid, token: { email_verified: false } }
  const readPin = await acquireBoardSceneReadPin.run({
    data: { boardId: callableReads.boardId, sceneProtocolVersion: 2 },
    auth: ownerAuth,
  })
  assert.equal(readPin.initialPage.revision.chunkCount, 1)
  assert.equal(readPin.initialPage.references.length, 1)
  assert.equal(
    readPin.initialPage.chunks.length,
    1,
    'Pin acquisition returns the first bounded page and its payload batch in the same callable response.',
  )
  await assert.rejects(
    readBoardScenePage.run({
      data: {
        boardId: callableReads.boardId,
        pinId: readPin.pinId,
        revisionId: readPin.revisionId,
        pageId: pageId(0),
      },
      auth: ownerAuth,
    }),
    assertCode('failed-precondition'),
  )
  const page = await readBoardScenePage.run({
    data: {
      boardId: callableReads.boardId,
      pinId: readPin.pinId,
      revisionId: readPin.revisionId,
      pageId: pageId(0),
      sceneProtocolVersion: 2,
    },
    auth: ownerAuth,
  })
  assert.equal(page.revision.generation, callableHead.generation)
  assert.equal(page.revision.sceneFormatVersion, 1)
  assert.equal(page.revision.chunkCount, page.references.length)
  assert.equal(
    page.chunks.length,
    Math.min(page.references.length, 8),
    'The first bounded payload batch is returned with the manifest page.',
  )
  assert.deepEqual(
    page.chunks.map(({ id, digest }) => ({ id, digest })),
    page.references.slice(0, 8).map(({ chunkId, digest }) => ({ id: chunkId, digest })),
  )
  const chunkIds = page.references.map((reference) => reference.chunkId)
  const returnedChunks = await readBoardSceneChunks.run({
    data: {
      boardId: callableReads.boardId,
      pinId: readPin.pinId,
      revisionId: readPin.revisionId,
      pageId: pageId(0),
      chunkIds,
      sceneProtocolVersion: 2,
    },
    auth: ownerAuth,
  })
  assert.deepEqual(
    returnedChunks.chunks.map(({ id, digest }) => ({ id, digest })),
    page.references.map(({ chunkId, digest }) => ({ id: chunkId, digest })),
  )
  assert(returnedChunks.chunks.every(({ payload }) => typeof payload === 'string'))
  const strangerAuth = { uid: stranger.uid, token: { email_verified: false } }
  await assert.rejects(
    readBoardScenePage.run({
      data: {
        boardId: callableReads.boardId,
        pinId: readPin.pinId,
        revisionId: readPin.revisionId,
        pageId: pageId(0),
        sceneProtocolVersion: 2,
      },
      auth: strangerAuth,
    }),
    assertCode('permission-denied'),
  )
  await assert.rejects(
    readBoardScenePage.run({
      data: {
        boardId: callableReads.boardId,
        pinId: `${prefix}_missing_pin`,
        revisionId: readPin.revisionId,
        pageId: pageId(0),
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    assertCode('failed-precondition'),
  )
  await assert.rejects(
    readBoardScenePage.run({
      data: {
        boardId: callableReads.boardId,
        pinId: readPin.pinId,
        revisionId: `${prefix}_wrong_revision`,
        pageId: pageId(0),
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    assertCode('failed-precondition'),
  )
  await assert.rejects(
    readBoardSceneChunks.run({
      data: {
        boardId: callableReads.boardId,
        pinId: readPin.pinId,
        revisionId: readPin.revisionId,
        pageId: pageId(0),
        chunkIds: [`${prefix}_unreferenced`],
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    assertCode('failed-precondition'),
  )
  await assert.rejects(
    readBoardSceneChunks.run({
      data: {
        boardId: callableReads.boardId,
        pinId: readPin.pinId,
        revisionId: readPin.revisionId,
        pageId: pageId(0),
        chunkIds: Array.from({ length: 9 }, (_, index) => `${prefix}_bounded_${index}`),
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    assertCode('invalid-argument'),
  )
  await db.doc(`boardScenes/${callableReads.boardId}/readerPins/${readPin.pinId}`).update({
    expiresAt: Timestamp.fromMillis(Date.now() - 1000),
  })
  await assert.rejects(
    readBoardScenePage.run({
      data: {
        boardId: callableReads.boardId,
        pinId: readPin.pinId,
        revisionId: readPin.revisionId,
        pageId: pageId(0),
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    assertCode('failed-precondition'),
  )
  passed.push('callable scene page/chunk reads require an active authorized pin and bound manifest references')

  const { createNamedBoardSceneVersion, listNamedBoardSceneVersions, acquireNamedBoardSceneVersionReadPin } =
    await import('../functions/lib/board-scenes.js')
  const { prepareBoardSceneGenerationReset } = await import('../functions/lib/board-scenes.js')
  const named = await createNamedBoardSceneVersion.run({
    data: { boardId: callableReads.boardId, name: 'Before edits', sceneProtocolVersion: 2 },
    auth: ownerAuth,
  })
  await assert.rejects(
    createNamedBoardSceneVersion.run({
      data: { boardId: callableReads.boardId, name: 'Not owner', sceneProtocolVersion: 2 },
      auth: strangerAuth,
    }),
    assertCode('permission-denied'),
  )
  const listedVersions = await listNamedBoardSceneVersions.run({
    data: { boardId: callableReads.boardId },
    auth: ownerAuth,
  })
  assert.equal(listedVersions.versions.length, 1)
  assert.equal(listedVersions.versions[0].versionId, named.versionId)
  await checkpointScene(
    callableReads.boardId,
    (base) => ({
      ...base,
      elements: [
        ...base.elements,
        {
          id: `${prefix}_later_edit`,
          type: 'rectangle',
          x: 9,
          y: 10,
          width: 30,
          height: 20,
          version: 1,
          versionNonce: 99,
        },
      ],
    }),
    callableHead,
    actor,
  )
  const historicalPin = await acquireNamedBoardSceneVersionReadPin.run({
    data: { boardId: callableReads.boardId, versionId: named.versionId, sceneProtocolVersion: 2 },
    auth: ownerAuth,
  })
  assert.equal(historicalPin.revisionId, named.revisionId)
  const historicalPage = await readBoardScenePage.run({
    data: {
      boardId: callableReads.boardId,
      pinId: historicalPin.pinId,
      revisionId: named.revisionId,
      pageId: pageId(0),
      sceneProtocolVersion: 2,
    },
    auth: ownerAuth,
  })
  assert.equal(historicalPage.revision.generation, named.generation)
  const historicalChunks = await readBoardSceneChunks.run({
    data: {
      boardId: callableReads.boardId,
      pinId: historicalPin.pinId,
      revisionId: named.revisionId,
      pageId: pageId(0),
      chunkIds: historicalPage.references.map(({ chunkId }) => chunkId),
      sceneProtocolVersion: 2,
    },
    auth: ownerAuth,
  })
  assert.equal(historicalChunks.chunks.length, historicalPage.references.length)
  assert.notEqual((await db.doc(`boardScenes/${callableReads.boardId}`).get()).data().headRevisionId, named.revisionId)
  const rootsAfterHeadAdvance = await db.collection(`boardScenes/${callableReads.boardId}/versions`).get()
  assert(
    rootsAfterHeadAdvance.docs.some((version) => version.id === named.versionId),
    'named version remains a durable root after live head advances',
  )
  const readerAuth = { uid: stranger.uid, token: { email_verified: true, email: `${stranger.uid}@example.test` } }
  const resetOperationId = `${prefix}_restore_prepare`
  const preparedReset = await prepareBoardSceneGenerationReset.run({
    data: {
      boardId: callableReads.boardId,
      operationId: resetOperationId,
      versionId: named.versionId,
      sceneProtocolVersion: 2,
    },
    auth: ownerAuth,
  })
  assert.equal(preparedReset.phase, 'prepared')
  assert.equal(preparedReset.sourceGeneration, 1)
  assert.equal(preparedReset.targetGeneration, 2)
  assert.equal(
    preparedReset.sourceHeadRevisionId,
    (await db.doc(`boardScenes/${callableReads.boardId}`).get()).data().headRevisionId,
  )
  const resetJobRef = db.doc(`boardScenes/${callableReads.boardId}/maintenanceJobs/${resetOperationId}`)
  const resetJob = (await resetJobRef.get()).data()
  assert.equal(resetJob.status, 'generation-reset-prepared')
  assert.deepEqual(
    new Set(resetJob.protectedRevisionIds),
    new Set([preparedReset.sourceHeadRevisionId, named.revisionId]),
  )
  const recoveryVersion = (
    await db.doc(`boardScenes/${callableReads.boardId}/versions/${preparedReset.recoveryVersionId}`).get()
  ).data()
  assert.equal(
    recoveryVersion.revisionId,
    preparedReset.sourceHeadRevisionId,
    'pre-restore recovery version protects the current head',
  )
  const retriedReset = await prepareBoardSceneGenerationReset.run({
    data: {
      boardId: callableReads.boardId,
      operationId: resetOperationId,
      versionId: named.versionId,
      sceneProtocolVersion: 2,
    },
    auth: ownerAuth,
  })
  assert.deepEqual(retriedReset, preparedReset, 'callable retry returns the same prepared operation')
  await assert.rejects(
    prepareBoardSceneGenerationReset.run({
      data: {
        boardId: callableReads.boardId,
        operationId: resetOperationId,
        versionId: `${prefix}_other_version`,
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    assertCode('already-exists'),
  )
  await assert.rejects(
    prepareBoardSceneGenerationReset.run({
      data: {
        boardId: callableReads.boardId,
        operationId: `${prefix}_reader_restore`,
        versionId: named.versionId,
        sceneProtocolVersion: 2,
      },
      auth: readerAuth,
    }),
    assertCode('permission-denied'),
  )
  await assert.rejects(
    acquireNamedBoardSceneVersionReadPin.run({
      data: {
        boardId: callableReads.boardId,
        versionId: `${prefix}_unknown`,
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    assertCode('not-found'),
  )
  await assert.rejects(
    readBoardScenePage.run({
      data: {
        boardId: callableReads.boardId,
        pinId: historicalPin.pinId,
        revisionId: (await db.doc(`boardScenes/${callableReads.boardId}`).get()).data().headRevisionId,
        pageId: pageId(0),
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    assertCode('failed-precondition'),
  )
  await db.doc(`boardScenes/${callableReads.boardId}/maintenance/control`).update({ admission: 'closed' })
  await assert.rejects(
    createNamedBoardSceneVersion.run({
      data: {
        boardId: callableReads.boardId,
        name: 'Gate must block',
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    (error) => error.details?.reason === 'maintenance',
  )
  await assert.rejects(
    prepareBoardSceneGenerationReset.run({
      data: {
        boardId: callableReads.boardId,
        operationId: `${prefix}_closed_restore`,
        versionId: named.versionId,
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    (error) => error.details?.reason === 'maintenance',
  )
  await assert.rejects(
    acquireNamedBoardSceneVersionReadPin.run({
      data: {
        boardId: callableReads.boardId,
        versionId: named.versionId,
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    (error) => error.details?.reason === 'maintenance',
  )
  await db.doc(`boardScenes/${callableReads.boardId}/maintenance/control`).update({ admission: 'open' })
  await db.doc(`boardShares/${callableReads.boardId}`).update({
    generalAccess: 'restricted',
    invitedEmails: [readerAuth.token.email],
    collaborators: { [readerAuth.token.email]: { role: 'viewer' } },
  })
  const readerVersions = await listNamedBoardSceneVersions.run({
    data: { boardId: callableReads.boardId },
    auth: readerAuth,
  })
  assert(
    readerVersions.versions.some((version) => version.versionId === named.versionId),
    'authorized viewers can enumerate named versions',
  )
  const readerPin = await acquireNamedBoardSceneVersionReadPin.run({
    data: {
      boardId: callableReads.boardId,
      versionId: named.versionId,
      sceneProtocolVersion: 2,
    },
    auth: readerAuth,
  })
  assert.equal(readerPin.revisionId, named.revisionId, 'authorized viewers can read a named historical root')
  await assert.rejects(
    listNamedBoardSceneVersions.run({
      data: { boardId: callableReads.boardId },
      auth: { uid: `${prefix}_outsider`, token: { email_verified: false } },
    }),
    assertCode('permission-denied'),
  )
  const { fenceBoardSceneGenerationReset, publishBoardSceneGenerationReset, activateBoardSceneGenerationReset } =
    await import('../functions/lib/scene-generation-reset.js')
  for (const callable of [
    fenceBoardSceneGenerationReset,
    publishBoardSceneGenerationReset,
    activateBoardSceneGenerationReset,
  ]) {
    await assert.rejects(
      callable.run({
        data: { boardId: callableReads.boardId, operationId: resetOperationId, sceneProtocolVersion: 2 },
        auth: readerAuth,
      }),
      assertCode('permission-denied'),
    )
  }
  await assert.rejects(
    publishBoardSceneGenerationReset.run({
      data: {
        boardId: callableReads.boardId,
        operationId: resetOperationId,
        sceneProtocolVersion: 1,
      },
      auth: ownerAuth,
    }),
    assertCode('failed-precondition'),
  )
  const resetRoom = `boards/${callableReads.boardId}`
  await rtdb.ref(`${resetRoom}/generation`).set(1)
  await rtdb.ref(`presence/${callableReads.boardId}`).remove()
  await rtdb.ref(`activeSessions/${callableReads.boardId}`).remove()
  await rtdb.ref(`${resetRoom}/elements`).remove()
  await rtdb
    .ref(`activeSessions/${callableReads.boardId}/live-session`)
    .set({ userId: actor.uid, sessionId: 'live-session' })
  const activeDeferred = await fenceBoardSceneGenerationReset.run({
    data: { boardId: callableReads.boardId, operationId: resetOperationId, sceneProtocolVersion: 2 },
    auth: ownerAuth,
  })
  assert.equal(activeDeferred.reason, 'active-sessions')
  assert.equal(
    (await db.doc(`boardScenes/${callableReads.boardId}/maintenance/control`).get()).data().admission,
    'open',
  )
  assert.notEqual(
    (await rtdb.ref(`system/sceneMaintenance/${callableReads.boardId}/admissionClosed`).get()).val(),
    true,
  )
  await rtdb.ref(`activeSessions/${callableReads.boardId}/live-session`).remove()
  await rtdb.ref(`${resetRoom}/elements/uncheckpointed`).set({ id: 'uncheckpointed', data: '{}' })
  const deltaDeferred = await fenceBoardSceneGenerationReset.run({
    data: { boardId: callableReads.boardId, operationId: resetOperationId, sceneProtocolVersion: 2 },
    auth: ownerAuth,
  })
  assert.equal(deltaDeferred.reason, 'uncheckpointed-deltas')
  await rtdb.ref(`${resetRoom}/elements/uncheckpointed`).remove()
  const fencedReset = await fenceBoardSceneGenerationReset.run({
    data: { boardId: callableReads.boardId, operationId: resetOperationId, sceneProtocolVersion: 2 },
    auth: ownerAuth,
  })
  assert.equal(fencedReset.phase, 'fenced')
  assert.equal(
    (await db.doc(`boardScenes/${callableReads.boardId}`).get()).data().generation,
    1,
    'fencing changes the RTDB room generation but does not publish the Firestore head',
  )
  assert.equal((await rtdb.ref(`${resetRoom}/generation`).get()).val(), 2)
  assert.equal(
    (await rtdb.ref(`system/sceneMaintenance/${callableReads.boardId}`).get()).child('admissionClosed').val(),
    true,
  )
  const fencedRetry = await fenceBoardSceneGenerationReset.run({
    data: { boardId: callableReads.boardId, operationId: resetOperationId, sceneProtocolVersion: 2 },
    auth: ownerAuth,
  })
  assert.equal(fencedRetry.phase, 'fenced', 'retry after fencing is idempotent')
  const publishedReset = await publishBoardSceneGenerationReset.run({
    data: { boardId: callableReads.boardId, operationId: resetOperationId, sceneProtocolVersion: 2 },
    auth: ownerAuth,
  })
  assert.equal(publishedReset.phase, 'published')
  assert.equal(publishedReset.generation, 2)
  const restoredHead = (await db.doc(`boardScenes/${callableReads.boardId}`).get()).data()
  assert.equal(restoredHead.headRevisionId, publishedReset.revisionId)
  assert.equal(restoredHead.generation, 2)
  const restoredScene = await loadSceneRevision(callableReads.boardId, restoredHead)
  const selectedScene = await loadSceneRevision(callableReads.boardId, {
    headRevisionId: named.revisionId,
    generation: named.generation,
  })
  assert.deepEqual(
    restoredScene.scene.elements,
    selectedScene.scene.elements.filter((element) => element.isDeleted !== true),
    'published generation contains the selected historical live canvas elements',
  )
  assert.deepEqual(restoredScene.scene.deletionLedger ?? [], [], 'new generation starts with an empty deletion ledger')
  assert.deepEqual(restoredScene.scene.files, selectedScene.scene.files)
  assert.deepEqual(restoredScene.scene.appState, selectedScene.scene.appState)
  assert.equal((await rtdb.ref(`${resetRoom}/generation`).get()).val(), 2)
  assert.equal(
    (await db.doc(`boardScenes/${callableReads.boardId}/maintenance/control`).get()).data().admission,
    'closed',
    'publication keeps admission closed until target activation is completed',
  )
  const publishedRetry = await publishBoardSceneGenerationReset.run({
    data: { boardId: callableReads.boardId, operationId: resetOperationId, sceneProtocolVersion: 2 },
    auth: ownerAuth,
  })
  assert.deepEqual(publishedRetry, publishedReset, 'publication retry returns the committed target generation')
  const activatedReset = await activateBoardSceneGenerationReset.run({
    data: { boardId: callableReads.boardId, operationId: resetOperationId, sceneProtocolVersion: 2 },
    auth: ownerAuth,
  })
  assert.equal(activatedReset.phase, 'activated')
  assert.equal(
    (await db.doc(`boardScenes/${callableReads.boardId}/maintenance/control`).get()).data().admission,
    'open',
  )
  assert.equal((await rtdb.ref(`system/sceneMaintenance/${callableReads.boardId}/admissionClosed`).get()).val(), false)
  const activatedRetry = await activateBoardSceneGenerationReset.run({
    data: { boardId: callableReads.boardId, operationId: resetOperationId, sceneProtocolVersion: 2 },
    auth: ownerAuth,
  })
  assert.deepEqual(activatedRetry, activatedReset, 'activation retry returns the completed reset')
  const recoveryOperationId = `${prefix}_restore_crash_recovery`
  const recoveryPrepared = await prepareBoardSceneGenerationReset.run({
    data: {
      boardId: callableReads.boardId,
      operationId: recoveryOperationId,
      versionId: named.versionId,
      sceneProtocolVersion: 2,
    },
    auth: ownerAuth,
  })
  await fenceBoardSceneGenerationReset.run({
    data: {
      boardId: callableReads.boardId,
      operationId: recoveryOperationId,
      sceneProtocolVersion: 2,
    },
    auth: ownerAuth,
  })
  const selectedChunkRef = db.doc(`boardScenes/${callableReads.boardId}/chunks/${historicalPage.references[0].chunkId}`)
  const selectedChunk = (await selectedChunkRef.get()).data()
  await selectedChunkRef.update({ payload: 'tampered' })
  await assert.rejects(
    publishBoardSceneGenerationReset.run({
      data: {
        boardId: callableReads.boardId,
        operationId: recoveryOperationId,
        sceneProtocolVersion: 2,
      },
      auth: ownerAuth,
    }),
    assertCode('failed-precondition'),
  )
  await selectedChunkRef.set(selectedChunk)
  await publishBoardSceneGenerationReset.run({
    data: {
      boardId: callableReads.boardId,
      operationId: recoveryOperationId,
      sceneProtocolVersion: 2,
    },
    auth: ownerAuth,
  })
  // Model a worker dying after Firestore admission reopened but before RTDB admission did.
  await db
    .doc(`boardScenes/${callableReads.boardId}/maintenanceJobs/${recoveryOperationId}`)
    .update({ phase: 'activated', status: 'running' })
  await db.doc(`boardScenes/${callableReads.boardId}/maintenance/control`).update({
    admission: 'open',
    jobId: null,
    token: null,
    leaseUntil: null,
    phase: null,
  })
  const recoveredActivation = await activateBoardSceneGenerationReset.run({
    data: {
      boardId: callableReads.boardId,
      operationId: recoveryOperationId,
      sceneProtocolVersion: 2,
    },
    auth: ownerAuth,
  })
  assert.equal(recoveredActivation.status, 'complete')
  assert.equal(recoveredActivation.generation, recoveryPrepared.targetGeneration)
  assert.equal(
    (await rtdb.ref(`system/sceneMaintenance/${callableReads.boardId}/admissionClosed`).get()).val(),
    false,
    'activation retry opens RTDB after recovering the intermediate cross-store state',
  )
  passed.push(
    'named versions are owner-created durable roots and exact historical revisions remain readable after head changes',
  )
  passed.push('generation reset fencing defers active sessions and RTDB deltas, then closes both stores idempotently')
  passed.push(
    'generation reset publishes a clean immutable G+1 and reopens admission idempotently only after activation',
  )
  passed.push('activation retry completes safely after the Firestore gate opened but before RTDB reopened')

  const tampered = await seed('tampered'),
    head = await ensureScene(tampered.boardId, actor, tampered.projectId)
  const invalid = await stage(tampered.boardId, head, scene('tampered-new'), 'tampered')
  await db.doc(`boardScenes/${tampered.boardId}/chunks/${invalid.chunks[0].chunkId}`).update({ payload: '[]' })
  await assert.rejects(
    commitSceneCandidate(tampered.boardId, invalid.commitId, actor),
    assertCode('failed-precondition'),
  )
  assert.equal((await db.doc(`boardScenes/${tampered.boardId}`).get()).data().headRevisionId, head.headRevisionId)
  passed.push('tampered payload cannot advance head')

  // Deterministic permission revocation after validation, before the final transaction.
  // Inject into this process's Admin client only; no production request flag or hook.
  const revoked = await seed('revoke', { publicRole: 'editor' }),
    revokeHead = await ensureScene(revoked.boardId, actor, revoked.projectId)
  const editor = { uid: `${prefix}_editor` },
    candidate = await stage(revoked.boardId, revokeHead, scene('revoked-new'), 'revoke')
  await db.doc(`boardScenes/${revoked.boardId}/uploads/${candidate.commitId}`).update({ uploaderUid: editor.uid })
  for (const chunk of candidate.chunks)
    await db.doc(`boardScenes/${revoked.boardId}/chunks/${chunk.chunkId}`).update({ uploaderUid: editor.uid })
  const originalTransaction = db.runTransaction.bind(db)
  let transactions = 0
  db.runTransaction = async (...args) => {
    transactions++
    if (transactions === 3) await db.doc(`boardShares/${revoked.boardId}`).update({ generalAccess: 'restricted' })
    return originalTransaction(...args)
  }
  try {
    await assert.rejects(
      commitSceneCandidate(revoked.boardId, candidate.commitId, editor),
      assertCode('permission-denied'),
    )
  } finally {
    db.runTransaction = originalTransaction
  }
  assert(transactions >= 3, 'revocation must occur at final publication, not initial authorization')
  assert.equal((await db.doc(`boardScenes/${revoked.boardId}`).get()).data().headRevisionId, revokeHead.headRevisionId)
  assert(!(await db.doc(`boardScenes/${revoked.boardId}/uploads/${candidate.commitId}`).get()).data().receipt)
  passed.push('revocation after validation blocks final head publication')

  const race = await seed('race'),
    raceHead = await ensureScene(race.boardId, actor, race.projectId)
  const left = await stage(race.boardId, raceHead, scene('left'), 'left'),
    right = await stage(race.boardId, raceHead, scene('right'), 'right')
  const writes = await Promise.allSettled([
    commitSceneCandidate(race.boardId, left.commitId, actor),
    commitSceneCandidate(race.boardId, right.commitId, actor),
  ])
  assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(writes.find((result) => result.status === 'rejected').reason.code, 'aborted')
  const winner = writes.findIndex((result) => result.status === 'fulfilled'),
    winningId = [left, right][winner].commitId,
    receipt = writes[winner].value
  assert.deepEqual(await commitSceneCandidate(race.boardId, winningId, actor), receipt)
  const later = await stage(
    race.boardId,
    (await db.doc(`boardScenes/${race.boardId}`).get()).data(),
    scene('later'),
    'later',
  )
  await commitSceneCandidate(race.boardId, later.commitId, actor)
  assert.deepEqual(await commitSceneCandidate(race.boardId, winningId, actor), receipt)
  assert.equal((await db.doc(`boardScenes/${race.boardId}`).get()).data().headRevisionId, later.commitId)
  passed.push('one-winner expected-head race and old receipt replay preserve newer head')

  // Exact-record cleanup tested with deterministic replacement between capture and removal.
  const values = { unchanged: { version: 1 }, replaced: { version: 2 }, new: { version: 3 } }
  let connected = false
  const elementsRef = {
    child: (key) => ({
      transaction: async (callback) => {
        const value = callback(values[key])
        if (value === null) delete values[key]
      },
    }),
  }
  const presenceRef = { get: async () => ({ exists: () => connected }) }
  await pruneCheckpointedRecords(elementsRef, presenceRef, { unchanged: { version: 1 }, replaced: { version: 1 } })
  assert.deepEqual(values, { replaced: { version: 2 }, new: { version: 3 } })
  connected = true
  await pruneCheckpointedRecords(elementsRef, presenceRef, { replaced: { version: 2 } })
  assert.equal(values.replaced.version, 2)
  connected = false
  const observedRecords = { exact: { data: 'scene', version: 1, id: 'x' }, newer: { id: 'y', version: 2, data: 'new' } }
  const coldRef = {
    child: (key) => ({
      transaction: async (callback) => {
        assert.equal(callback(null), null, 'cold cache must perform a server compare-and-set rather than abort')
        const value = callback(observedRecords[key])
        if (value === null) delete observedRecords[key]
      },
    }),
  }
  await pruneCheckpointedRecords(coldRef, presenceRef, {
    exact: { id: 'x', version: 1, data: 'scene' },
    newer: { id: 'y', version: 1, data: 'old' },
  })
  assert.deepEqual(observedRecords, { newer: { id: 'y', version: 2, data: 'new' } })
  passed.push('exact-record cleanup retains replacement/new record and reconnect state')
  console.log(JSON.stringify({ passed }, null, 2))
} finally {
  const artifactDirectory = process.env.E2E_ARTIFACT_DIR || '.system_generated/scene-backend'
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(`${artifactDirectory}/server-integrity.json`, JSON.stringify({ passed }, null, 2))
  await Promise.all([db.terminate(), adminApp.delete()])
}
