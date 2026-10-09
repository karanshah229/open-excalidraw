import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const webRequire = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const { initializeApp } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const { getFirestore } = require('firebase-admin/firestore')
const { getDatabase } = require('firebase-admin/database')
const projectId = 'demo-projects'
Object.assign(process.env, {
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:29099',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:28080',
  FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:29000',
  VITE_FIREBASE_API_KEY: 'emulator-only',
  VITE_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
  VITE_FIREBASE_PROJECT_ID: projectId,
  VITE_FIREBASE_APP_ID: 'emulator-only',
  VITE_FIREBASE_STORAGE_BUCKET: `${projectId}.appspot.com`,
  VITE_FIREBASE_DATABASE_URL: `http://127.0.0.1:29000?ns=${projectId}`,
  VITE_FIREBASE_AUTH_EMULATOR_PORT: '29099',
  VITE_FIREBASE_FIRESTORE_EMULATOR_PORT: '28080',
  VITE_FIREBASE_DATABASE_EMULATOR_PORT: '29000',
  VITE_FIREBASE_STORAGE_EMULATOR_PORT: '29199',
  VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT: '25001',
  VITE_USE_FIREBASE_EMULATOR: 'true',
  VITE_FIREBASE_SYNC_ACCESS_FUNCTION_REGION: 'us-central1',
  VITE_RECAPTCHA_SITE_KEY: '',
  VITE_FIREBASE_APPCHECK_KEY: '',
})
const admin = initializeApp({ projectId, databaseURL: `http://127.0.0.1:29000?ns=${projectId}` }, 'projects-tests')
const db = getFirestore(admin),
  rtdb = getDatabase(admin)
const rules = await readFile(new URL('../database.rules.json', import.meta.url), 'utf8')
const installed = await fetch(`http://127.0.0.1:29000/.settings/rules.json?ns=${projectId}`, {
  method: 'PUT',
  headers: { Authorization: 'Bearer owner' },
  body: rules,
})
assert.equal(installed.status, 200, 'Repository RTDB rules must compile and install')
const imageData =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII='
const password = 'Project-fixture-123!'
const identities = {}
for (const role of ['owner', 'editor', 'viewer', 'outsider']) {
  const user = await getAuth(admin).createUser({
    email: `${role}@projects.test`,
    password,
    emailVerified: true,
    displayName: role,
  })
  identities[role] = user
}
const { createServer } = await import(webRequire.resolve('vite'))
const server = await createServer({
  root: fileURLToPath(new URL('../apps/whiteboard', import.meta.url)),
  // Keep emulator dependency prebundles separate from the real dev preview.
  cacheDir: fileURLToPath(new URL('../apps/whiteboard/node_modules/.vite-projects-tests', import.meta.url)),
  server: { host: '127.0.0.1', port: 15186, strictPort: true },
  plugins: [
    {
      name: 'projects-test-entry',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace('/src/main.tsx', '/tests/projects-bootstrap.ts'),
      },
    },
  ],
})
await server.listen()
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const base = 'http://127.0.0.1:15186',
  requests = [],
  failures = [],
  results = [],
  sharingAudit = []
const out = fileURLToPath(new URL('../logs/projects-e2e/', import.meta.url))
await mkdir(out, { recursive: true })
async function page(role, path = '') {
  const context = await browser.createBrowserContext(),
    page = await context.newPage()
  await page.setViewport({ width: 1400, height: 1000 })
  page.on('dialog', (dialog) => dialog.accept())
  page.on('pageerror', (error) => failures.push({ role, error: error.message }))
  const requestStarts = new WeakMap()
  page.on('response', (response) => {
    if (/127\.0\.0\.1:(25001|28080|29099|29199)/.test(response.url()))
      requests.push({
        role,
        operation: (() => {
          try {
            const d = JSON.parse(response.request().postData() || '{}').data
            return d?.action || d?.operation || null
          } catch {
            return null
          }
        })(),
        status: response.status(),
        method: response.request().method(),
        url: response.url(),
        durationMs: Date.now() - (requestStarts.get(response.request()) ?? Date.now()),
      })
  })
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    requestStarts.set(request, Date.now())
    if (page.delayFunction && request.method() === 'POST' && request.url().includes(`/${page.delayFunction}`)) {
      setTimeout(() => void request.continue(), 1200)
      return
    }
    // Test identities and data must never reach production Firebase endpoints.
    if (/googleapis\.com|firebaseio\.com|cloudfunctions\.net/.test(new URL(request.url()).hostname))
      void request.abort()
    else if (page.failFunction && request.method() === 'POST' && request.url().includes(`/${page.failFunction}`))
      void request.respond({
        status: 503,
        headers: { 'Access-Control-Allow-Origin': base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'Injected service failure' } }),
      })
    else void request.continue()
  })
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__projectsTest))
  if (role) {
    await page.evaluate(
      async ({ email, password }) => {
        const t = window.__projectsTest
        await t.auth.signInWithEmailAndPassword(t.firebase.getFirebaseAuth(), email, password)
      },
      { email: identities[role].email, password },
    )
    await page.waitForSelector('.workspace-intro')
  }
  return page
}
async function clickText(page, text, selector = 'button,[role="menuitem"]') {
  await page.waitForFunction(
    (text, selector) =>
      [...document.querySelectorAll(selector)].some(
        (node) => node.textContent.trim() === text && !node.matches(':disabled'),
      ),
    {},
    text,
    selector,
  )
  await page.evaluate(
    (text, selector) =>
      [...document.querySelectorAll(selector)]
        .find((node) => node.textContent.trim() === text && !node.matches(':disabled'))
        .click(),
    text,
    selector,
  )
}
async function menu(page, name, action) {
  await page.click(`[aria-label="Project actions for ${name}"]`)
  await clickText(page, action, '[role="menuitem"]')
}
async function boardShare(page, boardId) {
  await page.$eval(`[data-board-id="${boardId}"] [aria-label="Share board"]`, (node) => node.click())
  await page.waitForSelector('[role="dialog"] .google-share-copy-btn')
}
async function restrictBoard(page, boardId) {
  await boardShare(page, boardId)
  await page.click('[aria-label="General access setting"]')
  await clickText(page, 'Restricted', '[role="menuitem"]')
}
async function until(check, label) {
  for (let index = 0; index < 100; index++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
async function record(name, fn) {
  const start = requests.length,
    started = Date.now()
  await fn()
  sharingAudit.push({ name, durationMs: Date.now() - started, requests: requests.slice(start) })
  results.push(name)
  console.log(`PASS: ${name}`)
}
let owner, editor, viewer, outsider, anonymous, project, boardId, createdByEditor
try {
  owner = await page('owner')
  await record('Create project and board through the UI; real Firestore sync', async () => {
    await clickText(owner, 'New board')
    await owner.type('#board-name-input', 'Original board')
    await owner.type('#new-project-name', 'Project Alpha')
    await clickText(owner, 'Create board')
    await owner.waitForFunction(() => location.pathname.startsWith('/boards/'))
    boardId = new URL(owner.url()).pathname.split('/').pop()
    await until(
      async () => !(await db.collection(`users/${identities.owner.uid}/projects`).get()).empty,
      'project uploaded',
    )
    project = (await db.collection(`users/${identities.owner.uid}/projects`).get()).docs[0]
    await until(async () => (await project.ref.collection('boards').doc(boardId).get()).exists, 'board uploaded')
    await owner.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await owner.click('button[title="Share board"]')
    assert.equal(
      await owner.$eval('.google-share-done-btn', (node) => node.disabled),
      false,
      'Board sharing uses policy from the initial board read',
    )
    assert.equal(
      await owner.$eval('[role="dialog"]', (node) => node.textContent.includes('Loading permissions')),
      false,
    )
    await owner.keyboard.press('Escape')
    await owner.evaluate((dataURL) => {
      const t = window.__projectsTest,
        api = window.__excalidrawAPI
      window.__setUserInteracted()
      api.addFiles([{ id: 'fixture-image', mimeType: 'image/png', dataURL, created: 1 }])
      api.updateScene({
        elements: t.excalidraw.convertToExcalidrawElements(
          [
            {
              id: 'fixture-image-element',
              type: 'image',
              fileId: 'fixture-image',
              status: 'saved',
              x: 0,
              y: 0,
              width: 100,
              height: 100,
            },
          ],
          { regenerateIds: false },
        ),
      })
    }, imageData)
    await until(
      async () =>
        (await project.ref.collection('boards').doc(boardId).get()).data()?.scene?.files?.['fixture-image']
          ?.storagePath,
      'image uploaded through Storage network',
    )
    await owner.goto(base)
    await owner.waitForSelector('[aria-label="Project actions for Project Alpha"]')
  })
  await record('Cloud projects with legacy owner metadata remain visible on the homepage', async () => {
    const id = `legacy-owner-${Date.now()}`,
      board = `${id}-board`,
      now = new Date().toISOString()
    const ref = db.doc(`users/${identities.owner.uid}/projects/${id}`)
    await ref.set({
      id,
      name: 'Legacy owner project',
      ownerId: 'original-environment-user',
      members: [{ principalId: 'original-environment-user', role: 'owner' }],
      createdAt: now,
      updatedAt: now,
    })
    await ref
      .collection('boards')
      .doc(board)
      .set({
        id: board,
        projectId: id,
        name: 'Legacy owner board',
        active: true,
        scene: { elements: [], appState: {}, files: {} },
        formatVersion: 1,
        revision: 1,
        baseRevision: 1,
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        syncAttempts: 0,
        nextSyncAt: null,
        lastSyncError: null,
      })
    try {
      await owner.waitForSelector(`[data-board-id="${board}"]`, { timeout: 5000 })
      const value = await owner.evaluate(async (id) => {
        const workspace = await window.__projectsTest.workspace.workspaceApi.listWorkspace()
        return workspace.projects.find((project) => project.id === id)?.ownerId
      }, id)
      assert.equal(value, identities.owner.uid, 'Private namespace establishes ownership across environment imports')
      await until(
        async () => (await ref.get()).data()?.ownerId === identities.owner.uid,
        'legacy ownership metadata repaired',
      )
      const policy = {
        boardId: board,
        ownerId: identities.owner.uid,
        boardName: 'Legacy owner board',
        generalAccess: 'restricted',
        generalRole: 'viewer',
        collaborators: {},
        invitedEmails: [],
        scene: { elements: [], appState: {}, files: {} },
        createdAt: now,
        updatedAt: now,
      }
      await db.doc(`boardShares/${board}`).set(policy)
      await until(
        async () => (await rtdb.ref(`boardAccess/${board}`).get()).val()?.blocked === false,
        'initial projection',
      )
      await rtdb
        .ref(`boardAccess/${board}`)
        .set({ ownerId: identities.owner.uid, publicRead: false, publicWrite: false })
      const staleDenied = await owner.evaluate(async (board) => {
        const t = window.__projectsTest
        try {
          await t.database.get(t.database.ref(t.firebase.getFirebaseRtdb(), `boards/${board}/elements`))
          return false
        } catch {
          return true
        }
      }, board)
      assert.equal(staleDenied, true, 'Legacy projection reproduces the export permission failure')
      const exported = await owner.evaluate(async (id) => {
        const result = await window.__projectsTest.exports.exportBoards({
          projectId: id,
          formats: ['excalidraw', 'svg', 'png'],
        })
        return { files: result.fileNames, failures: result.failures }
      }, id)
      assert.deepEqual(exported.failures, [])
      assert.equal(exported.files.length, 3)
      assert.equal((await rtdb.ref(`boardAccess/${board}`).get()).val().blocked, false)
      assert.deepEqual(
        (await db.doc(`boardShares/${board}`).get()).data(),
        policy,
        'Projection repair preserves sharing and drawing data',
      )
      const projectPolicy = db.doc(`projectShares/${id}`)
      await projectPolicy.set({ ownerId: identities.editor.uid, generalAccess: 'restricted', generalRole: 'viewer' })
      const denied = await owner.evaluate(async (id) => {
        try {
          await window.__projectsTest.projects.projectService.manage(id, 'repair')
          return false
        } catch (error) {
          return error.code === 'functions/permission-denied'
        }
      }, id)
      assert.equal(denied, true, 'Repair cannot reassign an existing policy owned by someone else')
      assert.equal((await projectPolicy.get()).data().ownerId, identities.editor.uid)
      await projectPolicy.delete()
    } finally {
      await ref.update({ deletedAt: new Date().toISOString() })
      const deletedDenied = await owner.evaluate(async (id) => {
        try {
          await window.__projectsTest.projects.projectService.manage(id, 'repair')
          return false
        } catch (error) {
          return error.code === 'functions/permission-denied'
        }
      }, id)
      assert.equal(deletedDenied, true, 'Repair cannot restore a deleted project')
      await db.doc(`projectShares/${id}`).delete()
      await owner.waitForFunction((board) => !document.querySelector(`[data-board-id="${board}"]`), {}, board)
      await ref.collection('boards').doc(board).delete()
      await db.doc(`boardShares/${board}`).delete()
      await ref.delete()
    }
  })
  await record('Projection deduplication preserves legacy bindings and ignores older revisions', async () => {
    const projectionApp = initializeApp({ projectId, databaseURL: `http://127.0.0.1:29000?ns=${projectId}` })
    const { mirrorCurrentPolicy } = await import('../functions/lib/project-access.js')
    const id = 'projection-regression',
      ref = db.doc(`boardShares/${id}`)
    await ref.set({
      ownerId: 'projection-fixture',
      accessRevision: 3,
      pending: false,
      generalAccess: 'restricted',
      collaborators: {},
      invitedEmails: [],
    })
    await mirrorCurrentPolicy('board', id)
    await ref.update({ projectId: 'bound-parent' })
    await Promise.all([mirrorCurrentPolicy('board', id), mirrorCurrentPolicy('board', id)])
    const bound = (await rtdb.ref(`boardAccess/${id}`).get()).val()
    assert.equal(bound.projectId, 'bound-parent', 'Same-revision legacy parent bindings must not be skipped')
    assert.equal(bound.version, 7)
    await ref.update({ accessRevision: 2, generalAccess: 'anyone_with_link', generalRole: 'editor' })
    await mirrorCurrentPolicy('board', id)
    assert.deepEqual((await rtdb.ref(`boardAccess/${id}`).get()).val(), bound, 'Older revisions cannot broaden access')
    await ref.delete()
    await rtdb.ref(`boardAccess/${id}`).remove()
    await require('firebase-admin/app').deleteApp(projectionApp)
  })
  await record('Startup uses one scroll-free loader; owned metadata excludes drawings', async () => {
    owner.delayFunction = 'listSharedProjects'
    await owner.reload({ waitUntil: 'domcontentloaded' })
    await owner.waitForSelector('.workspace-startup-loader')
    assert.equal(await owner.$$eval('.workspace-startup-loader', (nodes) => nodes.length), 1)
    assert.equal(
      await owner.$eval('.workspace-startup-loader', (node) => node.textContent.trim()),
      'Fetching your ideas…',
    )
    assert.equal(await owner.evaluate(() => document.documentElement.scrollHeight > innerHeight), false)
    await owner.waitForSelector(`[data-board-id="${boardId}"]`)
    owner.delayFunction = null
    const data = await owner.evaluate(() => window.__projectsTest.projects.projectService.list(undefined, true))
    assert.ok(data.ownedPolicies.boards.every((policy) => !('scene' in policy)))
    assert.ok(data.ownedPolicies.boards.every((policy) => policy.ownerId === identities.owner.uid))
  })
  await record('Concurrent workspace refreshes share one metadata request', async () => {
    const before = requests.filter(
      (request) => request.role === 'owner' && request.method === 'POST' && request.url.includes('/listSharedProjects'),
    ).length
    await owner.evaluate(async () => {
      const api = window.__projectsTest.workspace.workspaceApi
      await Promise.all([api.listWorkspace(), api.listWorkspace(), api.listWorkspace()])
    })
    const after = requests.filter(
      (request) => request.role === 'owner' && request.method === 'POST' && request.url.includes('/listSharedProjects'),
    ).length
    assert.equal(after - before, 1, 'Overlapping refreshes must not duplicate metadata calls')
  })
  await record('Updated drawing refreshes thumbnail immediately after logo navigation', async () => {
    await owner.waitForSelector(`[data-board-id="${boardId}"] .board-preview-svg`)
    const before = await owner.$eval(`[data-board-id="${boardId}"] .board-preview-svg`, (node) => node.innerHTML)
    await owner.click(`[data-board-id="${boardId}"]`)
    await owner.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await owner.evaluate(() => {
      window.__setUserInteracted()
      window.__excalidrawAPI.updateScene({
        elements: [
          ...window.__excalidrawAPI.getSceneElements(),
          ...window.__projectsTest.excalidraw.convertToExcalidrawElements(
            [{ id: 'preview-change', type: 'rectangle', x: 150, y: 0, width: 100, height: 80 }],
            { regenerateIds: false },
          ),
        ],
      })
    })
    await owner.click('[aria-label="OpenExcalidraw"]')
    await owner.waitForFunction(
      (id, old) => {
        const node = document.querySelector(`[data-board-id="${id}"] .board-preview-svg`)
        return node && node.innerHTML !== old
      },
      { timeout: 5000 },
      boardId,
      before,
    )
  })
  await record(
    'Project filter design resets visibility, search and checkboxes; empty filters show matching state',
    async () => {
      await owner.click('[aria-label="Filter boards"]')
      await owner.waitForSelector('.workspace-project-filter')
      assert.equal(await owner.$eval('.project-filter-title', (node) => node.textContent), 'Filter projects')
      await clickText(owner, 'Shared', '.project-filter-tabs button')
      await owner.waitForSelector('.empty-boards--filtered')
      assert.match(
        await owner.$eval('.empty-boards--filtered', (node) => node.textContent),
        /No matching projects or boards/,
      )
      assert.equal(await owner.$('.workspace-empty-state'), null)
      await owner.type('[aria-label="Search projects"]', 'no project matches')
      await clickText(owner, 'Reset filters')
      assert.equal(await owner.$eval('[aria-label="Search projects"]', (node) => node.value), '')
      assert.equal(
        await owner.$eval('.project-filter-tabs button', (node) => node.getAttribute('aria-pressed')),
        'true',
      )
      await owner.waitForSelector(`[data-board-id="${boardId}"]`)
      await owner.keyboard.press('Escape')
    },
  )
  await record('Download formats accept real pointer clicks above the modal', async () => {
    await menu(owner, 'Project Alpha', 'Download')
    await owner.click('[aria-label="Download formats"]')
    const option = await owner.waitForSelector('.download-format-popover label:nth-child(2)')
    await option.click()
    assert.equal(await option.$eval('[role=checkbox]', (node) => node.getAttribute('data-state')), 'checked')
    await owner.keyboard.press('Escape')
    await clickText(owner, 'Close')
  })
  await record('Project menu preserves accordion; rename survives reload', async () => {
    const before = await owner.$eval('.group-header-toggle', (node) => node.getAttribute('aria-expanded'))
    await owner.click('[aria-label="Project actions for Project Alpha"]')
    assert.equal(
      await owner.evaluate(
        () => document.body.hasAttribute('data-scroll-locked') || getComputedStyle(document.body).overflow === 'hidden',
      ),
      false,
      'Project menu must not lock body scrolling',
    )
    await clickText(owner, 'Rename', '[role="menuitem"]')
    await owner.waitForFunction(() =>
      document
        .querySelector('[role="dialog"]')
        ?.getAnimations()
        .every((animation) => animation.playState === 'finished'),
    )
    await owner.screenshot({ path: `${out}/rename-dialog.png` })
    assert.equal(await owner.$eval('.group-header-toggle', (node) => node.getAttribute('aria-expanded')), before)
    await owner.$eval('[aria-label="Project name"]', (node) => node.select())
    await owner.type('[aria-label="Project name"]', 'Project Beta')
    await clickText(owner, 'Save')
    await owner.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    assert.ok(
      await owner.$('[aria-label="Project actions for Project Beta"]'),
      'Rename must appear immediately when dialog closes',
    )
    await owner.reload()
    await owner.waitForSelector('[aria-label="Project actions for Project Beta"]')
    assert.equal((await project.ref.get()).data().name, 'Project Beta')
  })
  if (process.env.SHARING_FLOW_AUDIT === '1')
    await record('Project Share modal action-by-action request audit', async () => {
      await menu(owner, 'Project Beta', 'Share')
      await owner.waitForFunction(() => !document.querySelector('.google-share-copy-btn')?.disabled)
      const action = async (name, fn) => {
        const start = requests.length,
          started = Date.now()
        await fn()
        await owner.waitForFunction(() => !document.querySelector('.google-share-copy-btn')?.disabled)
        await new Promise((resolve) => setTimeout(resolve, 150))
        const committed = (await db.doc(`projectShares/${project.id}`).get()).data()
        const calls = requests
          .slice(start)
          .filter((request) => request.method === 'POST' && request.url.includes(':25001/'))
        assert.ok(calls.length <= 1, `${name} should make at most one callable request`)
        assert.ok(
          calls.every((request) => request.url.endsWith('/manageProject')),
          `${name} must not reload project lists or publish snapshots`,
        )
        if (['Copy link', 'Invalid email', 'Duplicate invitation', 'Done'].includes(name))
          assert.equal(calls.length, 0, `${name} should make zero callable requests`)
        sharingAudit.push({
          name: `Project modal: ${name}`,
          durationMs: Date.now() - started,
          requests: requests.slice(start),
          state: {
            generalAccess: committed.generalAccess,
            generalRole: committed.generalRole,
            invitedCount: committed.invitedEmails.length,
            auditInviteRole: committed.collaborators?.['audit@example.test']?.role ?? null,
          },
        })
      }
      const choice = async (label, text) => {
        await owner.click(`[aria-label="${label}"]`)
        await clickText(owner, text, '[role="menuitem"]')
      }
      for (const access of ['Anyone with the link'])
        await action(access, () => choice('General access setting', access))
      await owner.click('[aria-label="General access role"]')
      sharingAudit.push({
        name: 'Project general role options',
        options: await owner.$$eval('[role="menuitem"]', (nodes) => nodes.map((n) => n.textContent.trim())),
        requests: [],
      })
      await clickText(owner, 'Viewer', '[role="menuitem"]')
      for (const role of ['Viewer', 'Editor', 'Viewer'])
        await action(`General ${role}`, () => choice('General access role', role))
      for (const access of ['Restricted', 'Restricted'])
        await action(access, () => choice('General access setting', access))
      await owner
        .browserContext()
        .overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
      await action('Copy link', () => owner.click('.google-share-copy-btn'))
      await action('Invalid email', async () => {
        await owner.type('#share-email-input', 'invalid')
        await owner.click('.google-share-add-btn')
      })
      await owner.$eval('#share-email-input', (input) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await action('Add viewer', async () => {
        await owner.type('#share-email-input', 'audit@example.test')
        await owner.click('.google-share-add-btn')
      })
      await action('Duplicate invitation', async () => {
        await owner.type('#share-email-input', 'audit@example.test')
        await owner.click('.google-share-add-btn')
      })
      const person = async (text) => {
        const handle = await owner.evaluateHandle(() =>
          [...document.querySelectorAll('.google-share-user-row')]
            .find((n) => n.textContent.includes('audit@example.test'))
            .querySelector('[aria-label="Change permission"]'),
        )
        await handle.asElement().click()
        await clickText(owner, text, '[role="menuitem"]')
      }
      for (const role of ['Viewer', 'Editor', 'Present', 'Viewer', 'Remove access'])
        await action(`Person ${role}`, () => person(role))
      await action('Done', () => owner.click('.google-share-done-btn'))
      const duplicate = sharingAudit.find((f) => f.name === 'Project modal: Duplicate invitation')
      assert.equal(
        duplicate.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/manageProject')).length,
        0,
        'Duplicate invitation should make zero permission calls',
      )
      assert.equal(
        (await db.doc(`projectShares/${project.id}`).get()).data().collaborators?.['audit@example.test'],
        undefined,
        'Removed invitation must remain removed',
      )
    })
  await record('Project sharing provisions existing boards; verified email membership', async () => {
    await menu(owner, 'Project Beta', 'Share')
    assert.equal(
      await owner.$eval('[role="dialog"]', (node) => node.textContent.includes('Loading permissions')),
      false,
    )
    await owner.waitForFunction(() =>
      document
        .querySelector('[role="dialog"]')
        ?.getAnimations()
        .every((animation) => animation.playState === 'finished'),
    )
    await owner.screenshot({ path: `${out}/share-dialog.png` })
    for (const role of ['editor', 'viewer']) {
      await owner.type('input[placeholder="Add people by email..."]', identities[role].email)
      await clickText(owner, 'Add')
      await until(
        async () =>
          (await db.doc(`projectShares/${project.id}`).get()).data()?.invitedEmails.includes(identities[role].email),
        'invite committed',
      )
      await owner.waitForFunction(() => !document.querySelector('.google-share-done-btn').disabled)
    }
    const roleTrigger = await owner.evaluateHandle(
      (email) =>
        [...document.querySelectorAll('.google-share-user-row')]
          .find((node) => node.textContent.includes(email))
          .querySelector('[aria-label="Change permission"]'),
      identities.editor.email,
    )
    await roleTrigger.asElement().click()
    await clickText(owner, 'Editor', '[role="menuitem"]')
    await owner.waitForFunction(() => !document.querySelector('.google-share-done-btn').disabled)
    const projectWrites = requests.filter(
      (request) => request.method === 'POST' && request.url.includes('/manageProject'),
    ).length
    await clickText(owner, 'Done')
    await owner.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 1000 })
    assert.equal(
      requests.filter((request) => request.method === 'POST' && request.url.includes('/manageProject')).length,
      projectWrites,
      'Done must not resave an already persisted project policy',
    )
    const config = (await db.doc(`projectShares/${project.id}`).get()).data()
    assert.deepEqual(config.invitedEmails.sort(), [identities.editor.email, identities.viewer.email].sort())
    editor = await page('editor')
    viewer = await page('viewer')
    outsider = await page('outsider')
    await editor.waitForSelector(`[data-board-id="${boardId}"]`)
    await viewer.waitForSelector(`[data-board-id="${boardId}"]`)
    assert.match(
      await editor.$eval(
        '[aria-label="Project actions for Project Beta"]',
        (node) => node.closest('.group-header').textContent,
      ),
      /Shared/,
    )
    assert.equal(await viewer.$('[aria-label="Delete board"]'), null)
    assert.equal(await editor.$('[aria-label="Make private"]'), null)
    assert.equal(await outsider.$(`[data-board-id="${boardId}"]`), null)
  })
  await record('Restricted project links use board denied UI without filters or metadata', async () => {
    await outsider.goto(`${base}/?projectId=${project.id}`)
    await outsider.waitForSelector('.access-denied-card')
    assert.match(await outsider.$eval('.access-denied-card', (node) => node.textContent), /Switch account/)
    assert.equal(await outsider.$('.workspace-filters'), null)
    const deniedGuest = await page(null, `/?projectId=${project.id}`)
    await deniedGuest.waitForSelector('.access-denied-card')
    assert.match(await deniedGuest.$eval('.access-denied-card', (node) => node.textContent), /Sign in with Google/)
    assert.equal(await deniedGuest.$('.workspace-filters'), null)
    await deniedGuest.browserContext().close()
    await outsider.goto(base)
  })
  await record('Owned policy metadata is complete and never exposes another account or drawings', async () => {
    const data = await owner.evaluate(() => window.__projectsTest.projects.projectService.list(undefined, true))
    assert.ok(data.ownedPolicies.projects.some((policy) => policy.projectId === project.id))
    assert.ok(data.ownedPolicies.boards.some((policy) => policy.boardId === boardId && policy.accessRevision))
    assert.ok(
      data.ownedPolicies.boards.every((policy) => !('scene' in policy) && policy.ownerId === identities.owner.uid),
    )
    const others = await viewer.evaluate(() => window.__projectsTest.projects.projectService.list(undefined, true))
    assert.equal(
      others.ownedPolicies.boards.some((policy) => policy.boardId === boardId),
      false,
    )
  })
  await record('Shared board cards preserve Share without a redundant privacy menu', async () => {
    await owner.$eval(`[data-board-id="${boardId}"] [aria-label="Share board"]`, (node) => node.click())
    await owner.waitForSelector('[role="dialog"] .google-share-copy-btn')
    await owner.keyboard.press('Escape')
    assert.equal(await owner.$(`[data-board-id="${boardId}"] [aria-label^="Board actions for"]`), null)
    assert.equal(new URL(owner.url()).pathname, '/')
  })
  await record('Editor creates inherited board owned by project owner; viewer create denied', async () => {
    await clickText(editor, 'New board')
    await editor.type('#board-name-input', 'Editor board')
    await clickText(editor, 'Create board')
    await editor.waitForFunction(() => location.pathname.startsWith('/boards/'))
    createdByEditor = new URL(editor.url()).pathname.split('/').pop()
    assert.equal(
      (await project.ref.collection('boards').doc(createdByEditor).get()).data().creatorId,
      identities.editor.uid,
    )
    assert.equal((await db.doc(`boardShares/${createdByEditor}`).get()).data().ownerId, identities.owner.uid)
    const denied = await viewer.evaluate(async (id) => {
      try {
        await window.__projectsTest.projects.projectService.createBoard(id, 'Forbidden')
        return false
      } catch {
        return true
      }
    }, project.id)
    assert.equal(denied, true)
  })
  await record('Shared editor rename persists and visible cards load authorized previews', async () => {
    await editor.waitForSelector('button[aria-label="Edit board name"]')
    await editor.click('button[aria-label="Edit board name"]')
    await editor.waitForFunction(() => {
      const input = document.querySelector('input[aria-label="Edit board name"]')
      return input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === input.value.length
    })
    await editor.type('input[aria-label="Edit board name"]', 'Renamed by editor')
    await editor.keyboard.press('Enter')
    await until(
      async () => (await db.doc(`boardShares/${createdByEditor}`).get()).data().boardName === 'Renamed by editor',
      'editor rename persisted',
    )
    await viewer.waitForSelector(`[data-board-id="${boardId}"] .board-preview-svg`)
  })
  await record('Inherited editors publish live canvas changes; viewers cannot write RTDB deltas', async () => {
    await owner.goto(`${base}/boards/${createdByEditor}`)
    await owner.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await until(
      async () => Object.keys((await rtdb.ref(`activeSessions/${createdByEditor}`).get()).val() ?? {}).length >= 2,
      'two collaborating sessions registered',
    )
    await editor.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await editor.evaluate(() => {
      window.__setUserInteracted()
      window.__excalidrawAPI.updateScene({
        elements: window.__projectsTest.excalidraw.convertToExcalidrawElements(
          [{ id: 'inherited-edit', type: 'rectangle', x: 20, y: 30, width: 100, height: 60 }],
          { regenerateIds: false },
        ),
      })
    })
    await until(
      async () => (await rtdb.ref(`boards/${createdByEditor}/elements/inherited-edit`).get()).exists(),
      'inherited canvas delta uploaded',
    )
    assert.equal(
      await viewer.evaluate(async (id) => {
        const t = window.__projectsTest,
          uid = t.firebase.getFirebaseAuth().currentUser.uid
        try {
          await t.database.set(t.database.ref(t.firebase.getFirebaseRtdb(), `boards/${id}/elements/viewer-edit`), {
            id: 'viewer-edit',
            version: 1,
            versionNonce: 1,
            lastModifiedBy: uid,
            data: '{}',
          })
          return false
        } catch {
          return true
        }
      }, createdByEditor),
      true,
    )
  })
  await owner.goto(base)
  await owner.waitForSelector('[aria-label="Project actions for Project Beta"]')
  await record('Open board recovers through project policy gates and live viewer/editor changes', async () => {
    await viewer.goto(`${base}/boards/${boardId}`)
    await viewer.waitForFunction(() => window.__excalidrawAPI?.getAppState().viewModeEnabled === true)
    const policyRef = db.doc(`projectShares/${project.id}`)
    const policy = (await policyRef.get()).data()
    // Hold the same gate used by the callable long enough to deterministically
    // terminate the Firestore listener, then commit the role change normally.
    await policyRef.update({ pending: true })
    await viewer.waitForSelector('.access-denied-card')
    policy.collaborators[identities.viewer.email].role = 'editor'
    await owner.evaluate(
      async ({ id, policy }) => window.__projectsTest.projects.projectService.manage(id, 'share', { policy }),
      { id: project.id, policy },
    )
    await viewer.waitForFunction(
      () =>
        !document.querySelector('.access-denied-card') &&
        window.__excalidrawAPI?.getAppState().viewModeEnabled === false,
      { timeout: 10000 },
    )
    policy.collaborators[identities.viewer.email].role = 'viewer'
    await owner.evaluate(
      async ({ id, policy }) => window.__projectsTest.projects.projectService.manage(id, 'share', { policy }),
      { id: project.id, policy },
    )
    await viewer.waitForFunction(
      () =>
        !document.querySelector('.access-denied-card') &&
        window.__excalidrawAPI?.getAppState().viewModeEnabled === true,
      { timeout: 10000 },
    )
    policy.generalAccess = 'anyone_with_link'
    policy.generalRole = 'editor'
    await owner.evaluate(
      async ({ id, policy }) => window.__projectsTest.projects.projectService.manage(id, 'share', { policy }),
      { id: project.id, policy },
    )
    await viewer.waitForFunction(
      () =>
        !document.querySelector('.access-denied-card') &&
        window.__excalidrawAPI?.getAppState().viewModeEnabled === false,
      { timeout: 10000 },
    )
    policy.generalAccess = 'restricted'
    policy.generalRole = 'viewer'
    await owner.evaluate(
      async ({ id, policy }) => window.__projectsTest.projects.projectService.manage(id, 'share', { policy }),
      { id: project.id, policy },
    )
    await viewer.waitForFunction(
      () =>
        !document.querySelector('.access-denied-card') &&
        window.__excalidrawAPI?.getAppState().viewModeEnabled === true,
      { timeout: 10000 },
    )
    await viewer.goto(base)
    await viewer.waitForSelector(`[data-board-id="${boardId}"]`)
  })
  await record('Viewers cannot manage projects; editors cannot change individual board privacy', async () => {
    const rejected = await viewer.evaluate(
      async ({ projectId, boardId }) => {
        const service = window.__projectsTest.projects.projectService
        const attempts = [
          () => service.manage(projectId, 'delete'),
          () => service.boardAccess(boardId, projectId, 'private'),
        ]
        return Promise.all(
          attempts.map(async (attempt) => {
            try {
              await attempt()
              return false
            } catch {
              return true
            }
          }),
        )
      },
      { projectId: project.id, boardId },
    )
    assert.deepEqual(rejected, [true, true])
    assert.equal(
      await editor.evaluate(
        async ({ projectId, boardId }) => {
          try {
            await window.__projectsTest.projects.projectService.boardAccess(boardId, projectId, 'private')
            return false
          } catch {
            return true
          }
        },
        { projectId: project.id, boardId },
      ),
      true,
    )
    assert.equal((await db.doc(`boardShares/${boardId}`).get()).data().inheritProjectAccess, true)
  })
  await record('Project editors get all menu actions and can rename/share without taking ownership', async () => {
    await editor.goto(base)
    await editor.waitForSelector('[aria-label="Project actions for Project Beta"]')
    await editor.click('[aria-label="Project actions for Project Beta"]')
    assert.deepEqual(
      await editor.$$eval('[role="menuitem"]', (nodes) => nodes.map((node) => node.textContent.trim())),
      ['Share', 'Rename', 'Download', 'Archive', 'Delete'],
    )
    await clickText(editor, 'Rename', '[role="menuitem"]')
    await editor.$eval('[aria-label="Project name"]', (node) => node.select())
    await editor.type('[aria-label="Project name"]', 'Editor renamed project')
    await clickText(editor, 'Save')
    await editor.waitForSelector('[aria-label="Project actions for Editor renamed project"]')
    assert.equal((await project.ref.get()).data().ownerId, identities.owner.uid)
    assert.equal(
      await editor.evaluate(
        async (id) =>
          (await window.__projectsTest.workspace.workspaceStore.listProjects()).some((project) => project.id === id),
        project.id,
      ),
      false,
    )
    await menu(editor, 'Editor renamed project', 'Share')
    assert.match(await editor.$eval('.google-share-user-row', (node) => node.textContent), /Owner/)
    assert.equal(await editor.$eval('.google-share-user-row', (node) => node.textContent.includes('(you)')), false)
    await editor.click('[aria-label="General access setting"]')
    await clickText(editor, 'Anyone with the link', '[role="menuitem"]')
    await editor.waitForFunction(() => !document.querySelector('.google-share-done-btn').disabled)
    await editor.click('[aria-label="General access setting"]')
    await clickText(editor, 'Restricted', '[role="menuitem"]')
    await editor.waitForFunction(() => !document.querySelector('.google-share-done-btn').disabled)
    await clickText(editor, 'Done')
    await editor.evaluate(
      async (id) => window.__projectsTest.workspace.workspaceApi.renameProject(id, 'Project Beta'),
      project.id,
    )
    assert.equal((await project.ref.get()).data().name, 'Project Beta')
    await owner.reload()
    await owner.waitForSelector('[aria-label="Project actions for Project Beta"]')
  })
  await record('Direct board sharing survives inheritance; collaborator removal revokes all stores', async () => {
    await owner.evaluate(
      async ({ boardId, projectId, outsider, viewer }) => {
        const t = window.__projectsTest,
          config = await t.sharing.sharingService.getShareConfig(boardId)
        config.projectId = projectId
        config.collaborators = {
          [outsider]: { email: outsider, role: 'editor', addedAt: new Date().toISOString() },
          [viewer]: { email: viewer, role: 'viewer', addedAt: new Date().toISOString() },
        }
        await t.sharing.sharingService.saveShareConfig(config)
      },
      { boardId, projectId: project.id, outsider: identities.outsider.email, viewer: identities.viewer.email },
    )
    await outsider.goto(`${base}/boards/${boardId}`)
    await outsider.waitForFunction(() => window.__excalidrawAPI?.getAppState().viewModeEnabled === false)
    assert.equal(
      await outsider.$('.access-denied-card'),
      null,
      'Direct board grants must not require project membership',
    )
    assert.equal(
      await outsider.evaluate(
        async (id) =>
          (
            await window.__projectsTest.sharing.sharingService.getSharedBoard(
              id,
              window.__projectsTest.firebase.getFirebaseAuth().currentUser.email,
              window.__projectsTest.firebase.getFirebaseAuth().currentUser.uid,
            )
          ).status,
        boardId,
      ),
      'allowed',
    )
    const fetchedImage = await viewer.evaluate(
      async (id) =>
        (
          await window.__projectsTest.sharing.sharingService.getSharedBoard(
            id,
            window.__projectsTest.firebase.getFirebaseAuth().currentUser.email,
            window.__projectsTest.firebase.getFirebaseAuth().currentUser.uid,
          )
        ).config.scene.files['fixture-image'].dataURL,
      boardId,
    )
    assert.equal(fetchedImage, imageData, 'Inherited viewers can fetch private-root image assets')
    await owner.evaluate(
      async ({ boardId, email }) => {
        const t = window.__projectsTest,
          config = await t.sharing.sharingService.getShareConfig(boardId)
        delete config.collaborators[email]
        config.invitedEmails = config.invitedEmails.filter((item) => item !== email)
        await t.sharing.sharingService.saveShareConfig(config)
      },
      { boardId, email: identities.outsider.email },
    )
    assert.equal(
      (await db.doc(`boardShares/${boardId}`).get()).data().collaborators[identities.outsider.email],
      undefined,
    )
    const token = await outsider.evaluate(() =>
      window.__projectsTest.firebase.getFirebaseAuth().currentUser.getIdToken(),
    )
    assert.equal(
      (await fetch(`http://127.0.0.1:29000/boards/${boardId}.json?ns=${projectId}&auth=${encodeURIComponent(token)}`))
        .status,
      401,
    )
  })
  await record('Unverified email cannot claim project or board invitations', async () => {
    await getAuth(admin).updateUser(identities.viewer.uid, { emailVerified: false })
    await viewer.evaluate(async () => {
      const t = window.__projectsTest,
        user = t.firebase.getFirebaseAuth().currentUser
      await t.auth.reload(user)
      await user.getIdToken(true)
    })
    const access = await viewer.evaluate(
      async ({ projectId, boardId }) => {
        const t = window.__projectsTest
        const projects = await t.projects.projectService.list(projectId)
        let readable = true
        try {
          await t.firestore.getDocFromServer(t.firestore.doc(t.firebase.getFirestoreDb(), 'boardShares', boardId))
        } catch {
          readable = false
        }
        return { count: projects.projects.length, readable }
      },
      { projectId: project.id, boardId },
    )
    assert.deepEqual(access, { count: 0, readable: false })
    await getAuth(admin).updateUser(identities.viewer.uid, { emailVerified: true })
    await viewer.evaluate(async () => {
      const t = window.__projectsTest,
        user = t.firebase.getFirebaseAuth().currentUser
      await t.auth.reload(user)
      await user.getIdToken(true)
    })
  })
  await record('Custom board access restricts project editors and preserves direct grants on restore', async () => {
    await owner.evaluate(async (id) => {
      const t = window.__projectsTest,
        config = await t.sharing.sharingService.getShareConfig(id)
      await t.sharing.sharingService.saveShareConfig({ ...config, inheritProjectAccess: false })
    }, boardId)
    assert.equal(
      await editor.evaluate(
        async (id) => (await window.__projectsTest.sharing.sharingService.getSharedBoard(id)).status,
        boardId,
      ),
      'restricted',
    )
    const listed = await editor.evaluate(
      async (id) => window.__projectsTest.projects.projectService.list(id),
      project.id,
    )
    assert.equal(
      listed.boards.some((board) => board.id === boardId),
      false,
    )
    assert.equal(
      await viewer.evaluate(async (id) => {
        const t = window.__projectsTest,
          user = t.firebase.getFirebaseAuth().currentUser
        return (await t.sharing.sharingService.getSharedBoard(id, user.email, user.uid)).config.effectiveRole
      }, boardId),
      'viewer',
    )
    await owner.evaluate(
      async ({ boardId, projectId }) =>
        window.__projectsTest.projects.projectService.boardAccess(boardId, projectId, 'inherit'),
      { boardId, projectId: project.id },
    )
    assert.ok((await db.doc(`boardShares/${boardId}`).get()).data().collaborators[identities.viewer.email])
  })
  await record('Restricted board keeps invitees and removes inherited access; no metadata leaks', async () => {
    await owner.reload()
    await owner.waitForSelector(`[data-board-id="${boardId}"]`)
    await restrictBoard(owner, boardId)
    await until(
      async () => (await db.doc(`boardShares/${boardId}`).get()).data().inheritProjectAccess === false,
      'board override committed',
    )
    const config = (await db.doc(`boardShares/${boardId}`).get()).data()
    assert.ok(config.invitedEmails.includes(identities.viewer.email), 'Restricted preserves individual invitees')
    assert.equal(config.generalAccess, 'restricted')
    const direct = await viewer.evaluate(async (id) => {
      const t = window.__projectsTest,
        user = t.firebase.getFirebaseAuth().currentUser
      return (await t.sharing.sharingService.getSharedBoard(id, user.email, user.uid)).status
    }, boardId)
    assert.equal(direct, 'allowed')
    await clickText(owner, 'Done')
    // Remove the explicit invitation separately before checking owner-only denial across stores.
    await owner.evaluate(async (id) => {
      const service = window.__projectsTest.sharing.sharingService
      const config = await service.getShareConfig(id)
      await service.saveShareConfig({ ...config, invitedEmails: [], collaborators: {} })
    }, boardId)
    await viewer.reload()
    await viewer.waitForSelector('.workspace-intro')
    await until(
      async () =>
        new Set(await viewer.$$eval('[data-board-id]', (nodes) => nodes.map((node) => node.dataset.boardId))).size ===
        1,
      'recipient listing excludes private board',
    )
    assert.equal(await viewer.$(`[data-board-id="${boardId}"]`), null)
    const networkDenied = await viewer.evaluate(async (id) => {
      const t = window.__projectsTest
      try {
        await t.firestore.getDocFromServer(t.firestore.doc(t.firebase.getFirestoreDb(), 'boardShares', id))
        return false
      } catch {
        return true
      }
    }, boardId)
    assert.equal(networkDenied, true)
    const storagePath = (await db.doc(`boardShares/${boardId}`).get()).data().scene.files['fixture-image'].storagePath
    assert.equal(
      await viewer.evaluate(async (path) => {
        const t = window.__projectsTest
        try {
          await t.storage.getBytes(t.storage.ref(t.firebase.getFirebaseStorage(), path))
          return false
        } catch {
          return true
        }
      }, storagePath),
      true,
      'Storage access must also be revoked',
    )

    const listed = await viewer.evaluate(
      async (id) => window.__projectsTest.projects.projectService.list(id),
      project.id,
    )
    assert.equal(
      listed.boards.some((board) => board.id === boardId),
      false,
    )
    const token = await viewer.evaluate(() => window.__projectsTest.firebase.getFirebaseAuth().currentUser.getIdToken())
    const response = await fetch(
      `http://127.0.0.1:29000/boards/${boardId}.json?ns=${projectId}&auth=${encodeURIComponent(token)}`,
    )
    assert.equal(response.status, 401, 'RTDB must reject inherited access after privacy change')
  })
  await record('Restore inheritance and preserve existing board IDs', async () => {
    await boardShare(owner, boardId)
    await clickText(owner, 'Use project access')
    await until(
      async () => (await db.doc(`boardShares/${boardId}`).get()).data().inheritProjectAccess === true,
      'restored inheritance',
    )
    await clickText(owner, 'Done')
    await viewer.reload()
    await viewer.waitForSelector(`[data-board-id="${boardId}"]`)
  })
  await record('Failed privacy network request leaves committed access unchanged and shows an error', async () => {
    owner.failFunction = 'manageBoardAccess'
    await restrictBoard(owner, boardId)
    await owner.waitForSelector('[role="dialog"] [role="alert"]')
    assert.equal((await db.doc(`boardShares/${boardId}`).get()).data().inheritProjectAccess, true)
    await owner.keyboard.press('Escape')
    owner.failFunction = null
  })
  await record('Archive is personal; shared project remains available to others', async () => {
    await menu(viewer, 'Project Beta', 'Archive')
    await until(
      async () => (await viewer.$('[aria-label="Project actions for Project Beta"]')) === null,
      'archived hidden',
    )
    await owner.reload()
    await owner.waitForSelector('[aria-label="Project actions for Project Beta"]')
    assert.equal(
      (await db.doc(`users/${identities.viewer.uid}/projectPreferences/${project.id}`).get()).data().archived,
      true,
    )
    assert.equal((await db.doc(`projectShares/${project.id}`).get()).data().archived, undefined)
    await viewer.click('[aria-label="Filter boards"]')
    await viewer.waitForFunction(() =>
      document
        .querySelector('.filter-popover')
        ?.getAnimations()
        .every((animation) => animation.playState === 'finished'),
    )
    await viewer.screenshot({ path: `${out}/project-filter.png` })
    await viewer.screenshot({ path: `${out}/project-filters.png` })
    await clickText(viewer, 'Include archived projects', 'label')
    await viewer.keyboard.press('Escape')
    await viewer.waitForSelector('[aria-label="Project actions for Project Beta"]')
    await menu(viewer, 'Project Beta', 'Unarchive')
  })
  await record('Public project links open the filtered homepage without sign-in', async () => {
    const boardWrites = requests.filter(
      (request) => request.method === 'POST' && request.url.includes('/manageBoardAccess'),
    ).length
    await menu(owner, 'Project Beta', 'Share')
    await owner.click('[aria-label="General access setting"]')
    await clickText(owner, 'Anyone with the link', '[role="menuitem"]')
    await owner.waitForFunction(() => !document.querySelector('.google-share-done-btn').disabled)
    await clickText(owner, 'Done')
    await owner.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 60000 })
    assert.equal((await db.doc(`projectShares/${project.id}`).get()).data().generalAccess, 'anyone_with_link')
    assert.equal(
      requests.filter((request) => request.method === 'POST' && request.url.includes('/manageBoardAccess')).length,
      boardWrites,
      'Project policy updates must not republish existing boards',
    )
    anonymous = await page(null, `/?projectId=${project.id}`)
    await anonymous.waitForSelector(`[data-board-id="${boardId}"]`)
    assert.equal(new URL(anonymous.url()).pathname, '/')
    assert.equal(new URL(anonymous.url()).searchParams.get('projectId'), project.id)
  })
  await record('Project Presentation access opens every inherited board without editing controls', async () => {
    await menu(owner, 'Project Beta', 'Share')
    await owner.click('[aria-label="General access role"]')
    await clickText(owner, 'Present', '[role="menuitem"]')
    await owner.waitForFunction(() => !document.querySelector('.google-share-done-btn').disabled)
    await clickText(owner, 'Done')
    await owner.waitForSelector('.google-share-dialog', { hidden: true })
    for (const id of [boardId, createdByEditor.id ?? createdByEditor]) {
      if (typeof id !== 'string') continue
      await anonymous.goto(`${base}/boards/${id}`)
      await anonymous.waitForSelector('.shared-presentation-landing')
      assert.equal(await anonymous.$('.excalidraw-container'), null)
    }
    await menu(owner, 'Project Beta', 'Share')
    await owner.click('[aria-label="General access role"]')
    await clickText(owner, 'Viewer', '[role="menuitem"]')
    await owner.waitForFunction(() => !document.querySelector('.google-share-done-btn').disabled)
    await clickText(owner, 'Done')
    await owner.waitForSelector('.google-share-dialog', { hidden: true })
  })
  await record('Anyone-with-link project editors receive the full menu and board editing', async () => {
    const policy = (await db.doc(`projectShares/${project.id}`).get()).data()
    policy.generalRole = 'editor'
    await owner.evaluate(
      async ({ id, policy }) => window.__projectsTest.projects.projectService.manage(id, 'share', { policy }),
      { id: project.id, policy },
    )
    await outsider.goto(`${base}/?projectId=${project.id}`)
    await outsider.waitForSelector('[aria-label="Project actions for Project Beta"]')
    await outsider.click('[aria-label="Project actions for Project Beta"]')
    assert.deepEqual(
      await outsider.$$eval('[role="menuitem"]', (nodes) => nodes.map((node) => node.textContent.trim())),
      ['Share', 'Rename', 'Download', 'Archive', 'Delete'],
    )
    await outsider.keyboard.press('Escape')
    assert.equal(
      await outsider.$$eval(
        'button',
        (nodes) => nodes.find((node) => node.textContent.trim() === 'New board').disabled,
      ),
      false,
    )
    await outsider.goto(`${base}/boards/${boardId}`)
    await outsider.waitForFunction(() => window.__excalidrawAPI?.getAppState().viewModeEnabled === false)
    policy.generalRole = 'viewer'
    await owner.evaluate(
      async ({ id, policy }) => window.__projectsTest.projects.projectService.manage(id, 'share', { policy }),
      { id: project.id, policy },
    )
    await outsider.waitForFunction(
      () =>
        !document.querySelector('.access-denied-card') &&
        window.__excalidrawAPI?.getAppState().viewModeEnabled === true,
      { timeout: 10000 },
    )
  })
  await record('Project download offers multiple formats and produces a ZIP', async () => {
    const downloads = `${out}/downloads-${Date.now()}`
    await mkdir(downloads, { recursive: true })
    await owner
      .createCDPSession()
      .then((session) => session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }))
    await owner.evaluate(async (id) => {
      const store = window.__projectsTest.workspace.workspaceStore
      const board = await store.loadBoard(id)
      board.scene.appState.viewBackgroundColor = 'transparent'
      board.scene.elements.push(
        ...window.__projectsTest.excalidraw.convertToExcalidrawElements(
          [{ id: 'export-rectangle', type: 'rectangle', x: 140, y: 0, width: 100, height: 80, strokeColor: '#000000' }],
          { regenerateIds: false },
        ),
      )
      await store.saveBoard(board)
    }, boardId)
    await menu(owner, 'Project Beta', 'Download')
    await owner.waitForFunction(() =>
      document
        .querySelector('[role="dialog"]')
        ?.getAnimations()
        .every((animation) => animation.playState === 'finished'),
    )
    const dialogHeight = await owner.$eval('[role="dialog"]', (node) => node.getBoundingClientRect().height)
    await owner.screenshot({ path: `${out}/download-dialog.png` })
    await owner.click('[aria-label="Download formats"]')
    const svgOption = await owner.waitForSelector('.download-format-popover label:nth-child(2)')
    await svgOption.click()
    assert.equal(
      await svgOption.$eval('[role=checkbox]', (node) => node.getAttribute('data-state')),
      'checked',
      'Real pointer click must toggle SVG',
    )
    await clickText(owner, 'PNG', 'label')
    await owner.keyboard.press('Escape')
    await clickText(owner, 'Download ZIP')
    await owner.waitForFunction(
      () => document.querySelector('[role="dialog"]')?.textContent.includes('files downloaded.'),
      { timeout: 60000 },
    )
    assert.match(await owner.$eval('[role="dialog"]', (node) => node.textContent), /0 failed/)
    assert.equal(
      await owner.$eval('[role="dialog"]', (node) => node.getBoundingClientRect().height),
      dialogHeight,
      'Download result must not shift layout',
    )
    const { readdir } = await import('node:fs/promises')
    await until(async () => (await readdir(downloads)).some((name) => name.endsWith('.zip')), 'ZIP downloaded')
    assert.match(
      (await readdir(downloads)).find((name) => name.endsWith('.zip')),
      /^Project Beta-boards-\d{4}-\d{2}-\d{2}\.zip$/,
    )
    const { unzipSync, strFromU8 } = webRequire('fflate')
    const archive = unzipSync(
      await readFile(`${downloads}/${(await readdir(downloads)).find((name) => name.endsWith('.zip'))}`),
    )
    assert.equal(Object.keys(archive).filter((name) => name.endsWith('.excalidraw')).length, 2)
    assert.equal(Object.keys(archive).filter((name) => name.endsWith('.svg')).length, 2)
    assert.equal(Object.keys(archive).filter((name) => name.endsWith('.png')).length, 2)
    const editable = Object.entries(archive).find(([name]) => name.includes(boardId) && name.endsWith('.excalidraw'))[1]
    assert.equal(
      JSON.parse(strFromU8(editable)).files['fixture-image'].dataURL,
      imageData,
      'Editable export embeds authorized image bytes',
    )
    assert.equal(JSON.parse(strFromU8(archive['manifest.json'])).failures.length, 0)
    const png = Object.entries(archive).find(([name]) => name.includes(boardId) && name.endsWith('.png'))[1]
    const corner = await owner.evaluate(
      async (bytes) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d')
        context.drawImage(bitmap, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let inkPixels = 0
        for (let index = 0; index < pixels.length; index += 4)
          if (pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100 && pixels[index + 3] > 200)
            inkPixels++
        return { corner: [...context.getImageData(0, 0, 1, 1).data], inkPixels }
      },
      [...png],
    )
    assert.deepEqual(corner.corner, [255, 255, 255, 255], 'Transparent canvas exports with opaque white background')
    assert.ok(corner.inkPixels > 50, 'PNG must retain visible drawing strokes')
    await clickText(owner, 'Close')
  })
  await record(
    'Account download excludes received boards, includes local edits, and retries partial failures',
    async () => {
      await viewer.goto(`${base}/settings?tab=account`)
      await viewer.waitForSelector('h2')
      await clickText(viewer, 'Download')
      await clickText(viewer, 'Download ZIP')
      await viewer.waitForFunction(() =>
        document.querySelector('[role="dialog"]')?.textContent.includes('0 files downloaded. 0 failed.'),
      )
      await clickText(viewer, 'Close')
      await owner.goto(`${base}/settings?tab=account`)
      await owner.waitForSelector('h2')
      const brokenId = await owner.evaluate(async (uid) => {
        const t = window.__projectsTest,
          store = t.workspace.workspaceStore
        const localProject = await store.createProject('Local backup', uid)
        await store.createBoard(localProject.id, 'Unsynced local board')
        const broken = await store.createBoard(localProject.id, 'Missing image board')
        broken.scene = {
          elements: t.excalidraw.convertToExcalidrawElements(
            [
              {
                id: 'missing-element',
                type: 'image',
                fileId: 'missing-image',
                status: 'saved',
                x: 0,
                y: 0,
                width: 100,
                height: 100,
              },
            ],
            { regenerateIds: false },
          ),
          appState: {},
          files: {
            'missing-image': {
              id: 'missing-image',
              mimeType: 'image/png',
              created: 1,
              dataURL: '',
              storagePath: `users/${uid}/boards/${broken.id}/assets/missing-image`,
            },
          },
        }
        await store.saveBoard(broken)
        return broken.id
      }, identities.owner.uid)
      await clickText(owner, 'Download')
      await clickText(owner, 'Download ZIP')
      await owner.waitForFunction(
        () => document.querySelector('[role="dialog"]')?.textContent.includes('3 files downloaded. 1 failed.'),
        { timeout: 60000 },
      )
      assert.match(await owner.$eval('.export-failures', (node) => node.textContent), /Missing image board/)
      await owner.evaluate(
        async ({ id, dataURL }) => {
          const store = window.__projectsTest.workspace.workspaceStore,
            board = await store.loadBoard(id)
          board.scene.files['missing-image'].dataURL = dataURL
          await store.saveBoard(board)
        },
        { id: brokenId, dataURL: imageData },
      )
      await clickText(owner, 'Retry failed exports')
      await owner.waitForFunction(
        () => document.querySelector('[role="dialog"]')?.textContent.includes('4 files downloaded. 0 failed.'),
        { timeout: 60000 },
      )
      await clickText(owner, 'Close')
      await owner.goto(base)
      await owner.waitForSelector('[aria-label="Project actions for Project Beta"]')
    },
  )
  await record(
    'Account export discovers cold cloud inventory and preserves conflict copies without writes',
    async () => {
      const fixtureId = `export-${Date.now()}`,
        id = `${fixtureId}-board`,
        inheritedId = `${fixtureId}-inherited`
      const now = new Date().toISOString(),
        uid = identities.owner.uid
      const parent = db.doc(`users/${uid}/projects/${fixtureId}`)
      const scene = {
        elements: [
          {
            id: 'conflict-shape',
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 90,
            height: 80,
            angle: 0,
            strokeColor: '#000000',
            backgroundColor: 'transparent',
            fillStyle: 'solid',
            strokeWidth: 1,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 100,
            groupIds: [],
            frameId: null,
            roundness: null,
            seed: 1,
            version: 1,
            versionNonce: 1,
            isDeleted: false,
            boundElements: null,
            updated: 1,
            link: null,
            locked: false,
          },
        ],
        appState: {},
        files: {},
      }
      const metadata = {
        id: fixtureId,
        name: 'Cloud backup fixture',
        ownerId: uid,
        members: [],
        createdAt: now,
        updatedAt: now,
      }
      await parent.set(metadata)
      const policy = {
        ownerId: uid,
        ownerEmail: identities.owner.email,
        ownerName: 'owner',
        createdAt: now,
        updatedAt: now,
        generalAccess: 'restricted',
        generalRole: 'viewer',
        collaborators: {},
        invitedEmails: [],
        accessRevision: 1,
      }
      await db.doc(`projectShares/${fixtureId}`).set({
        ...policy,
        projectId: fixtureId,
        name: metadata.name,
        collaborators: {
          [identities.viewer.email]: { email: identities.viewer.email, role: 'viewer', addedAt: now },
        },
        invitedEmails: [identities.viewer.email],
      })
      for (const board of [id, inheritedId]) {
        await parent
          .collection('boards')
          .doc(board)
          .set({
            id: board,
            projectId: fixtureId,
            name: board === id ? 'Conflict copy' : 'Inherited copy',
            active: true,
            scene,
            formatVersion: 1,
            createdAt: now,
            updatedAt: now,
            revision: 4,
            baseRevision: 4,
            syncStatus: 'synced',
            syncAttempts: 0,
            nextSyncAt: null,
            lastSyncError: null,
          })
        await db.doc(`boardShares/${board}`).set({
          ...policy,
          boardId: board,
          projectId: fixtureId,
          boardName: board === id ? 'Conflict copy' : 'Inherited copy',
          scene,
          inheritProjectAccess: board !== id,
          ...(board === id
            ? {
                collaborators: {
                  [identities.outsider.email]: { email: identities.outsider.email, role: 'viewer', addedAt: now },
                },
                invitedEmails: [identities.outsider.email],
              }
            : {}),
        })
      }
      await until(
        async () => (await rtdb.ref(`boardAccess/${inheritedId}`).get()).val()?.projectId === fixtureId,
        'export fixture projected',
      )
      // Keep the fixture across the next scenarios; only demo-emulator resources are used.
      globalThis.exportFixture = { fixtureId, id, inheritedId, parent, scene }
      const before = (await parent.collection('boards').doc(id).get()).data()
      const exported = await owner.evaluate(
        async ({ fixtureId, id, scene }) => {
          const t = window.__projectsTest,
            store = t.workspace.workspaceStore
          const list = store.listProjects,
            load = store.loadBoard
          store.listProjects = async () => []
          store.loadBoard = async (key) =>
            key === id
              ? {
                  id,
                  projectId: fixtureId,
                  name: 'Conflict copy',
                  active: true,
                  scene: { ...scene, elements: [{ ...scene.elements[0], width: 200, version: 2 }] },
                  syncStatus: 'conflict',
                  revision: 5,
                  baseRevision: 3,
                }
              : load.call(store, key)
          try {
            const result = await t.exports.exportBoards({ projectId: fixtureId, formats: ['excalidraw', 'svg', 'png'] })
            const prior = {
              ...result,
              files: {},
              fileNames: result.fileNames.filter((name) => !name.endsWith(`${id}-cloud.png`)),
              failures: [
                { boardId: id, boardName: 'Conflict copy', format: 'png', variant: 'cloud', message: 'Retry fixture' },
              ],
            }
            const retried = await t.exports.exportBoards({
              projectId: fixtureId,
              formats: ['excalidraw', 'svg', 'png'],
              previous: prior,
            })
            return {
              retriedFiles: Object.keys(retried.files),
              files: Object.fromEntries(
                Object.entries(result.files).map(([name, bytes]) => [
                  name,
                  name.endsWith('.excalidraw') ? JSON.parse(new TextDecoder().decode(bytes)) : bytes.length,
                ]),
              ),
              captures: result.captures,
              failures: result.failures,
            }
          } finally {
            store.listProjects = list
            store.loadBoard = load
          }
        },
        { fixtureId, id, scene, uid },
      )
      assert.deepEqual(exported.failures, [])
      assert.equal(Object.keys(exported.files).length, 9)
      assert.equal(exported.retriedFiles.length, 1)
      assert.ok(exported.retriedFiles[0].endsWith(`${id}-cloud.png`))
      const local = Object.entries(exported.files).find(([name]) => name.endsWith(`${id}-local.excalidraw`))[1]
      const cloud = Object.entries(exported.files).find(([name]) => name.endsWith(`${id}-cloud.excalidraw`))[1]
      assert.equal(local.elements[0].width, 200)
      assert.equal(cloud.elements[0].width, 90)
      assert.deepEqual(exported.captures.find((item) => item.boardId === id).variants, ['local', 'cloud'])
      assert.deepEqual((await parent.collection('boards').doc(id).get()).data(), before)
    },
  )
  await record(
    'Shared export is opt-in, discovers direct invitations, and excludes private sibling boards',
    async () => {
      const { id, inheritedId } = globalThis.exportFixture
      const exportsFor = (page, includeShared) =>
        page.evaluate(async (includeShared) => {
          const result = await window.__projectsTest.exports.exportBoards({ formats: ['excalidraw'], includeShared })
          return { names: result.fileNames, failures: result.failures }
        }, includeShared)
      assert.equal((await exportsFor(viewer, false)).names.length, 0)
      const invited = await exportsFor(viewer, true)
      assert.ok(invited.names.some((name) => name.includes(inheritedId)))
      assert.ok(
        !invited.names.some((name) => name.includes(`${id}.`)),
        'Project invite cannot read custom private board',
      )
      const direct = await exportsFor(outsider, true)
      assert.ok(
        direct.names.some((name) => name.includes(`${id}.`)),
        'Individual invitation discoverable without project membership',
      )
      assert.ok(
        !direct.names.some((name) => name.includes(inheritedId)),
        'Direct board invitation cannot read siblings',
      )
      await viewer.goto(`${base}/settings?tab=account`)
      await viewer.waitForSelector('h2')
      await clickText(viewer, 'Download')
      const checkbox = await viewer.waitForSelector('[role="dialog"] .filter-check [role="checkbox"]')
      assert.equal(await checkbox.evaluate((node) => node.getAttribute('data-state')), 'unchecked')
      await checkbox.click()
      assert.equal(await checkbox.evaluate((node) => node.getAttribute('data-state')), 'checked')
      await clickText(viewer, 'Download ZIP')
      await viewer.waitForFunction(
        () => {
          const node = document.querySelector('[role="dialog"]')
          return node?.textContent.includes('files downloaded.') && !node?.textContent.includes('Preparing')
        },
        { timeout: 60000 },
      )
      await clickText(viewer, 'Close')
      await db.doc(`boardShares/${id}`).update({ collaborators: {}, invitedEmails: [], accessRevision: 2 })
      const revoked = await exportsFor(outsider, true)
      assert.ok(!revoked.names.some((name) => name.includes(`${id}.`)), 'Revoked direct invitation no longer exported')
    },
  )
  await record(
    'Multipart exports make valid numbered ZIPs, release file buffers, and stop on cancellation',
    async () => {
      const { fixtureId, id, inheritedId } = globalThis.exportFixture
      const downloads = `${out}/multipart-${Date.now()}`
      await mkdir(downloads, { recursive: true })
      await owner
        .createCDPSession()
        .then((session) => session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }))
      const exported = await owner.evaluate(async (fixtureId) => {
        const exports = window.__projectsTest.exports
        const original = await exports.exportBoards({ projectId: fixtureId, formats: ['excalidraw'] })
        const limit = Math.max(...Object.values(original.files).map((bytes) => bytes.length))
        const oversized = await exports.exportBoards({
          projectId: fixtureId,
          formats: ['excalidraw'],
          maxArchiveBytes: 1,
        })
        const recovered = await exports.exportBoards({
          projectId: fixtureId,
          formats: ['excalidraw'],
          previous: oversized,
        })
        const parts = []
        const result = await exports.exportBoards({
          projectId: fixtureId,
          formats: ['excalidraw'],
          maxArchiveBytes: limit,
          onArchiveReady: async (part, number, multipart) => {
            parts.push({
              number,
              multipart,
              names: Object.keys(part.files),
              bytes: Object.values(part.files).reduce((sum, bytes) => sum + bytes.length, 0),
            })
            await exports.downloadExport(part, undefined, 'multipart-check', multipart ? number : undefined)
          },
        })
        const controller = new AbortController()
        let aborted = false,
          count = 0
        try {
          await exports.exportBoards({
            projectId: fixtureId,
            formats: ['excalidraw'],
            maxArchiveBytes: limit,
            signal: controller.signal,
            onArchiveReady: async () => {
              count++
              controller.abort()
            },
          })
        } catch (error) {
          aborted = error.name === 'AbortError'
        }
        let zipFailure = false
        try {
          await exports.exportBoards({
            projectId: fixtureId,
            formats: ['excalidraw'],
            maxArchiveBytes: limit,
            onArchiveReady: async () => {
              throw new Error('Compression fixture failure')
            },
          })
        } catch {
          zipFailure = true
        }
        return {
          oversizedFailures: oversized.failures.length,
          recoveredFiles: recovered.fileNames.length,
          parts,
          limit,
          names: result.fileNames,
          retained: Object.keys(result.files),
          archives: result.archiveCount,
          failures: result.failures,
          aborted,
          count,
          zipFailure,
        }
      }, fixtureId)
      assert.equal(exported.oversizedFailures, 2)
      assert.equal(exported.recoveredFiles, 2)
      assert.equal(exported.parts.length, 2)
      assert.ok(exported.parts.every((part) => part.multipart && part.bytes <= exported.limit))
      assert.deepEqual(exported.retained, [])
      assert.equal(exported.archives, 2)
      assert.deepEqual(exported.failures, [])
      assert.equal(new Set(exported.parts.flatMap((part) => part.names)).size, 2)
      assert.equal(exported.aborted, true)
      assert.equal(exported.count, 1)
      assert.equal(exported.zipFailure, true)
      await until(
        async () => (await readdir(downloads)).filter((name) => name.endsWith('.zip')).length === 2,
        'numbered ZIP parts downloaded',
      )
      const { unzipSync } = webRequire('fflate')
      for (const [index, name] of (await readdir(downloads))
        .filter((name) => name.endsWith('.zip'))
        .sort()
        .entries()) {
        assert.ok(name.endsWith(`-part-00${index + 1}.zip`))
        const files = unzipSync(await readFile(`${downloads}/${name}`))
        const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']))
        assert.equal(manifest.partNumber, index + 1)
        assert.equal(manifest.files.length, 1)
        assert.ok(files[manifest.files[0]])
      }
      const { parent } = globalThis.exportFixture
      for (const board of [id, inheritedId]) {
        await parent.collection('boards').doc(board).delete()
        await db.doc(`boardShares/${board}`).delete()
      }
      await parent.delete()
      await db.doc(`projectShares/${fixtureId}`).delete()
    },
  )
  await record('Soft delete blocks direct links and stale scene saves; data retained', async () => {
    await editor.goto(base)
    await editor.waitForSelector('[aria-label="Project actions for Project Beta"]')
    await menu(editor, 'Project Beta', 'Delete')
    const controls = await editor.$$eval('.project-dialog-footer button', (nodes) =>
      nodes.map((node) => ({
        radius: getComputedStyle(node).borderRadius,
        height: node.offsetHeight,
        top: node.offsetTop,
      })),
    )
    assert.equal(controls[0].radius, controls[1].radius)
    assert.equal(controls[0].height, controls[1].height)
    assert.equal(controls[0].top, controls[1].top)
    assert.equal(
      await editor.$eval('.project-dialog-footer', (node) => getComputedStyle(node).justifyContent),
      'flex-end',
    )
    assert.equal(await editor.$eval('.project-delete-dialog', (node) => node.offsetWidth), 400)
    assert.equal(await editor.$eval('.project-delete-btn', (node) => getComputedStyle(node).paddingLeft), '16px')
    await editor.screenshot({ path: `${out}/delete-project-compact.png` })
    await clickText(editor, 'Delete project')
    await editor.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 60000 })
    assert.ok((await project.ref.get()).data().deletedAt)
    assert.equal((await project.ref.collection('boards').get()).size, 2)
    const rejected = await editor.evaluate(async (id) => {
      const t = window.__projectsTest
      try {
        await t.firestore.updateDoc(t.firestore.doc(t.firebase.getFirestoreDb(), 'boardShares', id), {
          scene: { elements: [], appState: {} },
        })
        return false
      } catch {
        return true
      }
    }, boardId)
    assert.equal(rejected, true)
    await anonymous.goto(`${base}/boards/${boardId}`)
    await anonymous.waitForFunction(() => /access|restricted|permission/i.test(document.body.textContent))
    const mirror = (await rtdb.ref(`projectAccess/${project.id}`).get()).val()
    assert.equal(mirror.blocked, true)
  })
  await record('Account switch isolates cached owned projects and boards', async () => {
    await owner.evaluate(
      async ({ email, password }) => {
        const t = window.__projectsTest,
          auth = t.firebase.getFirebaseAuth()
        await t.auth.signOut(auth)
        await t.auth.signInWithEmailAndPassword(auth, email, password)
      },
      { email: identities.viewer.email, password },
    )
    await owner.waitForSelector('.workspace-intro')
    await owner.waitForFunction(
      async () => (await window.__projectsTest.workspace.workspaceStore.listProjects()).length === 0,
    )
    const data = await owner.evaluate(() => window.__projectsTest.workspace.workspaceApi.listWorkspace())
    assert.equal(data.projects.length, 0)
    assert.equal(data.boards.length, 0)
  })
  assert.ok(
    requests.some((request) => request.url.includes('/manageProject') && request.status === 200),
    'Must exercise real Functions network calls',
  )
  assert.ok(
    requests.some((request) => request.url.includes(':28080/')),
    'Must exercise Firestore network calls',
  )
  assert.ok(
    requests.some((request) => request.url.includes(':29199/')),
    'Must exercise authorized Storage network calls',
  )
  assert.deepEqual(failures, [], 'No uncaught browser errors')
  console.log(`PASS: ${results.length} browser/network scenarios; Firebase rules and Functions exercised`)
} catch (error) {
  console.error('Original project test failure:', error.stack)
  if (anonymous) {
    await anonymous.screenshot({ path: `${out}/anonymous-failure.png`, fullPage: true })
    await writeFile(`${out}/anonymous-failure.html`, await anonymous.content())
    console.log('Anonymous URL:', anonymous.url())
    console.log(
      'Anonymous body:',
      await anonymous.$eval('body', (node) => node.textContent.slice(0, 2000)).catch(() => 'Navigation in progress'),
    )
  }
  if (editor) await editor.screenshot({ path: `${out}/editor-failure.png`, fullPage: true })
  if (viewer) await viewer.screenshot({ path: `${out}/viewer-failure.png`, fullPage: true })
  if (owner) {
    await owner.screenshot({ path: `${out}/failure.png`, fullPage: true })
    await writeFile(`${out}/failure.html`, await owner.content())
  }
  throw error
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify({ results, requests, failures, sharingAudit }, null, 2))
  await browser.close()
  await server.close()
  await db.terminate()
  await admin.delete()
}
