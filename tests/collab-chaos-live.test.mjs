import { reloadAllowingPendingChanges } from './browser-navigation.mjs'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function eventually(read, predicate, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${message}. Last observed value: ${JSON.stringify(last)}`)
}

function rectangle(id, x, y, version = 1, versionNonce = 1) {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 120,
    height: 80,
    angle: 0,
    strokeColor: '#1d4ed8',
    backgroundColor: '#dbeafe',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    isDeleted: false,
    version,
    versionNonce,
  }
}

async function openBoard(page, boardUrl) {
  await page.goto(boardUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__excalidrawAPI), { timeout: 15_000 })
}

async function createElement(page, element) {
  await page.evaluate((next) => {
    window.__setUserInteracted?.()
    const api = window.__excalidrawAPI
    const template = api.getSceneElements()[0]
    const validElement = { ...template, ...next, groupIds: [], frameId: null, boundElements: null, updated: Date.now() }
    const elements = [...api.getSceneElements(), validElement]
    api.updateScene({ elements })
    window.__collab?.broadcastChanges?.(elements)
  }, element)
}

async function updateElement(page, id, patch) {
  await page.evaluate(
    ({ id: targetId, patch: nextPatch }) => {
      window.__setUserInteracted?.()
      const api = window.__excalidrawAPI
      const elements = api
        .getSceneElements()
        .map((element) => (element.id === targetId ? { ...element, ...nextPatch } : element))
      api.updateScene({ elements })
      window.__collab?.broadcastChanges?.(elements)
    },
    { id, patch },
  )
}

async function scene(page) {
  return page.evaluate(() =>
    window.__excalidrawAPI.getSceneElements().map((element) => ({
      id: element.id,
      x: element.x,
      y: element.y,
      version: element.version,
      versionNonce: element.versionNonce,
      isDeleted: element.isDeleted,
    })),
  )
}

async function runChaosSuite() {
  console.log('\n🧨 LIVE COLLABORATION CHAOS SUITE')
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  let guestContext
  try {
    const boardId = `chaos-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    const host = await browser.newPage()
    await host.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

    await host.evaluate(
      async ({ id, initial }) => {
        const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
        const { signInOwner: signInAnonymously } = await import('/tests/regression-fixture.ts')
        const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
        const auth = getFirebaseAuth()
        if (auth && (!auth.currentUser || auth.currentUser.isAnonymous)) await signInAnonymously(auth)
        const project = await workspaceApi.createProject(`Chaos ${id}`)
        await workspaceApi.saveBoard({
          id,
          projectId: project.id,
          name: 'Chaos Board',
          scene: { elements: [initial], appState: { viewBackgroundColor: '#ffffff' } },
          revision: 1,
          syncStatus: 'synced',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        await (
          await import('/tests/regression-fixture.ts')
        ).seedSharedBoard({
          boardId: id,
          boardName: 'Chaos Board',
          ownerId: auth?.currentUser?.uid ?? 'owner',
          ownerName: 'Chaos Host',
          generalAccess: 'anyone_with_link',
          generalRole: 'editor',
          collaborators: {},
          invitedEmails: [],
          scene: { elements: [initial], appState: { viewBackgroundColor: '#ffffff' } },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      },
      { id: boardId, initial: rectangle('anchor', 100, 100) },
    )

    await openBoard(host, boardUrl)
    guestContext = await browser.createBrowserContext()
    const guest = await guestContext.newPage()
    await openBoard(guest, boardUrl)
    await host.waitForSelector('.collab-avatar', { timeout: 12_000 })
    await guest.waitForSelector('.collab-avatar', { timeout: 12_000 })

    console.log('✓ Room established in independent browser contexts')

    // Simultaneous, disjoint operations must both survive the network race.
    await Promise.all([
      createElement(host, rectangle('host-box', 320, 100, 2, 101)),
      createElement(guest, rectangle('guest-box', 520, 100, 2, 202)),
    ])
    const disjoint = await eventually(
      () => scene(host),
      (elements) => elements.some((e) => e.id === 'host-box') && elements.some((e) => e.id === 'guest-box'),
      'Disjoint concurrent creates did not converge',
    )
    assert.equal(disjoint.filter((e) => ['host-box', 'guest-box'].includes(e.id)).length, 2)
    await eventually(
      () => scene(guest),
      (elements) => elements.some((e) => e.id === 'host-box') && elements.some((e) => e.id === 'guest-box'),
      'Guest missed a concurrent create',
    )
    console.log('✓ Concurrent disjoint creates converge without dropped elements')

    // Same-element collision must converge deterministically, not merely eventually.
    await Promise.all([
      updateElement(host, 'anchor', { x: 700, version: 10, versionNonce: 10 }),
      updateElement(guest, 'anchor', { x: 900, version: 10, versionNonce: 20 }),
    ])
    const winner = await eventually(
      () => Promise.all([scene(host), scene(guest)]),
      ([left, right]) => {
        const a = left.find((e) => e.id === 'anchor')
        const b = right.find((e) => e.id === 'anchor')
        return a?.x === 700 && b?.x === 700
      },
      'Same-element LWW collision did not settle on the lower nonce',
    )
    assert.equal(winner[0].find((e) => e.id === 'anchor')?.x, 700)
    console.log('✓ Same-element collision converges to deterministic LWW winner')

    // A repeatedly reloading peer must not erase a live room or lose its scene.
    for (let attempt = 0; attempt < 3; attempt++) {
      await reloadAllowingPendingChanges(guest, { waitUntil: 'domcontentloaded' })
      await guest.waitForFunction(() => Boolean(window.__excalidrawAPI), { timeout: 15_000 })
      await eventually(
        () => scene(guest),
        (elements) => elements.some((e) => e.id === 'host-box') && elements.some((e) => e.id === 'guest-box'),
        `Reload ${attempt + 1} lost live elements`,
      )
    }
    console.log('✓ Three rapid peer reloads preserve the complete live scene')

    // Simulate a temporary transport partition. The online peer continues to
    // edit; the reconnecting peer must converge to that post-partition state.
    const cdp = await guest.createCDPSession()
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    })
    await updateElement(host, 'host-box', { y: 360, version: 20, versionNonce: 30 })
    await eventually(
      () => scene(host),
      (elements) => elements.find((e) => e.id === 'host-box')?.y === 360,
      'Host did not apply its partition-time edit',
    )
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await eventually(
      () => scene(guest),
      (elements) => elements.find((e) => e.id === 'host-box')?.y === 360,
      'Guest did not converge after network recovery',
      20_000,
    )
    console.log('✓ Temporary network partition recovers without peer state rollback')

    // Late replacement peer joins after the original peer departs. It must get
    // complete elements, not only whatever partial RTDB patches are latest.
    await guest.close()
    guestContext = await browser.createBrowserContext()
    const latePeer = await guestContext.newPage()
    await openBoard(latePeer, boardUrl)
    const lateScene = await eventually(
      () => scene(latePeer),
      (elements) => elements.some((e) => e.id === 'host-box') && elements.some((e) => e.id === 'guest-box'),
      'Late peer did not receive complete room state',
    )
    assert.equal(lateScene.find((e) => e.id === 'host-box')?.y, 360)
    console.log('✓ Late replacement peer receives complete scene after membership churn')

    console.log('🧨 CHAOS SUITE PASSED')
  } finally {
    await guestContext?.close().catch(() => {})
    await browser.close()
  }
}

void runChaosSuite().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
