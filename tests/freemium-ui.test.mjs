import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
const { server } = await import('./freemium-dev-server.mjs')
const ar = createRequire(new URL('../functions/package.json', import.meta.url))
const aa = ar('firebase-admin/app'),
  af = ar('firebase-admin/firestore'),
  au = ar('firebase-admin/auth')
Object.assign(process.env, {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:18580',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19599',
})
const admin = aa.initializeApp({ projectId: 'demo-whiteboard-freemium' }),
  db = af.getFirestore(admin)
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const page = await browser.newPage(),
  errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.setViewport({ width: 1440, height: 1000 })
await page.setRequestInterception(true)
page.on('request', (req) =>
  /googleapis.com|firebaseio.com|cloudfunctions.net/.test(new URL(req.url()).hostname)
    ? void req.abort('blockedbyclient')
    : void req.continue(),
)
const clickText = async (text) =>
  page.evaluate((text) => {
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === text)
    if (!button) throw Error(`Missing button: ${text}`)
    button.click()
  }, text)
const waitText = (text) => page.waitForFunction((text) => document.body.innerText.includes(text), {}, text)
try {
  await page.goto('http://127.0.0.1:15175', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__freemium))
  const email = `ui-${Date.now()}@example.test`,
    password = 'Synthetic-fixture-123!'
  const uid = await page.evaluate(
    async ({ email, password }) => {
      const h = window.__freemium
      await h.auth.createUserWithEmailAndPassword(h.firebase.getFirebaseAuth(), email, password)
      return h.firebase.getFirebaseAuth().currentUser.uid
    },
    { email, password },
  )
  await waitText('Upgrade to Pro')
  await clickText('Upgrade to Pro')
  await waitText('Plan and cloud usage')
  await waitText('Images smaller than 5 MiB')
  assert.ok(await page.$eval('.account-primary', (el) => el.disabled), 'Unverified email cannot request Pro')
  await page.click('[aria-label="Close plan and usage"]')
  await au.getAuth(admin).updateUser(uid, { emailVerified: true })
  await page.evaluate(async () => {
    const h = window.__freemium
    await h.auth.signOut(h.firebase.getFirebaseAuth())
  })
  await page.evaluate(
    async ({ email, password }) => {
      const h = window.__freemium
      await h.auth.signInWithEmailAndPassword(h.firebase.getFirebaseAuth(), email, password)
    },
    { email, password },
  )
  await waitText('Upgrade to Pro')
  await db.doc(`accountUsage/${uid}`).update({ boards: 2, assetBytes: 20 * 1024 ** 2 })
  await page.evaluate(() => window.dispatchEvent(new Event('account-usage-changed')))
  await waitText('approaching your allowance.')
  await page.click('[aria-label="Dismiss usage warning"]')
  assert.equal(await page.$('.cloud-quota-banner'), null)
  await db.doc(`accountUsage/${uid}`).update({ boards: 3, assetBytes: 24 * 1024 ** 2 })
  await page.evaluate(() => window.dispatchEvent(new Event('account-usage-changed')))
  await waitText('at or near capacity.')
  await clickText('Upgrade to Pro')
  await waitText('3 / 3')
  await clickText('Request Pro access')
  await waitText('Request recorded.')
  assert.equal((await db.doc(`proAccessRequests/${uid}`).get()).data().status, 'requested')
  await mkdir(new URL('../logs/freemium-ui/', import.meta.url), { recursive: true })
  await page.screenshot({
    path: new URL('../logs/freemium-ui/free-desktop.png', import.meta.url).pathname,
    fullPage: true,
  })
  await page.setViewport({ width: 390, height: 844 })
  await page.screenshot({
    path: new URL('../logs/freemium-ui/free-mobile.png', import.meta.url).pathname,
    fullPage: true,
  })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Mobile page does not overflow horizontally',
  )
  await page.click('[aria-label="Close plan and usage"]')
  await page.evaluate(async () => {
    try {
      await window.__freemium.account.cloudCall('reserveCloudAsset', {
        boardId: 'upgrade-warning-fixture',
        fileId: 'too-large',
        bytes: 5 * 1024 ** 2,
        mimeType: 'image/png',
      })
    } catch (error) {
      if (error.code !== 'functions/resource-exhausted') throw error
    }
  })
  await page.waitForSelector('.cloud-quota-banner')
  await db.doc('adminConfig/complimentaryUsers').set({ emails: [email] })
  await page.evaluate(() => window.dispatchEvent(new Event('account-usage-changed')))
  await waitText('Pro')
  await page.waitForSelector('.cloud-quota-banner', { hidden: true })
  await clickText('Pro')
  await waitText('Complimentary, no subscription required')
  assert.equal(await page.$('.account-primary'), null, 'Complimentary users do not get an upgrade request CTA')
  await page.screenshot({
    path: new URL('../logs/freemium-ui/complimentary-mobile.png', import.meta.url).pathname,
    fullPage: true,
  })
  await page.click('[aria-label="Close plan and usage"]')
  const recovery = await page.evaluate(async () => {
    const h = window.__freemium,
      scene = { elements: [], appState: {}, files: {} },
      key = 'test-recovery'
    const old = await h.recovery.saveGuestRecovery(key, scene),
      latest = await h.recovery.saveGuestRecovery(key, { ...scene, appState: { theme: 'dark' } })
    await h.recovery.clearGuestRecovery(key, old)
    return { latest, stored: await h.recovery.readGuestRecovery(key) }
  })
  assert.equal(recovery.stored.operationId, recovery.latest, 'An old acknowledgement cannot erase newer local recovery')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__freemium))
  const restored = await page.evaluate(() => window.__freemium.recovery.readGuestRecovery('test-recovery'))
  assert.equal(restored.operationId, recovery.latest, 'Shared recovery survives reload')
  const pooledReset = await page.evaluate(() =>
    window.__freemium.account.pauseUntil({
      code: 'functions/resource-exhausted',
      details: { metric: 'sharedPool', limit: 2000 },
    }),
  )
  assert.equal(pooledReset, new Date(Date.parse(new Date().toISOString().slice(0, 10)) + 86400000).toISOString())
  await db.doc('adminConfig/complimentaryUsers').set({ emails: [] })
  await db.doc(`accountUsage/${uid}`).update({ boards: 0, assetBytes: 0 })
  await page.evaluate(() => window.dispatchEvent(new Event('account-usage-changed')))
  const localBoards = await page.evaluate(async () => {
    const api = window.__freemium.workspace.workspaceApi
    const { projects } = await api.listWorkspace()
    const project = projects[0] ?? (await api.createProject('Quota fixture'))
    const boards = []
    for (let n = 0; n < 3; n++) boards.push(await api.createBoard(project.id, `Quota board ${n}`))
    return boards
  })
  await page.waitForFunction(
    async (ids) => {
      const documents = await Promise.all(ids.map((id) => window.__freemium.workspace.workspaceStore.loadBoard(id)))
      return documents.every((document) => document?.syncStatus === 'synced')
    },
    { timeout: 45000 },
    localBoards.map((board) => board.id),
  )
  localBoards.push(
    await page.evaluate(
      (projectId) => window.__freemium.workspace.workspaceApi.createBoard(projectId, 'Fourth local board'),
      localBoards[0].projectId,
    ),
  )
  await page.waitForFunction(
    async (id) => (await window.__freemium.workspace.workspaceStore.loadBoard(id))?.syncStatus === 'sync-failed',
    { timeout: 45000 },
    localBoards[3].id,
  )
  const localOnly = await page.evaluate(async (id) => {
    const h = window.__freemium,
      document = await h.workspace.workspaceStore.loadBoard(id)
    const saved = await h.workspace.workspaceApi.saveBoard({
      ...document,
      scene: { ...document.scene, elements: [{ id: 'offline-rectangle', type: 'rectangle', version: 1 }] },
    })
    return { saved, persisted: await h.workspace.workspaceStore.loadBoard(id), previousPause: document.nextSyncAt }
  }, localBoards[3].id)
  assert.equal(localOnly.persisted.scene.elements[0].id, 'offline-rectangle')
  assert.equal(localOnly.saved.syncStatus, 'sync-failed')
  assert.equal(localOnly.saved.nextSyncAt, localOnly.previousPause, 'Local edits preserve quota retry delay')
  assert.equal(
    (await db.doc(`users/${uid}/projects/${localBoards[3].projectId}/boards/${localBoards[3].id}`).get()).exists,
    false,
    'Fourth board remains local',
  )
  assert.deepEqual(errors, [])
  console.log('PASS Free alerts, Pro request, complimentary CTA, responsive layout, and local recovery UI checks')
} finally {
  await browser.close()
  await aa.deleteApp(admin)
  await server.close()
}
