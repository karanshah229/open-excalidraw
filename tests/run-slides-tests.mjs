import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const { createServer } = await import(require.resolve('vite'))
const server = await createServer({
  root: fileURLToPath(new URL('../apps/whiteboard', import.meta.url)),
  mode: 'e2e',
  server: { host: '127.0.0.1', port: 5189, strictPort: true },
})
try {
  await server.listen()
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/slides.e2e.mjs'], {
      stdio: 'inherit',
      env: { ...process.env, E2E_BASE_URL: 'http://127.0.0.1:5189' },
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Slide browser tests exited ${code}`))))
  })
} finally {
  await server.close()
}
