import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const appRoot = fileURLToPath(new URL('../apps/whiteboard/', import.meta.url))
const output = fileURLToPath(new URL('../.system_generated/metadata-e2e/', import.meta.url))
const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const { preview } = await import(require.resolve('vite'))
const server = process.env.E2E_BASE_URL
  ? null
  : await preview({
      root: appRoot,
      configFile: false,
      preview: { host: '127.0.0.1', port: 0, open: false },
    })
let browser
const network = []
try {
  const baseUrl = new URL(process.env.E2E_BASE_URL || server.resolvedUrls.local[0]).href
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  const page = await browser.newPage()
  await page.setCacheEnabled(false)
  page.on('response', (response) => {
    if (response.url().startsWith(baseUrl)) {
      network.push({ url: response.url(), status: response.status(), contentType: response.headers()['content-type'] })
    }
  })

  for (const route of ['', 'boards/metadata-test']) {
    const response = await page.goto(new URL(route, baseUrl).href, { waitUntil: 'domcontentloaded' })
    assert.equal(response.status(), 200)
    assert.equal(await page.title(), 'OpenExcalidraw')
    const metadata = await page.evaluate(() => {
      const meta = (key) => document.querySelector(`meta[name="${key}"], meta[property="${key}"]`)?.content
      return {
        description: meta('description'),
        theme: meta('theme-color'),
        ogTitle: meta('og:title'),
        ogDescription: meta('og:description'),
        ogImage: meta('og:image'),
        twitterImage: meta('twitter:image'),
        twitterCard: meta('twitter:card'),
        icons: [...document.querySelectorAll('link[rel="icon"]')].map((link) => link.href),
        apple: document.querySelector('link[rel="apple-touch-icon"]')?.href,
        manifest: document.querySelector('link[rel="manifest"]')?.href,
      }
    })
    assert.ok(metadata.description?.includes('Excalidraw'))
    assert.equal(metadata.ogTitle, 'OpenExcalidraw')
    assert.equal(metadata.ogDescription, metadata.description)
    assert.equal(metadata.theme, '#6b63e6')
    assert.equal(metadata.twitterCard, 'summary_large_image')
    assert.equal(metadata.twitterImage, metadata.ogImage)
    assert.equal(new URL(metadata.ogImage).protocol, 'https:')
    assert.equal(metadata.icons.length, 2)
    assert.ok(metadata.apple)
    assert.ok(metadata.manifest)

    const manifest = await page.evaluate(async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Manifest returned ${response.status}`)
      return response.json()
    }, metadata.manifest)
    assert.equal(manifest.name, 'OpenExcalidraw')
    assert.equal(manifest.start_url, '/')
    assert.equal(manifest.theme_color, metadata.theme)

    // Social crawlers load the public URL after deployment; test its asset
    // against this production bundle without depending on the live deployment.
    const assets = [
      ...metadata.icons.map((url) => ({ url, type: /\.svg$/.test(url) ? 'image/svg+xml' : 'image/' })),
      { url: metadata.apple, type: 'image/png', size: [180, 180] },
      ...manifest.icons.map((icon) => ({
        url: new URL(icon.src, baseUrl).href,
        type: icon.type,
        size: icon.sizes.split('x').map(Number),
      })),
      { url: new URL(new URL(metadata.ogImage).pathname, baseUrl).href, type: 'image/png', size: [1200, 630] },
    ]
    for (const asset of assets) {
      const result = await page.evaluate(async ({ url }) => {
        const response = await fetch(url)
        const blob = await response.blob()
        const image = new Image()
        const objectUrl = URL.createObjectURL(blob)
        try {
          image.src = objectUrl
          await image.decode()
          return {
            status: response.status,
            type: response.headers.get('content-type'),
            size: [image.naturalWidth, image.naturalHeight],
          }
        } finally {
          URL.revokeObjectURL(objectUrl)
        }
      }, asset)
      assert.equal(result.status, 200, asset.url)
      assert.ok(result.type.startsWith(asset.type), `${asset.url}: ${result.type}`)
      if (asset.size) assert.deepEqual(result.size, asset.size, asset.url)
      console.log(
        `PASS ${route || '/'} ${new URL(asset.url).pathname}: HTTP 200, ${result.type}, ${result.size.join('x')}`,
      )
    }
  }
  await mkdir(output, { recursive: true })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#root > *')
  await page.screenshot({ path: `${output}page.png`, fullPage: true })
  console.log('PASS metadata and browser network checks on home and nested board routes')
} finally {
  await mkdir(output, { recursive: true })
  await writeFile(`${output}network.json`, JSON.stringify(network, null, 2) + '\n')
  await browser?.close()
  if (server)
    await new Promise((resolve, reject) => server.httpServer.close((error) => (error ? reject(error) : resolve())))
}
