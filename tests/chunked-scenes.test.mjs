/** ADR 006 browser integration. Only the isolated regression emulators are allowed. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Chunk tests require isolated demo-regression emulators.')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getDatabase } = require('firebase-admin/database')
const adminApp = initializeApp({ projectId: 'demo-regression', databaseURL: 'https://demo-regression.firebaseio.com' })
const db = getFirestore()
const rtdb = getDatabase()
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const artifacts = process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const calls = [],
  checks = [],
  errors = []
function checkpoint(message) {
  checks.push(message)
  console.log('PASS ' + message)
}
async function pageIn(context) {
  const page = await context.newPage()
  page.setDefaultTimeout(45000)
  await page.setViewport({ width: 1440, height: 900 })
  page.on('dialog', async (dialog) => {
    await dialog.accept()
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().includes(':45001/')) return
    let data
    try {
      data = JSON.parse(request.postData() || '{}').data
    } catch {
      return
    }
    calls.push({ endpoint: request.url().split('/').pop(), data, at: Date.now() })
  })
  return page
}
async function waitFor(predicate, message, timeout = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(message)
}
async function open(page, id, count) {
  await page.goto(`${base}/boards/${id}`, { waitUntil: 'domcontentloaded' })
  await page.bringToFront()
  await page.waitForFunction(
    (expected) => window.__excalidrawAPI?.getSceneElements().length >= expected,
    { polling: 100 },
    count,
  )
}
async function nativeRectangle(page, x = 900, y = 550) {
  await page.bringToFront()
  const before = await page.evaluate(() => window.__excalidrawAPI.getSceneElements().map((e) => e.id))
  await page.keyboard.press('Escape')
  await page.keyboard.press('r')
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 105, y + 75, { steps: 6 })
  await page.mouse.up()
  await page.waitForFunction(
    (ids) => window.__excalidrawAPI.getSceneElements().some((e) => !ids.includes(e.id)),
    {},
    before,
  )
  return page.evaluate((ids) => window.__excalidrawAPI.getSceneElements().find((e) => !ids.includes(e.id)).id, before)
}
// The durable oracle deliberately does not use the production scene loader/merge helper.
// Its exact revision envelope is completed below after the shared schema is fixed.
async function durable(id) {
  const head = (await db.doc(`boardScenes/${id}`).get()).data()
  assert(head?.headRevisionId, 'Board has a canonical committed head')
  const revision = (await db.doc(`boardScenes/${id}/revisions/${head.headRevisionId}`).get()).data()
  assert(revision, 'The head references a complete revision')
  const refs = []
  for (let i = 0; i < revision.pageCount; i++) {
    const page = (
      await db.doc(`boardScenes/${id}/revisions/${head.headRevisionId}/pages/${String(i).padStart(6, '0')}`).get()
    ).data()
    assert(page, 'Every manifest page exists')
    refs.push(...page.references)
  }
  assert.equal(refs.length, revision.chunkCount, 'Manifest reference count matches revision')
  assert.equal(new Set(refs.map((ref) => ref.chunkId)).size, refs.length, 'No duplicate chunk references')
  const records = [],
    chunkData = []
  for (const ref of refs) {
    const chunk = (await db.doc(`boardScenes/${id}/chunks/${ref.chunkId}`).get()).data()
    assert(chunk, 'Every referenced immutable chunk exists')
    assert.equal(createHash('sha256').update(chunk.payload).digest('hex'), ref.digest, 'Chunk digest matches bytes')
    assert.equal(chunk.digest, ref.digest)
    assert(Buffer.byteLength(chunk.payload) < 512 * 1024, 'Payload respects conservative chunk budget')
    records.push(...JSON.parse(chunk.payload))
    chunkData.push({ ...chunk, chunkId: ref.chunkId })
  }
  assert.equal(new Set(records.map((record) => record.key)).size, records.length, 'Record IDs are unique')
  const elements = records
    .filter((record) => record.kind === 'element')
    .sort((a, b) => a.order - b.order)
    .map((record) => record.value)
  assert.equal(new Set(elements.map((element) => element.id)).size, elements.length, 'Element IDs are unique')
  assert.deepEqual(
    records
      .filter((record) => record.kind === 'element')
      .map((record) => record.order)
      .sort((a, b) => a - b),
    Array.from({ length: elements.length }, (_, i) => i),
    'Stacking order is complete',
  )
  const appState = records.find((record) => record.kind === 'appState')?.value
  assert(appState, 'Persisted app state is present')
  return { head, revision, refs, chunkData, scene: { elements, appState } }
}

try {
  const ownerContext = await browser.createBrowserContext()
  const owner = await pageIn(ownerContext)
  await owner.goto(base)
  const fixture = await owner.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    const { user } = await signInOwner(getFirebaseAuth())
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { convertToExcalidrawElements } = await import('/tests/frame-reload-fixture.ts')
    const project = await workspaceApi.createProject('ADR006 chunk tests')
    const board = await workspaceApi.createBoard(project.id, 'Board larger than 1 MiB')
    const elements = convertToExcalidrawElements(
      Array.from({ length: 320 }, (_, n) => ({
        type: 'rectangle',
        id: `large-${n}`,
        x: (n % 20) * 45,
        y: Math.floor(n / 20) * 35,
        width: 30,
        height: 20,
        customData: { payload: `${n}:` + '🌍'.repeat(1100) },
      })),
      { regenerateIds: false },
    )
    const scene = { elements, appState: { viewBackgroundColor: '#ffffff' } }
    await workspaceApi.saveBoard({ ...board, scene })
    await workspaceApi.flushCloud()
    return {
      id: board.id,
      projectId: project.id,
      uid: user.uid,
      email: user.email,
      count: elements.length,
      bytes: new TextEncoder().encode(JSON.stringify(scene)).length,
    }
  })
  assert(fixture.bytes > 1024 * 1024, 'Fixture actually exceeds the old document ceiling')
  await open(owner, fixture.id, fixture.count)
  const initial = await durable(fixture.id)
  assert(initial.refs.length > 1, 'Large fixture genuinely occupies multiple chunks')
  assert.equal(initial.scene.elements.length, fixture.count)
  assert.equal(initial.scene.elements[319].customData.payload, '319:' + '🌍'.repeat(1100))
  checkpoint('large board saved and assembled')
  const pendingContext = await browser.createBrowserContext(),
    pendingPage = await pageIn(pendingContext)
  await pendingPage.goto(base)
  await pendingPage.evaluate(async (email) => {
    const { signInExistingOwner } = await import('/tests/chunked-scene-fixture.ts')
    await signInExistingOwner(email)
  }, fixture.email)
  await waitFor(
    async () =>
      pendingPage.evaluate(async (id) => {
        const { localBoard } = await import('/tests/chunked-scene-fixture.ts')
        return (await localBoard(id))?.cloudScenePending
      }, fixture.id),
    'Cold workspace metadata did not mark scene as pending',
  )
  const raceChecks = await pendingPage.evaluate(async () => {
    const { storageRaceChecks } = await import('/tests/chunked-scene-fixture.ts')
    return storageRaceChecks()
  })
  assert.equal(raceChecks.length, 7)
  checkpoint('deterministic local hydration, metadata and acknowledgement races')
  await pendingPage.setOfflineMode(true)
  const pendingFailure = await pendingPage.evaluate(async (id) => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    try {
      await workspaceApi.loadBoardWithProject(id)
      return 'allowed'
    } catch (error) {
      return error.message
    }
  }, fixture.id)
  assert.match(
    pendingFailure,
    /download|complete|connect/i,
    'Offline metadata placeholder cannot be treated as an empty editable scene',
  )
  const pendingSaveFailure = await pendingPage.evaluate(async (id) => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { localBoard } = await import('/tests/chunked-scene-fixture.ts')
    try {
      await workspaceApi.saveBoard(await localBoard(id))
      return 'allowed'
    } catch (error) {
      return error.message
    }
  }, fixture.id)
  assert.match(
    pendingSaveFailure,
    /complete|load/i,
    'Unhydrated metadata placeholder cannot be saved as an empty board',
  )
  assert.equal((await durable(fixture.id)).head.headRevisionId, initial.head.headRevisionId)
  await pendingContext.close()
  checkpoint('cold metadata discovery cannot edit an unhydrated scene offline')
  assert.equal(await owner.evaluate(() => window.__lazyCollab?.isLazyCollabActive), false)
  const mountedElements = await owner.evaluate(() => window.__excalidrawAPI.getSceneElementsIncludingDeleted())
  const remotePage = await pageIn(ownerContext)
  await remotePage.goto(base)
  await remotePage.evaluate(
    async ({ id, scene }) => {
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      await getFirebaseAuth().authStateReady()
      const { sceneService } = await import('/src/features/scenes/scene-service.ts')
      await sceneService.commit(id, {
        ...scene,
        elements: scene.elements.map((e, index) =>
          index === 0 ? { ...e, x: 777, version: e.version + 10, versionNonce: 2 } : e,
        ),
      })
    },
    { id: fixture.id, scene: { ...initial.scene, elements: mountedElements } },
  )
  const externalSnapshot = await durable(fixture.id)
  assert.equal(
    externalSnapshot.scene.elements.find((e) => e.id === 'large-0')?.x,
    777,
    'External edit is durably newer before testing subscriber rendering',
  )
  console.log(
    'External head version',
    JSON.stringify({
      before: mountedElements[0].version,
      durable: externalSnapshot.scene.elements.find((e) => e.id === 'large-0')?.version,
    }),
  )
  await owner.bringToFront()
  try {
    await owner.waitForFunction(
      () => window.__excalidrawAPI.getSceneElements().find((e) => e.id === 'large-0')?.x === 777,
      { polling: 100 },
    )
  } catch (error) {
    const diagnostic = await owner.evaluate(async (id) => {
      const { localBoard } = await import('/tests/chunked-scene-fixture.ts')
      const local = await localBoard(id),
        mounted = window.__excalidrawAPI.getSceneElements().find((e) => e.id === 'large-0')
      return {
        url: location.href,
        mounted: { x: mounted?.x, version: mounted?.version, nonce: mounted?.versionNonce },
        pending: Boolean(window.__pendingScene?.()),
        unsaved: window.__hasUnsavedChanges?.(),
        lazy: window.__lazyCollab,
        local: {
          head: local?.cloudRevisionId,
          generation: local?.cloudGeneration,
          status: local?.syncStatus,
          shape: local?.scene.elements.find((e) => e.id === 'large-0') && {
            x: local.scene.elements.find((e) => e.id === 'large-0').x,
            version: local.scene.elements.find((e) => e.id === 'large-0').version,
          },
        },
        status: document.querySelector('.sync-status-pill')?.textContent,
        trace: window.__sceneTrace,
      }
    }, fixture.id)
    console.log('HEAD RECEIVE DIAGNOSTIC ' + JSON.stringify(diagnostic))
    await writeFile(`${artifacts}/head-receive-diagnostic.json`, JSON.stringify(diagnostic, null, 2))
    throw error
  }
  assert.equal(
    await owner.evaluate(() => window.__lazyCollab?.isLazyCollabActive),
    false,
    'A private head update reaches the mounted editor without an active live scene room',
  )
  await waitFor(async () => {
    const local = await owner.evaluate(async (id) => {
      const { localBoard } = await import('/tests/chunked-scene-fixture.ts')
      return localBoard(id)
    }, fixture.id)
    return (
      local?.cloudRevisionId === externalSnapshot.head.headRevisionId &&
      local?.scene.elements.find((e) => e.id === 'large-0')?.x === 777
    )
  }, 'Owned shared head did not reach durable local cache')
  await remotePage.close()
  checkpoint('private mounted editor receives external head commit without collab activation')
  const begin = calls.length
  const drawn = await nativeRectangle(owner)
  const edited = await waitFor(async () => {
    const snapshot = await durable(fixture.id)
    return snapshot.scene.elements.some((e) => e.id === drawn) ? snapshot : null
  }, 'Native edit never reached scene publication')
  assert(
    calls
      .slice(begin)
      .filter((call) => call.endpoint === 'commitBoardScene')
      .every((call) => Object.keys(call.data).every((key) => ['boardId', 'commitId'].includes(key))),
    'Callable traffic contains references, never the whole scene',
  )
  assert(
    calls.slice(begin).some((call) => call.endpoint === 'commitBoardScene'),
    'Native draw has at least one observed commit callable',
  )
  checkpoint('native draw causes reference-only callable publication')
  // Offline UI edits remain local and publish when the existing queue reconnects.
  const offlineHead = edited.head.headRevisionId
  await owner.setOfflineMode(true)
  const offlineDrawn = await nativeRectangle(owner, 1050, 650)
  assert.equal((await durable(fixture.id)).head.headRevisionId, offlineHead, 'Offline edits cannot publish a head')
  await owner.setOfflineMode(false)
  const reconnected = await waitFor(async () => {
    const snapshot = await durable(fixture.id)
    return snapshot.scene.elements.some((e) => e.id === offlineDrawn) ? snapshot : null
  }, 'Offline native edit was not recovered on reconnect')
  assert(
    reconnected.refs.some((ref) => edited.refs.some((old) => old.chunkId === ref.chunkId)),
    'Unchanged chunks are reused after first-mount Excalidraw normalization',
  )
  checkpoint('offline native edit retains draft and recovers')
  const slowCdp = await owner.createCDPSession()
  await slowCdp.send('Network.enable')
  await slowCdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 180,
    downloadThroughput: 180000,
    uploadThroughput: 90000,
  })
  const slowDrawn = await nativeRectangle(owner, 780, 580)
  await waitFor(
    async () => (await durable(fixture.id)).scene.elements.some((e) => e.id === slowDrawn),
    'Throttled network lost a native edit',
    90000,
  )
  await slowCdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  checkpoint('throttled HTTP transfer preserves native edits')

  // Lost response after commit: fail only the HTTP response, not staging or server execution.
  const cdp = await owner.createCDPSession()
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*commitBoardScene*', requestStage: 'Response' }] })
  let dropped = false,
    lostCommitId
  const lostCallStart = calls.length
  cdp.on('Fetch.requestPaused', async (event) => {
    if (!dropped && event.responseStatusCode === 200) {
      dropped = true
      lostCommitId = JSON.parse(event.request.postData).data.commitId
      await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionReset' })
    } else await cdp.send('Fetch.continueResponse', { requestId: event.requestId })
  })
  const lostAckDrawn = await nativeRectangle(owner, 850, 680)
  await waitFor(
    async () => dropped && (await durable(fixture.id)).scene.elements.some((e) => e.id === lostAckDrawn),
    'Lost-ack edit was not durably committed',
  )
  await cdp.send('Fetch.disable')
  await owner.evaluate(async () => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    await workspaceApi.flushCloud()
  })
  await waitFor(
    async () => {
      const local = await owner.evaluate(async (id) => {
        const { localBoard } = await import('/tests/chunked-scene-fixture.ts')
        return localBoard(id)
      }, fixture.id)
      return local?.syncStatus === 'synced' && local.cloudRevisionId === (await durable(fixture.id)).head.headRevisionId
    },
    'Lost acknowledgement did not recover the local durable save status',
    90000,
  )
  assert(
    calls
      .slice(lostCallStart)
      .filter((call) => call.endpoint === 'commitBoardScene' && call.data.commitId === lostCommitId).length >= 2,
    'Client retries the original ambiguous commit ID instead of blindly uploading another revision',
  )
  checkpoint('lost acknowledgement recovers original receipt and local synced revision')

  // Publish metadata without copying the now-large scene into boardShares.
  await owner.evaluate(async (id) => {
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const config = await sharingService.getShareConfig(id, {
      ownerId: getFirebaseAuth().currentUser.uid,
      boardName: 'Chunked shared board',
    })
    await sharingService.saveShareConfig({ ...config, generalAccess: 'anyone_with_link', generalRole: 'viewer' })
  }, fixture.id)
  const shared = (await db.doc(`boardShares/${fixture.id}`).get()).data()
  assert.equal(shared.sceneId, fixture.id)
  assert(
    !shared.scene || Buffer.byteLength(JSON.stringify(shared.scene)) < 1024 * 1024,
    'Publication does not copy a large scene into metadata',
  )
  const viewerContext = await browser.createBrowserContext()
  const viewer = await pageIn(viewerContext)
  await viewer.evaluateOnNewDocument((id) => {
    window.__chunkLoadEvents = []
    window.addEventListener(`board-load:${id}`, (event) => window.__chunkLoadEvents.push(event.detail))
  }, fixture.id)
  await open(viewer, fixture.id, fixture.count + 4)
  assert.equal(
    await viewer.evaluate(() =>
      window.__excalidrawAPI.getSceneElements().some((e) => e.customData?.payload === '319:' + '🌍'.repeat(1100)),
    ),
    true,
    'A cold browser assembles all chunks without IndexedDB recovery',
  )
  const loadEvents = await viewer.evaluate(() => window.__chunkLoadEvents)
  assert(loadEvents.length > 0, 'Cold hydration reports chunk loading progress')
  assert(
    loadEvents.every((event) => event.completed >= 0 && event.completed <= event.total),
    'Loading counters remain bounded',
  )
  assert(
    loadEvents.some((event) => event.completed === event.total && event.total > 1),
    'Complete multi-chunk load is reported',
  )
  const headBeforeAttack = (await durable(fixture.id)).head.headRevisionId
  const denial = await viewer.evaluate(
    async ({ id, commitId }) => {
      const { forbiddenHeadWrite, stageScene, commitCandidate } = await import('/tests/chunked-scene-fixture.ts')
      const results = []
      for (const action of [
        () => forbiddenHeadWrite(id),
        () => stageScene(id, { elements: [], appState: {} }),
        () => commitCandidate({ boardId: id, commitId }),
      ]) {
        try {
          await action()
          results.push('allowed')
        } catch (error) {
          results.push(error.code)
        }
      }
      return results
    },
    { id: fixture.id, commitId: headBeforeAttack },
  )
  assert(
    denial.every((code) => String(code).includes('permission-denied')),
    'Viewer cannot stage or publish',
  )
  assert.equal((await durable(fixture.id)).head.headRevisionId, headBeforeAttack)
  checkpoint('cold viewer reads chunks; viewer cannot stage or mutate head')
  await owner.goto(base) // Isolate head-only delivery from active RTDB collaboration.
  await viewer.bringToFront()
  await viewer.waitForFunction(
    () => !window.__lazyCollab?.isLazyCollabActive && !window.__lazyCollab?.isTransitioningCollab,
    { polling: 100 },
  )
  await viewer.evaluate(() => {
    window.__beforeACLAPI = window.__excalidrawAPI
  })
  await owner.evaluate(async (id) => {
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const config = await sharingService.getShareConfig(id)
    await sharingService.saveShareConfig({ ...config, generalAccess: 'restricted' })
  }, fixture.id)
  await viewer.bringToFront()
  await viewer.waitForFunction(() => document.body.innerText.includes('You need access'), { polling: 100 })
  await owner.evaluate(async (id) => {
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const config = await sharingService.getShareConfig(id)
    await sharingService.saveShareConfig({ ...config, generalAccess: 'anyone_with_link' })
  }, fixture.id)
  await viewer.waitForFunction(
    () =>
      !document.body.innerText.includes('You need access') &&
      Boolean(document.querySelector('.excalidraw canvas')) &&
      Boolean(window.__excalidrawAPI) &&
      window.__excalidrawAPI !== window.__beforeACLAPI,
    { polling: 100 },
  )
  const recoveryScene = (await durable(fixture.id)).scene
  await owner.evaluate(
    async ({ id, scene }) => {
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      await getFirebaseAuth().authStateReady()
      const { sceneService } = await import('/src/features/scenes/scene-service.ts')
      await sceneService.commit(id, {
        ...scene,
        elements: scene.elements.map((e) =>
          e.id === 'large-0' ? { ...e, x: 888, version: Number(e.version) + 20, versionNonce: 3 } : e,
        ),
      })
    },
    { id: fixture.id, scene: recoveryScene },
  )
  await viewer.bringToFront()
  try {
    await viewer.waitForFunction(
      () => window.__excalidrawAPI?.getSceneElements().find((e) => e.id === 'large-0')?.x === 888,
      { polling: 100 },
    )
  } catch (error) {
    const diagnostic = await viewer.evaluate(() => ({
      body: document.body.innerText,
      mounted: window.__excalidrawAPI?.getSceneElements().find((e) => e.id === 'large-0'),
      trace: window.__sceneTrace,
      lazy: window.__lazyCollab,
      pending: Boolean(window.__pendingScene?.()),
    }))
    await writeFile(`${artifacts}/acl-recovery-diagnostic.json`, JSON.stringify(diagnostic, null, 2))
    console.log('ACL RECOVERY DIAGNOSTIC', JSON.stringify(diagnostic))
    throw error
  }
  assert.equal((await durable(fixture.id)).scene.elements.find((e) => e.id === 'large-0')?.x, 888)
  checkpoint('revoked viewer recovers without reload and receives later head-only publication')
  // A viewer can trigger trusted legacy migration, but cannot supply a replacement scene.
  const legacyId = `legacy_${Date.now()}`
  const legacyPrivate = { ...initial.scene.elements[0], id: 'legacy-private', x: 50, version: 5, versionNonce: 10 }
  const legacyShared = { ...initial.scene.elements[1], id: 'legacy-shared', x: 90, version: 6, versionNonce: 11 }
  const oldMetadata = (
    await db.doc(`users/${fixture.uid}/projects/${fixture.projectId}/boards/${fixture.id}`).get()
  ).data()
  await db.doc(`users/${fixture.uid}/projects/${fixture.projectId}/boards/${legacyId}`).set({
    ...oldMetadata,
    id: legacyId,
    sceneId: null,
    scene: { elements: [legacyPrivate], appState: {} },
  })
  await db.doc(`boardShares/${legacyId}`).set({
    ...shared,
    boardId: legacyId,
    sceneId: null,
    scene: { elements: [legacyShared], appState: { viewBackgroundColor: '#ffeedd' } },
    pending: false,
  })
  await open(viewer, legacyId, 2)
  const legacy = await durable(legacyId)
  assert.deepEqual(legacy.scene.elements.map((e) => e.id).sort(), ['legacy-private', 'legacy-shared'])
  assert.equal(legacy.scene.appState.viewBackgroundColor, '#ffeedd')
  checkpoint('cold viewer triggers trusted migration of both legacy scenes without write permission')
  await viewerContext.close()

  // Pause the mounted editor to prevent background autosaves from disturbing protocol races.
  await owner.goto(base)
  const stable = await durable(fixture.id)
  const candidates = await owner.evaluate(
    async ({ id, scene, head }) => {
      const { stageScene } = await import('/tests/chunked-scene-fixture.ts')
      return Promise.all([
        stageScene(
          id,
          {
            ...scene,
            elements: scene.elements.map((e, i) =>
              i === 0 ? { ...e, x: 1001, version: e.version + 1, versionNonce: 10 } : e,
            ),
          },
          head,
        ),
        stageScene(
          id,
          {
            ...scene,
            elements: scene.elements.map((e, i) =>
              i === 1 ? { ...e, x: 1002, version: e.version + 1, versionNonce: 11 } : e,
            ),
          },
          head,
        ),
      ])
    },
    { id: fixture.id, scene: stable.scene, head: stable.head },
  )
  const race = await owner.evaluate(async (candidates) => {
    const { commitCandidate } = await import('/tests/chunked-scene-fixture.ts')
    return Promise.all(
      candidates.map(async (candidate) => {
        try {
          return { receipt: await commitCandidate(candidate) }
        } catch (error) {
          return { code: error.code }
        }
      }),
    )
  }, candidates)
  assert.equal(race.filter((result) => result.receipt).length, 1, 'Exactly one stale-head contender commits')
  assert.equal(
    race.filter((result) => String(result.code).includes('aborted')).length,
    1,
    'Other contender receives explicit conflict',
  )
  const winner = race.findIndex((result) => result.receipt)
  const replay = await owner.evaluate(async (candidate) => {
    const { commitCandidate } = await import('/tests/chunked-scene-fixture.ts')
    return commitCandidate(candidate)
  }, candidates[winner])
  assert.deepEqual(replay, race[winner].receipt, 'Commit retry returns its original receipt')
  const winnerSnapshot = await durable(fixture.id)
  assert.equal(winnerSnapshot.scene.elements[winner].x, winner === 0 ? 1001 : 1002)
  assert.equal(
    (await db.doc(`boardScenes/${fixture.id}/revisions/${stable.head.headRevisionId}`).get()).exists,
    true,
    'Previous complete revision remains retained',
  )
  const immutableError = await owner.evaluate(
    async ({ id, chunkId }) => {
      const { forbiddenChunkRewrite } = await import('/tests/chunked-scene-fixture.ts')
      try {
        await forbiddenChunkRewrite(id, chunkId)
        return 'allowed'
      } catch (error) {
        return error.code
      }
    },
    { id: fixture.id, chunkId: winnerSnapshot.refs[0].chunkId },
  )
  assert.match(immutableError, /permission-denied/, 'Even owner cannot rewrite an immutable chunk')
  checkpoint('deterministic stale-head contention, idempotent receipt replay, retained immutable history')
  const incomplete = await owner.evaluate(
    async ({ id, scene }) => {
      const { stageScene } = await import('/tests/chunked-scene-fixture.ts')
      return stageScene(id, scene)
    },
    { id: fixture.id, scene: winnerSnapshot.scene },
  )
  // Admin-only fault injection deletes staged bytes, never a committed revision.
  await db.doc(`boardScenes/${fixture.id}/chunks/${incomplete.refs[0].chunkId}`).delete()
  const incompleteResult = await owner.evaluate(async (candidate) => {
    const { commitCandidate } = await import('/tests/chunked-scene-fixture.ts')
    try {
      await commitCandidate(candidate)
      return 'allowed'
    } catch (error) {
      return error.code
    }
  }, incomplete)
  assert.match(incompleteResult, /failed-precondition/, 'Missing staged chunk cannot advance the head')
  assert.equal((await durable(fixture.id)).head.headRevisionId, winnerSnapshot.head.headRevisionId)
  checkpoint('incomplete staged candidate fails without exposing a partial board')
  await owner.evaluate(
    async ({ id, scene }) => {
      const { sceneService } = await import('/src/features/scenes/scene-service.ts')
      await Promise.all(
        [0, 1].map((index) =>
          sceneService.commit(id, {
            ...scene,
            elements: scene.elements.map((e, i) =>
              i === index ? { ...e, x: 2001 + index, version: e.version + 100, versionNonce: 30 + index } : e,
            ),
          }),
        ),
      )
    },
    { id: fixture.id, scene: winnerSnapshot.scene },
  )
  const mergedDifferent = await durable(fixture.id)
  assert.equal(mergedDifferent.scene.elements[0].x, 2001)
  assert.equal(
    mergedDifferent.scene.elements[1].x,
    2002,
    'Client conflict retry preserves edits to different elements in one chunk',
  )
  await owner.evaluate(
    async ({ id, scene }) => {
      const { sceneService } = await import('/src/features/scenes/scene-service.ts')
      await Promise.all(
        [10, 20].map((nonce) =>
          sceneService.commit(id, {
            ...scene,
            elements: scene.elements.map((e, i) =>
              i === 0 ? { ...e, x: nonce === 10 ? 3001 : 3002, version: e.version + 1, versionNonce: nonce } : e,
            ),
          }),
        ),
      )
    },
    { id: fixture.id, scene: mergedDifferent.scene },
  )
  const mergedSame = await durable(fixture.id)
  assert.equal(mergedSame.scene.elements[0].x, 3001, 'Lower nonce wins equal-version same-element writes')
  const generationRefusal = await owner.evaluate(
    async ({ id, scene, generation }) => {
      const { sceneService } = await import('/src/features/scenes/scene-service.ts')
      try {
        await sceneService.commit(id, scene, { expectedGeneration: generation + 1 })
        return 'allowed'
      } catch (error) {
        return error.message
      }
    },
    { id: fixture.id, scene: mergedSame.scene, generation: mergedSame.head.generation },
  )
  assert.match(generationRefusal, /restored|replaced/)
  assert.equal((await durable(fixture.id)).head.headRevisionId, mergedSame.head.headRevisionId)
  checkpoint(
    'client stale-head retries merge different elements and deterministic same-element conflicts; mismatched generation refuses publication',
  )
  // Three real contexts enter collab, then leave one at a time; remaining edits must survive.
  await owner.evaluate(async (id) => {
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const config = await sharingService.getShareConfig(id)
    await sharingService.saveShareConfig({ ...config, generalRole: 'editor' })
  }, fixture.id)
  await open(owner, fixture.id, fixture.count + 4)
  const guestContextA = await browser.createBrowserContext(),
    guestContextB = await browser.createBrowserContext()
  const guestA = await pageIn(guestContextA),
    guestB = await pageIn(guestContextB)
  await open(guestA, fixture.id, fixture.count + 4)
  await open(guestB, fixture.id, fixture.count + 4)
  for (const page of [owner, guestA, guestB]) {
    await page.bringToFront()
    await page.waitForFunction(
      () => window.__lazyCollab?.isLazyCollabActive === true && !window.__lazyCollab?.isTransitioningCollab,
      { polling: 100 },
    )
  }
  const collaborative = await nativeRectangle(guestA, 950, 620)
  for (const page of [owner, guestB]) {
    await page.bringToFront()
    await page.waitForFunction(
      (id) => window.__excalidrawAPI.getSceneElements().some((e) => e.id === id),
      { polling: 100 },
      collaborative,
    )
  }
  await guestContextA.close()
  const afterFirstDrop = await nativeRectangle(guestB, 1000, 500)
  await owner.bringToFront()
  await owner.waitForFunction(
    (id) => window.__excalidrawAPI.getSceneElements().some((e) => e.id === id),
    {},
    afterFirstDrop,
  )
  await ownerContext.close()
  await guestB.bringToFront()
  await guestB.waitForFunction(
    () => window.__lazyCollab?.isLazyCollabActive === false && !window.__lazyCollab?.isTransitioningCollab,
    { polling: 100 },
  )
  const afterSecondDrop = await nativeRectangle(guestB, 1100, 700)
  await waitFor(
    async () => {
      const ids = (await durable(fixture.id)).scene.elements.map((e) => e.id)
      return [collaborative, afterFirstDrop, afterSecondDrop].every((id) => ids.includes(id))
    },
    'Collab-to-solo checkpoint lost an edit after sequential dropout',
    90000,
  )
  await guestContextB.close()
  const finalContext = await browser.createBrowserContext(),
    finalPage = await pageIn(finalContext)
  await open(finalPage, fixture.id, fixture.count + 7)
  for (const id of [collaborative, afterFirstDrop, afterSecondDrop])
    assert.equal(
      await finalPage.evaluate((id) => window.__excalidrawAPI.getSceneElements().some((e) => e.id === id), id),
      true,
      'Fresh browser sees edits from every membership stage',
    )
  await finalContext.close()
  checkpoint('three-context native collab edits, sequential dropout, solo continuation and cold reload')
  // Inject an acknowledged RTDB delta after every browser is gone. This isolates
  // the server fallback from normal browser flushing and exercises the real 30s grace.
  const beforeFallback = await durable(fixture.id)
  const crashedEdit = { ...beforeFallback.scene.elements[0], x: 2026, version: 10000, versionNonce: 1 }
  await rtdb.ref(`boards/${fixture.id}/elements/${crashedEdit.id}`).set({
    id: crashedEdit.id,
    version: crashedEdit.version,
    versionNonce: 1,
    data: JSON.stringify(crashedEdit),
  })
  await rtdb.ref(`presence/${fixture.id}/crashed-session`).set({ uid: fixture.uid })
  await rtdb.ref(`presence/${fixture.id}/crashed-session`).remove()
  const fallback = await waitFor(
    async () => {
      const snapshot = await durable(fixture.id)
      return snapshot.scene.elements.find((e) => e.id === crashedEdit.id)?.x === 2026 ? snapshot : null
    },
    'Real abandoned-room fallback failed to persist acknowledged RTDB delta',
    90000,
  )
  assert(
    fallback.scene.elements.some((e) => e.id === afterSecondDrop),
    'Fallback preserves existing browser checkpoint edits',
  )
  await waitFor(
    async () => !(await rtdb.ref(`boards/${fixture.id}/elements/${crashedEdit.id}`).get()).exists(),
    'Captured unchanged RTDB delta was not pruned after checkpoint',
  )
  checkpoint('last-client-loss fallback commits RTDB delta after real grace and prunes captured record')
  // A real .excalidraw file import replaces the current board, even when its
  // supplied versions are lower than the durable scene's existing versions.
  const importContext = await browser.createBrowserContext()
  const importPage = await pageIn(importContext)
  await importPage.goto(base)
  await importPage.evaluate(async (email) => {
    const { signInExistingOwner } = await import('/tests/chunked-scene-fixture.ts')
    await signInExistingOwner(email)
  }, fixture.email)
  await open(importPage, fixture.id, fixture.count + 7)
  await importPage.waitForFunction(
    () =>
      document.querySelector('.workspace-startup-loader')?.hidden === true &&
      !window.__lazyCollab?.isTransitioningCollab,
    { polling: 100 },
  )
  const importFile = `${artifacts}/replacement.excalidraw`
  const importedElements = fallback.scene.elements
    .filter((e) => e.id === 'large-0' || e.id === 'large-1')
    .map((e, index) => ({ ...e, isDeleted: false, version: 1, versionNonce: index + 1, x: 1234 + index * 100 }))
  await writeFile(
    importFile,
    JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'test',
      elements: importedElements,
      appState: { viewBackgroundColor: '#ffccdd' },
      files: {},
    }),
  )
  const fileInput = await importPage.waitForSelector('input[aria-label="Import board file"]')
  await fileInput.uploadFile(importFile)
  await importPage.waitForFunction(
    () => {
      const elements = window.__excalidrawAPI.getSceneElements()
      return elements.length === 2 && elements.find((e) => e.id === 'large-0')?.x === 1234
    },
    { polling: 100 },
  )
  const imported = await waitFor(async () => {
    const snapshot = await durable(fixture.id)
    const visible = snapshot.scene.elements.filter((e) => !e.isDeleted)
    return visible.length === 2 && visible.find((e) => e.id === 'large-0')?.x === 1234 ? snapshot : null
  }, 'Real file input replacement was not durably committed')
  for (const old of fallback.scene.elements.filter(
    (e) => !importedElements.some((replacement) => replacement.id === e.id),
  )) {
    assert(
      !imported.scene.elements.some((e) => e.id === old.id && !e.isDeleted),
      'Import must not resurrect elements omitted by the replacement file',
    )
  }
  await importContext.close()
  const importedColdContext = await browser.createBrowserContext()
  const importedColdPage = await pageIn(importedColdContext)
  await open(importedColdPage, fixture.id, 2)
  await importedColdPage.waitForFunction(() => window.__excalidrawAPI.getSceneElements().length === 2, { polling: 100 })
  assert.equal(
    await importedColdPage.evaluate(() => window.__excalidrawAPI.getSceneElements().find((e) => e.id === 'large-0')?.x),
    1234,
  )
  await importedColdContext.close()
  checkpoint(
    'native file input replaces with lower-version subset; omitted elements stay deleted across durable save and cold reload',
  )
  console.log('PASS chunked-scenes', JSON.stringify({ fixture, checks }))
} finally {
  await writeFile(`${artifacts}/chunked-scenes-audit.json`, JSON.stringify({ calls, checks, errors }, null, 2) + '\n')
  await browser.close()
  await db.terminate()
  await deleteApp(adminApp)
}
