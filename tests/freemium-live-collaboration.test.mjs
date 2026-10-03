// Real dev collaboration capture. Never uses production or emulator fixtures.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
import {
  projectId,
  adminAuth,
  fixtureToken,
  adminFetch,
  patchDocument,
  deleteTree,
  closeAdmin,
} from './freemium-live-admin.mjs'

if (process.env.FREEMIUM_LIVE_PROJECT !== projectId) throw new Error(`Opt in with FREEMIUM_LIVE_PROJECT=${projectId}`)
for (const key of Object.keys(process.env))
  if (key.endsWith('_EMULATOR_HOST')) throw new Error('Live capture cannot use emulators.')
const baseUrl = 'http://127.0.0.1:15176'
const directory = new URL('../logs/freemium-live/', import.meta.url)
const boardId = `collab-limits-${Date.now()}`
const users = [],
  pages = [],
  slides = [],
  checks = [],
  cleanupErrors = [],
  errors = []
let browser, signer, failure
async function call(page, name, data = {}) {
  return page.evaluate(
    async ({ name, data }) => (await import('/src/features/account/cloud-api.ts')).cloudCall(name, data),
    { name, data },
  )
}
const rtdbUrl = (key) => `https://${projectId}-default-rtdb.firebaseio.com/${key}/${boardId}.json`
async function until(work, message, timeout = 45000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await work()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(message)
}
async function check(name, work) {
  await work()
  checks.push(name)
  console.log(`PASS ${name}`)
}
async function capture(page, file, title, detail) {
  await page.screenshot({ path: new URL(file, directory).pathname, fullPage: true })
  slides.push({ file, title, detail })
}
async function newPage(token) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  pages.push(page)
  page.setDefaultTimeout(45000)
  await page.setViewport({ width: 1440, height: 1000 })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', (dialog) => dialog.accept())
  page.on('console', (message) => {
    if (message.type() === 'warn' && /permission|presence|session|denied/.test(message.text()))
      console.log('Browser diagnostic:', message.text())
  })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  assert.equal(
    await page.evaluate(async () => (await import('/src/lib/firebase.ts')).getFirebaseApp().options.projectId),
    projectId,
  )
  if (token) {
    for (let attempt = 0; ; attempt++) {
      try {
        await page.evaluate(async (token) => {
          const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
          const { signInWithCustomToken } = await import('/node_modules/.vite/deps/firebase_auth.js')
          await signInWithCustomToken(getFirebaseAuth(), token)
        }, token)
        break
      } catch (error) {
        if (!error.message.includes('auth/invalid-custom-token') || attempt >= 20) throw error
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    }
  }
  return page
}
async function openBoard(page) {
  await page.goto(`${baseUrl}/boards/${boardId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
}
async function propagate(page, shape, color) {
  return page.evaluate(
    async ({ shape, color }) => {
      const { convertToExcalidrawElements } = await import('/node_modules/.vite/deps/@excalidraw_excalidraw.js')
      const api = window.__excalidrawAPI
      const element = convertToExcalidrawElements([
        {
          type: shape,
          x: shape === 'ellipse' ? 390 : 80,
          y: 230,
          width: 230,
          height: 140,
          backgroundColor: color,
          fillStyle: 'solid',
          strokeColor: color,
        },
      ])[0]
      api.updateScene({ elements: [...api.getSceneElements(), element] })
      // Exercise the actual app's collaboration broadcaster and server endpoint.
      await window.__collab.broadcastChanges(api.getSceneElements())
      api.scrollToContent(api.getSceneElements(), { fitToContent: true, animate: false })
      return element.id
    },
    { shape, color },
  )
}
try {
  for (const name of ['Avery Owner', 'Blake Editor', 'Casey Editor', 'Drew Editor']) {
    users.push(
      await adminAuth.createUser({
        email: `collab-e2e-${boardId}-${users.length}@example.test`,
        emailVerified: true,
        displayName: name,
      }),
    )
  }
  await writeFile(
    new URL('collaboration-fixtures.json', directory),
    JSON.stringify({ boardId, uids: users.map((user) => user.uid) }, null, 2),
  )
  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  signer = await fixtureToken(
    users[0].uid,
    users.slice(1).map((user) => user.uid),
  )
  for (const user of users) await newPage(signer.tokens[user.uid])
  await signer.revoke()
  signer = undefined
  const owner = pages[0]
  await call(owner, 'commitCloudBoard', {
    mode: 'share-config',
    boardId,
    operationId: randomUUID(),
    document: {
      boardName: 'Live collaboration limits',
      ownerId: users[0].uid,
      ownerName: 'Avery Owner',
      ownerEmail: users[0].email,
      generalAccess: 'anyone_with_link',
      generalRole: 'editor',
      invitedEmails: [],
      collaborators: {},
    },
  })
  const scene = await owner.evaluate(async () => {
    const { convertToExcalidrawElements } = await import('/node_modules/.vite/deps/@excalidraw_excalidraw.js')
    return {
      elements: convertToExcalidrawElements([
        { type: 'text', x: 80, y: 60, text: 'Live collaboration', fontFamily: 2, fontSize: 32, strokeColor: '#e9e6ff' },
        {
          type: 'text',
          x: 80,
          y: 120,
          text: 'Each tab/device consumes a session slot\nThe board owner’s plan controls capacity',
          fontFamily: 2,
          fontSize: 20,
          strokeColor: '#a9a4c8',
        },
      ]),
      appState: { viewBackgroundColor: '#101116' },
      files: {},
    }
  })
  await call(owner, 'commitCloudBoard', {
    mode: 'shared-scene',
    boardId,
    operationId: randomUUID(),
    document: { scene },
  })
  // Existing deployed access mirrors have project-sharing fields; wait for their policy.
  await until(
    async () => (await adminFetch(rtdbUrl('boardAccess')))?.blocked === false,
    'Existing access mirror did not publish a usable board policy.',
  )
  await check('two real users enter live collaboration and exchange edits', async () => {
    await openBoard(owner)
    await openBoard(pages[1])
    await owner.waitForFunction(
      () => window.__lazyCollab?.isLazyCollabActive && window.__collab?.activeCollaborators.length >= 1,
    )
    await pages[1].waitForFunction(
      () => window.__lazyCollab?.isLazyCollabActive && window.__collab?.activeCollaborators.length >= 1,
    )
    const rectangle = await propagate(owner, 'rectangle', '#a5d8ff')
    await pages[1].waitForFunction(
      (id) => window.__excalidrawAPI.getSceneElements().some((element) => element.id === id),
      {},
      rectangle,
    )
    const ellipse = await propagate(pages[1], 'ellipse', '#b2f2bb')
    await owner.waitForFunction(
      (id) => window.__excalidrawAPI.getSceneElements().some((element) => element.id === id),
      {},
      ellipse,
    )
    const records = await adminFetch(rtdbUrl('boards'))
    assert.ok(records.elements[rectangle] && records.elements[ellipse])
    await capture(
      owner,
      '10-live-collaboration.png',
      'Live editing across two browsers',
      'Two separate authenticated browser contexts exchange drawing elements through the actual RTDB + callable collaboration path.',
    )
  })
  await check('third Free browser fills capacity and shows the warning', async () => {
    await openBoard(pages[2])
    await pages[2].waitForFunction(() => document.body.innerText.includes('All Free live session slots'))
    await owner.waitForFunction(() => window.__collab?.activeCollaborators.length >= 2)
    const sessions = await adminFetch(rtdbUrl('sessionGrants'))
    assert.equal(Object.keys(sessions).length, 3)
    await capture(
      pages[2],
      '11-free-collab-full.png',
      'Free: three live sessions',
      'Owner + two editors occupy all three slots. The third browser receives the real server capacity notice.',
    )
  })
  await check('fourth Free browser is rejected and remains read-only', async () => {
    await openBoard(pages[3])
    await pages[3].waitForFunction(() => document.body.innerText.includes('live collaboration allowance is full'))
    await pages[3].waitForFunction(() => window.__excalidrawAPI.getAppState().viewModeEnabled === true)
    assert.equal(Object.keys(await adminFetch(rtdbUrl('sessionGrants'))).length, 3)
    await capture(
      pages[3],
      '12-free-collab-blocked.png',
      'Free: fourth session blocked',
      'Real server rejection. This browser can view the board snapshot but cannot enter live editing; the owner’s plan controls admission.',
    )
  })
  await check('owner Pro entitlement admits the fourth browser; guests stay Free', async () => {
    // Close the denied tab while the owner is still Free, so wake/reconnect
    // handlers cannot admit its old session during the entitlement transition.
    const guestContext = pages[3].browserContext()
    await pages[3].close()
    await patchDocument(`accountEntitlements/${users[0].uid}`, { plan: 'pro', active: true })
    await owner.evaluate(() => window.dispatchEvent(new Event('account-usage-changed')))
    pages[3] = await guestContext.newPage()
    await pages[3].setViewport({ width: 1440, height: 1000 })
    pages[3].on('dialog', (dialog) => dialog.accept())
    await openBoard(pages[3])
    await pages[3].waitForFunction(
      () => window.__collab?.activeCollaborators.length >= 3 && !window.__excalidrawAPI.getAppState().viewModeEnabled,
    )
    assert.equal(Object.keys(await adminFetch(rtdbUrl('sessionGrants'))).length, 4)
    assert.equal((await call(pages[3], 'getAccountUsage')).plan, 'free')
    await owner.waitForFunction(() => window.__collab?.activeCollaborators.length >= 3)
    await owner.waitForFunction(() =>
      [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Pro'),
    )
    await capture(
      owner,
      '13-pro-collaboration.png',
      'Pro: fourth editor can join',
      'The board owner has a real manual Pro entitlement. All four browsers collaborate while guest accounts remain Free. Pro supports ten sessions.',
    )
  })
  await check('Pro ten-session ceiling rejects an eleventh browser', async () => {
    for (let n = 0; n < 6; n++)
      await call(owner, 'admitCloudSession', { boardId, sessionId: `additional-pro-session-${n}` })
    assert.equal(Object.keys(await adminFetch(rtdbUrl('sessionGrants'))).length, 10)
    // Clone the already authenticated guest's storage without creating another credential.
    const extra = await pages[3].browserContext().newPage()
    pages.push(extra)
    await extra.setViewport({ width: 1440, height: 1000 })
    extra.on('dialog', (dialog) => dialog.accept())
    await openBoard(extra)
    await extra.waitForFunction(
      () =>
        document.body.innerText.includes('live collaboration allowance is full') &&
        window.__excalidrawAPI.getAppState().viewModeEnabled,
    )
    await capture(
      extra,
      '14-pro-collab-blocked.png',
      'Pro: eleventh session blocked',
      'Ten real server-admitted slots: four editing browsers + six additional session reservations. The next actual browser is rejected. Pro is not unlimited live concurrency.',
    )
  })
  assert.deepEqual(errors, [])
  console.log(`${checks.length} live collaboration checks passed`)
} catch (error) {
  failure = error
  for (let index = 0; index < Math.min(pages.length, 4); index++) {
    await pages[index]
      .screenshot({ path: new URL(`collaboration-failure-${index}.png`, directory).pathname, fullPage: true })
      .catch(() => {})
    console.log(
      `Failure page ${index}:`,
      (await pages[index].evaluate(() => document.body.innerText).catch(() => '')).slice(0, 1200),
    )
    console.log(
      `Collaboration state ${index}:`,
      await pages[index]
        .evaluate(() => ({
          active: window.__lazyCollab?.isLazyCollabActive,
          sessions: window.__lazyCollab?.activeSessions.length,
          collaborators: window.__collab?.activeCollaborators.length,
          viewMode: window.__excalidrawAPI?.getAppState().viewModeEnabled,
        }))
        .catch(() => ({})),
    )
  }
} finally {
  await browser?.close()
  if (signer) await signer.revoke().catch((error) => cleanupErrors.push(error.message))
  await deleteTree(`boardShares/${boardId}`).catch((error) => cleanupErrors.push(error.message))
  for (const user of users) {
    for (const path of [
      `users/${user.uid}`,
      `accountUsage/${user.uid}`,
      `accountEntitlements/${user.uid}`,
      `proAccessRequests/${user.uid}`,
    ])
      await deleteTree(path).catch((error) => cleanupErrors.push(error.message))
    await adminAuth.deleteUser(user.uid).catch((error) => cleanupErrors.push(error.message))
  }
  for (const key of ['boardAccess', 'sessionGrants', 'liveUsers', 'boards', 'activeSessions', 'presence'])
    await adminFetch(rtdbUrl(key), { method: 'DELETE' }).catch((error) => cleanupErrors.push(error.message))
  await closeAdmin()
  const results = { checks, slides, cleanupErrors, boardId, uids: users.map((user) => user.uid) }
  await writeFile(new URL('collaboration-results.json', directory), JSON.stringify(results, null, 2))
  if (!failure && !cleanupErrors.length) {
    const original = JSON.parse(await readFile(new URL('results.json', directory), 'utf8'))
    original.checks = [
      ...original.checks.filter((check) => !check.startsWith('Collaboration: ')),
      ...checks.map((check) => `Collaboration: ${check}`),
    ]
    original.slides = [...original.slides.filter((slide) => !/^1[0-4]-/.test(slide.file)), ...slides]
    original.collaboration = results
    await writeFile(new URL('results.json', directory), JSON.stringify(original, null, 2))
  }
}
if (failure || cleanupErrors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupErrors.map((message) => new Error(message))],
    'Live collaboration capture or cleanup failed',
  )
