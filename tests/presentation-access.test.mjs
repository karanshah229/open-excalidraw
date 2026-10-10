import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getAuth } = require('firebase-admin/auth')
const project = process.env.GCLOUD_PROJECT
if (!project?.startsWith('demo-') || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Isolated demo emulators required')
const app = initializeApp({ projectId: project }),
  db = getFirestore(),
  auth = getAuth()
const suffix = Date.now().toString(36),
  boardId = `role-board-${suffix}`,
  projectId = `role-project-${suffix}`
const tokens = {},
  uids = {}
for (const role of ['owner', 'viewer', 'presenter']) {
  const uid = `${role}-${suffix}`,
    email = `${uid}@example.test`,
    password = 'EmulatorOnly123!'
  uids[role] = uid
  await auth.createUser({ uid, email, password, emailVerified: true })
  const response = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  )
  tokens[role] = (await response.json()).idToken
}
const base = {
  ownerId: uids.owner,
  projectId,
  boardId,
  generalAccess: 'restricted',
  generalRole: 'viewer',
  inheritProjectAccess: true,
  invitedEmails: [],
  collaborators: {},
  accessRevision: 1,
  pending: false,
  scene: { elements: [], appState: {} },
}
await db.doc(`users/${uids.owner}/projects/${projectId}`).set({ ownerId: uids.owner })
await db
  .doc(`users/${uids.owner}/projects/${projectId}/boards/${boardId}`)
  .set({ active: true, projectId, scene: base.scene })
await db.doc(`boardShares/${boardId}`).set(base)
await db.doc(`slideNotes/${boardId}/notes/slide-one`).set({ text: 'Live presenter notes', revision: 1 })
const port = process.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT || process.env.FIREBASE_FUNCTIONS_EMULATOR_PORT || 5001
async function call(endpoint, role, data) {
  const response = await fetch(`http://127.0.0.1:${port}/${project}/us-central1/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}) },
    body: JSON.stringify({ data: { boardId, projectId, ...data } }),
  })
  return { status: response.status, body: await response.json() }
}
async function canRead(role) {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${project}/databases/(default)/documents/boardShares/${boardId}`,
    { headers: role ? { Authorization: `Bearer ${tokens[role]}` } : {} },
  )
  return response.status
}
try {
  const shared = await call('manageBoardAccess', 'owner', {
    action: 'share',
    expectedRevision: 1,
    policy: { ...base, generalAccess: 'anyone_with_link', generalRole: 'presentation' },
  })
  assert.equal(shared.status, 200)
  assert.equal(shared.body.result.policy.accessRevision, 2)
  assert.equal(await canRead(null), 200, 'Public Presentation has board read access')
  assert.equal(
    (await call('slideNotes', 'presenter', { operation: 'read', slideId: 'slide-one' })).body.result.text,
    'Live presenter notes',
  )
  assert.equal(
    (
      await call('slideNotes', 'presenter', {
        operation: 'write',
        slideId: 'slide-one',
        revision: 1,
        text: 'blocked',
        mutationId: 'denied',
      })
    ).status,
    403,
  )
  const stale = await call('manageBoardAccess', 'owner', {
    action: 'share',
    expectedRevision: 1,
    policy: { ...base, generalAccess: 'anyone_with_link', generalRole: 'editor' },
  })
  assert.equal(stale.status, 409, 'Stale role changes cannot overwrite committed access')
  const unknown = await call('manageBoardAccess', 'owner', {
    action: 'share',
    policy: { ...base, generalRole: 'unknown' },
  })
  assert.equal(unknown.status, 400, 'Unknown roles are rejected instead of downgraded')
  const identical = await call('manageBoardAccess', 'owner', {
    action: 'share',
    expectedRevision: 2,
    policy: shared.body.result.policy,
  })
  assert.equal(identical.body.result.policy.accessRevision, 2, 'Unchanged permissions do not rewrite policy')
  await db.doc(`boardShares/${boardId}`).set({
    ...base,
    accessRevision: 3,
    invitedEmails: [`${uids.presenter}@example.test`],
    collaborators: { [`${uids.presenter}@example.test`]: { role: 'presentation' } },
  })
  assert.equal(await canRead('presenter'), 200, 'Invited Presentation grants read access')
  assert.equal(await canRead('viewer'), 403)
  assert.equal((await call('slideNotes', 'presenter', { operation: 'read', slideId: 'slide-one' })).status, 200)
  await db.doc(`boardShares/${boardId}`).set(base)
  await db
    .doc(`projectShares/${projectId}`)
    .set({ ...base, generalAccess: 'anyone_with_link', generalRole: 'presentation' })
  assert.equal(await canRead('viewer'), 200, 'Project Presentation applies to inherited boards')
  assert.equal((await call('slideNotes', 'viewer', { operation: 'read', slideId: 'slide-one' })).status, 200)
  await db.doc(`boardShares/${boardId}`).update({ inheritProjectAccess: false })
  assert.equal(await canRead('viewer'), 403, 'Custom board access excludes inherited grants')
  await db.doc(`boardShares/${boardId}`).set({ ...base, generalAccess: 'anyone_with_link', pending: true })
  assert.equal(await canRead('owner'), 200, 'Owner remains authorized while access synchronizes')
  assert.equal(await canRead('viewer'), 403, 'Peers remain fail-closed while access synchronizes')
  const commit = async (role, document) => {
    const response = await fetch(
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${project}/databases/(default)/documents:commit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[role]}` },
        body: JSON.stringify({
          writes: [
            {
              update: {
                name: `projects/${project}/databases/(default)/documents/${document}`,
                fields: { updatedAt: { stringValue: new Date().toISOString() } },
              },
              updateMask: { fieldPaths: ['updatedAt'] },
            },
          ],
        }),
      },
    )
    return response.status
  }
  assert.equal(
    await commit('owner', `boardShares/${boardId}`),
    200,
    'Owner scene commit survives board policy synchronization',
  )
  assert.equal(await commit('presenter', `boardShares/${boardId}`), 403, 'Presenter commits remain denied')
  await db.doc(`projectShares/${projectId}`).set({ ...base, pending: true })
  assert.equal(
    await commit('owner', `users/${uids.owner}/projects/${projectId}/boards/${boardId}`),
    200,
    'Owned workspace commit survives project policy synchronization',
  )
  await db.doc(`boardShares/${boardId}`).update({ deletedAt: 'deleted' })
  assert.equal(await canRead('owner'), 403, 'Deletion still revokes the owner')
  console.log(
    'PASS: live Presentation permissions, notes, project inheritance, revision conflicts, pending owner access and deletion',
  )
} finally {
  await deleteApp(app)
}
