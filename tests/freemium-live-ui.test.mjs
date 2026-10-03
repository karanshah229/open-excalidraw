// Explicitly opted-in live dev test. Creates and cleans up only its own fixtures.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import puppeteer from 'puppeteer-core'
import {
  projectId,
  adminAuth,
  readDocument,
  patchDocument,
  deleteTree,
  complimentaryFixture,
  closeAdmin,
  fixtureToken,
  adminFetch,
} from './freemium-live-admin.mjs'

const baseUrl = process.env.FREEMIUM_LIVE_URL ?? 'http://127.0.0.1:15176'
assert.equal(new URL(baseUrl).hostname, '127.0.0.1')
assert.notEqual(new URL(baseUrl).port, '5174')
if (process.env.FREEMIUM_LIVE_PROJECT !== projectId) throw new Error(`Opt in with FREEMIUM_LIVE_PROJECT=${projectId}`)
for (const key of Object.keys(process.env))
  if (key.endsWith('_EMULATOR_HOST')) throw new Error('Live tests cannot use emulators.')
const directory = new URL('../logs/freemium-live/', import.meta.url)
await mkdir(directory, { recursive: true })
const email = `freemium-e2e-${Date.now()}@example.test`,
  password = `Fixture-${randomUUID()}!`
const cleanupErrors = []
let testFailure
const checks = [],
  slides = [],
  boards = []
let user,
  browser,
  page,
  project,
  signingKey,
  listed = false
const waitText = (text) =>
  page.waitForFunction((text) => document.body.innerText.includes(text), { timeout: 45000 }, text)
const clickText = (text) =>
  page.evaluate((text) => {
    const button = [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === text)
    if (!button) throw new Error(`Missing button: ${text}`)
    button.click()
  }, text)
async function check(name, fn) {
  await fn()
  checks.push(name)
  console.log(`PASS ${name}`)
}
async function capture(file, title, detail) {
  await page.screenshot({ path: new URL(file, directory).pathname, fullPage: true })
  slides.push({ file, title, detail })
}
const call = (name, data = {}) =>
  page.evaluate(
    async ({ name, data }) => {
      const { cloudCall } = await import('/src/features/account/cloud-api.ts')
      return cloudCall(name, data)
    },
    { name, data },
  )
async function refresh() {
  await page.evaluate(() => window.dispatchEvent(new Event('account-usage-changed')))
}
async function boardDocument(id) {
  return page.evaluate(
    async (id) => (await import('/src/features/workspace/workspace-api.ts')).workspaceStore.loadBoard(id),
    id,
  )
}
async function saveBoard(name) {
  const board = await page.evaluate(
    async ({ projectId, name }) =>
      (await import('/src/features/workspace/workspace-api.ts')).workspaceApi.createBoard(projectId, name),
    { projectId: project.id, name },
  )
  boards.push(board)
  await page.waitForFunction(
    async (id) =>
      (await import('/src/features/workspace/workspace-api.ts')).workspaceStore
        .loadBoard(id)
        .then((board) => board?.syncStatus === 'synced'),
    { timeout: 60000 },
    board.id,
  )
  return board
}
try {
  user = await adminAuth.createUser({ email, password, emailVerified: true, displayName: 'Freemium preview' })
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  page = await browser.newPage()
  page.setDefaultTimeout(45000)
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', async (dialog) => {
    // Unsynced local edits intentionally trigger the app's navigation warning.
    if (dialog.type() === 'beforeunload') await dialog.accept()
    else {
      errors.push(`Unexpected dialog: ${dialog.message()}`)
      await dialog.dismiss()
    }
  })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await check('real dev Firebase configuration; registered authentication', async () => {
    const actual = await page.evaluate(
      async () => (await import('/src/lib/firebase.ts')).getFirebaseApp().options.projectId,
    )
    assert.equal(actual, projectId)
    // Authentication fixture only; product UI uses Google sign-in.
    signingKey = await fixtureToken(user.uid)
    for (let attempt = 0; ; attempt++) {
      try {
        await page.evaluate(async (token) => {
          const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
          const { signInWithCustomToken } = await import('/node_modules/.vite/deps/firebase_auth.js')
          await signInWithCustomToken(getFirebaseAuth(), token)
        }, signingKey.token)
        break
      } catch (error) {
        // Newly created Google signing keys can take a short time to propagate.
        if (!error.message.includes('auth/invalid-custom-token') || attempt >= 20) throw error
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    }
    await signingKey.revoke()
    signingKey = undefined
    await waitText('Upgrade to Pro')
  })
  await check('Free usage and pricing UI reads live callable', async () => {
    assert.equal((await call('getAccountUsage')).plan, 'free')
    await clickText('Upgrade to Pro')
    await waitText('Plan and cloud usage')
    await waitText('0 / 3')
    await capture(
      '01-free-plan.png',
      'Free plan and live usage',
      'Real dev account · live Firebase usage · Pro pricing and request CTA',
    )
    await page.click('[aria-label="Close plan and usage"]')
  })
  project = await page.evaluate(async () =>
    (await import('/src/features/workspace/workspace-api.ts')).workspaceApi.createProject('Freemium E2E preview'),
  )
  await check('two actual cloud boards trigger the early warning', async () => {
    await saveBoard('Product ideas')
    await saveBoard('Architecture')
    await waitText('approaching your allowance.')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitText('approaching your allowance.')
    await capture(
      '02-early-warning.png',
      'Warning before the limit',
      'Two boards saved to real Firestore · warning survives reload',
    )
  })
  await check('three cloud boards trigger the critical alert', async () => {
    await saveBoard('Planning')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitText('at or near capacity.')
    await capture(
      '03-critical-alert.png',
      'Free capacity reached',
      'Three real cloud boards · prominent alert with upgrade entry point',
    )
  })
  await check('fourth board rejected by cloud; edits persist locally', async () => {
    const board = await page.evaluate(
      async (projectId) =>
        (await import('/src/features/workspace/workspace-api.ts')).workspaceApi.createBoard(
          projectId,
          'Local board — cloud limit reached',
        ),
      project.id,
    )
    boards.push(board)
    await page.waitForFunction(
      async (id) =>
        (await import('/src/features/workspace/workspace-api.ts')).workspaceStore
          .loadBoard(id)
          .then((board) => board?.syncStatus === 'sync-failed'),
      { timeout: 60000 },
      board.id,
    )
    assert.equal(await readDocument(`users/${user.uid}/projects/${project.id}/boards/${board.id}`), null)
    await page.goto(`${baseUrl}/boards/${board.id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
    // Draw through the real Excalidraw toolbar/canvas, rather than injecting a scene.
    await page.waitForSelector('[data-testid="toolbar-rectangle"]')
    await page.click('[data-testid="toolbar-rectangle"]')
    await page.waitForFunction(() => window.__excalidrawAPI.getAppState().activeTool.type === 'rectangle')
    await page.mouse.move(650, 330)
    await page.mouse.down()
    await page.mouse.move(950, 530, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(
      async (id) =>
        (await import('/src/features/workspace/workspace-api.ts')).workspaceStore
          .loadBoard(id)
          .then((board) => board?.scene.elements.some((element) => element.type === 'rectangle')),
      { timeout: 30000 },
      board.id,
    )
    const before = await boardDocument(board.id)
    assert.equal(before.syncStatus, 'sync-failed')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() =>
      window.__excalidrawAPI?.getSceneElements().some((element) => element.type === 'rectangle'),
    )
    const after = await boardDocument(board.id)
    assert.equal(after.nextSyncAt, before.nextSyncAt)
    await clickText('Sync failed')
    await waitText('Cloud sync paused')
    await capture(
      '04-local-editing.png',
      'Cloud blocked, drawing retained',
      'Fourth board rejected server-side · canvas drawing survives reload in local storage',
    )
  })
  await check('oversized image rejected by the real server', async () => {
    await assert.rejects(
      call('reserveCloudAsset', {
        boardId: boards[0].id,
        fileId: 'oversized-fixture',
        bytes: 5 * 1024 ** 2,
        mimeType: 'image/png',
      }),
      (error) => /smaller|limit|large/i.test(error.message),
    )
  })
  await check('daily save limit enforced on the real server', async () => {
    const usage = await readDocument(`accountUsage/${user.uid}`)
    await patchDocument(`accountUsage/${user.uid}`, { saves: 1000, day: new Date().toISOString().slice(0, 10) })
    const document = await boardDocument(boards[0].id)
    await assert.rejects(
      call('commitCloudBoard', {
        mode: 'private',
        boardId: document.id,
        projectId: project.id,
        operationId: randomUUID(),
        baseRevision: document.revision,
        document: {
          ...document,
          revision: document.revision + 1,
          scene: { ...document.scene, appState: { viewBackgroundColor: '#dddddd' } },
        },
      }),
      (error) => /save allowance|saves/i.test(error.message),
    )
    await patchDocument(`accountUsage/${user.uid}`, { saves: usage.data.saves, day: usage.data.day })
  })
  await check('real RTDB session admission caps the fourth registered session', async () => {
    const boardId = boards[0].id
    await call('commitCloudBoard', {
      mode: 'share-config',
      boardId,
      operationId: randomUUID(),
      document: {
        ownerId: user.uid,
        ownerName: 'Freemium preview',
        boardName: boards[0].name,
        generalAccess: 'anyone_with_link',
        generalRole: 'editor',
        invitedEmails: [],
        collaborators: {},
      },
    })
    for (let n = 0; n < 3; n++) await call('admitCloudSession', { boardId, sessionId: `fixture-session-${n}` })
    await assert.rejects(call('admitCloudSession', { boardId, sessionId: 'fixture-session-3' }), (error) =>
      /collaboration allowance|full/i.test(error.message),
    )
    await assert.rejects(
      call('commitCloudElements', { boardId, sessionId: 'unregistered-fixture', elements: [] }),
      (error) => /editor session/i.test(error.message),
    )
  })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await waitText('Upgrade to Pro')
  await check('Pro CTA records request without granting Pro or charging', async () => {
    await clickText('Upgrade to Pro')
    await clickText('Request Pro access')
    await waitText('Request recorded.')
    assert.equal((await readDocument(`proAccessRequests/${user.uid}`)).data.status, 'requested')
    assert.equal((await call('getAccountUsage')).plan, 'free')
    await capture(
      '05-pro-request.png',
      'Request Pro access',
      'Real Firestore request recorded · no payment flow or automatic entitlement',
    )
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await capture('06-mobile-plan.png', 'Mobile plan and usage', 'Actual responsive dialog at 390 × 844')
    await page.click('[aria-label="Close plan and usage"]')
  })
  await check('80% image usage warning renders from seeded live account counter', async () => {
    await patchDocument(`accountUsage/${user.uid}`, { boards: 1, assetBytes: 20 * 1024 ** 2 })
    await refresh()
    await waitText('approaching your allowance.')
    await page.setViewport({ width: 1440, height: 1000 })
    await clickText('Upgrade to Pro')
    await waitText('20.0 MiB')
    await capture(
      '07-image-warning.png',
      'Image storage early warning',
      'Seeded counter on this disposable dev account · 20 / 25 MiB = 80%',
    )
    await page.click('[aria-label="Close plan and usage"]')
    await patchDocument(`accountUsage/${user.uid}`, { boards: 3, assetBytes: 0 })
  })
  await check('Firebase complimentary list grants Pro and removes upgrade CTA', async () => {
    await complimentaryFixture(email, true)
    listed = true
    await refresh()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Pro'),
    )
    assert.equal((await call('getAccountUsage')).source, 'complimentary')
    await clickText('Pro')
    await waitText('Complimentary, no subscription required')
    assert.equal(await page.$('.account-primary'), null)
    await capture(
      '08-complimentary.png',
      'Complimentary Pro',
      'Verified temporary email added to Firebase config · no subscription or upgrade request',
    )
    await page.setViewport({ width: 390, height: 844 })
    await capture(
      '09-complimentary-mobile.png',
      'Complimentary Pro on mobile',
      'Same entitlement and allowances across responsive layouts',
    )
  })
  assert.deepEqual(errors, [], 'No uncaught browser exceptions')
  console.log(`${checks.length} live dev checks passed`)
} catch (error) {
  if (page) {
    await page.screenshot({ path: new URL('failure.png', directory).pathname, fullPage: true }).catch(() => {})
    console.log('Failure page:', (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 1600))
  }
  testFailure = error
} finally {
  await browser?.close()
  if (signingKey) await signingKey.revoke().catch((error) => cleanupErrors.push(error.message))
  if (listed) await complimentaryFixture(email, false).catch((error) => cleanupErrors.push(error.message))
  if (user) {
    // Fixtures use unique UIDs and board IDs. Never delete shared project-wide counters/config.
    for (const board of boards) {
      await deleteTree(`boardShares/${board.id}`).catch((error) => cleanupErrors.push(error.message))
    }
    for (const path of [
      `users/${user.uid}`,
      `accountUsage/${user.uid}`,
      `accountEntitlements/${user.uid}`,
      `proAccessRequests/${user.uid}`,
    ])
      await deleteTree(path).catch((error) => cleanupErrors.push(error.message))
    for (const board of boards)
      for (const key of ['boardAccess', 'sessionGrants', 'liveUsers', 'boards', 'activeSessions', 'presence'])
        await adminFetch(`https://${projectId}-default-rtdb.firebaseio.com/${key}/${board.id}.json`, {
          method: 'DELETE',
        }).catch((error) => cleanupErrors.push(error.message))
    await adminAuth.deleteUser(user.uid).catch((error) => cleanupErrors.push(error.message))
  }
  await closeAdmin()
  await writeFile(
    new URL('results.json', directory),
    JSON.stringify(
      {
        projectId,
        baseUrl,
        fixtures: { uid: user?.uid, boardIds: boards.map((board) => board.id) },
        checks,
        slides,
        cleanupErrors,
        caveats: [
          'Dev rules and existing triggers preserved for other worktrees.',
          'Image 80% warning uses a seeded fixture counter.',
          'Google OAuth popup not automated; fixture authentication uses a Firebase custom token with an immediately revoked in-memory signer.',
        ],
      },
      null,
      2,
    ),
  )
}
if (testFailure || cleanupErrors.length)
  throw new AggregateError(
    [...(testFailure ? [testFailure] : []), ...cleanupErrors.map((message) => new Error(message))],
    'Live dev validation or fixture cleanup failed',
  )
