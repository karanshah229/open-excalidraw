/** Actual history UI assertions. Fixtures and destructive restores stay in disposable demo emulators. */
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { writeFile } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('History UI tests require isolated demo-regression emulators.')
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const artifacts = process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const calls = [], errors = []
const context = await browser.createBrowserContext()
const page = await context.newPage()
page.setDefaultTimeout(45000)
await page.setViewport({ width: 1440, height: 900 })
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
page.on('pageerror', (error) => errors.push(error.message))
page.on('dialog', (dialog) => dialog.accept())
page.on('request', (request) => {
  if (request.method() !== 'POST' || !request.url().includes(':45001/')) return
  try { calls.push({ endpoint: request.url().split('/').pop(), data: JSON.parse(request.postData() || '{}').data }) } catch { /* noncallable */ }
})
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  const seed = await page.evaluate(async () => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { boardHistoryStore, setWorkspaceIdentity, convertToExcalidrawElements } = await import('/tests/history-fixture.ts')
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signOut } = await import('/tests/regression-fixture.ts')
    const auth = getFirebaseAuth()
    if (auth?.currentUser) await signOut(auth)
    workspaceApi.deactivateCloudWorkspace()
    setWorkspaceIdentity('local-user')
    const project = await workspaceApi.createProject('History UI local fixture')
    const id = `history-local-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const elements = convertToExcalidrawElements([
      { type: 'frame', children: ['original-shape'], id: 'slide-one', x: 0, y: 0, width: 400, height: 300, name: 'Slide one', customData: { agenticWhiteboard: { slide: { schemaVersion: 1, orderKey: '0/1' } } } },
      { type: 'rectangle', id: 'original-shape', x: 40, y: 40, width: 100, height: 80, frameId: 'slide-one' },
    ], { regenerateIds: false })
    const original = await workspaceApi.saveBoard({ id, projectId: project.id, name: 'Original board', scene: { elements, appState: { viewBackgroundColor: '#ffffff', theme: 'light' }, files: {} }, formatVersion: 1, active: true, createdAt: now, updatedAt: now, revision: 0, baseRevision: 0, syncStatus: 'local-only', syncAttempts: 0, nextSyncAt: null, lastSyncError: null })
    const target = await boardHistoryStore.saveNotes(id, { 'slide-one': 'Original speaker note' })
    const edited = { ...original, revision: target.document.revision, name: 'Changed board', scene: { ...original.scene, elements: [...elements, ...convertToExcalidrawElements([{ type: 'ellipse', id: 'later-shape', x: 200, y: 120, width: 80, height: 60 }], { regenerateIds: false })] } }
    await workspaceApi.saveBoard(edited)
    await boardHistoryStore.saveNotes(id, { 'slide-one': 'Later speaker note' })
    const latest = await boardHistoryStore.getCommittedContent(id)
    return { id, target: target.version.localVersionId, latest: latest.version.localVersionId }
  })
  await page.goto(`${base}/boards/${seed.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__excalidrawAPI)
  await page.waitForSelector('[data-testid="board-history-open"]:not(:disabled)')
  const liveBefore = await page.evaluate(() => window.__excalidrawAPI.getSceneElements().map((element) => element.id).sort())
  assert.ok(liveBefore.includes('later-shape'))
  const callOffset = calls.length
  await page.click('[data-testid="board-history-open"]')
  await page.waitForSelector('[data-testid="board-history-dialog"]')
  await page.waitForSelector(`[data-version-id="${seed.target}"]`)
  await page.waitForFunction(() => document.querySelector('[data-testid="history-preview-name"]')?.textContent === 'Changed board')
  assert.equal(await page.$eval('.history-entry[aria-pressed="true"]', (row) => row.dataset.versionId), seed.latest,
    'Opening history automatically selects its newest saved version')
  assert.match(await page.$eval('[data-testid="history-preview-notes"]', (element) => element.textContent), /Later speaker note/,
    'The newest version preview includes its speaker notes')
  await page.click(`[data-version-id="${seed.target}"]`)
  await page.waitForFunction(() => document.querySelector('[data-testid="history-preview-name"]')?.textContent === 'Original board')
  assert.match(await page.$eval('[data-testid="history-preview-notes"]', (element) => element.textContent), /Original speaker note/)
  await page.click('[data-testid="history-preview-canvas"] .dropdown-menu-button')
  assert.equal(await page.$eval('[data-testid="history-preview-canvas"]', (canvas) => /Excalidraw links|Follow us|Discord chat|GitHub/.test(canvas.textContent)), false, 'Preview menu excludes vendor links')
  await page.screenshot({ path: `${artifacts}/board-history-menu.png` })
  await page.click('[data-testid="history-preview-canvas"] .dropdown-menu-button')

  const assertTheme = async (theme) => {
    await page.waitForFunction((value) => {
      const canvas = document.querySelector('[data-testid="history-preview-canvas"] .excalidraw')
      return document.documentElement.dataset.theme === value && canvas && canvas.classList.contains('theme--dark') === (value === 'dark')
    }, {}, theme)
    const styles = await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="board-history-dialog"]')
      const probe = document.createElement('div')
      probe.style.backgroundColor = 'var(--bg-surface)'
      probe.style.color = 'var(--text-primary)'
      modal.append(probe)
      const expected = getComputedStyle(probe), actual = getComputedStyle(modal)
      const result = { background: actual.backgroundColor, color: actual.color, expectedBackground: expected.backgroundColor, expectedColor: expected.color }
      probe.remove()
      return result
    })
    assert.equal(styles.background, styles.expectedBackground)
    assert.equal(styles.color, styles.expectedColor)
    return styles.background
  }
  const darkBackground = await assertTheme('dark')
  assert.equal(await page.$eval('[aria-label="Close board history"]', (button) => button.textContent), '', 'Close is an accessible X icon')
  assert.equal(await page.$eval(`[data-version-id="${seed.target}"]`, (row) => row.querySelector('time').textContent === new Date(row.querySelector('time').dateTime).toLocaleString()), true)
  await page.screenshot({ path: `${artifacts}/board-history-dark.png` })
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
  const lightBackground = await assertTheme('light')
  assert.notEqual(lightBackground, darkBackground, 'An open modal responds to app theme changes')
  await page.screenshot({ path: `${artifacts}/board-history-light.png` })
  await page.setViewport({ width: 390, height: 844 })
  await page.waitForFunction(() => {
    const modal = document.querySelector('[data-testid="board-history-dialog"]').getBoundingClientRect()
    const canvas = document.querySelector('[data-testid="history-preview-canvas"]').getBoundingClientRect()
    const action = document.querySelector('[data-testid="history-restore"]').getBoundingClientRect()
    return canvas.height > 100 && action.bottom <= modal.bottom && action.right <= modal.right && modal.right <= innerWidth
  })
  await page.screenshot({ path: `${artifacts}/board-history-mobile.png` })
  await page.setViewport({ width: 1440, height: 900 })

  assert.deepEqual(await page.evaluate(() => window.__excalidrawAPI.getSceneElements().map((element) => element.id).sort()), liveBefore, 'Preview never injects its scene into the live editor')
  assert.equal(calls.slice(callOffset).filter((call) => ['commitBoardScene', 'updateBoardContent', 'slideNotes', 'restoreBoardVersion'].includes(call.endpoint) && call.data?.operation !== 'read').length, 0, 'Preview makes no content mutation calls')
  await page.click('[data-testid="history-restore"]')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="history-data-loss-confirmation"]') || !document.querySelector('[data-testid="board-history-dialog"]'))
  if (await page.$('[data-testid="history-data-loss-confirmation"]')) await page.click('[data-testid="history-confirm-restore"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="history-restoration-progress"]') && !document.querySelector('[data-testid="board-history-dialog"]'))
  assert.deepEqual(await page.evaluate(() => window.__excalidrawAPI.getSceneElements().map((element) => element.id).sort()), ['original-shape', 'slide-one'])
  const after = await page.evaluate(async (id) => {
    const { boardHistoryStore } = await import('/tests/history-fixture.ts')
    return { content: await boardHistoryStore.getCommittedContent(id), versions: await boardHistoryStore.list(id) }
  }, seed.id)
  assert.equal(after.content.document.name, 'Original board')
  assert.equal(after.content.notes['slide-one'], 'Original speaker note')
  assert.ok(after.versions.every((version) => version.name !== 'Changed board'), 'Abandoned descendants are hidden')
  await page.click('[data-testid="board-history-open"]')
  await page.waitForSelector(`[data-version-id="${after.content.version.localVersionId}"]`)
  await page.click(`[data-version-id="${after.content.version.localVersionId}"]`)
  await page.waitForSelector('[data-testid="history-preview-name"]')
  assert.equal(await page.$eval('[data-testid="history-restore"]', (button) => button.disabled), true, 'Current version cannot be restored')
  assert.equal(await page.$eval('[data-testid="history-restore-reason"]', (element) => element.textContent), 'This is the current version.')
  await page.click('[aria-label="Close board history"]')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__excalidrawAPI && window.__excalidrawAPI.getSceneElements().some((element) => element.id === 'original-shape'))
  assert.equal(await page.evaluate(() => window.__excalidrawAPI.getSceneElements().some((element) => element.id === 'later-shape')), false, 'Cold reload retains restored content')
  await page.keyboard.down('Meta')
  await page.keyboard.press('z')
  await page.keyboard.up('Meta')
  assert.equal(await page.evaluate(() => window.__excalidrawAPI.getSceneElements().some((element) => element.id === 'later-shape')), false, 'Undo cannot resurrect an abandoned universe')
  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log('PASS History actual UI local restore, complete preview, current-disabled, lineage, reload and undo')
} finally {
  await writeFile(`${artifacts}/board-history-ui-network.json`, JSON.stringify({ calls, errors }, null, 2))
  await context.close()
  await browser.close()
}
