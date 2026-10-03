import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
Object.assign(process.env, {
  VITE_FIREBASE_API_KEY: 'emulator-only',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-whiteboard-freemium.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'demo-whiteboard-freemium',
  VITE_FIREBASE_APP_ID: 'emulator-only',
  VITE_FIREBASE_STORAGE_BUCKET: 'demo-whiteboard-freemium.appspot.com',
  VITE_FIREBASE_DATABASE_URL: 'http://127.0.0.1:19500?ns=demo-whiteboard-freemium',
  VITE_USE_FIREBASE_EMULATOR: 'true',
  VITE_FIREBASE_SYNC_ACCESS_FUNCTION_REGION: 'us-central1',
  VITE_FIREBASE_AUTH_EMULATOR_PORT: '19599',
  VITE_FIREBASE_FIRESTORE_EMULATOR_PORT: '18580',
  VITE_FIREBASE_DATABASE_EMULATOR_PORT: '19500',
  VITE_FIREBASE_STORAGE_EMULATOR_PORT: '19699',
  VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT: '15501',
  VITE_RECAPTCHA_SITE_KEY: '',
  VITE_FIREBASE_APPCHECK_KEY: '',
})
const { createServer } = await import(require.resolve('vite'))
export const server = await createServer({
  root: fileURLToPath(new URL('../apps/whiteboard', import.meta.url)),
  server: { host: '127.0.0.1', port: 15175, strictPort: true },
  plugins: [
    {
      name: 'isolated-freemium-bootstrap',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace('/src/main.tsx', '/tests/freemium-bootstrap.ts'),
      },
    },
  ],
})
await server.listen()
server.printUrls()
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await server.close()
    process.exit()
  })
