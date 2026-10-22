/** Browser contract test for pinned callable scene reads and legacy Firestore denial. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Scene read security test requires isolated demo-regression emulators.')

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const adminApp = initializeApp({ projectId: 'demo-regression' }, 'scene-read-security')
const db = getFirestore(adminApp)
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const calls = []
const context = await browser.createBrowserContext()
const page = await context.newPage()

page.on('request', (request) => {
  if (request.method() !== 'POST' || !request.url().includes(':45001/')) return
  try {
    calls.push({ endpoint: request.url().split('/').pop(), data: JSON.parse(request.postData() || '{}').data })
  } catch {
    // Ignore non-callable requests.
  }
})

let fixture
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  fixture = await page.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    const { user } = await signInOwner(getFirebaseAuth())
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const project = await workspaceApi.createProject('Scene read security fixture')
    const board = await workspaceApi.createBoard(project.id, 'Pinned callable reader fixture')
    await workspaceApi.saveBoard({
      ...board,
      scene: {
        elements: [
          {
            id: 'security-fixture-element',
            type: 'rectangle',
            x: 10,
            y: 20,
            width: 80,
            height: 40,
            version: 1,
            versionNonce: 17,
          },
        ],
        appState: { viewBackgroundColor: '#ffffff' },
        files: {},
      },
    })
    await workspaceApi.flushCloud()
    return { boardId: board.id, projectId: project.id, uid: user.uid, email: user.email }
  })

  // Reload to clear the in-memory chunk cache so this test proves the callable path fetches payload bytes.
  const loadStart = calls.length
  await page.reload({ waitUntil: 'domcontentloaded' })
  const loaded = await page.evaluate(async (boardId) => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    await getFirebaseAuth().authStateReady()
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const scene = await sceneService.load(boardId)
    if (!scene) throw new Error('Expected a committed scene.')
    return {
      revisionId: scene.revisionId,
      generation: scene.generation,
      chunkIds: scene.chunks.map(({ chunkId }) => chunkId),
    }
  }, fixture.boardId)
  assert(loaded.chunkIds.length > 0, 'The fixture contains at least one scene chunk.')

  const directReads = await page.evaluate(
    async ({ boardId, revisionId, chunkId }) => {
      const { directSceneReadProbe } = await import('/tests/chunked-scene-fixture.ts')
      return directSceneReadProbe(boardId, revisionId, chunkId)
    },
    { boardId: fixture.boardId, revisionId: loaded.revisionId, chunkId: loaded.chunkIds[0] },
  )

  assert.equal(
    directReads.headAllowed,
    true,
    'Authorized clients retain the head metadata read required to locate the board.',
  )
  for (const [path, result] of Object.entries(directReads).filter(([path]) => path !== 'headAllowed')) {
    assert.equal(result.allowed, false, `Direct Firestore read of ${path} must be denied.`)
    assert.equal(result.code, 'permission-denied', `Direct Firestore read of ${path} must fail by rules.`)
  }

  const pageReads = calls.slice(loadStart).filter(
    (call) => call.endpoint === 'readBoardScenePage' && call.data.boardId === fixture.boardId,
  )
  const chunkReads = calls.slice(loadStart).filter(
    (call) => call.endpoint === 'readBoardSceneChunks' && call.data.boardId === fixture.boardId,
  )
  assert(pageReads.length > 0, 'Scene pages are read through the callable API.')
  assert(chunkReads.length > 0, 'Scene chunks are read through the callable API.')
  for (const call of [...pageReads, ...chunkReads]) {
    assert.equal(call.data.sceneProtocolVersion, 2, `${call.endpoint} declares the scene protocol.`)
    assert.equal(typeof call.data.pinId, 'string', `${call.endpoint} names the active reader pin.`)
    assert.equal(call.data.revisionId, loaded.revisionId, `${call.endpoint} reads the pinned revision.`)
  }
  for (const call of chunkReads) {
    assert.equal(typeof call.data.pageId, 'string', 'Chunk calls are bounded to one manifest page.')
    assert(
      call.data.chunkIds.length >= 1 && call.data.chunkIds.length <= 8,
      'Chunk call batch stays below the endpoint limit.',
    )
  }
  console.log(
    'PASS scene payload reads use protocol-versioned pinned callables; direct Firestore payload reads are denied',
  )
} finally {
  await context.close()
  await browser.close()
  if (fixture) {
    await db.recursiveDelete(db.doc(`boardScenes/${fixture.boardId}`))
    await db.doc(`boardShares/${fixture.boardId}`).delete()
    await db.doc(`users/${fixture.uid}/projects/${fixture.projectId}/boards/${fixture.boardId}`).delete()
    await db.doc(`users/${fixture.uid}/projects/${fixture.projectId}`).delete()
    await db.doc(`projectShares/${fixture.projectId}`).delete()
  }
}
