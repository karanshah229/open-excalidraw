import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp } = require('firebase-admin/app'),
  { getFirestore } = require('firebase-admin/firestore')
const { getAuth } = require('firebase-admin/auth')
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST)
  throw new Error('This test requires local Firebase demo emulators.')
const project = process.env.GCLOUD_PROJECT
assert(project.startsWith('demo-'))
initializeApp({ projectId: project })
const db = getFirestore(),
  auth = getAuth(),
  suffix = Date.now().toString(36)
const ids = { owner: `notes-owner-${suffix}`, editor: `notes-editor-${suffix}`, viewer: `notes-viewer-${suffix}` }
const tokens = {}
for (const [role, uid] of Object.entries(ids)) {
  const email = `${uid}@example.com`,
    password = 'EmulatorOnly123!'
  await auth.createUser({ uid, email, emailVerified: true, password })
  const response = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  )
  tokens[role] = (await response.json()).idToken
  assert(tokens[role])
}
const boardId = `notes-board-${suffix}`,
  projectId = `notes-project-${suffix}`
await db.doc(`users/${ids.owner}/projects/${projectId}`).set({ ownerId: ids.owner })
await db.doc(`users/${ids.owner}/projects/${projectId}/boards/${boardId}`).set({ active: true, projectId })
const config = {
  ownerId: ids.owner,
  projectId,
  generalAccess: 'restricted',
  inheritProjectAccess: true,
  invitedEmails: [`${ids.editor}@example.com`, `${ids.viewer}@example.com`],
  collaborators: {
    [`${ids.editor}@example.com`]: { role: 'editor' },
    [`${ids.viewer}@example.com`]: { role: 'viewer' },
  },
}
await db.doc(`boardShares/${boardId}`).set(config)
const endpoint = process.env.SLIDE_NOTES_FUNCTION_URL || `http://127.0.0.1:5001/${project}/us-central1/slideNotes`
async function call(role, extra = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}) },
    body: JSON.stringify({ data: { operation: 'read', boardId, slideId: 'test-slide', projectId, ...extra } }),
  })
  return { status: response.status, body: await response.json() }
}
assert.equal((await call(null)).status, 401)
assert.equal((await call('viewer')).status, 403)
const written = await call('editor', {
  operation: 'write',
  text: 'Only editors see this',
  revision: 0,
  mutationId: 'first',
})
assert.equal(written.body.result.revision, 1)
assert.equal((await call('owner')).body.result.text, 'Only editors see this')
for (const role of ['owner', 'editor', 'viewer']) {
  const direct = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${project}/databases/(default)/documents/slideNotes/${boardId}/notes/test-slide`,
    { headers: { Authorization: `Bearer ${tokens[role]}` } })
  assert.equal(direct.status, 403, 'Direct Firestore access must use the authorized callable instead')
}

assert.equal(
  (await call('editor', { operation: 'write', text: 'Only editors see this', revision: 0, mutationId: 'first' })).body
    .result.revision,
  1,
  'Retry is idempotent',
)
const conflict = await call('editor', { operation: 'write', text: 'Stale notes', revision: 0, mutationId: 'stale' })
assert.equal(conflict.body.result.conflict, true)
assert.equal(conflict.body.result.text, 'Only editors see this')
assert.equal(
  (await call('editor', { operation: 'write', text: 'x'.repeat(20001), revision: 1, mutationId: 'large' })).status,
  400,
)
await db
  .doc(`boardShares/${boardId}`)
  .update({ generalAccess: 'anyone_with_link', generalRole: 'viewer', invitedEmails: [], collaborators: {} })
assert.equal((await call('editor')).status, 403, 'Revoked editor cannot read cached remote notes')
assert.equal((await call('viewer')).status, 403, 'Public board viewers cannot read notes')
await db
  .doc(`projectShares/${projectId}`)
  .set({ ownerId: ids.owner, generalAccess: 'anyone_with_link', generalRole: 'editor' })
assert.equal((await call('editor')).status, 200, 'Inherited project editor can read')
await db.doc(`projectShares/${projectId}`).update({ deletedAt: new Date().toISOString() })
assert.equal((await call('owner')).status, 403, 'Project deletion revokes notes even for owner')
assert.equal(
  (await db.doc(`boardShares/${boardId}`).get()).data().scene,
  undefined,
  'Notes never enter the shared scene',
)
console.log(
  'PASS speaker notes: editor-only access, revisions, idempotency, conflicts, length, revocation, inheritance and deletion',
)
