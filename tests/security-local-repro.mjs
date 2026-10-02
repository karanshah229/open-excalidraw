// Run against an isolated Vite server on port 15173 with Firebase disabled.
// Exercises the real IndexedDB implementation, not mocked storage.
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:15173/', { waitUntil: 'networkidle0' })
  const result = await page.evaluate(async () => {
    const { isFirebaseConfigured } = await import('/src/lib/firebase.ts')
    if (isFirebaseConfigured) throw new Error('Refusing test: Firebase must be disabled for this fixture.')
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    await workspaceApi.activateCloudWorkspace('account-A')
    const project = await workspaceApi.createProject('A private project')
    const board = await workspaceApi.createBoard(project.id, 'A secret board')
    await workspaceApi.saveBoard({ ...board, scene: { elements: [{ id: 'secret', type: 'rectangle', x: 1, y: 1, width: 20, height: 20 }], appState: {} } })
    await workspaceApi.deleteBoard(board.id)
    const deleted = await workspaceApi.loadBoard(board.id)
    const another = await workspaceApi.createBoard(project.id, 'A retained private board')
    workspaceApi.deactivateCloudWorkspace()
    const afterLogout = await workspaceApi.loadBoardWithProject(another.id)
    await workspaceApi.activateCloudWorkspace('account-B')
    const bWorkspace = await workspaceApi.listWorkspace()
    return { deleted, afterLogoutOwner: afterLogout.project.ownerId,
      bSeesA: bWorkspace.boards.some((b) => b.id === another.id), boardId: another.id }
  })
  assert.equal(result.deleted, null)
  assert.equal(result.afterLogoutOwner, 'account-A')
  assert.equal(result.bSeesA, true)
  console.log('CONFIRMED: logout retains A board; activation of B lists A private board from shared IndexedDB')
  await page.goto(`http://127.0.0.1:15173/boards/${result.boardId}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.excalidraw', { timeout: 20000 })
  console.log('CONFIRMED: cached private board opens with no signed-in user through local fallback')
} finally {
  await browser.close()
}
