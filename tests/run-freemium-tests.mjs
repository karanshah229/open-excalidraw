import { spawn } from 'node:child_process'
import { readFile, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const tempRoot = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'wb-freemium-'))
const envPath = new URL('../functions/.env.demo-whiteboard-freemium', import.meta.url)
const expected =
  'RTDB_FUNCTION_REGION=us-central1\nFIRESTORE_FUNCTION_REGION=us-central1\nSYNC_ACCESS_FUNCTION_REGION=us-central1\nSTORAGE_FUNCTION_REGION=us-central1\n'
let created = false
try {
  try {
    if ((await readFile(envPath, 'utf8')) !== expected)
      throw Error('Existing demo environment differs; preserve it and resolve before testing.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await writeFile(envPath, expected, { flag: 'wx' })
    created = true
  }
  const command = 'node tests/freemium-emulator.test.mjs && node tests/freemium-ui.test.mjs'
  const child = spawn(
    'firebase',
    [
      'emulators:exec',
      '--config',
      'firebase.freemium-test.json',
      '--project',
      'demo-whiteboard-freemium',
      '--only',
      'auth,firestore,database,storage,functions',
      command,
    ],
    { stdio: 'inherit', env: { ...process.env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot } },
  )
  process.exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
} finally {
  if (created) await unlink(envPath)
  await rm(tempRoot, { recursive: true, force: true })
}
