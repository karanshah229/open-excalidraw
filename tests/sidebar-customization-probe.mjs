// Exploration only: mounts native Excalidraw with public sidebar APIs, then removes the disposable fixture.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const { createServer } = await import(require.resolve('vite'))
const fixFallback = process.env.SIDEBAR_FALLBACK_FIX === '1'
const root = fileURLToPath(new URL('../apps/whiteboard', import.meta.url))
const fixture = `${root}/__sidebar_probe.tsx`,
  html = `${root}/__sidebar_probe.html`
const output = fileURLToPath(
  new URL(`../.system_generated/sidebar-exploration/${fixFallback ? 'candidate-fix' : 'baseline'}`, import.meta.url),
)
await mkdir(output, { recursive: true })
await writeFile(html, '<div id="root"></div><script type="module" src="/__sidebar_probe.tsx"></script>')
await writeFile(
  fixture,
  `
import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw, DefaultSidebar, Sidebar } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
function Content({note, setNote}) {
 const [local, setLocal] = useState(0)
 useEffect(() => { window.__mounts = (window.__mounts || 0) + 1 }, [])
 return <section style={{padding:16}}><h3>Slides · 6</h3>
  <button aria-label="Present">Present</button>
  <input aria-label="Retained note" value={note} onChange={e => setNote(e.target.value)} />
  <button aria-label="Local counter" onClick={() => setLocal(local + 1)}>Local state: {local}</button>
 </section>
}
function Probe() {
 const [api, setApi] = useState(null), [active, setActive] = useState(null), [note, setNote] = useState('')
 return <div className="probe"><main><Excalidraw theme="dark" excalidrawAPI={value => {window.__api=value;setApi(value)}}
   onChange={(_, state) => setActive(state.openSidebar)}>
  <DefaultSidebar className="probe-sidebar">
   <DefaultSidebar.TabTriggers><Sidebar.TabTrigger tab="slides" aria-label="Slides tab">Slides</Sidebar.TabTrigger></DefaultSidebar.TabTriggers>
   <Sidebar.Tab tab="slides"><Content note={note} setNote={setNote} /></Sidebar.Tab>
  </DefaultSidebar>
 </Excalidraw></main>
 <nav aria-label="Board panels">{['library', 'slides', 'search'].map(tab => <button key={tab} className="sidebar-trigger"
   aria-label={'Open '+tab} aria-pressed={active?.tab===tab}
   onClick={() => api?.toggleSidebar({name:'default', tab, force:active?.tab!==tab})}>{tab==='library'?'▤':tab==='slides'?'▣':'⌕'}</button>)}</nav>
 </div>
}
const style = document.createElement('style')
style.textContent = 'html,body,#root{height:100%;margin:0}.probe{height:100%;display:grid;grid-template-columns:minmax(0,1fr) 48px;background:#232329;color:#eee}.probe main{min-width:0;position:relative}.probe nav{display:flex;flex-direction:column;align-items:center;gap:12px;padding-top:16px}.probe nav button{width:36px;height:36px;border:0;border-radius:8px;background:#31303b;color:#eee;font-size:20px}.probe nav button[aria-pressed=true]{background:#a8a5ff;color:#171717}.probe-sidebar .sidebar-triggers{display:none!important}.probe-sidebar input{display:block;margin:20px 0}.probe-sidebar button{padding:8px}'
document.head.append(style)
createRoot(document.getElementById('root')).render(<Probe />)
`,
)
let server, browser
try {
  server = await createServer({
    root,
    cacheDir: `${output}/vite-cache-${fixFallback}`,
    optimizeDeps: {
      include: ['@excalidraw/excalidraw'],
      rolldownOptions: {
        plugins: [
          {
            name: 'sidebar-exploration-only-fallback-fix',
            transform(code, id) {
              if (!fixFallback || !id.endsWith('/dist/dev/index.js')) return
              console.log('Applying exploratory fallback fix in memory')
              return code
                .replace(
                  'const [, setCounter] = useAtom2(renderAtom);',
                  'const [renderCount, setCounter] = useAtom2(renderAtom);',
                )
                .replace('metaRef.current.counter > 1 && props.__fallback', 'renderCount > 1 && props.__fallback')
            },
          },
        ],
      },
    },
    server: { host: '127.0.0.1', port: 5190, strictPort: true },
  })
  await server.listen()
  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  const page = await browser.newPage(),
    errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewport({ width: 1400, height: 900 })
  await page.goto('http://127.0.0.1:5190/__sidebar_probe.html')
  await page.waitForFunction(() => !!window.__api)
  await page.click('[aria-label="Open slides"]')
  await page.waitForSelector('[aria-label="Retained note"]')
  assert.equal(await page.$$eval('.sidebar', (nodes) => nodes.length), 1)
  await page.type('[aria-label="Retained note"]', 'Keep this draft')
  await page.click('[aria-label="Local counter"]')
  await page.click('[aria-label="Open library"]')
  await page.waitForSelector('[data-testid="library"][data-state="active"]')
  await page.click('[aria-label="Open slides"]')
  await page.waitForSelector('[aria-label="Retained note"]')
  assert.equal(await page.$eval('[aria-label="Retained note"]', (n) => n.value), 'Keep this draft')
  assert.equal(await page.$eval('[aria-label="Local counter"]', (n) => n.textContent), 'Local state: 0')
  await page.click('[data-testid="sidebar-dock"]')
  await page.waitForSelector('.sidebar--docked')
  await page.mouse.click(350, 500)
  assert(await page.$('.sidebar'), 'Docked sidebar remains open on canvas click')
  await page.screenshot({ path: `${output}/desktop-slides.png` })
  await page.click('[data-testid="sidebar-close"]')
  await page.waitForSelector('.sidebar', { hidden: true })
  assert(await page.$('[aria-label="Open slides"]'), 'Rail stays mounted on collapse')
  await page.click('[aria-label="Open slides"]')
  await page.waitForSelector('[aria-label="Retained note"]')
  assert.equal(await page.$eval('[aria-label="Retained note"]', (n) => n.value), 'Keep this draft')
  await page.click('[aria-label="Open slides"]')
  await page.waitForSelector('.sidebar', { hidden: true })
  await page.click('[aria-label="Open search"]')
  await page.waitForSelector('[data-testid="search"][data-state="active"]')
  assert.equal(await page.$$eval('.sidebar', (nodes) => nodes.length), 1)
  await page.click('[aria-label="Open slides"]')
  await page.waitForSelector('[aria-label="Retained note"]')
  await page.addStyleTag({ content: '.probe .excalidraw{--right-sidebar-width:380px!important}' })
  assert.equal(
    await page.$eval('.sidebar', (n) => Math.round(n.getBoundingClientRect().width)),
    372,
    '380px native width token includes an 8px spacing adjustment',
  )
  await page.setViewport({ width: 540, height: 800 })
  await page.waitForSelector('.excalidraw--mobile')
  await new Promise((resolve) => setTimeout(resolve, 500))
  await page.waitForFunction(() => !document.querySelector('[data-testid="sidebar-dock"]'))
  await page.waitForSelector('[aria-label="Retained note"]', { visible: true, timeout: 3000 })
  console.log(
    'Narrow sidebar DOM:',
    await page.$$eval('.sidebar', (nodes) => nodes.map((n) => ({ className: n.className, content: n.innerText }))),
  )
  await page.screenshot({ path: `${output}/narrow-slides.png` })
  assert.equal(await page.$$eval('.sidebar', (nodes) => nodes.length), 1, 'Exactly one sidebar on mobile too')
  await page.mouse.click(25, 500)
  await page.waitForSelector('.sidebar', { hidden: true })
  assert.deepEqual(errors, [])
  console.log(
    'PASS public APIs: native Slides/Library/Search tabs, single sidebar, external rail, docking, host-owned draft retention, local-state remount, CSS width and narrow-screen outside close',
  )
} finally {
  await browser?.close()
  await server?.close()
  await Promise.all([rm(fixture, { force: true }), rm(html, { force: true })])
}
