import { reloadAllowingPendingChanges } from './browser-navigation.mjs'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIREBASE_AUTH_EMULATOR_HOST)
  throw new Error('Live collaboration chaos tests require isolated demo-regression emulators')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function eventually(read, predicate, message, timeoutMs = 60_000) {
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

async function waitForAuthorizedTransport(page) {
  await page.waitForFunction(() => {
    const transport = window.__collab?.debugTransport
    const boardId = location.pathname.split('/').pop()
    return Boolean(
      transport?.activeBoardId === boardId &&
      transport?.activeSessionId &&
      transport?.connectionEpoch &&
      !transport?.boardContext?.blocked,
    )
  }, { timeout: 15000 })
}

async function createElement(page, element) {
  await page.evaluate(async (next) => {
    const api = window.__excalidrawAPI
    const template = api.getSceneElements()[0]
    const validElement = { ...template, ...next, groupIds: [], frameId: null, boundElements: null, updated: Date.now() }
    const elements = [...api.getSceneElements(), validElement]
    api.updateScene({ elements })
    const { service, collabUser } = window.__collab ?? {}
    if (!service || !collabUser?.uid) throw new Error('Live collaboration transport is not ready')
    // Await RTDB acceptance before the opposite tab's convergence assertion;
    // the normal UI callback intentionally dispatches this write fire-and-forget.
    const written = await service.broadcastElementDeltas(location.pathname.split('/').pop(), [validElement], collabUser.uid)
    if (!written) throw new Error(`RTDB rejected complete element ${validElement.id}`)
  }, element)
}

async function updateElement(page, id, patch) {
  await page.evaluate(
    async ({ id: targetId, patch: nextPatch }) => {
      const api = window.__excalidrawAPI
      const elements = api
        .getSceneElements()
        .map((element) => (element.id === targetId ? { ...element, ...nextPatch } : element))
      api.updateScene({ elements })
      const updated = elements.find((element) => element.id === targetId)
      const { service, collabUser } = window.__collab ?? {}
      if (!service || !collabUser?.uid || !updated) throw new Error('Live collaboration transport is not ready')
      const written = await service.broadcastElementDeltas(location.pathname.split('/').pop(), [updated], collabUser.uid)
      if (!written) throw new Error(`RTDB rejected complete element ${updated.id}: ${JSON.stringify(window.__collab?.debugTransport)}`)
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
    host.on('console', (message) => { if (message.type() === 'error') console.error(`[host console] ${message.text()}`) })
    host.on('pageerror', (error) => console.error(`[host pageerror] ${error.stack ?? error.message}`))
    await host.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

    await host.evaluate(
      async ({ id, initial }) => {
        const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
        const { seedSharedBoard } = await import('/tests/regression-fixture.ts')
        const { convertToExcalidrawElements } = await import('/tests/frame-reload-fixture.ts')
        const auth = getFirebaseAuth()
        const [validInitial] = convertToExcalidrawElements(
          [{ type: 'rectangle', id: initial.id, x: initial.x, y: initial.y, width: initial.width, height: initial.height }],
          { regenerateIds: false },
        )
        await seedSharedBoard({
          boardId: id,
          boardName: 'Chaos Board',
          ownerId: auth?.currentUser?.uid ?? '',
          ownerName: 'Chaos Host',
          generalAccess: 'anyone_with_link',
          generalRole: 'editor',
          collaborators: {},
          invitedEmails: [],
          scene: { elements: [validInitial], appState: { viewBackgroundColor: '#ffffff' } },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        return auth.currentUser.uid
      },
      { id: boardId, initial: rectangle('anchor', 100, 100) },
    )

    await openBoard(host, boardUrl)
    // A second tab in the same authenticated browser profile exercises an
    // independent editor session without introducing unrelated account setup.
    const guest = await browser.newPage()
    guest.on('console', (message) => { if (message.type() === 'error') console.error(`[guest console] ${message.text()}`) })
    guest.on('pageerror', (error) => console.error(`[guest pageerror] ${error.stack ?? error.message}`))
    await openBoard(guest, boardUrl)
    // Avatar awareness may lag the authoritative presence registry. Establish
    // collaboration from the same two-session condition used by the product.
    await eventually(
      () => Promise.all([host, guest].map((page) => page.evaluate(() => ({
        active: window.__lazyCollab?.isLazyCollabActive,
        sessions: window.__lazyCollab?.activeSessions?.length ?? 0,
        transport: window.__collab?.debugTransport,
      })))),
      (states) => states.every((state) =>
        state.active && state.sessions >= 2 &&
        state.transport?.activeBoardId === boardId &&
        Boolean(state.transport?.connectionEpoch) &&
        !state.transport?.boardContext?.blocked &&
        state.transport?.activeSessionId,
      ),
      'Both tabs did not establish an authorized RTDB editing session',
    )

    console.log('✓ Room established in independent browser contexts')
    for (const [name, page] of [['host', host], ['guest', guest]]) {
      const access = await page.evaluate(() => ({
        isEditor: window.__collab?.isEditor,
        viewMode: window.__excalidrawAPI?.getAppState().viewModeEnabled,
        viewOnly: Boolean(document.querySelector('.view-only-badge')),
      }))
      assert.equal(access.isEditor, true, `${name} must join as an active editor: ${JSON.stringify(access)}`)
      assert.equal(access.viewOnly, false, `${name} board permission must allow edits: ${JSON.stringify(access)}`)
    }

    // Simultaneous, disjoint operations must both survive the network race.
    await Promise.all([
      createElement(host, rectangle('host-box', 320, 100, 2, 101)),
      createElement(guest, rectangle('guest-box', 520, 100, 2, 202)),
    ])
    let disjoint
    try {
      disjoint = await eventually(
        () => scene(host),
        (elements) => elements.some((e) => e.id === 'host-box') && elements.some((e) => e.id === 'guest-box'),
        'Disjoint concurrent creates did not converge',
      )
    } catch (error) {
      const diagnostics = await Promise.all([host, guest].map((page) => page.evaluate(async (id) => {
        const response = await fetch(`http://127.0.0.1:49000/boards/${id}/elements.json?ns=demo-regression`)
        return {
          scene: window.__excalidrawAPI?.getSceneElementsIncludingDeleted?.().map((element) => ({ id: element.id, version: element.version, versionNonce: element.versionNonce })),
          collab: window.__lazyCollab,
          transport: window.__collab?.debugTransport,
          isEditor: window.__collab?.isEditor,
          remoteRecords: await response.json(),
          error: document.body.innerText.slice(0, 300),
        }
      }, boardId)))
      throw new Error(`${error instanceof Error ? error.message : String(error)}. Sync diagnostics: ${JSON.stringify(diagnostics)}`, { cause: error })
    }
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
      await waitForAuthorizedTransport(guest)
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
    await waitForAuthorizedTransport(host)
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
