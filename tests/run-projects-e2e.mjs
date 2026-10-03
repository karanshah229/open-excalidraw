import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises'

// Demo Firebase resources only. Preserve any existing local parameter file.
const parameters = new URL('../functions/.env.demo-projects', import.meta.url)
const temporaryDirectory = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'wbp-'))
let previous
try {
  previous = await readFile(parameters)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL('..', import.meta.url),
      stdio: 'inherit',
      env: { ...process.env, TMPDIR: temporaryDirectory },
    })
    child.on('error', reject)
    child.on('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`)),
    )
  })
}
try {
  await writeFile(
    parameters,
    'RTDB_FUNCTION_REGION=us-central1\nFIRESTORE_FUNCTION_REGION=us-central1\nSYNC_ACCESS_FUNCTION_REGION=us-central1\n',
  )
  await run('pnpm', ['--filter', '@agentic-whiteboard/functions', 'build'])
  await run('firebase', [
    'emulators:exec',
    '--only',
    'auth,firestore,database,storage,functions',
    '--project',
    'demo-projects',
    '--config',
    'projects.firebase.json',
    'node tests/projects.e2e.mjs',
  ])
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
  if (previous !== undefined) await writeFile(parameters, previous)
  else
    await unlink(parameters).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
}
