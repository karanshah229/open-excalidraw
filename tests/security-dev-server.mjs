import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
Object.assign(process.env, {
  VITE_FIREBASE_API_KEY: 'emulator-only',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-whiteboard-security.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'demo-whiteboard-security',
  VITE_FIREBASE_APP_ID: 'emulator-only',
  VITE_FIREBASE_STORAGE_BUCKET: 'demo-whiteboard-security.appspot.com',
  VITE_FIREBASE_DATABASE_URL: 'http://127.0.0.1:19000?ns=demo-whiteboard-security',
  VITE_USE_FIREBASE_EMULATOR: 'false',
  VITE_FIREBASE_SYNC_ACCESS_FUNCTION_REGION: 'us-central1',
  VITE_RECAPTCHA_SITE_KEY: '',
  VITE_FIREBASE_APPCHECK_KEY: '',
})
const { createServer } = await import(require.resolve('vite'))
const server = await createServer({
  root: fileURLToPath(new URL('../apps/whiteboard', import.meta.url)),
  server: { host: '127.0.0.1', port: 15174, strictPort: true },
  plugins: [{ name: 'isolated-security-bootstrap', transformIndexHtml: {
    order: 'pre', handler: html => html.replace('/src/main.tsx', '/tests/security-bootstrap.ts'),
  } }],
})
await server.listen()
server.printUrls()
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit() })
