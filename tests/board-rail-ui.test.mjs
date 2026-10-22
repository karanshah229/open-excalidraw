/** Actual owner/viewer rail controls, keyboard popovers, and legacy history availability. */
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Requires disposable rail UI emulators')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const app = initializeApp({ projectId: 'demo-regression' }), db = getFirestore(app)
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const ownerContext = await browser.createBrowserContext(), viewerContext = await browser.createBrowserContext()
const owner = await ownerContext.newPage(), viewer = await viewerContext.newPage()
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190', artifacts = process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'
const checks = [], diagnostics = []
for (const page of [owner, viewer]) { await page.setViewport({ width: 1440, height: 900 }); page.setDefaultTimeout(60000); page.on('dialog', (dialog) => dialog.accept()) }
async function inspect(page, ownerMode) {
  await page.bringToFront()
  await page.waitForSelector('[data-testid="board-info-open"]')
  const controls = await page.evaluate(() => {
    const rail = document.querySelector('.board-panel-rail'), footer = rail.querySelector('.board-panel-footer')
    return { footer: [...footer.querySelectorAll('button')].map((button) => { const rect = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label'), text: button.textContent.trim(), disabled: button.disabled, x: rect.x, y: rect.y, width: rect.width, height: rect.height } }), headerInfo: document.querySelector('#header-status-slot [data-testid="board-info-open"]') !== null, headerHistory: document.querySelector('#header-status-slot [data-testid="board-history-open"]') !== null }
  })
  diagnostics.push({ role: ownerMode ? 'owner' : 'viewer', controls })
  assert.equal(controls.headerInfo, true)
  assert.equal(controls.headerHistory, false)
  assert.deepEqual(controls.footer.map((control) => control.label), ownerMode ? ['Board history', 'Help'] : ['Help'])
  assert.ok(controls.footer.every((control) => control.text === '' && control.x >= 1390 && control.width >= 32 && control.height >= 32), 'Rail controls show icons and accessible labels')
  assert.ok(controls.footer.every((control, index) => index === 0 || control.y > controls.footer[index - 1].y), 'History sits directly above help')
  await page.focus('[data-testid="board-info-open"]')
  await page.keyboard.press('Enter')
  const popoverSelector = ownerMode ? '.sync-status-popover' : '.board-info-popover'
  await page.waitForSelector(popoverSelector)
  const popover = await page.$eval(popoverSelector, (element) => { const rect = element.getBoundingClientRect(), info = document.querySelector('[data-testid="board-info-open"]').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, infoBottom: info.bottom, text: element.textContent } })
  assert.ok(popover.left >= 0 && popover.top >= 0 && popover.right <= 1440 && popover.bottom <= 900, 'Popover stays within viewport')
  assert.ok(popover.top >= popover.infoBottom, 'Info popover opens below its header trigger')
  assert.ok(popover.text.includes('Filename') && popover.text.includes('File size'))
  if (ownerMode) assert.ok(await page.$eval('.sync-simple-title', (element) => element.textContent.trim().length > 0), 'Save status remains inside info popover')
  await page.screenshot({ path: `${artifacts}/board-rail-${ownerMode ? 'owner' : 'viewer'}-info.png` })
  await page.keyboard.press('Escape')
  await page.waitForFunction((selector) => !document.querySelector(selector), {}, popoverSelector)
  await page.waitForFunction(() => document.querySelector('[data-testid="board-info-open"]') === document.activeElement, { timeout: 5000 })
  assert.equal(await page.$eval('[data-testid="board-info-open"]', (button) => button === document.activeElement), true, 'Escape returns keyboard focus to info')
  assert.equal(await page.$eval('[data-testid="board-info-open"]', (button) => button.textContent.trim()), '', 'Header info is icon-only')
  checks.push(`${ownerMode ? 'Owner' : 'Viewer'} sidebar History above Help, header icon-only info, below-header popover details/status and viewport bounds, Enter/Escape focus`)
}
try {
  await owner.goto(base)
  const fixture = await owner.evaluate(async () => {
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const { user } = await signInOwner(getFirebaseAuth())
    const project = await workspaceApi.createProject('Rail UI proof')
    const board = await workspaceApi.createBoard(project.id, 'Rail info proof')
    await workspaceApi.flushCloud()
    const config = await sharingService.getShareConfig(board.id, { ownerId: user.uid, boardName: board.name, scene: board.scene })
    await sharingService.saveShareConfig({ ...config, generalAccess: 'anyone_with_link', generalRole: 'viewer', scene: board.scene })
    return { id: board.id }
  })
  await owner.goto(`${base}/boards/${fixture.id}`)
  await owner.waitForSelector('[data-testid="board-info-open"]')
  const head = (await db.doc(`boardScenes/${fixture.id}`).get()).data()
  if (head?.historyProtocolVersion === 1) await owner.waitForSelector('[data-testid="board-history-open"]:not(:disabled)')
  else {
    await owner.waitForSelector('[data-testid="board-history-open"][disabled]')
    assert.match(await owner.$eval('[data-testid="board-history-open"]', (button) => button.title), /requires a server update/)
    checks.push('Legacy backend exposes disabled History with explicit server-update tooltip')
  }
  await inspect(owner, true)
  await viewer.goto(`${base}/boards/${fixture.id}`)
  await viewer.waitForFunction(() => !!window.__excalidrawAPI && window.__excalidrawAPI.getAppState().viewModeEnabled)
  assert.equal(await viewer.$('[data-testid="board-history-open"]'), null, 'Viewers have no history control')
  await inspect(viewer, false)
  console.log('PASS ' + checks.join('; '))
} finally {
  await writeFile(`${artifacts}/board-rail-ui.json`, JSON.stringify({ checks, diagnostics }, null, 2))
  await ownerContext.close(); await viewerContext.close(); await browser.close(); await deleteApp(app)
}
