/** Real status component/auth/native-outbox browser regression, independent of worker timing. */
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { writeFile } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Requires disposable status UI emulators')
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.createBrowserContext(), page = await context.newPage()
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190', artifacts = process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'
const checks = [], errors = []
page.setDefaultTimeout(30000); await page.setViewport({ width: 1200, height: 800 })
page.on('pageerror', (error) => errors.push(error.message))
const title = async (text) => page.waitForFunction((expected) => document.querySelector('.sync-simple-title')?.textContent === expected, {}, text)
async function render(boardId, cloudHistoryEnabled = true) {
  await page.evaluate(async ({ boardId, cloudHistoryEnabled }) => {
    const { renderStatus } = await import('/tests/history-sync-status-fixture.tsx')
    renderStatus({ boardId, cloudHistoryEnabled, state: cloudHistoryEnabled ? 'Synced' : 'Synced locally' })
  }, { boardId, cloudHistoryEnabled })
  await page.waitForSelector('[data-testid="board-info-open"]')
  if (!(await page.$('.sync-status-popover'))) await page.click('[data-testid="board-info-open"]')
}
try {
  await page.goto(`${base}/tests/history-fixture.ts`)
  const seed = await page.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner, pauseCloudReplication } = await import('/tests/regression-fixture.ts')
    const { user } = await signInOwner(getFirebaseAuth()); pauseCloudReplication()
    const { boardHistoryStore } = await import('/tests/history-fixture.ts')
    const timestamp = new Date().toISOString(), boardId = crypto.randomUUID()
    const document = { id: boardId, projectId: 'isolated-status-project', name: 'Status original', active: true, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced', revision: 0, baseRevision: 0, syncAttempts: 0, nextSyncAt: null, lastSyncError: null, formatVersion: 1, scene: { elements: [], appState: {}, files: {} }, cloudGeneration: 1, cloudRestoreFence: 0, cloudVersionId: 'status-cloud-base', cloudRevisionId: 'status-scene-base' }
    await boardHistoryStore.initialize(document, {})
    const saved = await boardHistoryStore.save({ ...document, name: 'Status pending capture' }, { changedFields: { name: true } })
    await boardHistoryStore.acknowledgeHead(boardId, saved.version.localVersionId)
    return { boardId, localVersionId: saved.version.localVersionId, uid: user.uid }
  })
  await render(seed.boardId)
  await title('Board synced; history pending')
  assert.match(await page.$eval('[data-testid="history-upload-status"]', (element) => element.textContent), /1 historical version/)
  assert.equal(await page.$eval('[data-testid="board-info-open"]', (button) => button.dataset.historyPending), '1')
  checks.push('Synced current board plus unreceipted native history shows pending count, not All changes saved')
  await page.evaluate(async ({ boardId, localVersionId }) => {
    const { boardHistoryStore } = await import('/tests/history-fixture.ts')
    await boardHistoryStore.markOutboxBlocked(boardId, localVersionId, 'Fixture historical ancestry unavailable')
    window.dispatchEvent(new CustomEvent('board-history-sync-status', { detail: { boardId, status: 'blocked' } }))
  }, seed)
  await title('Board synced; history upload failed')
  assert.match(await page.$eval('[data-testid="history-upload-status"]', (element) => element.textContent), /1 historical version could not upload/)
  assert.equal(await page.$eval('[data-testid="history-upload-error"]', (element) => element.textContent), 'Fixture historical ancestry unavailable')
  await page.screenshot({ path: `${artifacts}/board-history-sync-status-blocked.png` })
  checks.push('Blocked history status event shows exact error/count while current-board sync remains separate')
  await render('another-status-board')
  await title('All changes saved')
  assert.equal(await page.$('[data-testid="history-upload-error"]'), null, 'Board switch cannot expose another board’s error')
  await render(seed.boardId, false)
  await title('Synced locally')
  assert.equal(await page.$('[data-testid="history-upload-status"]'), null)
  assert.equal(await page.$eval('[data-testid="board-info-open"]', (button) => button.dataset.historyPending), '0')
  assert.match(await page.$eval('.sync-simple-desc', (element) => element.textContent), /device only/)
  checks.push('Board switch clears errors; local-only board suppresses cloud-history pending state')
  await render(seed.boardId)
  await title('Board synced; history upload failed')
  await page.evaluate(async () => {
    const { signInOwner, pauseCloudReplication } = await import('/tests/regression-fixture.ts')
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    await signInOwner(getFirebaseAuth()); pauseCloudReplication()
  })
  await title('All changes saved')
  assert.equal(await page.$('[data-testid="history-upload-error"]'), null, 'Account change cannot expose previous account’s history error')
  assert.equal(await page.$eval('[data-testid="board-info-open"]', (button) => button.dataset.historyPending), '0')
  checks.push('Actual Firebase account change isolates the same board ID’s native outbox')
  // Guest sessions are real editors even though AuthProvider hides anonymous users from profile UI.
  await page.evaluate(async (boardId) => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signOut, signInAnonymously } = await import('/tests/regression-fixture.ts')
    const { boardHistoryStore, setWorkspaceIdentity } = await import('/tests/history-fixture.ts')
    await signOut(getFirebaseAuth()); const { user } = await signInAnonymously(getFirebaseAuth()); setWorkspaceIdentity(user.uid)
    const timestamp = new Date().toISOString()
    const document = { id: boardId, projectId: '', name: 'Guest status', active: true, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced', revision: 0, baseRevision: 0, syncAttempts: 0, nextSyncAt: null, lastSyncError: null, formatVersion: 1, scene: { elements: [], appState: {}, files: {} }, cloudGeneration: 1, cloudRestoreFence: 0, cloudVersionId: 'guest-cloud-base', cloudRevisionId: 'guest-scene-base' }
    await boardHistoryStore.initialize(document, {})
    const saved = await boardHistoryStore.save({ ...document, name: 'Guest pending' }, { changedFields: { name: true } })
    await boardHistoryStore.acknowledgeHead(boardId, saved.version.localVersionId)
    window.__statusCapture = { boardId, localVersionId: saved.version.localVersionId }
    window.dispatchEvent(new CustomEvent('board-history-local-save', { detail: { boardId } }))
  }, seed.boardId)
  await title('Board synced; history pending')
  assert.match(await page.$eval('[data-testid="history-upload-status"]', (element) => element.textContent), /1 historical version/)
  await page.evaluate(async () => {
    const { boardHistoryStore } = await import('/tests/history-fixture.ts')
    const { boardId, localVersionId } = window.__statusCapture
    const acceptedAt = new Date().toISOString()
    await boardHistoryStore.acknowledge(boardId, localVersionId, { localSnapshotVersionId: 'guest-history-receipt', canonicalVersionId: 'guest-cloud-current', acceptedAt, expiresAt: new Date(Date.now() + 86400000).toISOString() })
    window.dispatchEvent(new CustomEvent('board-history-sync-status', { detail: { boardId, status: 'completed' } }))
  })
  await title('All changes saved')
  assert.equal(await page.$('[data-testid="history-upload-status"]'), null)
  checks.push('Anonymous guest history is tracked; accepted receipt/event restores All changes saved')
  assert.deepEqual(errors, [])
  console.log('PASS ' + checks.join('; '))
} finally {
  await writeFile(`${artifacts}/board-history-sync-status-report.json`, JSON.stringify({ checks, errors }, null, 2))
  await page.evaluate(async () => { const { unmountStatus } = await import('/tests/history-sync-status-fixture.tsx'); unmountStatus() }).catch(() => {})
  await context.close(); await browser.close()
}
