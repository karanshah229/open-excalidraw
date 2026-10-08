import assert from 'node:assert/strict'
import { resolveBoardSharing } from '../apps/whiteboard/src/features/workspace/board-loading'

const timeout = new Error('Firestore getDoc timeout')
const fail = async () => {
  throw timeout
}
assert.deepEqual(await resolveBoardSharing('owner', 'owner', fail), { status: 'unavailable' })
for (const ownerId of ['someone-else', '', undefined, 'local-user']) {
  await assert.rejects(resolveBoardSharing(ownerId, 'owner', fail), (error) => error === timeout)
}
for (const code of ['unavailable', 'deadline-exceeded']) {
  assert.deepEqual(
    await resolveBoardSharing('owner', 'owner', async () => {
      throw Object.assign(new Error(code), { code })
    }),
    { status: 'unavailable' },
  )
}
for (const code of ['permission-denied', 'unauthenticated', 'internal']) {
  await assert.rejects(
    resolveBoardSharing('owner', 'owner', async () => {
      throw Object.assign(new Error(code), { code })
    }),
  )
}
const allowed = { status: 'allowed', config: { effectiveRole: 'viewer' } }
assert.equal(await resolveBoardSharing('someone-else', 'owner', async () => allowed), allowed)
assert.deepEqual(await resolveBoardSharing('local-user', undefined, fail), { status: 'not-found' })
await assert.rejects(resolveBoardSharing('owner', undefined, fail))
console.log('PASS owner-local timeout recovery, access checks, cloud errors and guest-local loading')
