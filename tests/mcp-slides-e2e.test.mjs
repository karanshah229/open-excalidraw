import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { mkdir, writeFile } from 'node:fs/promises'
import { Client } from '../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
if (process.env.GCLOUD_PROJECT !== 'demo-regression') throw new Error('Requires isolated regression emulators')
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const transport = new StdioClientTransport({
  command: 'node',
  args: ['packages/mcp/dist/index.js'],
  env: {
    ...process.env,
    AGENTIC_WHITEBOARD_BRIDGE_PORT: new URL(process.env.VITE_MCP_BRIDGE_URL || 'ws://127.0.0.1:8787').port,
  },
})
const client = new Client({ name: 'slides-e2e', version: '1' }, { capabilities: {} })
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const owner = await browser.newPage()
owner.setDefaultTimeout(30000)
let recipient
const requests = []
owner.on('console', (message) => {
  if (message.type() === 'error') console.log('Browser error:', message.text())
})
owner.on('request', (request) => {
  if (request.method() === 'POST' && request.url().includes(':45001/')) requests.push(request.url().split('/').pop())
})
owner.on('dialog', (dialog) => dialog.accept())
const raw = (name, args = {}) => client.callTool({ name, arguments: args })
const call = async (name, args = {}) => {
  const result = await raw(name, args)
  assert(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
  return JSON.parse(result.content.find((item) => item.type === 'text').text)
}
const noUnload = async (page) =>
  assert.equal(
    await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }),
    false,
  )
try {
  await client.connect(transport)
  const tools = (await client.listTools()).tools.map((tool) => tool.name)
  for (const name of ['create_slide', 'get_slide_notes', 'set_slide_notes', 'get_slide_preview', 'share_project'])
    assert(tools.includes(name))
  await owner.goto(base)
  const fixture = await owner.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    await signInOwner(getFirebaseAuth())
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { convertToExcalidrawElements } = await import('/tests/frame-reload-fixture.ts')
    const project = await workspaceApi.createProject('MCP slides')
    const board = await workspaceApi.createBoard(project.id, 'MCP slides')
    const elements = convertToExcalidrawElements(
      [{ type: 'rectangle', id: 'content', x: 100, y: 100, width: 200, height: 120, backgroundColor: '#d0bfff' }],
      { regenerateIds: false },
    )
    await workspaceApi.saveBoard({
      ...board,
      scene: { elements, appState: { viewBackgroundColor: '#ffffff', theme: 'light' } },
    })
    await workspaceApi.flushCloud()
    return { boardId: board.id, projectId: project.id }
  })
  await owner.goto(`${base}/boards/${fixture.boardId}`)
  await owner.waitForFunction(() => window.__excalidrawAPI?.getSceneElements().length === 1)
  await owner.waitForFunction(() => document.querySelector('.excalidraw'))
  let revision
  for (let i = 0; i < 50; i++) {
    const info = await call('get_capabilities')
    if (info.activeBoardId === fixture.boardId) {
      revision = info.revision
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(revision !== undefined, 'Editor adapter connects')
  const first = await call('create_slide', { elementIds: ['content'], padding: 24, expectedRevision: revision })
  const a = first.slide.id
  assert.deepEqual(first.slide.elementIds, ['content'])
  assert.equal(first.slide.width, 248)
  await owner.waitForFunction(
    (id) => window.__excalidrawAPI.getSceneElements().find((e) => e.id === 'content').frameId === id,
    {},
    a,
  )
  await owner.keyboard.down('Meta')
  await owner.keyboard.press('z')
  await owner.keyboard.up('Meta')
  await owner.waitForFunction(() => window.__excalidrawAPI.getSceneElements().length === 1)
  assert.equal((await call('get_slides')).slides.length, 0, 'Slide creation is one undo step')
  await owner.keyboard.down('Meta')
  await owner.keyboard.down('Shift')
  await owner.keyboard.press('z')
  await owner.keyboard.up('Shift')
  await owner.keyboard.up('Meta')
  await owner.waitForFunction((id) => window.__excalidrawAPI.getSceneElements().some((e) => e.id === id), {}, a)
  assert(
    (await raw('create_slide', { bounds: { x: 500, y: 100, width: 300, height: 200 }, expectedRevision: revision }))
      .isError,
    'Stale scene mutation is denied',
  )
  const second = await call('create_slide', { bounds: { x: 500, y: 100, width: 300, height: 200 } })
  const b = second.slide.id
  await call('slide_command', { slideId: b, action: 'move_before', targetSlideId: a })
  assert.deepEqual(
    (await call('get_slides')).slides.map((slide) => slide.id),
    [b, a],
  )
  await call('slide_command', { slideId: b, action: 'move_after', targetSlideId: a })
  const preview = await raw('get_slide_preview', { slideId: a, size: 400 })
  assert(!preview.isError)
  assert(
    preview.content.some((item) => item.type === 'image' && item.mimeType === 'image/png' && item.data.length > 100),
  )
  const cachedPreview = await raw('get_slide_preview', { slideId: a, size: 400 })
  assert.equal(JSON.parse(cachedPreview.content[0].text).cached, true)
  const before = preview.content.find((item) => item.type === 'image').data
  await call('update_elements', { patches: [{ id: 'content', changes: { backgroundColor: '#a5d8ff' } }] })
  const updated = await raw('get_slide_preview', { slideId: a, size: 400 })
  assert.notEqual(
    updated.content.find((item) => item.type === 'image').data,
    before,
    'Preview regenerates after drawing update',
  )
  await owner.evaluate(() => window.__excalidrawAPI.toggleSidebar({ name: 'default', tab: 'slides' }))
  await owner.waitForSelector('[aria-label="Go to slide 1"]')
  await owner.click('[aria-label="Go to slide 1"]')
  await owner.evaluate(() =>
    [...document.querySelectorAll('.slide-actions button')].find((b) => b.textContent === 'Notes').click(),
  )
  await owner.waitForSelector('#slide-notes-input:not(:disabled)')
  const notes = await call('get_slide_notes', { slideId: a })
  const written = await call('set_slide_notes', {
    slideId: a,
    text: 'Notes from MCP',
    expectedRevision: notes.noteRevision,
  })
  assert.equal((await call('get_slide_notes', { slideId: a })).text, 'Notes from MCP')
  await owner.waitForFunction(() => document.querySelector('#slide-notes-input')?.value === 'Notes from MCP')
  await owner.evaluate(() => window.__excalidrawAPI.toggleSidebar({ name: null }))

  assert(
    (await raw('set_slide_notes', { slideId: a, text: 'Stale overwrite', expectedRevision: notes.noteRevision }))
      .isError,
  )
  assert.equal((await call('get_slide_notes', { slideId: a })).noteRevision, written.noteRevision)
  await owner.evaluate(
    async ({ boardId, slideId }) => {
      const { readNoteDraft, writeNoteDraft, noteKey } = await import('/src/features/slides/notes-store.ts')
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const key = noteKey(getFirebaseAuth().currentUser.uid, boardId, slideId)
      const current = await readNoteDraft(key)
      window.__mcpSavedNote = current
      await writeNoteDraft({ ...current, text: 'Unsynced typing', dirty: true, mutationId: crypto.randomUUID() })
    },
    { boardId: fixture.boardId, slideId: a },
  )
  assert.equal((await call('get_slide_notes', { slideId: a })).hasUnsyncedDraft, true)
  assert(
    (await raw('set_slide_notes', { slideId: a, text: 'Discard draft', expectedRevision: written.noteRevision }))
      .isError,
  )
  await owner.evaluate(async () => {
    const { writeNoteDraft } = await import('/src/features/slides/notes-store.ts')
    await writeNoteDraft(window.__mcpSavedNote)
  })
  const localChecks = await owner.evaluate(async (slideId) => {
    const { createSlideDataHandler } = await import('/src/features/mcp-bridge/slide-data-operations.ts')
    const handler = createSlideDataHandler()
    const context = {
      boardId: 'local-note-test',
      projectId: '',
      identity: 'guest',
      role: 'owner',
      local: true,
      scene: { elements: window.__excalidrawAPI.getSceneElements(), files: {}, background: '#fff', theme: 'light' },
    }
    const first = await handler.handle(
      { type: 'set_slide_notes', slideId, text: 'Local', expectedRevision: 0 },
      context,
    )
    let tokenDenied = false
    try {
      await handler.handle({ type: 'set_slide_notes', slideId, text: 'Lost typing', expectedRevision: 1 }, context)
    } catch {
      tokenDenied = true
    }
    const read = await handler.handle({ type: 'get_slide_notes', slideId }, context)
    const second = await handler.handle(
      {
        type: 'set_slide_notes',
        slideId,
        text: '',
        expectedRevision: read.noteRevision,
        expectedDraftMutationId: read.draftMutationId,
      },
      context,
    )
    handler.clear()
    return { first, tokenDenied, second }
  }, a)
  assert.equal(localChecks.first.noteRevision, 1)
  assert(localChecks.tokenDenied, 'Local notes require a current draft token')
  assert.equal(localChecks.second.text, '')
  assert.equal(localChecks.second.noteRevision, 2)
  const share = await call('get_share_info')
  let start = requests.length
  const shared = await call('share_board', {
    generalAccess: 'anyone_with_link',
    generalRole: 'presentation',
    inheritProjectAccess: false,
    expectedAccessRevision: share.accessRevision ?? 0,
  })
  assert.equal(shared.generalRole, 'presentation')
  assert.deepEqual(requests.slice(start), ['manageBoardAccess'], 'One permission mutation; no publishing or note calls')
  start = requests.length
  const info = await call('get_share_info')
  assert.equal(info.shareUrl, `${base}/boards/${fixture.boardId}`)
  assert.equal(requests.length, start, 'Reading share URL performs no callable mutation')
  assert((await raw('share_board', { generalRole: 'viewer', expectedAccessRevision: 0 })).isError)
  const project = await call('get_share_info', { projectId: fixture.projectId })
  start = requests.length
  await call('share_project', {
    projectId: fixture.projectId,
    generalAccess: 'anyone_with_link',
    generalRole: 'presentation',
    expectedAccessRevision: project.accessRevision ?? 0,
  })
  assert.deepEqual(requests.slice(start), ['manageProject'])
  assert.equal((await call('get_share_info')).projectPolicy.generalRole, 'presentation')
  const projectAfter = await call('get_share_info', { projectId: fixture.projectId })
  assert(
    (await raw('share_project', { projectId: fixture.projectId, generalRole: 'viewer', expectedAccessRevision: 0 }))
      .isError,
  )
  const invited = await call('share_project', {
    projectId: fixture.projectId,
    inviteEmail: 'speaker@example.com',
    inviteRole: 'presentation',
    expectedAccessRevision: projectAfter.accessRevision,
  })
  assert.equal(invited.collaborators['speaker@example.com'].role, 'presentation')
  const removed = await call('share_project', {
    projectId: fixture.projectId,
    removeEmail: 'speaker@example.com',
    expectedAccessRevision: invited.accessRevision,
  })
  assert(!removed.invitedEmails.includes('speaker@example.com'))

  const inheritance = await call('share_board', {
    generalAccess: 'restricted',
    inheritProjectAccess: true,
    expectedAccessRevision: shared.accessRevision,
  })
  assert(inheritance.inheritProjectAccess)
  const context = await browser.createBrowserContext()
  recipient = await context.newPage()
  await recipient.goto(info.shareUrl)
  await recipient.waitForSelector('.shared-slideshow-start:not(:disabled)')
  // Fresh presentation tab becomes the active data adapter and has no canvas.
  for (let i = 0; i < 50; i++) {
    const result = await raw('get_slide_notes', { slideId: a })
    if (!result.isError && JSON.parse(result.content[0].text).readOnly) break
    if (i === 49) throw new Error('Presentation data adapter did not become active')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(await recipient.$('.excalidraw-container'), null)
  const inheritedInfo = await call('get_share_info')
  assert.equal(inheritedInfo.effectiveRole, 'presentation')
  assert.equal(inheritedInfo.projectRole, 'presentation')

  assert.equal((await call('get_slide_notes', { slideId: a })).text, 'Notes from MCP')
  assert(
    (await raw('set_slide_notes', { slideId: a, text: 'Forbidden', expectedRevision: written.noteRevision })).isError,
  )
  assert((await raw('create_slide', { bounds: { x: 900, y: 100, width: 200, height: 200 } })).isError)
  assert((await raw('share_project', { projectId: fixture.projectId, generalRole: 'editor' })).isError)
  assert.equal((await call('get_slides')).slides.length, 2)
  assert.equal(
    await owner.evaluate(() => window.__excalidrawAPI.getSceneElements().length),
    3,
    'Denied recipient writes never reach the owner adapter',
  )

  assert((await raw('get_slide_preview', { slideId: a, size: 400 })).content.some((item) => item.type === 'image'))
  await noUnload(recipient)
  await mkdir('.system_generated/slides', { recursive: true })
  await recipient.screenshot({ path: '.system_generated/slides/mcp-presentation-data.png' })
  await recipient.close()
  await owner.bringToFront()
  await owner.evaluate(() => window.dispatchEvent(new Event('focus')))
  // Reconnect editor snapshot after the audience adapter closes.
  await call('update_elements', { patches: [{ id: 'content', changes: { strokeColor: '#6741d9' } }] })
  const current = await call('get_share_info')
  await call('share_board', {
    generalAccess: 'anyone_with_link',
    generalRole: 'viewer',
    inheritProjectAccess: false,
    expectedAccessRevision: current.accessRevision,
  })
  const viewer = await context.newPage()
  await viewer.goto(info.shareUrl)
  await viewer.waitForSelector('.excalidraw-container')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert((await raw('get_slide_notes', { slideId: a })).isError, 'Viewer adapter cannot read notes')
  await noUnload(viewer)
  console.log(
    'PASS MCP slideshow tools: native creation, scene/note conflicts, ordering, cached image replies, board/project Present sharing, zero-mutation URL reads, presentation-only adapter and Viewer denial',
  )
} catch (error) {
  await mkdir('.system_generated/slides', { recursive: true })
  await owner.screenshot({ path: '.system_generated/slides/mcp-slides-error-owner.png' })
  if (recipient && !recipient.isClosed()) {
    await recipient.screenshot({ path: '.system_generated/slides/mcp-slides-error-recipient.png' })
    console.log('Recipient UI:', await recipient.evaluate(() => document.body.innerText))
  }
  await writeFile('.system_generated/slides/mcp-slides-error.txt', String(error))
  throw error
} finally {
  await browser.close()
  await client.close()
  await transport.close()
}
