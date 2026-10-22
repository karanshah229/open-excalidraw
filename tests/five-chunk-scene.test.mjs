/** Exact five-chunk save/edit/cold-render regression on disposable emulators. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Requires isolated demo-regression emulators.')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { manifestDigest } = await import('../functions/lib/scene-codec.js')
const app = initializeApp({ projectId: 'demo-regression' })
const db = getFirestore(app)
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const artifacts = process.env.E2E_ARTIFACT_DIR || '.system_generated/regression/five-chunk-scene'
await mkdir(artifacts, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const calls = [],
  results = []
let fixture, diagnosticOwner
async function pageIn(context) {
  const page = await context.newPage()
  page.setDefaultTimeout(60000)
  await page.setViewport({ width: 1440, height: 900 })
  page.on('dialog', (dialog) => dialog.accept())
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes(':45001/')) {
      const data = JSON.parse(request.postData() || '{}').data
      calls.push({ endpoint: request.url().split('/').pop(), data })
    }
  })
  return page
}
async function eventually(read, message) {
  const until = Date.now() + 60000
  while (Date.now() < until) {
    const result = await read()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(message)
}
async function hasDurableFixtureElements(id) {
  const head = (await db.doc(`boardScenes/${id}`).get()).data()
  if (!head?.headRevisionId) return false
  const revision = (await db.doc(`boardScenes/${id}/revisions/${head.headRevisionId}`).get()).data()
  if (!revision) return false
  const records = []
  for (let i = 0; i < revision.pageCount; i++) {
    const page = (
      await db.doc(`boardScenes/${id}/revisions/${head.headRevisionId}/pages/${String(i).padStart(6, '0')}`).get()
    ).data()
    if (!page) return false
    for (const reference of page.references) {
      const chunk = (await db.doc(`boardScenes/${id}/chunks/${reference.chunkId}`).get()).data()
      if (!chunk) return false
      records.push(...JSON.parse(chunk.payload))
    }
  }
  const elements = records.filter((record) => record.kind === 'element')
  return elements.length === 20 && new Set(elements.map((record) => record.value?.id)).size === 20
}
// Independent record/hash oracle: never uses the application's scene codec.
async function durable(id) {
  const head = (await db.doc(`boardScenes/${id}`).get()).data()
  assert(head?.headRevisionId)
  const revision = (await db.doc(`boardScenes/${id}/revisions/${head.headRevisionId}`).get()).data()
  const refs = []
  for (let i = 0; i < revision.pageCount; i++) {
    const page = (
      await db.doc(`boardScenes/${id}/revisions/${head.headRevisionId}/pages/${String(i).padStart(6, '0')}`).get()
    ).data()
    assert(page)
    refs.push(...page.references)
  }
  assert.equal(refs.length, revision.chunkCount)
  assert.equal(new Set(refs.map((ref) => ref.chunkId)).size, refs.length)
  const records = []
  let bytes = 0
  for (const ref of refs) {
    const chunk = (await db.doc(`boardScenes/${id}/chunks/${ref.chunkId}`).get()).data()
    assert(chunk)
    assert.equal(createHash('sha256').update(chunk.payload).digest('hex'), ref.digest)
    assert.equal(chunk.digest, ref.digest)
    assert(Buffer.byteLength(chunk.payload) + 4096 <= 512 * 1024)
    bytes += Buffer.byteLength(chunk.payload)
    records.push(...JSON.parse(chunk.payload))
  }
  assert.equal(new Set(records.map((record) => record.key)).size, records.length)
  const elements = records.filter((record) => record.kind === 'element').sort((a, b) => a.order - b.order)
  assert.equal(elements.length, 20, `Expected 20 durable elements, found ${elements.length}; record sample: ${JSON.stringify(records.slice(0, 12).map((record) => ({ kind: record.kind, key: record.key, order: record.order, valueKeys: Object.keys(record.value ?? {}), id: record.value?.id })))}`)
  assert.deepEqual(
    elements.map((record) => record.order),
    elements.map((_, i) => i),
  )
  for (let i = 0; i < 20; i++) {
    assert.equal(elements[i].value.id, `five-${i}`)
    assert.equal(elements[i].value.customData.payload, `${i}:` + '🌍'.repeat(24000))
  }
  return { head: head.headRevisionId, refs, elements: elements.map((record) => record.value), bytes }
}
async function rawRecords(id) {
  const head = (await db.doc(`boardScenes/${id}`).get()).data()
  const revision = (await db.doc(`boardScenes/${id}/revisions/${head.headRevisionId}`).get()).data()
  const records = []
  for (let pageIndex = 0; pageIndex < revision.pageCount; pageIndex++) {
    const page = (
      await db
        .doc(`boardScenes/${id}/revisions/${head.headRevisionId}/pages/${String(pageIndex).padStart(6, '0')}`)
        .get()
    ).data()
    for (const reference of page.references) {
      const chunk = (await db.doc(`boardScenes/${id}/chunks/${reference.chunkId}`).get()).data()
      records.push(...JSON.parse(chunk.payload))
    }
  }
  return records.sort((left, right) => left.key.localeCompare(right.key)).map((record) => JSON.stringify(record))
}
async function forceFragmentedLayout(id) {
  const root = `boardScenes/${id}`
  const headRef = db.doc(root),
    head = (await headRef.get()).data()
  const revision = (await db.doc(`${root}/revisions/${head.headRevisionId}`).get()).data()
  const records = []
  for (let pageIndex = 0; pageIndex < revision.pageCount; pageIndex++) {
    const page = (
      await db.doc(`${root}/revisions/${head.headRevisionId}/pages/${String(pageIndex).padStart(6, '0')}`).get()
    ).data()
    for (const reference of page.references) {
      const chunk = (await db.doc(`${root}/chunks/${reference.chunkId}`).get()).data()
      records.push(...JSON.parse(chunk.payload))
    }
  }
  const revisionId = `e2e_fragment_${randomUUID().replaceAll('-', '')}`
  const references = []
  for (const [slot, record] of records.entries()) {
    const payload = JSON.stringify([record])
    const digest = createHash('sha256').update(payload).digest('hex')
    const chunkId = `${revisionId}_${String(slot).padStart(6, '0')}`
    references.push({ chunkId, digest })
    await db.doc(`${root}/chunks/${chunkId}`).create({
      payload,
      digest,
      uploadId: revisionId,
      slot,
      uploaderUid: fixture.ownerUid,
      generation: head.generation,
      kind: 'records',
    })
  }
  const pages = Array.from({ length: Math.ceil(references.length / 100) }, (_, index) =>
    references.slice(index * 100, (index + 1) * 100),
  )
  for (const [index, page] of pages.entries())
    await db.doc(`${root}/revisions/${revisionId}/pages/${String(index).padStart(6, '0')}`).create({ references: page })
  await db.doc(`${root}/revisions/${revisionId}`).create({
    generation: head.generation,
    sceneFormatVersion: revision.sceneFormatVersion,
    sceneProtocolVersion: revision.sceneProtocolVersion,
    pageCount: pages.length,
    chunkCount: references.length,
    candidateDigest: await manifestDigest(references, head.generation),
    parentRevisionId: head.headRevisionId,
    createdAt: new Date().toISOString(),
    reason: 'e2e-fragmentation-fixture',
  })
  await headRef.update({ headRevisionId: revisionId, updatedAt: new Date().toISOString() })
  return { revisionId, chunkCount: references.length }
}
try {
  const owner = await pageIn(await browser.createBrowserContext())
  await owner.goto(base)
  fixture = await owner.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    const { workspaceApi, workspaceStore } = await import('/src/features/workspace/workspace-api.ts')
    const { convertToExcalidrawElements } = await import('/tests/frame-reload-fixture.ts')
    await signInOwner(getFirebaseAuth())
    const project = await workspaceApi.createProject('Five chunk E2E')
    const board = await workspaceApi.createBoard(project.id, 'Exactly five chunks')
    // Let the queued empty-board registration finish before racing it with the
    // large content save. This keeps the fixture focused on chunk persistence.
    await workspaceApi.flushCloud()
    const currentBoard = await workspaceStore.loadBoard(board.id)
    if (!currentBoard) throw new Error('Created board was not available locally.')
    const scene = {
      elements: convertToExcalidrawElements(
        Array.from({ length: 20 }, (_, i) => ({
          id: `five-${i}`,
          type: 'rectangle',
          x: (i % 8) * 70,
          y: Math.floor(i / 8) * 70,
          width: 40,
          height: 40,
          customData: { payload: `${i}:` + '🌍'.repeat(24000) },
        })),
        { regenerateIds: false },
      ),
      appState: { viewBackgroundColor: '#ffffff' },
    }
    await workspaceApi.saveBoard({ ...currentBoard, scene })
    await workspaceApi.flushCloud()
    const savedBoard = await workspaceStore.loadBoard(board.id)
    if (savedBoard?.scene.elements.length !== 20)
      throw new Error(`Large scene save was not durable locally: ${savedBoard?.scene.elements.length ?? 'missing'} elements.`)
    return {
      id: board.id,
      ownerUid: getFirebaseAuth().currentUser.uid,
      bytes: new TextEncoder().encode(JSON.stringify(scene)).length,
      localSyncStatus: savedBoard.syncStatus,
      localSyncError: savedBoard.lastSyncError,
      localSceneElementCount: savedBoard.scene.elements.length,
    }
  })
  diagnosticOwner = owner
  await eventually(
    () => hasDurableFixtureElements(fixture.id),
    'Timed out waiting for all 20 fixture elements to reach the committed board head.',
  )
  const initial = await durable(fixture.id)
  assert.equal(initial.refs.length, 5, 'Fixture must publish exactly five chunks')
  assert(fixture.bytes > 1024 * 1024)
  await owner.goto(`${base}/boards/${fixture.id}`)
  await owner.bringToFront()
  await owner.waitForFunction(() => window.__excalidrawAPI?.getSceneElements().length === 20, { polling: 100 })
  // Persist the rendered import normalization before measuring a native edit.
  await owner.evaluate(async (id) => {
    const { workspaceApi, workspaceStore } = await import('/src/features/workspace/workspace-api.ts')
    const local = await workspaceStore.loadBoard(id)
    await workspaceApi.saveBoard({
      ...local,
      scene: { ...local.scene, elements: window.__excalidrawAPI.getSceneElementsIncludingDeleted() },
    })
    await workspaceApi.flushCloud()
  }, fixture.id)
  // Wait for normal first-mount normalization to reach the durable base before measuring reuse.
  await owner.waitForFunction(
    async (id) => {
      const { workspaceApi, workspaceStore } = await import('/src/features/workspace/workspace-api.ts')
      await workspaceApi.flushCloud()
      const local = await workspaceStore.loadBoard(id)
      return (
        local?.syncStatus === 'synced' &&
        window.__excalidrawAPI
          .getSceneElements()
          .every((e) => local.scene.elements.some((saved) => saved.id === e.id && saved.version === e.version))
      )
    },
    { polling: 200 },
    fixture.id,
  )
  const warmed = await durable(fixture.id)
  assert.equal(warmed.refs.length, 5)
  const namedVersion = await owner.evaluate(async (boardId) => {
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const version = await sceneService.createNamedVersion(boardId, 'Before native edit')
    const listed = await sceneService.listNamedVersions(boardId)
    if (!listed.some((item) => item.versionId === version.versionId)) throw new Error('Created version was not listed')
    return version
  }, fixture.id)
  await owner.waitForFunction(
    () =>
      document.querySelector('.workspace-startup-loader')?.hidden === true &&
      !window.__excalidrawAPI.getAppState().viewModeEnabled,
    { polling: 100 },
  )
  const beforeCalls = calls.length
  const originalX = warmed.elements[0].x
  await owner.mouse.click(1000, 650)
  await owner.evaluate(() =>
    window.__excalidrawAPI.updateScene({
      appState: { selectedElementIds: { 'five-0': true } },
    }),
  )
  await owner.waitForFunction(() => Boolean(window.__excalidrawAPI.getAppState().selectedElementIds['five-0']), {
    polling: 100,
  })
  await owner.keyboard.press('ArrowRight')
  await owner.waitForFunction(
    (x) => window.__excalidrawAPI.getSceneElements().find((e) => e.id === 'five-0')?.x === x + 1,
    { polling: 100 },
    originalX,
  )
  const edited = await eventually(async () => {
    const snapshot = await durable(fixture.id)
    return snapshot.elements[0].x === originalX + 1 ? snapshot : null
  }, 'Native keyboard move did not publish')
  assert.equal(edited.refs.length, 5, 'Small edit should retain exactly five chunks')
  const reused = edited.refs.filter((ref) => warmed.refs.some((old) => old.chunkId === ref.chunkId)).length
  assert(reused >= 3, `Small edit must reuse at least three unchanged chunks (reused ${reused}/${edited.refs.length})`)
  const commits = calls.slice(beforeCalls).filter((call) => call.endpoint === 'commitBoardScene')
  assert(commits.length > 0)
  assert(
    commits.every((call) =>
      Object.keys(call.data).every((key) => ['boardId', 'commitId', 'sceneProtocolVersion'].includes(key)),
    ),
  )
  const logicalRecordsBeforeRepack = await rawRecords(fixture.id)
  const fragmented = await forceFragmentedLayout(fixture.id)
  assert(
    fragmented.chunkCount > edited.refs.length,
    'fixture should deliberately create fragmented immutable membership',
  )
  const repackResult = await owner.evaluate(async (boardId) => {
    const { projectCall } = await import('/src/features/sharing/project-service.ts')
    return projectCall('repackBoardScene', { boardId, sceneProtocolVersion: 2 })
  }, fixture.id)
  assert(repackResult.revisionId, 'repack callable should publish a maintenance revision')
  assert(
    calls.some((call) => call.endpoint === 'repackBoardScene'),
    'browser must invoke the repack callable over the network',
  )
  const afterRepack = await durable(fixture.id)
  const repackRevision = (await db.doc(`boardScenes/${fixture.id}/revisions/${repackResult.revisionId}`).get()).data()
  assert(afterRepack.refs.length < fragmented.chunkCount, 'repack should reduce the deliberately fragmented layout')
  assert(
    repackRevision.repackBytesAfter < repackRevision.repackBytesBefore,
    'repack should reduce persisted chunk bytes',
  )
  assert.deepEqual(
    await rawRecords(fixture.id),
    logicalRecordsBeforeRepack,
    'repack must preserve every serialized scene record',
  )
  assert.deepEqual(afterRepack.elements, edited.elements)
  const historicalSnapshot = await owner.evaluate(
    async ({ boardId, versionId }) => {
      const { sceneService } = await import('/src/features/scenes/scene-service.ts')
      const loaded = await sceneService.loadNamedVersion(boardId, versionId)
      return { revisionId: loaded.revisionId, elements: loaded.scene.elements.map(({ id, x }) => ({ id, x })) }
    },
    { boardId: fixture.id, versionId: namedVersion.versionId },
  )
  assert.equal(historicalSnapshot.revisionId, namedVersion.revisionId)
  assert.equal(
    historicalSnapshot.elements.find((element) => element.id === 'five-0').x,
    originalX,
    'historical snapshot must not include the later native edit or RTDB state',
  )
  assert.equal(historicalSnapshot.elements.length, edited.elements.length)
  assert(calls.some((call) => call.endpoint === 'acquireNamedBoardSceneVersionReadPin'))
  assert(
    calls.some((call) => call.endpoint === 'readBoardScenePage' && call.data.revisionId === namedVersion.revisionId),
  )
  assert.equal(repackRevision.reason, 'maintenance')
  const repackMetrics = {
    repackedFromChunks: fragmented.chunkCount,
    repackedToChunks: afterRepack.refs.length,
    repackedBytesBefore: repackRevision.repackBytesBefore,
    repackedBytesAfter: repackRevision.repackBytesAfter,
  }
  // Remove the owner's live session, then load through an entirely new browser storage context.
  await owner.goto(base)
  await owner.evaluate(async (id) => {
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const config = await sharingService.getShareConfig(id)
    await sharingService.saveShareConfig({ ...config, generalAccess: 'anyone_with_link', generalRole: 'viewer' })
  }, fixture.id)
  const cold = await pageIn(await browser.createBrowserContext())
  const coldReadCallStart = calls.length
  const coldLoadStarted = Date.now()
  await cold.goto(`${base}/boards/${fixture.id}`)
  await cold.bringToFront()
  await cold.waitForFunction(() => window.__excalidrawAPI?.getSceneElements().length === 20, { polling: 100 })
  const coldLoadMs = Date.now() - coldLoadStarted
  assert(coldLoadMs < 5000, `5-chunk cold render should stay below 5s; took ${coldLoadMs}ms`)
  results.push(`5-chunk cold render ${coldLoadMs}ms`)
  const coldReadCalls = calls.slice(coldReadCallStart)
  assert(coldReadCalls.some((call) => call.endpoint === 'acquireBoardSceneReadPin'))
  assert(
    !coldReadCalls.some((call) => ['readBoardScenePage', 'readBoardSceneChunks'].includes(call.endpoint)),
    'The 5-chunk first page and payloads arrive in the authorized pin response without serial read callables.',
  )
  const rendered = await cold.evaluate(() =>
    window.__excalidrawAPI.getSceneElements().map((e) => ({
      id: e.id,
      x: e.x,
      y: e.y,
      payload: e.customData?.payload,
    })),
  )
  assert.deepEqual(
    rendered,
    JSON.parse(
      JSON.stringify(edited.elements.map((e) => ({ id: e.id, x: e.x, y: e.y, payload: e.customData?.payload }))),
    ),
  )
  assert.equal(await cold.evaluate(() => window.__excalidrawAPI.getAppState().viewModeEnabled), true)
  results.push({
    chunks: edited.refs.length,
    sceneBytes: fixture.bytes,
    encodedBytes: edited.bytes,
    initialElements: 20,
    renderedElements: rendered.length,
    reusedChunks: reused,
    ...repackMetrics,
  })
  console.log(
    'PASS exact five chunks: save, native edit, immutable reuse and cold viewer rendering',
    JSON.stringify(results[0]),
  )
} finally {
  if (!results.length && diagnosticOwner && !diagnosticOwner.isClosed()) {
    await diagnosticOwner.screenshot({ path: `${artifacts}/five-chunk-failure.png` })
    const state = await diagnosticOwner.evaluate(() => ({
      body: document.body.innerText,
      loaderHidden: document.querySelector('.workspace-startup-loader')?.hidden,
      activeElement: document.activeElement?.outerHTML?.slice(0, 500),
      scene: window.__excalidrawAPI?.getSceneElements().map((e) => ({ id: e.id, x: e.x, version: e.version })),
      appState: (() => {
        const state = window.__excalidrawAPI?.getAppState()
        return {
          selectedElementIds: state?.selectedElementIds,
          viewModeEnabled: state?.viewModeEnabled,
          gridSize: state?.gridSize,
          activeTool: state?.activeTool,
        }
      })(),
      pending: Boolean(window.__pendingScene?.()),
      lazy: window.__lazyCollab,
    }))
    await writeFile(`${artifacts}/five-chunk-failure.json`, JSON.stringify(state, null, 2))
  }
  await writeFile(`${artifacts}/five-chunk-scene.json`, JSON.stringify({ fixture, results, calls }, null, 2))
  await browser.close()
  await db.terminate()
  await deleteApp(app)
}
