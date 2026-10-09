import { createRequire } from 'node:module'
import { cp, readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const all = [
  'sharing-flow-audit.test.mjs',
  'presentation-access.test.mjs',
  'slides-shared.test.mjs',
  'board-behavior-contract.test.mjs',
  'e2e-collab-suite.mjs',
  'collab-chaos-live.test.mjs',
  'network-lifecycle.test.mjs',
  'repro-user-str.mjs',
  'inactive-tab-presence-cursor.test.mjs',
  'board-auto-zoom-center.test.mjs',
  'solo-no-collab-banner.test.mjs',
  'incognito-undo-beforeunload.test.mjs',
  'collab-undo-resurrect.test.mjs',
  'delete-all-reload-flash.test.mjs',
  'unauthenticated-owner-hidden.test.mjs',
  'solo-delete-collab-undo.test.mjs',
  'collab-undo-further-ops.test.mjs',
  'mcp-live-e2e.test.mjs',
  'create-board-modal-dropdown-scroll.test.mjs',
  'e2e-smoke-test-and-screenshots.mjs',
  'e2e-non-anonymous-test.mjs',
  'browser-collab-verify.mjs',
  'e2e-visual-screenshots.mjs',
]
const filter = process.argv.find((arg) => arg.startsWith('--test='))?.slice(7)
const files = process.env.E2E_REGRESSION_FILES ? JSON.parse(process.env.E2E_REGRESSION_FILES) : filter ? [filter] : all
if (!files.length || files.some((name) => !all.includes(name) && name !== 'sharing-flow-audit.test.mjs'))
  throw new Error('Unknown regression suite')
const run = (command, args, env = process.env) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`))))
  })
if (!process.argv.includes('--inside-emulators')) {
  await mkdir(resolve(root, '.system_generated'), { recursive: true })
  const runtime = await mkdtemp(resolve(root, '.system_generated/regression-runtime-'))
  try {
    await run('pnpm', ['--filter', '@agentic-whiteboard/functions', 'build'])
    await run('pnpm', ['--filter', '@agentic-whiteboard/mcp', 'build'])
    const functions = resolve(runtime, 'functions')
    await mkdir(functions)
    await cp(resolve(root, 'functions/lib'), resolve(functions, 'lib'), { recursive: true })
    await cp(resolve(root, 'functions/package.json'), resolve(functions, 'package.json'))
    await symlink(resolve(root, 'functions/node_modules'), resolve(functions, 'node_modules'), 'dir')
    await writeFile(
      resolve(functions, '.env.demo-regression'),
      'RTDB_FUNCTION_REGION=us-central1\nFIRESTORE_FUNCTION_REGION=us-central1\nSYNC_ACCESS_FUNCTION_REGION=us-central1\nASSET_ENFORCE_APP_CHECK=false\n',
    )
    const config = JSON.parse(await readFile(resolve(root, 'regression.firebase.json'), 'utf8'))
    config.functions.source = 'functions'
    for (const service of ['firestore', 'database', 'storage'])
      config[service].rules = resolve(root, config[service].rules)
    const configPath = resolve(runtime, 'firebase.json')
    await writeFile(configPath, JSON.stringify(config))
    await run(
      'firebase',
      [
        'emulators:exec',
        '--only',
        'auth,firestore,database,storage,functions',
        '--project',
        'demo-regression',
        '--config',
        configPath,
        'node tests/run-regression-tests.mjs --inside-emulators',
      ],
      { ...process.env, E2E_REGRESSION_FILES: JSON.stringify(files) },
    )
  } finally {
    await rm(runtime, { recursive: true, force: true })
  }
} else {
  if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error('Regression runner requires its local demo emulators')
  Object.assign(process.env, {
    VITE_FIREBASE_API_KEY: 'emulator-only',
    VITE_FIREBASE_AUTH_DOMAIN: 'demo-regression.firebaseapp.com',
    VITE_FIREBASE_PROJECT_ID: 'demo-regression',
    VITE_FIREBASE_APP_ID: 'emulator-only',
    VITE_FIREBASE_STORAGE_BUCKET: 'demo-regression.appspot.com',
    VITE_FIREBASE_DATABASE_URL: 'http://127.0.0.1:49000?ns=demo-regression',
    VITE_FIREBASE_AUTH_EMULATOR_PORT: '49099',
    VITE_FIREBASE_FIRESTORE_EMULATOR_PORT: '48080',
    VITE_FIREBASE_DATABASE_EMULATOR_PORT: '49000',
    VITE_FIREBASE_STORAGE_EMULATOR_PORT: '49199',
    VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT: '45001',
    VITE_USE_FIREBASE_EMULATOR: 'true',
    VITE_FIREBASE_SYNC_ACCESS_FUNCTION_REGION: 'us-central1',
    VITE_RECAPTCHA_SITE_KEY: '',
    VITE_FIREBASE_APPCHECK_KEY: '',
  })
  const rules = await readFile(resolve(root, 'database.rules.json'), 'utf8')
  const response = await fetch('http://127.0.0.1:49000/.settings/rules.json?ns=demo-regression', {
    method: 'PUT',
    headers: { Authorization: 'Bearer owner' },
    body: rules,
  })
  if (!response.ok) throw new Error('Could not install repository RTDB rules')
  const require = createRequire(resolve(root, 'apps/whiteboard/package.json'))
  const { createServer } = await import(require.resolve('vite'))
  const out = resolve(root, '.system_generated/regression')
  await mkdir(out, { recursive: true })
  const server = await createServer({
    root: resolve(root, 'apps/whiteboard'),
    cacheDir: resolve(out, 'vite-cache'),
    server: { host: '127.0.0.1', port: 15190, strictPort: true },
  })
  const results = []
  try {
    await server.listen()
    for (const name of files) {
      const artifacts = resolve(out, name + '.artifacts')
      await mkdir(artifacts, { recursive: true })
      const log = createWriteStream(resolve(out, name + '.log'))
      const start = Date.now()
      console.log('START ' + name)
      const result = await new Promise((resolveTest, reject) => {
        let timedOut = false
        const child = spawn(process.execPath, [resolve(root, 'tests', name)], {
          cwd: root,
          detached: true,
          env: { ...process.env, E2E_BASE_URL: 'http://127.0.0.1:15190', E2E_ARTIFACT_DIR: artifacts },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        child.stdout.pipe(log)
        child.stderr.pipe(log)
        const timer = setTimeout(() => {
          timedOut = true
          try {
            process.kill(-child.pid, 'SIGTERM')
          } catch {
            // The test may have already exited when its timeout fires.
          }
        }, 300000)
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('exit', (exitCode, signal) => {
          clearTimeout(timer)
          resolveTest({ exitCode, signal, timedOut })
        })
      })
      await new Promise((done) => log.end(done))
      results.push({ name, ...result, durationMs: Date.now() - start })
      await writeFile(
        resolve(out, 'results.json'),
        JSON.stringify({ project: 'demo-regression', results }, null, 2) + '\n',
      )
      console.log('END ' + name + ': ' + JSON.stringify(result))
    }
  } finally {
    await server.close()
  }
  if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1
}
