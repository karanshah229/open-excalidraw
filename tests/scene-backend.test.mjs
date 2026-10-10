/** Independent server integrity probes; only the disposable regression emulators. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Backend scene tests require isolated demo-regression emulators.')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, Timestamp } = require('firebase-admin/firestore')
initializeApp({ projectId: 'demo-regression' })
const { ensureScene, commitSceneCandidate, loadSceneRevision } = await import('../functions/lib/board-scenes.js')
const { packScene, manifestDigest, paginateReferences } = await import('../functions/lib/scene-codec.js')
const { pruneCheckpointedRecords } = await import('../functions/lib/scene-compaction-cleanup.js')
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
async function stage(boardId, head, payload, suffix) {
  const commitId = `${prefix}_commit_${suffix}`,
    root = `boardScenes/${boardId}`
  const chunks = (await packScene(payload)).map((chunk, slot) => ({ ...chunk, chunkId: `${commitId}_${pageId(slot)}` }))
  const references = chunks.map(({ chunkId, digest }) => ({ chunkId, digest })),
    pages = paginateReferences(references),
    now = Timestamp.now()
  await db.doc(`${root}/uploads/${commitId}`).create({
    uploaderUid: actor.uid,
    expectedHeadRevisionId: head.headRevisionId,
    generation: head.generation,
    sceneFormatVersion: 1,
    pageCount: pages.length,
    chunkCount: chunks.length,
    newChunkCount: chunks.length,
    candidateDigest: await manifestDigest(references, head.generation),
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
  await db.terminate()
}
