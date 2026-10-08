import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(root, '.system_generated/all-tests')
await mkdir(output, { recursive: true })
const results = []
const imageCloud = process.argv.includes('--image-cloud')

async function run(name, command, args) {
  const start = Date.now()
  const logPath = resolve(output, `${name}.log`)
  const log = createWriteStream(logPath)
  console.log(`START ${name} (log: ${logPath})`)
  const exitCode = await new Promise((done) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    child.on('error', (error) => {
      log.write(`${error.message}\n`)
      done(1)
    })
    child.on('close', (code) => done(code ?? 1))
  })
  await new Promise((done) => log.end(done))
  results.push({ name, exitCode, durationMs: Date.now() - start, logPath })
  await writeFile(
    resolve(output, imageCloud ? 'cloud-results.json' : 'results.json'),
    JSON.stringify({ startedBy: 'npm test', results }, null, 2) + '\n',
  )
  console.log(`${exitCode === 0 ? 'PASS' : 'FAIL'} ${name}`)
  return exitCode === 0
}

if (imageCloud) {
  if (process.env.GCLOUD_PROJECT !== 'demo-image-persistence' || !process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error('Cloud image tests require local demo-image-persistence emulators.')
  await run('images-cloud-persistence', process.execPath, ['tests/image-persistence.test.mjs', '--cloud'])
  await run('images-cloud-formats', process.execPath, ['tests/image-formats.test.mjs', '--cloud'])
  await run('slide-notes-access', process.execPath, ['tests/slide-notes-access.test.mjs'])
  await run('deleted-project-sync', process.execPath, ['tests/deleted-project-sync.test.mjs'])
} else {
  console.log(
    'Running automated local/emulator tests. Live-account checks and historical security exploit probes are separate.',
  )
  if (!(await run('build', 'pnpm', ['build']))) process.exit(1)
  await run('typecheck', 'pnpm', ['check'])
  await run('lint', 'pnpm', ['lint'])
  const tsx = 'packages/mcp/node_modules/tsx/dist/cli.mjs'
  await run('collaboration-unit', process.execPath, [tsx, 'tests/collab-edge-cases.test.ts'])
  await run('collaboration-load', process.execPath, [tsx, 'tests/collab-load-simulation.test.ts'])
  await run('slides-model', process.execPath, [tsx, 'tests/slides-model.test.ts'])
  await run('board-loading', process.execPath, [tsx, 'tests/board-loading.test.ts'])
  await run('slides-browser', process.execPath, ['tests/run-slides-tests.mjs'])
  await run('slides-production', process.execPath, ['tests/slides-production.test.mjs'])
  await run('mcp-tools', process.execPath, [tsx, 'tests/mcp-tools-suite.test.ts'])
  await run('image-access-policy', process.execPath, ['tests/image-access-policy.test.mjs'])

  // Firebase's .env.local overrides demo parameters. Use an isolated compiled
  // Functions source so a developer's live settings cannot change test policy.
  const runtime = await mkdtemp(resolve(output, 'runtime-'))
  try {
    const functions = resolve(runtime, 'functions')
    await mkdir(functions)
    await cp(resolve(root, 'functions/lib'), resolve(functions, 'lib'), { recursive: true })
    await cp(resolve(root, 'functions/package.json'), resolve(functions, 'package.json'))
    await symlink(resolve(root, 'functions/node_modules'), resolve(functions, 'node_modules'), 'dir')
    for (const project of ['demo-projects', 'demo-image-persistence']) {
      await writeFile(
        resolve(functions, `.env.${project}`),
        'RTDB_FUNCTION_REGION=us-central1\nFIRESTORE_FUNCTION_REGION=us-central1\nSYNC_ACCESS_FUNCTION_REGION=us-central1\nASSET_ENFORCE_APP_CHECK=false\n',
      )
    }
    async function config(source, destination) {
      const value = JSON.parse(await readFile(resolve(root, source), 'utf8'))
      value.functions.source = 'functions'
      value.emulators.firestore.websocketPort = source.startsWith('projects') ? 29500 : 19500
      for (const service of ['firestore', 'database', 'storage'])
        value[service].rules = resolve(root, value[service].rules)
      const path = resolve(runtime, destination)
      await writeFile(path, JSON.stringify(value, null, 2))
      return path
    }
    const projectsConfig = await config('projects.firebase.json', 'projects.firebase.json')
    await run('projects-e2e', process.execPath, ['tests/run-projects-e2e.mjs', `--config=${projectsConfig}`])
    await run('images-local-persistence', process.execPath, ['tests/image-persistence.test.mjs'])
    await run('images-local-formats', process.execPath, ['tests/image-formats.test.mjs'])
    await run('images-production-bundle-formats', process.execPath, [
      'tests/image-formats.test.mjs',
      '--production-bundle',
    ])
    const imagesConfig = await config('image-persistence.firebase.json', 'images.firebase.json')
    await run('images-cloud', 'firebase', [
      'emulators:exec',
      '--only',
      'auth,firestore,storage,database,functions',
      '--project',
      'demo-image-persistence',
      '--config',
      imagesConfig,
      'node tests/run-all-tests.mjs --image-cloud',
    ])
  } finally {
    await rm(runtime, { recursive: true, force: true })
  }
  await run('older-browser-regression', process.execPath, ['tests/run-regression-tests.mjs'])
}
const failures = results.filter((result) => result.exitCode !== 0)
console.log(`\n${results.length - failures.length}/${results.length} test stages passed.`)
if (failures.length) {
  console.error('Failed stages: ' + failures.map((result) => result.name).join(', '))
  process.exitCode = 1
}
