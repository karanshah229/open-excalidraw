import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const { createServer } = await import(require.resolve('vite'))
const server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
await server.listen()
let browser
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  const page = await browser.newPage()
  await page.goto(new URL('README.md', server.resolvedUrls.local[0]).href, { waitUntil: 'domcontentloaded' })
  const results = await page.evaluate(async () => {
    const { BoardHistoryStore } = await import('/packages/storage/src/board-history.ts')
    let assertions = 0
    const equal = (actual, expected, label) => {
      assertions++
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
    }
    const rejects = async (run, message) => {
      assertions++
      try { await run() } catch (error) {
        if (String(error).includes(message)) return
        throw error
      }
      throw new Error(`Expected ${message}`)
    }
    let time = Date.parse('2026-10-11T00:00:00Z')
    const db = `history-tests-${crypto.randomUUID()}`
    const store = new BoardHistoryStore({ databaseName: db, clock: () => time })
    const blank = (id = crypto.randomUUID()) => ({
      id, projectId: 'project', name: 'Initial', active: true,
      createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString(),
      syncStatus: 'local-only', revision: 0, baseRevision: 0,
      syncAttempts: 0, nextSyncAt: null, lastSyncError: null,
      formatVersion: 1, scene: { elements: [], appState: { viewBackgroundColor: 'transparent' }, files: {} },
    })
    const first = await store.initialize(blank(), { slide: 'Original note' })
    equal(first.document.revision, 0, 'seed preserves revision')
    const second = await store.save({ ...first.document, name: 'Second', scene: {
      ...first.document.scene, elements: [{ id: 'rectangle', version: 1, versionNonce: 5 }],
    } })
    equal(second.document.revision, 1, 'save advances local token once')
    equal(second.notes, { slide: 'Original note' }, 'scene save preserves committed notes')
    equal((await store.list(first.document.id)).length, 2, 'every changed save captured')
    await store.save(second.document)
    equal((await store.list(first.document.id)).length, 2, 'unchanged save no-op')
    await store.reconcileDocument({ ...second.document, projectId: 'current-project', baseRevision: 1,
      syncAttempts: 3, nextSyncAt: 'current-schedule', lastSyncError: 'current-error' })
    time += 1000
    const restored = await store.restoreLocal(first.document.id, first.version.localVersionId)
    equal(restored.document.name, 'Initial', 'restore name')
    equal(restored.document.scene.elements, [], 'restore full scene, not merge')
    equal(restored.notes, { slide: 'Original note' }, 'restore notes')
    equal(restored.document.projectId, 'current-project', 'restore preserves current project identity')
    equal([restored.document.baseRevision, restored.document.syncAttempts, restored.document.nextSyncAt, restored.document.lastSyncError],
      [1, 3, 'current-schedule', 'current-error'], 'restore preserves current metadata instead of historical metadata')
    equal(restored.document.updatedAt, new Date(time).toISOString(), 'restore refreshes current update time')
    equal((await store.list(first.document.id)).map((version) => version.localVersionId).includes(second.version.localVersionId), false, 'descendant hidden')
    equal(await store.get(first.document.id, second.version.localVersionId), null, 'hidden descendant unreadable')
    equal((await store.list(first.document.id)).length, 2, 'target ancestry survives')
    await rejects(() => store.restoreLocal(first.document.id, restored.version.localVersionId), 'BOARD_VERSION_IS_CURRENT')

    const originalOutbox = (await store.listOutbox(first.document.id)).find((entry) => entry.localVersionId === restored.version.localVersionId)
    await store.setRestoreFence(first.document.id, 8, true)
    await rejects(() => store.save(restored.document), 'BOARD_RESTORE_IN_PROGRESS')
    await store.setRestoreFence(first.document.id, 8, false)
    equal((await store.listOutbox(first.document.id)).find((entry) => entry.localVersionId === restored.version.localVersionId).headMutationId,
      originalOutbox.headMutationId, 'failed restore preserves unresolved mutation identity')
    await rejects(() => store.save(restored.document, { expectedFence: 1 }), 'BOARD_RESTORE_FENCE_CONFLICT')
    await store.reauthorizeOutbox(first.document.id, restored.version.localVersionId, {
      expectedFence: 8, resolvedHeadMutationId: originalOutbox.headMutationId,
    })

    const receipt = { localSnapshotVersionId: 'cloud-history', acceptedAt: new Date(time).toISOString(), expiresAt: new Date(time + 30 * 86400000).toISOString() }
    await store.acknowledge(first.document.id, restored.version.localVersionId, receipt)
    equal((await store.listOutbox(first.document.id)).some((entry) => entry.localVersionId === restored.version.localVersionId), true, 'history ACK does not discard pending head')
    await store.acknowledge(first.document.id, restored.version.localVersionId, receipt)
    await rejects(() => store.acknowledge(first.document.id, restored.version.localVersionId, { ...receipt, localSnapshotVersionId: 'another' }), 'HISTORY_RECEIPT_CONFLICT')
    await store.acknowledgeHead(first.document.id, restored.version.localVersionId)
    equal((await store.listOutbox(first.document.id)).some((entry) => entry.localVersionId === restored.version.localVersionId), false, 'head and history both acknowledged')

    const noteBoard = await store.initialize(blank())
    await store.saveNotes(noteBoard.document.id, { a: 'A' }, { changedFields: { notes: ['a'] } })
    await store.saveNotes(noteBoard.document.id, { b: 'B' }, { changedFields: { notes: ['b'] } })
    equal((await store.getCommittedContent(noteBoard.document.id)).notes, { a: 'A', b: 'B' }, 'per-slide intent preserves unrelated note')
    const noteHistory = (await store.list(noteBoard.document.id))[0]
    const pendingNote = (await store.listOutbox(noteBoard.document.id)).find((entry) => entry.changedFields.notes?.includes('b'))
    await store.rebaseNoteIntent(noteBoard.document.id, 'b', 7)
    const rebasedNote = (await store.listOutbox(noteBoard.document.id)).find((entry) => entry.changedFields.notes?.includes('b'))
    equal(rebasedNote.fieldBases.notes.b, 7, 'explicit keep-local refreshes only note CAS base')
    equal(rebasedNote.captureMutationId, pendingNote.captureMutationId, 'note keep-local preserves capture identity')
    await store.acceptRemoteNote(noteBoard.document.id, 'a', 'Remote A')
    equal((await store.getCommittedContent(noteBoard.document.id)).notes.a, 'Remote A', 'use remote updates committed current note')
    const selectedRemote = await store.getCommittedContent(noteBoard.document.id)
    const currentRemoteVersion = await store.get(noteBoard.document.id, selectedRemote.version.localVersionId)
    equal(currentRemoteVersion.notes, selectedRemote.notes, 'use remote current badge identifies exact immutable current tuple')
    equal(currentRemoteVersion.version.contentDigest, selectedRemote.version.contentDigest, 'use remote current version digest matches its payload')
    equal((await store.listOutbox(noteBoard.document.id)).find((entry) => entry.localVersionId === selectedRemote.version.localVersionId).changedFields,
      {}, 'remote selection snapshot creates no cloud note overwrite intent')
    equal((await store.get(noteBoard.document.id, noteHistory.localVersionId)).notes.a, 'A', 'use remote preserves original historical snapshot')
    equal((await store.listOutbox(noteBoard.document.id)).some((entry) => !entry.headAcknowledged && entry.changedFields.notes?.includes('a')), false, 'use remote retires pending slide intent')
    equal((await store.listOutbox(noteBoard.document.id)).some((entry) => !entry.headAcknowledged && entry.changedFields.notes?.includes('b')), true, 'use remote preserves unrelated slide intent')

    const rolloutBoard = await store.initialize(blank())
    const rolloutSave = await store.save({ ...rolloutBoard.document, name: 'Before rollout' })
    for (const entry of await store.listOutbox(rolloutBoard.document.id))
      await store.acknowledgeLegacyFields(rolloutBoard.document.id, entry.localVersionId, { scene: true, name: true, notes: [] })
    const rolloutCurrent = await store.getCommittedContent(rolloutBoard.document.id)
    // Reproduce the faulty order: hydration populated current metadata without
    // binding immutable captures retained by the legacy head-only ACK.
    await store.reconcileDocument({ ...rolloutCurrent.document, syncStatus: 'synced', cloudGeneration: 1,
      cloudRevisionId: 'legacy-r1', cloudVersionId: 'migration-current', cloudRestoreFence: 0 })
    await store.markOutboxBlocked(rolloutBoard.document.id, rolloutSave.version.localVersionId, 'no validated cloud history base')
    const rolloutBefore = await store.listOutbox(rolloutBoard.document.id)
    await store.repairLegacyCloudLineage(rolloutBoard.document.id, { generation: 1, restoreFence: 0, currentVersionId: 'migration-current' })
    const rolloutAfter = await store.listOutbox(rolloutBoard.document.id)
    equal(rolloutAfter.map((entry) => entry.captureMutationId), rolloutBefore.map((entry) => entry.captureMutationId), 'rollout repair preserves stable capture identities')
    equal(rolloutAfter.every((entry) => entry.sourceBaseVersionId === 'migration-current' && entry.headAcknowledged && !entry.receipt), true, 'already-hydrated legacy captures acquire a cloud base without fake receipts or new head intents')
    equal(rolloutAfter.every((entry) => entry.retryState === 'pending' && !entry.lastError), true, 'rollout repair retries only repaired ancestry blocks')
    await rejects(() => store.repairLegacyCloudLineage(rolloutBoard.document.id, { generation: 2, restoreFence: 0, currentVersionId: 'restored-current' }), 'BOARD_GENERATION_CONFLICT')
    await rejects(() => store.repairLegacyCloudLineage(rolloutBoard.document.id, { generation: 1, restoreFence: 1, currentVersionId: 'restored-current' }), 'BOARD_RESTORE_FENCE_CONFLICT')

    const protectedRollout = await store.initialize({ ...blank(), cloudGeneration: 1 })
    const stagedRollout = await store.save({ ...protectedRollout.document, name: 'Staged original' })
    const receiptRollout = await store.save({ ...stagedRollout.document, name: 'Accepted original' })
    const publication = { sourceBaseVersionId: 'original-base', parentVersionId: 'original-base',
      localBranchId: 'stable-branch', branchSequence: 1, commitId: 'stable-stage' }
    await store.prepareImport(protectedRollout.document.id, stagedRollout.version.localVersionId, publication)
    const protectedReceipt = { localSnapshotVersionId: 'accepted-cloud', acceptedAt: new Date(time).toISOString(), expiresAt: new Date(time + 86400000).toISOString() }
    await store.acknowledge(protectedRollout.document.id, receiptRollout.version.localVersionId, protectedReceipt)
    await rejects(() => store.repairLegacyCloudLineage(protectedRollout.document.id, { generation: 2, restoreFence: 0, currentVersionId: 'wrong-generation' }), 'BOARD_GENERATION_CONFLICT')
    await store.reconcileDocument({ ...(await store.getCommittedContent(protectedRollout.document.id)).document,
      cloudVersionId: 'migration-protected', cloudRestoreFence: 0 })
    await store.repairLegacyCloudLineage(protectedRollout.document.id, { generation: 1, restoreFence: 0, currentVersionId: 'migration-protected' })
    const protectedEntries = await store.listOutbox(protectedRollout.document.id)
    equal(protectedEntries.find((entry) => entry.localVersionId === stagedRollout.version.localVersionId).importPublication, publication, 'rollout repair never changes persisted staging identity or ancestry')
    equal(protectedEntries.find((entry) => entry.localVersionId === stagedRollout.version.localVersionId).sourceBaseVersionId, undefined, 'staged capture missing base is not silently rebound')
    equal((await store.get(protectedRollout.document.id, receiptRollout.version.localVersionId)).version.receipt, protectedReceipt, 'rollout repair never changes accepted capture receipt')
    equal(protectedEntries.find((entry) => entry.localVersionId === protectedRollout.version.localVersionId).sourceBaseVersionId, 'migration-protected', 'eligible unproven legacy ancestor is repaired independently')

    const staleCaptureBoard = await store.initialize({ ...blank(), cloudGeneration: 1 })
    await store.acknowledgeLegacyFields(staleCaptureBoard.document.id, staleCaptureBoard.version.localVersionId, { scene: true, name: true })
    await store.reconcileDocument({ ...(await store.getCommittedContent(staleCaptureBoard.document.id)).document, cloudGeneration: 2 }, { allowLegacyGenerationAdvance: true })
    await rejects(() => store.repairLegacyCloudLineage(staleCaptureBoard.document.id, { generation: 2, restoreFence: 0, currentVersionId: 'new-generation-baseline' }), 'BOARD_GENERATION_CONFLICT')
    equal((await store.listOutbox(staleCaptureBoard.document.id))[0].generation, 1, 'repair cannot rebase old cloud-generation capture even when current metadata advanced')
    equal((await store.get(staleCaptureBoard.document.id, staleCaptureBoard.version.localVersionId)).version.generation, 1, 'failed lineage repair rolls back immutable version metadata too')

    const staleRenameBoard = await store.initialize(blank(), { slide: 'Initial rename note' })
    await store.save({ ...staleRenameBoard.document, scene: { ...staleRenameBoard.document.scene,
      elements: [{ id: 'newer-scene', version: 1, versionNonce: 1 }] } }, { notes: { slide: 'Newer rename note' } })
    const staleRename = await store.save({ ...staleRenameBoard.document, name: 'Explicit stale rename' }, {
      reason: 'rename', changedFields: { name: true }, fieldBases: { nameRevision: 0 },
    })
    equal(staleRename.document.name, 'Explicit stale rename', 'explicit rename survives concurrent local revision advance')
    equal(staleRename.document.scene.elements.map((element) => element.id), ['newer-scene'], 'explicit stale rename retains newer scene content')
    equal(staleRename.notes.slide, 'Newer rename note', 'explicit stale rename retains newer native notes')
    equal((await store.listOutbox(staleRenameBoard.document.id)).find((entry) => entry.localVersionId === staleRename.version.localVersionId).changedFields, { name: true }, 'explicit stale rename retains its exact head field intent')
    const implicitStale = await store.save(staleRenameBoard.document)
    equal(implicitStale.document.name, 'Explicit stale rename', 'implicit stale save still cannot overwrite a newer name')

    const legacyBoard = await store.initialize(blank())
    const legacyNote = await store.saveNotes(legacyBoard.document.id, { a: 'Legacy local note' },
      { changedFields: { notes: ['a'] }, fieldBases: { notes: { a: 0 } } })
    await store.acknowledgeLegacyFields(legacyBoard.document.id, legacyNote.version.localVersionId, { scene: true })
    let legacyPending = (await store.listOutbox(legacyBoard.document.id)).find((entry) => entry.localVersionId === legacyNote.version.localVersionId)
    equal(legacyPending.headAcknowledged ?? false, false, 'legacy scene ACK cannot falsely acknowledge notes')
    await store.acknowledgeLegacyFields(legacyBoard.document.id, legacyNote.version.localVersionId, { notes: ['a'] })
    legacyPending = (await store.listOutbox(legacyBoard.document.id)).find((entry) => entry.localVersionId === legacyNote.version.localVersionId)
    equal(legacyPending.headAcknowledged, true, 'legacy completed fields ACK current head only')
    equal(legacyPending.receipt, undefined, 'legacy head ACK never fabricates a capture receipt')
    equal((await store.get(legacyBoard.document.id, legacyNote.version.localVersionId)).version.uploadStatus, 'pending', 'legacy immutable capture remains unpublished')
    const legacyCurrent = await store.getCommittedContent(legacyBoard.document.id)
    await store.reconcileDocument({ ...legacyCurrent.document, cloudRevisionId: 'legacy-scene-revision', syncStatus: 'synced' })
    const knownLegacy = await store.getCommittedContent(legacyBoard.document.id)
    await rejects(() => store.reconcileDocument({ ...knownLegacy.document, cloudGeneration: 2 }, { allowLegacyGenerationAdvance: true }), 'BOARD_GENERATION_CONFLICT')
    await store.acknowledgeLegacyFields(legacyBoard.document.id, legacyBoard.version.localVersionId, { scene: true, name: true })
    const beforeLegacyAdvance = (await store.listOutbox(legacyBoard.document.id)).length
    await store.reconcileDocument({ ...knownLegacy.document, cloudGeneration: 2, scene: { ...knownLegacy.document.scene, elements: [{ id: 'new-legacy-generation' }] } },
      { allowLegacyGenerationAdvance: true })
    equal((await store.getCommittedContent(legacyBoard.document.id)).document.cloudGeneration, 2, 'clean legacy generation can hydrate')
    equal((await store.listOutbox(legacyBoard.document.id)).length, beforeLegacyAdvance, 'clean legacy replacement retains historical capture obligations')
    equal((await store.getCommittedContent(legacyBoard.document.id)).notes.a, 'Legacy local note', 'legacy generation hydration preserves known notes')
    await store.bindCloudLineage(legacyBoard.document.id, { generation: 3, restoreFence: 6, currentVersionId: 'migration-baseline', cloudRevisionId: 'legacy-scene-revision' })
    equal((await store.listOutbox(legacyBoard.document.id)).every((entry) => entry.sourceBaseVersionId === 'migration-baseline' && entry.generation === 3), true,
      'migration binds retained legacy captures despite existing scene revision')

    // Failure occurs after version/payload writes, so rollback proves the atomic
    // transaction boundary rather than testing an early validation exception.
    const beforeFailure = await store.getCommittedContent(noteBoard.document.id)
    const beforeCount = (await store.list(noteBoard.document.id)).length
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'outbox') throw new DOMException('Injected quota exhaustion', 'QuotaExceededError')
      return add.apply(this, args)
    }
    try {
      await rejects(() => store.save({ ...beforeFailure.document, name: 'Must roll back' }), 'QuotaExceededError')
    } finally { IDBObjectStore.prototype.add = add }
    equal((await store.getCommittedContent(noteBoard.document.id)).document.name, beforeFailure.document.name, 'quota rollback current')
    equal((await store.list(noteBoard.document.id)).length, beforeCount, 'quota rollback history')

    const raceBoard = await store.initialize(blank())
    const secondStore = new BoardHistoryStore({ databaseName: db, clock: () => time })
    await Promise.all([
      store.save({ ...raceBoard.document, scene: { ...raceBoard.document.scene, elements: [{ id: 'A', version: 1, versionNonce: 1 }] } }),
      secondStore.save({ ...raceBoard.document, scene: { ...raceBoard.document.scene, elements: [{ id: 'B', version: 1, versionNonce: 1 }] } }),
    ])
    equal((await store.getCommittedContent(raceBoard.document.id)).document.scene.elements.map((element) => element.id).sort(), ['A', 'B'], 'concurrent stores preserve both edits')
    equal((await store.list(raceBoard.document.id)).length, 3, 'concurrent changed commits each versioned')
    await secondStore.close()

    const hydratedCloud = await store.initialize({ ...blank(), cloudRevisionId: 'REMOTE-R1', cloudGeneration: 1, syncStatus: 'synced' }, { existing: 'Protected note' })
    equal(await store.listOutbox(hydratedCloud.document.id), [], 'mere remote hydration creates no pending save')
    equal(hydratedCloud.document.syncStatus, 'synced', 'mirror baseline stays acknowledged')
    const claimBoard = await store.initialize(blank())
    const claimEdit = await store.save({ ...claimBoard.document, name: 'Before local restore' })
    const claimRestored = await store.restoreLocal(claimBoard.document.id, claimBoard.version.localVersionId)
    equal(claimRestored.document.cloudGeneration, undefined, 'locally restored board has no authoritative cloud generation')
    equal(claimRestored.version.generation, 2, 'never-cloud local restore advances its independent generation')
    await store.repairLegacyCloudLineage(claimBoard.document.id, { generation: 1, restoreFence: 0, currentVersionId: 'Cloud-base', cloudRevisionId: 'Cloud-R1' })
    equal((await store.getCommittedContent(claimBoard.document.id)).document.cloudGeneration, 1, 'repair API binds arbitrary never-cloud local generation to first cloud generation')
    equal((await store.listOutbox(claimBoard.document.id)).every((entry) => entry.generation === 1), true, 'claim explicitly remaps local generation after local restore')
    equal((await store.get(claimBoard.document.id, claimRestored.version.localVersionId)).version.localGeneration, 2, 'claim preserves original local generation provenance')
    equal(await store.get(claimBoard.document.id, claimEdit.version.localVersionId), null, 'claim does not revive abandoned local universe')
    const cloudBoard = await store.initialize({ ...blank(), cloudRevisionId: 'R1', cloudGeneration: 1 })
    const unsynced = await store.save({ ...cloudBoard.document, name: 'Pending' })
    const replaced = await store.applyCloudRestore({ ...cloudBoard.document, name: 'Cloud restored', cloudRevisionId: 'R2', cloudGeneration: 2, syncStatus: 'synced' }, { notes: {}, restoreFence: 2, currentVersionId: 'V2' })
    equal(replaced.document.name, 'Cloud restored', 'cloud restore complete replacement')
    equal(await store.get(cloudBoard.document.id, unsynced.version.localVersionId), null, 'unsynced history discarded after cloud replacement')
    equal(await store.listOutbox(cloudBoard.document.id), [], 'old-generation outbox discarded')
    await rejects(() => store.save(unsynced.document), 'BOARD_GENERATION_CONFLICT')
    await rejects(() => store.restoreLocal(cloudBoard.document.id, replaced.version.localVersionId), 'LOCAL_RESTORE_UNAVAILABLE')

    time += 31 * 86400000
    const pruned = await store.prune()
    if (!(pruned.versions > 0 && pruned.payloads > 0)) throw new Error('GC did not reclaim expired exclusive bytes')
    equal((await store.list(raceBoard.document.id)).length, 1, 'expired current remains separately readable')
    equal((await store.get(raceBoard.document.id, (await store.getCommittedContent(raceBoard.document.id)).version.localVersionId)).document.scene.elements.length, 2, 'shared/current payload protected')

    await store.claimLocalBoards([raceBoard.document.id], 'owner')
    let account = 'owner'
    const accountStore = new BoardHistoryStore({ databaseName: db, identity: () => account, clock: () => time })
    equal((await accountStore.getCommittedContent(raceBoard.document.id)).document.scene.elements.length, 2, 'claim preserves same board content')
    account = 'other-owner'
    equal(await accountStore.getCommittedContent(raceBoard.document.id), null, 'account boundary isolates ledger')
    await accountStore.close()
    await store.close()
    const { RxDbWorkspaceStore, boardHistoryStore, setWorkspaceIdentity } = await import('/packages/storage/src/index.ts')
    setWorkspaceIdentity(null)
    const workspace = new RxDbWorkspaceStore()
    const project = await workspace.createProject('Native authoritative projection', 'local-user')
    const initialWorkspaceBoard = await workspace.createBoard(project.id, 'Local name')
    const projection = workspace.projectCommittedBoard
    workspace.projectCommittedBoard = async () => { throw new Error('Injected projection failure') }
    const savedWorkspaceBoard = await workspace.saveBoard({ ...initialWorkspaceBoard, name: 'Durably saved name' })
    equal(savedWorkspaceBoard.name, 'Durably saved name', 'projection failure cannot fail successful authoritative save')
    equal((await workspace.listBoards(project.id))[0].name, 'Durably saved name', 'list reads authoritative current when projection failed')
    workspace.projectCommittedBoard = projection
    equal((await workspace.loadBoard(initialWorkspaceBoard.id)).name, 'Durably saved name', 'load repairs projection')
    for (const entry of await boardHistoryStore.listOutbox(initialWorkspaceBoard.id)) await boardHistoryStore.acknowledgeHead(initialWorkspaceBoard.id, entry.localVersionId)
    await workspace.acknowledgeBoardScene(initialWorkspaceBoard.id, savedWorkspaceBoard.revision, savedWorkspaceBoard.scene,
      'metadata-ack-R1', 1, { expectedCloudRevisionId: undefined, cloudBoardName: 'Canonical name', cloudVersionId: 'metadata-ack-V1', cloudNameRevision: 2 })
    equal((await workspace.loadBoard(initialWorkspaceBoard.id)).name, 'Canonical name', 'canonical ACK refreshes stale name after head intent retired')
    const earlier = await workspace.loadBoard(initialWorkspaceBoard.id)
    await workspace.saveBoard({ ...earlier, name: 'New unsynced rename' })
    await workspace.acknowledgeBoardScene(initialWorkspaceBoard.id, earlier.revision, earlier.scene,
      'metadata-ack-R2', 1, { expectedCloudRevisionId: 'metadata-ack-R1', cloudBoardName: 'Older network name' })
    equal((await workspace.loadBoard(initialWorkspaceBoard.id)).name, 'New unsynced rename', 'late canonical ACK preserves newer rename')
    return { passed: assertions, database: db }
  })
  assert.ok(results.passed >= 33)
  console.log(`PASS local history: ${results.passed} assertions, real IndexedDB atomic rollback/concurrent writers/lineage/fences/ACKs/GC/identity`)
} finally {
  await browser?.close()
  await server.close()
}
