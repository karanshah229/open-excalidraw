/** Real editors diverge offline; independent network/Firebase/chunk/canvas/history oracles. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
const live = process.env.E2E_FIREBASE_TARGET === 'development'
if (live ? process.env.GCLOUD_PROJECT !== 'open-excalidraw-dev-2' || process.env.FIRESTORE_EMULATOR_HOST : process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST || process.env.E2E_LEGACY_FUNCTIONS === 'true') throw new Error('Explicit isolated emulator or development Firebase configuration required')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
let db, rtdb, app, deleteApp, inspection
if (live) ({ db, rtdb, inspection } = await import('./helpers/dev-firebase-inspector.mjs'))
else {
  const { initializeApp, deleteApp: removeApp } = require('firebase-admin/app'); deleteApp = removeApp
  app = initializeApp({ projectId: 'demo-regression', databaseURL: 'https://demo-regression.firebaseio.com' })
  db = require('firebase-admin/firestore').getFirestore(app); rtdb = require('firebase-admin/database').getDatabase(app)
}
const base = process.env.E2E_BASE_URL || (live ? 'http://localhost:5173' : 'http://127.0.0.1:15190'), artifacts = process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'
if (live && !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Live test uses a local development frontend with deployed Firebase')
await mkdir(artifacts, { recursive: true })
const fixtureModule = live ? '/tests/dev-history-fixture.ts' : '/tests/history-fixture.ts'
const browser = live ? await puppeteer.connect({ browserWSEndpoint: JSON.parse(await readFile('.system_generated/live-history-browser.json', 'utf8')).endpoint }) : await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const isCallable = url => live ? url.startsWith('https://us-central1-open-excalidraw-dev-2.cloudfunctions.net/') : url.includes(':45001/')
const screenshots = []
async function evidence(title, pages, assertions = []) {
  for (const page of pages) {
    const peer = peers.find(p => p.page === page)?.name ?? 'owner', file = `${String(screenshots.length + 1).padStart(2, '0')}-${peer}.png`
    await page.screenshot({ path: `${artifacts}/${file}`, fullPage: true })
    screenshots.push({ title, peer, phase, file, assertions, at: new Date().toISOString() })
  }
  await writeFile(`${artifacts}/screenshots.json`, JSON.stringify(screenshots, null, 2))
}
const lostReplyMode = process.env.E2E_DIVERGENCE_LOST_REPLY === 'true'
const peers = [], calls = [], responses = [], failures = [], errors = [], stages = [], responseTasks = new Set()
let phase = 'setup', boardId, root, generation, owner, diagnostics, convergenceDiagnostics, drawDiagnostics, stopFault, faultCdp, droppedReceipt
const faultErrors = [], faultTasks = new Set()
const stable = value => JSON.stringify(normalize(value))
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, normalize(value[key])]))
  return value
}
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex')
const sorted = elements => [...elements].sort((a, b) => a.id.localeCompare(b.id))
const fingerprint = elements => digest(sorted(elements))
// Transport attribution is verified through receipts. Excalidraw hydration represents
// no bindings as either null or []; normalize only that semantic equivalence.
const diagramElement = ({ lastModifiedBy: _transportActor, ...element }) => ({ ...element, boundElements: element.boundElements ?? [] })
const diagramFingerprint = elements => fingerprint(elements.map(diagramElement))
// Excalidraw can locally normalize transport metadata (version, index, nonce,
// timestamp) while applying a remote element. Those fields are checked for the
// actual contested element below; diagram convergence compares persisted
// drawing content and deletion state, not client-local normalization.
const renderedDiagramFingerprint = elements => fingerprint(elements.map(({ updated: _updated, version: _version, versionNonce: _nonce, index: _index, ...element }) => diagramElement(element)))
const ids = elements => elements.filter(e => !e.isDeleted).map(e => e.id).sort()
async function eventually(predicate, label, timeout = 120000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value }
    catch (error) {
      // Vite may reconnect/reload after offline transport loss. Retry only a
      // destroyed execution context; assertions and application errors still fail.
      if (!/Execution context was destroyed|Cannot find context with specified id|Attempted to use detached Frame/.test(String(error))) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(label)
}
function stage(label, detail = {}) { stages.push({ label, phase, ...detail }); console.log('PASS ' + label) }
async function tab(name) {
  const context = live && name === 'owner' ? browser.defaultBrowserContext() : await browser.createBrowserContext()
  // Always use a fresh document in the registered owner's persistent context.
  // A preceding offline test can leave its default-page Firestore SDK offline.
  if (live && name === 'owner') {
    for (const stale of await context.pages()) if (stale.url().startsWith(base)) await stale.close()
  }
  const page = await context.newPage()
  peers.push({ name, context, page }); page.setDefaultTimeout(live ? 180000 : 60000)
  await page.setViewport({ width: 1440, height: 900 })
  page.on('dialog', d => d.accept())
  page.on('pageerror', e => errors.push({ peer: name, phase, message: e.message }))
  page.on('requestfailed', r => failures.push({ peer: name, phase, url: r.url().replace(/\?.*$/, ''), error: r.failure()?.errorText }))
  page.on('request', r => {
    if (r.method() !== 'POST' || !isCallable(r.url())) return
    try { calls.push({ peer: name, phase, at: Date.now(), endpoint: r.url().split('/').pop(), data: JSON.parse(r.postData() || '{}').data }) } catch { /* non-callable */ }
  })
  page.on('response', r => {
    if (r.request().method() !== 'POST' || !isCallable(r.url())) return
    const at = phase
    const task = (async () => { try { const body = await r.json(); responses.push({ peer: name, phase: at, endpoint: r.url().split('/').pop(), status: r.status(), error: body.error, data: JSON.parse(r.request().postData() || '{}').data, result: body.result?.chunks ? { chunks: body.result.chunks.map(c => ({ chunkId: c.chunkId, digest: c.digest, bytes: Buffer.byteLength(c.payload) })) } : body.result }) } catch { /* an offline request can have no readable response */ } })()
    responseTasks.add(task); void task.finally(() => responseTasks.delete(task))
  })
  return page
}
const head = async () => (await db.doc(root).get()).data()
const canvas = page => page.evaluate(() => window.__excalidrawAPI?.getSceneElementsIncludingDeleted() ?? [])
const ledger = page => page.evaluate(async ({ id, fixtureModule }) => {
  const { boardHistoryStore } = await import(fixtureModule)
  return { current: await boardHistoryStore.getCommittedContent(id), versions: await boardHistoryStore.list(id), outbox: await boardHistoryStore.listOutbox(id) }
}, { id: boardId, fixtureModule })
async function open(page) {
  await page.goto(`${base}/boards/${boardId}`)
  await page.waitForSelector('[data-testid="board-history-open"]:not(:disabled)')
  await page.waitForFunction(() => window.__excalidrawAPI?.getSceneElements().length >= 18)
  await page.waitForFunction(() => !window.__lazyCollab?.isTransitioningCollab)
}
// Decode committed records independently, without the application's loader, packer or merger.
async function durable(revisionId) {
  const current = await head(), id = revisionId ?? current.headRevisionId
  const revision = (await db.doc(`${root}/revisions/${id}`).get()).data()
  assert.ok(revision, 'Every published head/version references an existing revision')
  const refs = []
  for (let p = 0; p < revision.pageCount; p++) {
    const page = (await db.doc(`${root}/revisions/${id}/pages/${String(p).padStart(6, '0')}`).get()).data()
    assert.ok(page); refs.push(...page.references)
  }
  assert.equal(refs.length, revision.chunkCount)
  assert.equal(new Set(refs.map(r => r.chunkId)).size, refs.length)
  assert.equal(digest({ sceneFormatVersion: 1, generation: revision.generation, references: refs }), revision.candidateDigest, 'Manifest digest validates ordered references and generation')
  const records = [], chunkEvidence = []
  for (const ref of refs) {
    const chunk = (await db.doc(`${root}/chunks/${ref.chunkId}`).get()).data()
    assert.ok(chunk, 'Published manifest cannot contain dangling chunk references')
    assert.equal(digest(chunk.payload), ref.digest, 'SHA256 verifies actual persisted bytes')
    assert.equal(chunk.digest, ref.digest)
    assert.equal(chunk.generation, revision.generation, 'Chunk belongs to the manifest generation')
    assert.ok(Buffer.byteLength(chunk.payload) + 4096 <= 512 * 1024)
    records.push(...JSON.parse(chunk.payload)); chunkEvidence.push({ id: ref.chunkId, digest: ref.digest, bytes: Buffer.byteLength(chunk.payload) })
  }
  assert.equal(new Set(records.map(r => r.key)).size, records.length, 'No duplicate records across chunks')
  const elementRecords = records.filter(r => r.kind === 'element').sort((a, b) => a.order - b.order)
  assert.deepEqual(elementRecords.map(r => r.order), elementRecords.map((_, i) => i))
  const elements = elementRecords.map(r => r.value)
  assert.equal(new Set(elements.map(e => e.id)).size, elements.length, 'No duplicate element identities')
  for (const e of elements.filter(e => e.id.startsWith('seed-'))) {
    const expected = `${e.id}:` + '🌍'.repeat(20000), actual = e.customData.payload
    if (actual !== expected) {
      let first = 0; while (actual[first] === expected[first] && first < expected.length) first++
      await writeFile(`${artifacts}/payload-mismatch.json`, JSON.stringify({ id: e.id, revisionId: id, first, actualLength: actual.length, expectedLength: expected.length, actualCodeUnits: [...actual.slice(Math.max(0, first - 4), first + 12)].map(c => c.codePointAt(0)), expectedCodeUnits: [...expected.slice(Math.max(0, first - 4), first + 12)].map(c => c.codePointAt(0)), actualPrefix: actual.slice(0, 15) }, null, 2))
    }
    assert.equal(digest(actual), digest(expected), `Large record ${e.id} must retain exact UTF8 bytes (actual length ${actual?.length})`)
  }
  return { current, revisionId: id, refs, chunks: chunkEvidence, elements }
}
async function idle(page, requiredCaptures = [], baselineVersionIds = null) {
  const required = new Set(requiredCaptures), baseline = baselineVersionIds && new Set(baselineVersionIds)
  const timeout = live ? 720000 : 120000, deadline = Date.now() + timeout, quietMs = live ? 10000 : 1000
  let quietSince, lastProgress = Date.now(), previous = '', trackedSignature = ''
  while (Date.now() < deadline) {
    try {
      const value = await ledger(page)
      if (baseline) for (const version of value.versions) if (!baseline.has(version.localVersionId)) required.add(version.localVersionId)
      const nextTrackedSignature = [...required].sort().join(',')
      if (nextTrackedSignature !== trackedSignature) { quietSince = undefined; trackedSignature = nextTrackedSignature }
      const ready = value.current && value.outbox.length === 0 && [...required].every(id => value.versions.some(v => v.localVersionId === id && v.uploadStatus === 'published' && v.receipt))
      if (ready) {
        quietSince ??= Date.now()
        if (Date.now() - quietSince >= quietMs) return [...required]
      } else quietSince = undefined
      const status = JSON.stringify({ versions: required.size, acknowledged: [...required].filter(id => value.versions.some(v => v.localVersionId === id && v.uploadStatus === 'published' && v.receipt)).length, pending: value.outbox.map(x => ({ id: x.localVersionId, intent: x.publicationIntent, retry: x.retryState })), quietMs: quietSince ? Date.now() - quietSince : 0 })
      if (status !== previous || Date.now() - lastProgress >= 30000) { console.log(`WAIT history drain ${peers.find(p => p.page === page)?.name ?? 'peer'} ${status}`); previous = status; lastProgress = Date.now() }
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context with specified id/.test(String(error))) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`History drain exceeded ${timeout}ms for ${peers.find(p => p.page === page)?.name ?? 'peer'}`)
}
async function point(page, id) {
  return page.evaluate(id => {
    const api = window.__excalidrawAPI, e = api.getSceneElements().find(e => e.id === id), s = api.getAppState()
    if (!e) throw new Error('Missing visible shape ' + id)
    return { x: (e.x + e.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft, y: (e.y + 1 + s.scrollY) * s.zoom.value + s.offsetTop }
  }, id)
}
async function drag(page, id, dx, dy) {
  await page.bringToFront(); await page.keyboard.press('Escape'); await page.keyboard.press('v')
  const before = (await canvas(page)).find(e => e.id === id), p = await point(page, id)
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + dx, p.y + dy, { steps: 6 }); await page.mouse.up()
  await eventually(async () => { const e = (await canvas(page)).find(e => e.id === id); return e.x !== before.x || e.y !== before.y }, 'Pointer drag must change the intended shape')
  return (await canvas(page)).find(e => e.id === id)
}
async function remove(page, id) {
  await page.bringToFront(); await page.keyboard.press('Escape'); await page.keyboard.press('v')
  const p = await point(page, id); await page.mouse.click(p.x, p.y); await page.keyboard.press('Backspace')
  await eventually(async () => (await canvas(page)).find(e => e.id === id)?.isDeleted, 'Keyboard deletion must leave a tombstone')
}
async function draw(page, x, y) {
  await page.bringToFront(); await page.keyboard.press('Escape'); const before = ids(await canvas(page))
  await page.click('[data-testid="toolbar-rectangle"]')
  await page.waitForFunction(() => window.__excalidrawAPI.getAppState().activeTool.type === 'rectangle')
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 85, y + 65, { steps: 6 }); await page.mouse.up()
  return eventually(async () => (await canvas(page)).find(e => !e.isDeleted && !before.includes(e.id)), 'Real gesture must create a rectangle')
}
async function captured(page, label) {
  const visible = fingerprint(await canvas(page))
  const value = await eventually(async () => { const l = await ledger(page); return fingerprint(l.current.document.scene.elements) === visible && l.outbox.length > 0 ? l : null }, 'Debounced local save must durably capture the rendered canvas')
  stage(label, { outbox: value.outbox.length, visible })
  await evidence(label, [page], ['Native snapshot equals the current canvas', 'Unsynced version exists in the durable outbox'])
  return value
}
async function converge(pages, expected) {
  await eventually(async () => {
    const rendered = await Promise.all(pages.map(canvas)), cloud = await durable()
    const comparison = rendered.map(elements => ({ actualIds: ids(elements), fingerprint: fingerprint(elements), differences: elements.flatMap(e => {
      const persisted = cloud.elements.find(c => c.id === e.id)
      if (!persisted) return [{ id: e.id, missingFromCloud: true }]
      const actualDiagram = diagramElement(e), persistedDiagram = diagramElement(persisted)
      const keys = [...new Set([...Object.keys(actualDiagram), ...Object.keys(persistedDiagram)])].filter(k => stable(actualDiagram[k]) !== stable(persistedDiagram[k]))
      return keys.length ? [{ id: e.id, keys, actual: Object.fromEntries(keys.map(k => [k, k === 'customData' ? digest(e[k]) : e[k]])), persisted: Object.fromEntries(keys.map(k => [k, k === 'customData' ? digest(persisted[k]) : persisted[k]])) }] : []
    }) }))
    convergenceDiagnostics = { phase, expectedIds: expected, cloudIds: ids(cloud.elements), cloudFingerprint: fingerprint(cloud.elements), rendered: comparison }
    return rendered.every(elements => renderedDiagramFingerprint(elements) === renderedDiagramFingerprint(cloud.elements)) && ids(cloud.elements).join('|') === expected.join('|')
  }, 'Every live editor and canonical chunk snapshot must converge to the exact expected diagram', 180000)
  stage('Live editors match the independent canonical chunk snapshot', {
    peers: pages.length,
    ids: convergenceDiagnostics?.cloudIds,
    fingerprint: convergenceDiagnostics?.cloudFingerprint,
  })
}
async function assertCanvasTieBreaks(pages) {
  const cloud = await durable()
  for (const page of pages) {
    const rendered = await canvas(page)
    for (const element of rendered) {
      const persisted = cloud.elements.find((candidate) => candidate.id === element.id)
      assert.ok(persisted, `Element ${element.id} remains in the canonical revision`)
      assert.equal(element.isDeleted, persisted.isDeleted,
        `Peer ${peers.find((peer) => peer.page === page)?.name ?? 'unknown'} applies canonical deletion state for ${element.id}`)
    }
    const contested = rendered.find((element) => element.id === 'seed-0')
    const canonicalContested = cloud.elements.find((element) => element.id === 'seed-0')
    assert.deepEqual([contested?.version, contested?.versionNonce, contested?.isDeleted],
      [canonicalContested?.version, canonicalContested?.versionNonce, canonicalContested?.isDeleted],
      `Peer ${peers.find((peer) => peer.page === page)?.name ?? 'unknown'} applies the canonical LWW winner for the genuinely conflicting element`)
  }
}
try {
  owner = await tab('owner'); if (!owner.url().startsWith(base)) await owner.goto(base)
  if (live) {
    console.log('Waiting for Google sign-in in the visible isolated Chrome test window.')
    let timeout
    const auth = await Promise.race([
      owner.evaluate(async () => {
        const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
        const auth = getFirebaseAuth()
        await auth.authStateReady()
        return { project: auth.app.options.projectId, email: auth.currentUser?.email ?? null, anonymous: auth.currentUser?.isAnonymous ?? null }
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Dev owner auth check timed out at ${owner.url()}`)), 30_000) }),
    ]).finally(() => clearTimeout(timeout))
    if (auth.project !== 'open-excalidraw-dev-2' || auth.email !== 'karanshah229@gmail.com' || auth.anonymous !== false)
      throw new Error(`Registered owner auth is not ready at ${owner.url()}: ${JSON.stringify(auth)}`)
    console.log(`Dev owner auth ready at ${owner.url()} (project ${auth.project}, registered account, non-anonymous).`)
  }
  console.log('Preparing isolated dev multi-chunk fixture and public editor link.')
  const setup = await owner.evaluate(async live => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const user = live ? getFirebaseAuth().currentUser : (await (await import('/tests/regression-fixture.ts')).signInOwner(getFirebaseAuth())).user
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    if (live) await workspaceApi.activateCloudWorkspace(user.uid)
    return { ownerId: user.uid }
  }, live)
  console.log('Dev account workspace is online; creating isolated project.')
  const projectId = await owner.evaluate(async () => (await (await import('/src/features/workspace/workspace-api.ts')).workspaceApi.createProject('Divergent editors E2E')).id)
  console.log('Fixture project created; creating isolated board.')
  const board = await owner.evaluate(async projectId => await (await import('/src/features/workspace/workspace-api.ts')).workspaceApi.createBoard(projectId, 'Divergent chunked board'), projectId)
  boardId = board.id; root = `boardScenes/${boardId}`
  console.log('Fixture board created; saving 24 large scene records.')
  await owner.evaluate(async ({ board, fixtureModule }) => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts'), { convertToExcalidrawElements } = await import(fixtureModule)
    const elements = convertToExcalidrawElements(Array.from({ length: 24 }, (_, i) => ({ id: `seed-${i}`, type: 'rectangle', x: (i % 8) * 70, y: Math.floor(i / 8) * 70, width: 40, height: 40, customData: { payload: `seed-${i}:` + '🌍'.repeat(20000) } })), { regenerateIds: false })
    const scene = { elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} }
    await workspaceApi.saveBoard({ ...board, scene })
    return scene
  }, { board, fixtureModule })
  console.log('Large scene saved locally; waiting for its normal workspace sync receipt.')
  await eventually(async () => await owner.evaluate(async id => {
    const { workspaceStore } = await import('/src/features/workspace/workspace-api.ts')
    const current = await workspaceStore.loadBoard(id)
    return current?.syncStatus === 'synced'
  }, boardId), 'The fixture board must sync through the normal workspace worker', live ? 360000 : 120000)
  console.log('Chunked scene committed; enabling public editor link.')
  await owner.evaluate(async ({ board, ownerId, fixtureModule }) => {
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts'), { convertToExcalidrawElements } = await import(fixtureModule)
    const elements = convertToExcalidrawElements(Array.from({ length: 24 }, (_, i) => ({ id: `seed-${i}`, type: 'rectangle', x: (i % 8) * 70, y: Math.floor(i / 8) * 70, width: 40, height: 40, customData: { payload: `seed-${i}:` + '🌍'.repeat(20000) } })), { regenerateIds: false })
    const scene = { elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} }
    const config = await sharingService.getShareConfig(board.id, { ownerId, boardName: board.name, scene })
    await sharingService.saveShareConfig({ ...config, generalAccess: 'anyone_with_link', generalRole: 'editor', scene })
  }, { board, ownerId: setup.ownerId, fixtureModule })
  const fixture = { id: boardId, projectId, ownerId: setup.ownerId }
  console.log('Dev fixture created; opening owner and two isolated guest editor contexts.')
  boardId = fixture.id; root = `boardScenes/${boardId}`
  const guestA = await tab('guest-a'), guestB = await tab('guest-b')
  console.log('Opening registered owner board tab.')
  await open(owner)
  console.log('Opening guest A board tab.')
  await open(guestA)
  console.log('Opening guest B board tab.')
  await open(guestB)
  console.log('Owner and guest tabs loaded; waiting for all three collaboration sessions.')
  await eventually(async () => (await Promise.all([owner, guestA, guestB].map(p => p.evaluate(() => !!window.__lazyCollab?.isLazyCollabActive)))).every(Boolean), 'Three real editors must join collaboration')
  for (const p of [owner, guestA, guestB]) await idle(p)
  const initial = await durable(); generation = initial.current.generation
  assert.ok(initial.refs.length >= 5, 'Fixture must exercise at least five cloud chunks')
  assert.deepEqual(ids(initial.elements), Array.from({ length: 24 }, (_, i) => `seed-${i}`).sort())
  const policy = (await db.doc(`boardShares/${boardId}`).get()).data(), offlineBase = initial.current.currentVersionId
  const guestVersionIdsBefore = await Promise.all([guestA, guestB].map(async (page) =>
    (await ledger(page)).versions.map((version) => version.localVersionId),
  ))
  const ownerUid = await owner.evaluate(async () => (await import('/src/lib/firebase.ts')).getFirebaseAuth().currentUser.uid)
  stage('Shared multi-chunk baseline, three authenticated editor sessions', { chunks: initial.chunks })
  await evidence('Shared baseline', [owner, guestA, guestB], ['Three authenticated editors are collaborating', '24 expected shapes; five valid immutable scene chunks'])
  // CDP offline alone leaves established WebSockets alive. Disconnect BOTH Firebase transports too.
  await owner.evaluate(async fixtureModule => {
    const { getFirestoreDb, getFirebaseRtdb } = await import('/src/lib/firebase.ts'), { disableNetwork, goOffline } = await import(fixtureModule)
    await disableNetwork(getFirestoreDb()); goOffline(getFirebaseRtdb())
  }, fixtureModule)
  await owner.setOfflineMode(true); phase = 'divergent-offline'
  assert.equal(await owner.evaluate(() => navigator.onLine), false)
  const cloudBeforeOfflineEdits = await head(), roomBefore = (await rtdb.ref(`boards/${boardId}/generations/${generation}/elements`).get()).val()
  await drag(owner, 'seed-0', 55, 0); await captured(owner, 'First offline save captured')
  await drag(owner, 'seed-0', 35, 0); await captured(owner, 'Second conflicting offline move captured')
  await remove(owner, 'seed-1'); await captured(owner, 'Offline tombstone captured')
  const offlineAdded = await draw(owner, 950, 650); await captured(owner, 'Offline addition captured')
  assert.equal((await head()).currentVersionId, cloudBeforeOfflineEdits.currentVersionId, 'Offline gestures cannot publish the head')
  const roomAfter = (await rtdb.ref(`boards/${boardId}/generations/${generation}/elements`).get()).val()
  // Joining collaborators may refresh actor/timestamp metadata on existing RTDB records.
  // Compare the full canonical scene payload and identity/version fences, which detect
  // every drawing, deletion, addition, or overwrite that could leak from the offline owner.
  const sceneState = room => Object.fromEntries(Object.entries(room ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => [id, {
    data: value.data, generation: value.generation, id: value.id, restoreFence: value.restoreFence,
    version: value.version, versionNonce: value.versionNonce,
  }]))
  assert.deepEqual(sceneState(roomAfter), sceneState(roomBefore), 'Offline gestures cannot leak scene data through an existing RTDB socket')
  assert.ok(!(await canvas(guestA)).some(e => e.id === offlineAdded.id), 'Online peers cannot see untransmitted offline shapes')
  const localBefore = await ledger(owner), retained = []
  for (const entry of localBefore.outbox) {
    const snapshot = await owner.evaluate(async ({ id, version, fixtureModule }) => { const { boardHistoryStore } = await import(fixtureModule); return boardHistoryStore.get(id, version) }, { id: boardId, version: entry.localVersionId, fixtureModule })
    retained.push({ name: snapshot.document.name, notes: snapshot.notes, id: entry.localVersionId, parent: snapshot.version.parentLocalVersionId, base: entry.sourceBaseVersionId, fingerprint: fingerprint(snapshot.document.scene.elements), capturedAt: snapshot.version.capturedAt })
  }
  assert.ok(retained.length >= 4); assert.ok(retained.every(c => c.base === offlineBase))
  await drag(guestA, 'seed-0', 0, 35)
  const cloudChanged = await drag(guestB, 'seed-2', 0, 45)
  await remove(guestA, 'seed-3')
  const onlineAddedA = await draw(guestA, 1050, 600), onlineAddedB = await draw(guestB, 1100, 730)
  const onlineExpected = Array.from({ length: 24 }, (_, i) => `seed-${i}`).filter(id => id !== 'seed-3').concat(onlineAddedA.id, onlineAddedB.id).sort()
  // Public editors persist through their ordinary history outbox. Wait for its
  // receipts before asking the independent Firestore/RTDB oracle to compare the
  // shared diagram; otherwise this checks cloud convergence while the saves are
  // still explicitly pending locally.
  const guestCaptures = await eventually(async () => {
    const captures = await Promise.all([guestA, guestB].map(async (page, index) => {
      const versions = (await ledger(page)).versions.map((version) => version.localVersionId)
      return versions.filter((id) => !guestVersionIdsBefore[index].includes(id))
    }))
    return captures.every((entries) => entries.length > 0) ? captures : null
  }, 'Each online guest creates at least one history capture after its debounced scene save', 30000)
  guestCaptures[0] = await idle(guestA, guestCaptures[0], guestVersionIdsBefore[0])
  guestCaptures[1] = await idle(guestB, guestCaptures[1], guestVersionIdsBefore[1])
  drawDiagnostics = await Promise.all([guestA, guestB].map(async (page, index) => ({
    peer: index === 0 ? 'guest-a' : 'guest-b',
    drawn: [onlineAddedA, onlineAddedB][index],
    rendered: (await canvas(page)).filter((element) => element.id === [onlineAddedA, onlineAddedB][index].id),
    persisted: (await durable()).elements.filter((element) => element.id === [onlineAddedA, onlineAddedB][index].id),
    realtime: await rtdb.ref(`boards/${boardId}/generations/${generation}/elements/${[onlineAddedA, onlineAddedB][index].id}`).get().then((snapshot) => snapshot.val()),
  })))
  stage('Online guest scene/history outboxes drain with accepted receipts', {
    guestCaptures: guestCaptures.map((captures) => captures.length),
  })
  await converge([guestA, guestB], onlineExpected)
  const remoteBefore = await durable(), onlineCommon = remoteBefore.elements.find(e => e.id === 'seed-0'), localCommon = localBefore.current.document.scene.elements.find(e => e.id === 'seed-0')
  assert.ok((await head()).currentVersionId !== offlineBase, 'Online peers publish while owner is disconnected')
  assert.equal((await canvas(owner)).some(e => e.id === onlineAddedA.id), false, 'Offline owner remains unaware of remote edits')
  assert.equal((await canvas(owner)).find(e => e.id === 'seed-2').y, initial.elements.find(e => e.id === 'seed-2').y)
  const winner = localCommon.version > onlineCommon.version || localCommon.version === onlineCommon.version && localCommon.versionNonce < onlineCommon.versionNonce ? localCommon : onlineCommon
  assert.notDeepEqual([localCommon.x, localCommon.y], [onlineCommon.x, onlineCommon.y], 'Same-shape histories actually diverged')
  const canonicalBefore = (await db.collection(`${root}/versions`).get()).docs.filter(d => d.data().origin === 'cloud').map(d => d.id)
  stage('Two remaining peers converge while owner retains a distinct local branch', { retained, cloudVersion: remoteBefore.current.currentVersionId, winner: { id: winner.id, x: winner.x, y: winner.y, version: winner.version, nonce: winner.versionNonce } })
  await evidence('Divergent histories before reconnect', [owner, guestA, guestB], ['Owner has four durable offline captures', 'Guests match the latest cloud board', 'Owner cannot see remote changes'])
  phase = 'reconnecting'
  if (lostReplyMode) {
    faultCdp = await owner.createCDPSession()
    await faultCdp.send('Network.enable')
    const listener = event => {
      const task = (async () => {
        const request = event.request.method === 'POST' ? JSON.parse(event.request.postData || '{}').data : null
        if (!droppedReceipt && event.responseStatusCode === 200 && request?.captureMutationId === retained[0].id) {
          const receipt = (await db.doc(`${root}/importReceipts/${request.captureMutationId}`).get()).data()
          assert.ok(receipt, 'Server accepted capture before its response was deliberately lost')
          assert.equal(receipt.actorUid, ownerUid)
          assert.equal(receipt.result.generation, generation)
          assert.equal(fingerprint((await durable((await db.doc(`${root}/versions/${receipt.result.localSnapshotVersionId}`).get()).data().sceneRevisionId)).elements), retained[0].fingerprint)
          droppedReceipt = { captureId: request.captureMutationId, result: receipt.result, at: Date.now() }
          await faultCdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionFailed' })
        } else await faultCdp.send('Fetch.continueRequest', { requestId: event.requestId })
      })()
      faultTasks.add(task)
      task.then(() => faultTasks.delete(task), error => { faultTasks.delete(task); faultErrors.push(String(error)); void faultCdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {}) })
    }
    faultCdp.on('Fetch.requestPaused', listener)
    await faultCdp.send('Fetch.enable', { patterns: [{ urlPattern: live ? 'https://us-central1-open-excalidraw-dev-2.cloudfunctions.net/importBoardVersion' : '*45001*importBoardVersion', requestStage: 'Response' }] })
    stopFault = async () => { faultCdp.off('Fetch.requestPaused', listener); await Promise.allSettled([...faultTasks]); await faultCdp.send('Fetch.disable'); await faultCdp.detach(); assert.deepEqual(faultErrors, [], 'Fault interception must finish without callback failures') }
  }
  await owner.setOfflineMode(false)
  // Apply after Puppeteer's offline toggle, which resets CDP network conditions.
  if (faultCdp) await faultCdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 4 * 1024 * 1024, uploadThroughput: 2 * 1024 * 1024 })
  await owner.evaluate(async fixtureModule => {
    const { getFirestoreDb, getFirebaseRtdb } = await import('/src/lib/firebase.ts'), { enableNetwork, goOnline } = await import(fixtureModule)
    goOnline(getFirebaseRtdb()); await enableNetwork(getFirestoreDb())
  }, fixtureModule)
  const expected = Array.from({ length: 24 }, (_, i) => `seed-${i}`).filter(id => !['seed-1', 'seed-3'].includes(id)).concat(offlineAdded.id, onlineAddedA.id, onlineAddedB.id).sort()
  // Reconnect first drains the immutable offline-history outbox, then publishes
  // its current head through the ordinary scene commit path. Waiting for the
  // owner's acknowledged head prevents a fast test timeout from mistaking the
  // valid in-flight merge window for permanent divergence.
  await idle(owner, retained.map(c => c.id))
  await idle(guestA); await idle(guestB)
  await converge([owner, guestA, guestB], expected)
  const merged = await durable(), common = merged.elements.find(e => e.id === 'seed-0')
  assert.deepEqual([common.x, common.y, common.version, common.versionNonce], [winner.x, winner.y, winner.version, winner.versionNonce], 'Conflicting shape converges to deterministic version/nonce winner')
  assert.equal(merged.elements.find(e => e.id === 'seed-2').y, cloudChanged.y, 'Unrelated remote movement survives reconnect')
  for (const id of ['seed-1', 'seed-3']) assert.equal(merged.elements.find(e => e.id === id).isDeleted, true, 'Both independent tombstones survive')
  assert.equal(merged.current.generation, generation, 'Ordinary reconnect must not manufacture a restoration universe')
  // Joining publishers can change transport attribution across all records. Reuse is required
  // for byte-identical chunks, not for visually unchanged chunks with different bytes.
  for (const ref of merged.refs) {
    const unchanged = remoteBefore.refs.find(old => old.digest === ref.digest)
    if (unchanged) assert.equal(ref.chunkId, unchanged.chunkId, 'Byte-identical current-base chunks retain their identities')
  }
  const versions = await db.collection(`${root}/versions`).get(), receipts = await db.collection(`${root}/importReceipts`).get(), localAfter = await ledger(owner)
  for (const c of retained) {
    const receipt = receipts.docs.find(d => d.id === c.id)?.data(); assert.ok(receipt, 'Every exact offline capture has one stable receipt')
    assert.equal(receipt.result.generation, generation)
    assert.equal(receipt.actorUid, ownerUid, 'Receipt belongs to the authenticated device that submitted this capture')
    assert.equal(Date.parse(receipt.result.expiresAt) - Date.parse(receipt.result.acceptedAt), 30 * 24 * 60 * 60 * 1000, 'First acceptance fixes the thirty-day lifetime')
    const versionId = receipt.result.localSnapshotVersionId, version = versions.docs.find(d => d.id === versionId)?.data(); assert.ok(version)
    assert.equal(version.sceneGeneration, generation)
    assert.equal(version.serverCreatedAt.toDate().toISOString(), receipt.result.acceptedAt)
    assert.equal(version.expiresAt.toDate().toISOString(), receipt.result.expiresAt)
    assert.equal(version.boardName, c.name, 'Historical name remains the captured name')
    const notesRoot = (await db.doc(`${root}/noteRevisions/${version.notesRevisionId}`).get()).data()
    assert.ok(notesRoot); assert.deepEqual(c.notes, {}); assert.equal(notesRoot.pageCount, 0, 'Empty captured notes remain empty, independently of scene chunks')
    assert.equal(fingerprint((await durable(version.sceneRevisionId)).elements), c.fingerprint, 'History preserves original offline bytes, not the merged canvas')
    assert.equal(localAfter.versions.find(v => v.localVersionId === c.id)?.uploadStatus, 'published')
    assert.equal(localAfter.versions.find(v => v.localVersionId === c.id)?.receipt.localSnapshotVersionId, versionId)
    if (!receipt.result.canonicalVersionId) {
      assert.equal(version.origin, 'offline-import'); assert.equal(version.sourceBaseVersionId, c.base)
      const branch = (await db.doc(`${root}/branches/${version.branchId}`).get()).data()
      assert.equal(branch.kind, 'local-import'); assert.equal(branch.forkVersionId, offlineBase)
      const publication = await owner.evaluate(async ({ id, version, fixtureModule }) => { const { boardHistoryStore } = await import(fixtureModule); return boardHistoryStore.getImportPublication(id, version) }, { id: boardId, version: c.id, fixtureModule })
      assert.ok(publication, 'Accepted capture retains its staging identity locally')
      assert.equal(versions.docs.filter(d => d.data().mutationId === publication.commitId).length, 1, 'Accepted staging identity publishes exactly one immutable version')
      const previousCapture = retained.find(old => old.id === c.parent)
      if (previousCapture) {
        const parentReceipt = receipts.docs.find(d => d.id === previousCapture.id).data().result
        assert.equal(version.parentVersionId, parentReceipt.localSnapshotVersionId, 'Imported descendant retains its accepted parent')
        const parentVersion = versions.docs.find(d => d.id === parentReceipt.localSnapshotVersionId).data()
        assert.equal(version.branchSequence, parentReceipt.canonicalVersionId ? 1 : parentVersion.branchSequence + 1)
      }
    }
  }
  assert.ok(canonicalBefore.every(id => versions.docs.some(d => d.id === id)), 'Online peers historical saves are not replaced by offline imports')
  assert.deepEqual((await db.doc(`boardShares/${boardId}`).get()).data(), policy, 'Reconnection cannot change sharing policy')
  assert.equal((await db.collection(`${root}/restoreOperations`).get()).size, 0)
  const room = (await rtdb.ref(`boards/${boardId}`).get()).val()
  assert.equal(room.generation, generation); assert.equal(room.restoreFence, merged.current.restoreFence)
  assert.equal(room.restoreOperationId ?? null, null)
  const presence = (await rtdb.ref(`presence/${boardId}/generations/${generation}`).get()).val() ?? {}
  assert.ok(Object.keys(presence).length >= 3, 'Every reconnected editor is present in the current generation')
  for (const p of Object.values(presence)) { assert.equal(p.generation, generation); assert.equal(p.restoreFence, merged.current.restoreFence) }
  for (const [id, record] of Object.entries(room.generations[generation].elements)) {
    assert.equal(record.id, id); assert.equal(record.generation, generation); assert.equal(record.restoreFence, merged.current.restoreFence)
    const element = JSON.parse(record.data), canonical = merged.elements.find(e => e.id === id)
    assert.ok(canonical, 'Realtime records have corresponding canonical elements after drain')
    assert.deepEqual([element.x, element.y, element.isDeleted], [canonical.x, canonical.y, canonical.isDeleted], 'Realtime and canonical drawing content agrees')
    if (id === 'seed-0') assert.deepEqual([element.version, element.versionNonce], [canonical.version, canonical.versionNonce], 'The genuinely contested element keeps the canonical deterministic LWW winner in RTDB')
    if (id.startsWith('seed-')) assert.equal(digest(element.customData.payload), digest(`${id}:` + '🌍'.repeat(20000)))
  }
  const peerUids = await Promise.all([owner, guestA, guestB].map(p => p.evaluate(async () => (await import('/src/lib/firebase.ts')).getFirebaseAuth().currentUser.uid)))
  for (const uid of peerUids) assert.ok(Object.values(presence).some(p => p.userId === uid), 'Every known authenticated peer has current-generation presence')
  const reconnectCalls = calls.filter(c => c.phase === 'reconnecting')
  assert.ok(reconnectCalls.some(c => c.peer === 'owner' && c.endpoint === 'importBoardVersion'), 'Automatic reconnect really uploads retained captures')
  assert.ok(reconnectCalls.some(c => c.endpoint === 'commitBoardScene'), 'Merged scene really traverses cloud publication')
  for (const c of reconnectCalls.filter(c => ['importBoardVersion', 'commitBoardScene'].includes(c.endpoint))) assert.equal(c.data.boardId, boardId)
  assert.equal(calls.filter(c => c.endpoint === 'restoreBoardVersion').length, 0, 'Reconnect never invokes destructive restore')
  // A live request may remain unreadable after a transport disconnect. Never let
  // response-body telemetry hang teardown and mask the actual test failure.
  await Promise.race([Promise.allSettled([...responseTasks]), new Promise(resolve => setTimeout(resolve, 5000))])
  for (const c of retained) {
    const acknowledged = receipts.docs.find(d => d.id === c.id).data().result.localSnapshotVersionId
    assert.ok(responses.some(r => r.peer === 'owner' && r.status === 200 && r.data.captureMutationId === c.id &&
      (r.endpoint === 'importBoardVersion' && r.result.localSnapshotVersionId === acknowledged || r.endpoint === 'boardHistory' && r.data.operation === 'receipt' && r.result.receipt?.localSnapshotVersionId === acknowledged)), 'Observed network acknowledgement maps this capture to its exact persisted history ID')
  }
  assert.ok(responses.some(r => r.phase === 'reconnecting' && r.endpoint === 'commitBoardScene' && r.status === 200))
  assert.ok(responses.every(r => !r.error || r.error.status === 'ABORTED'), 'Only recoverable concurrent-head CAS conflicts are allowed in successful ordinary reconnect')
  if (lostReplyMode) {
    assert.ok(droppedReceipt, 'Fault mode really lost one accepted import response')
    const recovered = receipts.docs.find(d => d.id === droppedReceipt.captureId).data().result
    assert.deepEqual(recovered, droppedReceipt.result, 'Retry preserves original version ID, acceptance time and expiry')
    assert.equal(stable(localAfter.versions.find(v => v.localVersionId === droppedReceipt.captureId).receipt), stable({ localSnapshotVersionId: recovered.localSnapshotVersionId, canonicalVersionId: recovered.canonicalVersionId ?? undefined, acceptedAt: recovered.acceptedAt, expiresAt: recovered.expiresAt }), 'Native history automatically recovers the original durable receipt')
    assert.ok(calls.some(c => c.peer === 'owner' && c.at >= droppedReceipt.at && c.endpoint === 'boardHistory' && c.data.operation === 'receipt' && c.data.captureMutationId === droppedReceipt.captureId), 'Ambiguous acknowledgement causes a real receipt recovery request')
    stage('Slow reconnect recovers a lost accepted response without duplicate history', { droppedReceipt })
    await stopFault(); stopFault = null
  }
  stage('Automatic reconnect converges live peers/Firebase, preserves exact offline and cloud history', { mergedHead: merged.current.currentVersionId, ids: expected, chunks: merged.chunks, receipts: retained.length })
  await evidence('Converged after automatic reconnect', [owner, guestA, guestB], ['All canvases agree with independently decoded Firebase chunks', 'Both deletions and all independent additions survive', 'Every original capture has an exact immutable cloud snapshot', 'Outboxes drained; sharing and generation unchanged'])
  phase = 'history-preview'
  await owner.click('[data-testid="board-history-open"]'); await owner.waitForSelector('.history-entry')
  const visibleVersionIds = await owner.$$eval('.history-entry', rows => rows.map(row => row.dataset.versionId))
  for (const c of retained) {
    const id = receipts.docs.find(d => d.id === c.id).data().result.localSnapshotVersionId
    assert.ok(visibleVersionIds.includes(id), 'Uploaded offline version appears in the real history dialog')
  }
  const importedId = receipts.docs.find(d => d.id === retained[0].id).data().result.localSnapshotVersionId
  const previewOffset = calls.length, headBeforePreview = (await head()).currentVersionId
  await owner.click(`[data-version-id="${importedId}"]`)
  await owner.waitForSelector('[data-testid="history-preview-name"]')
  await owner.waitForFunction(() => !document.querySelector('[data-testid="history-restore"]')?.disabled)
  assert.match(await owner.$eval(`[data-version-id="${importedId}"]`, row => row.textContent), /Saved to cloud/)
  assert.ok(calls.slice(previewOffset).some(c => c.peer === 'owner' && c.endpoint === 'boardHistory' && c.data.operation === 'chunks'))
  assert.ok(!calls.slice(previewOffset).some(c => c.peer === 'owner' && ['commitBoardScene', 'importBoardVersion', 'updateBoardContent', 'restoreBoardVersion'].includes(c.endpoint)), 'Historical preview is read-only')
  assert.equal((await head()).currentVersionId, headBeforePreview)
  await evidence('Historical offline snapshot preview', [owner], ['Uploaded versions appear as Saved to cloud', 'Selected version can be restored', 'Preview reads chunks without changing the current head'])
  await owner.screenshot({ path: `${artifacts}/divergence-history.png` }); await owner.click('[aria-label="Close board history"]')
  phase = 'cold-reader'
  const cold = await tab('cold-reader'); await open(cold)
  await converge([owner, guestA, guestB, cold], expected)
  await assertCanvasTieBreaks([owner, guestA, guestB, cold])
  await owner.reload(); await owner.waitForSelector('[data-testid="board-history-open"]:not(:disabled)')
  await converge([owner, guestA, guestB, cold], expected); await idle(owner)
  await assertCanvasTieBreaks([owner, guestA, guestB, cold])
  await idle(owner, retained.map(c => c.id))
  for (const c of retained) assert.equal((await ledger(owner)).versions.find(v => v.localVersionId === c.id)?.uploadStatus, 'published', 'Every original capture must still exist and be acknowledged after reload')
  await evidence('Fresh browser and owner reload', [cold, owner], ['Fresh guest and reloaded owner match the canonical diagram', 'Every original owner capture still exists and is published', 'No browser errors'])
  await owner.screenshot({ path: `${artifacts}/divergence-converged.png` })
  assert.deepEqual(errors, [])
  stage('Fresh browser and owner reload preserve the exact converged diagram and acknowledged history')
  console.log('PASS divergence: real three-editor offline/online flow, five chunks, conflict winner, independent deletions/additions, exact history receipts, read-only preview, fresh browser and reload')
} finally {
  if (stopFault) await stopFault().catch(error => faultErrors.push(String(error)))
  await Promise.allSettled([...responseTasks])
  diagnostics = await Promise.all(peers.map(async ({ name, page }) => ({ peer: name, state: await page.evaluate(() => ({ text: document.body.innerText.slice(0, 2500), collab: window.__lazyCollab, elements: window.__excalidrawAPI?.getSceneElementsIncludingDeleted().map(({ id, x, y, width, height, version, versionNonce, updated, isDeleted }) => ({ id, x, y, width, height, version, versionNonce, updated, isDeleted })) })).catch(() => null), ledger: boardId ? await ledger(page).then(l => ({ current: { name: l.current?.document.name, generation: l.current?.document.cloudGeneration, revision: l.current?.document.revision, versionId: l.current?.document.cloudVersionId }, outbox: l.outbox })).catch(() => null) : null })))
  await writeFile(`${artifacts}/divergence-report.json`, JSON.stringify({ phase, live, firebaseProject: live ? 'open-excalidraw-dev-2' : 'demo-regression', frontend: base, screenshots, inspection, lostReplyMode, droppedReceipt, faultErrors, stages, calls, responses, failures, errors, diagnostics, drawDiagnostics, convergenceDiagnostics, head: root ? await head().catch(() => null) : null }, null, 2))
  if (live) browser.disconnect(); else await browser.close()
  await db.terminate(); if (app) await deleteApp(app)
}
