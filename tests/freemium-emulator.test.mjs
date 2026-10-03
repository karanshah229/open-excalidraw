// Runs only against the isolated demo emulators in firebase.freemium-test.json.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
const wr = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const ar = createRequire(new URL('../functions/package.json', import.meta.url))
const fa = wr('firebase/app'),
  au = wr('firebase/auth'),
  fs = wr('firebase/firestore'),
  st = wr('firebase/storage'),
  fn = wr('firebase/functions')
const aa = ar('firebase-admin/app'),
  af = ar('firebase-admin/firestore'),
  ad = ar('firebase-admin/database'),
  authAdmin = ar('firebase-admin/auth')
const projectId = 'demo-whiteboard-freemium',
  bucket = `${projectId}.appspot.com`,
  namespace = projectId
Object.assign(process.env, {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:18580',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19599',
  FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:19500',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:19699',
  GCLOUD_PROJECT: projectId,
})
const admin = aa.initializeApp({
  projectId,
  storageBucket: bucket,
  databaseURL: `http://127.0.0.1:19500?ns=${namespace}`,
})
const db = af.getFirestore(admin),
  rtdb = ad.getDatabase(admin),
  adminAuth = authAdmin.getAuth(admin)
const rules = await readFile(new URL('../database.rules.json', import.meta.url), 'utf8')
assert.equal(
  (
    await fetch(`http://127.0.0.1:19500/.settings/rules.json?ns=${namespace}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer owner' },
      body: rules,
    })
  ).status,
  200,
)
const prefix = `quota-${Date.now()}`,
  clients = [],
  password = 'Synthetic-fixture-123!'
async function client(name) {
  const app = fa.initializeApp({ projectId, apiKey: 'emulator-only', storageBucket: bucket }, `${prefix}-${name}`)
  clients.push(app)
  const auth = au.getAuth(app)
  au.connectAuthEmulator(auth, 'http://127.0.0.1:19599', { disableWarnings: true })
  await au.createUserWithEmailAndPassword(auth, `${prefix}-${name}@example.test`, password)
  const firestore = fs.getFirestore(app)
  fs.connectFirestoreEmulator(firestore, '127.0.0.1', 18580)
  const storage = st.getStorage(app)
  st.connectStorageEmulator(storage, '127.0.0.1', 19699)
  const functions = fn.getFunctions(app, 'us-central1')
  fn.connectFunctionsEmulator(functions, '127.0.0.1', 15501)
  return {
    auth,
    db: firestore,
    storage,
    call: async (name, data = {}) => (await fn.httpsCallable(functions, name)(data)).data,
  }
}
const owner = await client('owner'),
  guest = await client('guest'),
  other = await client('other')
const uid = owner.auth.currentUser.uid
const scene = (value = 1) => ({
  elements: [
    { id: 'rect', type: 'rectangle', x: value, y: 0, width: 100, height: 100, version: value, versionNonce: 1 },
  ],
  appState: {},
  files: {},
})
const board = (boardId, revision = 1, value = revision) => ({
  mode: 'private',
  boardId,
  projectId: 'project',
  operationId: `op-${boardId}-${revision}`,
  baseRevision: revision - 1,
  document: {
    id: boardId,
    projectId: 'project',
    name: boardId,
    active: true,
    revision,
    scene: scene(value),
    updatedAt: new Date().toISOString(),
  },
})
const usageRef = db.doc(`accountUsage/${uid}`)
const ids = ['one', 'two', 'three', 'four'].map((n) => `${prefix}-${n}`)
const rejected = async (promise, code) =>
  assert.rejects(promise, (error) => error.code === `functions/${code}` || error.code === code)
let passed = 0
async function check(name, work) {
  await work()
  passed++
  console.log(`PASS ${name}`)
}
try {
  await check('verified complimentary email required; removal downgrades', async () => {
    await db.doc('adminConfig/complimentaryUsers').set({ emails: [` ${owner.auth.currentUser.email.toUpperCase()} `] })
    assert.equal((await owner.call('getAccountUsage')).plan, 'free')
    await adminAuth.updateUser(uid, { emailVerified: true })
    assert.equal((await owner.call('getAccountUsage')).plan, 'pro')
    await db.doc('adminConfig/complimentaryUsers').set({ emails: [] })
    assert.equal((await owner.call('getAccountUsage')).plan, 'free')
  })
  await check('Pro request records intent without granting entitlement', async () => {
    await owner.call('requestProAccess')
    assert.equal((await db.doc(`proAccessRequests/${uid}`).get()).data().status, 'requested')
    assert.equal((await owner.call('getAccountUsage')).plan, 'free')
    await rejected(guest.call('requestProAccess'), 'failed-precondition')
  })
  await check('concurrent board creation cannot exceed three', async () => {
    const outcomes = await Promise.allSettled(ids.map((id) => owner.call('commitCloudBoard', board(id))))
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 3)
    assert.equal(outcomes.find((r) => r.status === 'rejected').reason.code, 'functions/resource-exhausted')
    assert.equal((await owner.call('getAccountUsage')).usage.boards, 3)
  })
  const activeId = (await usageRef.collection('boards').get()).docs[0].id
  await check('replayed operation counts one save', async () => {
    const before = (await owner.call('getAccountUsage')).usage.saves
    const operation = board(activeId)
    assert.equal((await owner.call('commitCloudBoard', operation)).duplicate, true)
    assert.equal((await owner.call('getAccountUsage')).usage.saves, before)
  })
  await check('direct writes and private admin lists cannot bypass server', async () => {
    await rejected(
      fs.setDoc(fs.doc(owner.db, `users/${uid}/projects/project/boards/bypass`), board('bypass').document),
      'permission-denied',
    )
    await rejected(fs.setDoc(fs.doc(owner.db, `accountUsage/${uid}`), { boards: 0 }), 'permission-denied')
    await rejected(fs.getDoc(fs.doc(owner.db, 'adminConfig/complimentaryUsers')), 'permission-denied')
  })
  const metadata = {
    boardName: 'Shared',
    ownerName: 'Fixture',
    generalAccess: 'anyone_with_link',
    generalRole: 'editor',
    invitedEmails: [],
    collaborators: {},
  }
  await owner.call('commitCloudBoard', {
    mode: 'share-config',
    boardId: activeId,
    operationId: 'share-config',
    document: metadata,
  })
  await check('shared/private copies count once; guest writes charge owner', async () => {
    const before = (await owner.call('getAccountUsage')).usage.saves
    await owner.call('commitCloudBoard', {
      mode: 'shared-scene',
      boardId: activeId,
      operationId: 'same-scene',
      document: { scene: scene(1) },
    })
    assert.equal((await owner.call('getAccountUsage')).usage.saves, before)
    await guest.call('commitCloudBoard', {
      mode: 'shared-scene',
      boardId: activeId,
      operationId: 'guest-change',
      document: { scene: scene(2) },
    })
    assert.equal((await owner.call('getAccountUsage')).usage.saves, before + 1)
    assert.equal((await guest.call('getAccountUsage')).usage.saves, 0)
  })
  await check('daily quota blocks change, permits identical scene and resets UTC', async () => {
    const day = new Date().toISOString().slice(0, 10)
    await usageRef.update({ saves: 1000, day })
    await rejected(
      guest.call('commitCloudBoard', {
        mode: 'shared-scene',
        boardId: activeId,
        operationId: 'full-day',
        document: { scene: scene(3) },
      }),
      'resource-exhausted',
    )
    await guest.call('commitCloudBoard', {
      mode: 'shared-scene',
      boardId: activeId,
      operationId: 'noop-day',
      document: { scene: scene(2) },
    })
    await usageRef.update({ day: '2000-01-01' })
    await guest.call('commitCloudBoard', {
      mode: 'shared-scene',
      boardId: activeId,
      operationId: 'new-day',
      document: { scene: scene(3) },
    })
    assert.equal((await owner.call('getAccountUsage')).usage.saves, 1)
  })
  await check('900 KiB scene safety ceiling', async () => {
    await rejected(
      owner.call('commitCloudBoard', {
        mode: 'shared-scene',
        boardId: activeId,
        operationId: 'huge-board',
        document: { scene: { ...scene(4), appState: { text: '界'.repeat(310000) } } },
      }),
      'resource-exhausted',
    )
  })
  await check('image reservations, rule enforcement, idempotency and hard sizes', async () => {
    const input = { boardId: activeId, fileId: 'image-one', bytes: 4, mimeType: 'image/png', shared: false }
    await rejected(
      st.uploadBytes(st.ref(owner.storage, `users/${uid}/boards/${activeId}/assets/forged`), new Uint8Array(4), {
        contentType: 'image/png',
      }),
      'storage/unauthorized',
    )
    const grant = await owner.call('reserveCloudAsset', input)
    await st.uploadBytes(st.ref(owner.storage, grant.storagePath), new Uint8Array(4), {
      contentType: 'image/png',
      customMetadata: { quotaGrant: grant.grantId },
    })
    await owner.call('confirmCloudAsset', { grantId: grant.grantId })
    assert.equal((await owner.call('reserveCloudAsset', input)).uploaded, true)
    assert.equal((await owner.call('getAccountUsage')).usage.assetBytes, 4)
    await rejected(
      owner.call('reserveCloudAsset', { ...input, fileId: 'too-big', bytes: 5 * 1024 ** 2 }),
      'resource-exhausted',
    )
    await usageRef.update({ assetBytes: 25 * 1024 ** 2 })
    await rejected(owner.call('reserveCloudAsset', { ...input, fileId: 'quota-full' }), 'resource-exhausted')
    await usageRef.update({ assetBytes: 4 })
  })
  await check('concurrent live session admissions capped; grants unforgeable', async () => {
    const outcomes = await Promise.allSettled(
      [1, 2, 3, 4].map((n) => guest.call('admitCloudSession', { boardId: activeId, sessionId: `session-${n}` })),
    )
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 3)
    const token = await guest.auth.currentUser.getIdToken()
    const response = await fetch(
      `http://127.0.0.1:19500/sessionGrants/${activeId}/forged.json?ns=${namespace}&auth=${token}`,
      { method: 'PUT', body: JSON.stringify({ userId: guest.auth.currentUser.uid, expiresAt: Date.now() + 3600000 }) },
    )
    assert.equal(response.status, 401)
  })
  await check('only admitted editors can write deltas; UTF8 element cap', async () => {
    const sessionId = Object.keys((await rtdb.ref(`sessionGrants/${activeId}`).get()).val())[0]
    await rejected(
      other.call('commitCloudElements', { boardId: activeId, sessionId, elements: scene().elements }),
      'permission-denied',
    )
    await guest.call('commitCloudElements', { boardId: activeId, sessionId, elements: scene(4).elements })
    await rejected(
      guest.call('commitCloudElements', {
        boardId: activeId,
        sessionId,
        elements: [{ ...scene(5).elements[0], text: '界'.repeat(90000) }],
      }),
      'resource-exhausted',
    )
    const token = await guest.auth.currentUser.getIdToken()
    const response = await fetch(
      `http://127.0.0.1:19500/boards/${activeId}/elements/forged.json?ns=${namespace}&auth=${token}`,
      { method: 'PUT', body: JSON.stringify({ data: '{}' }) },
    )
    assert.equal(response.status, 401)
  })
  await check('manual Pro grants are server-owned and expiry is enforced', async () => {
    const ref = db.doc(`accountEntitlements/${uid}`)
    await rejected(
      fs.setDoc(fs.doc(owner.db, `accountEntitlements/${uid}`), { plan: 'pro', active: true }),
      'permission-denied',
    )
    await ref.set({ plan: 'pro', active: true })
    assert.equal((await owner.call('getAccountUsage')).source, 'manual')
    await owner.call('commitCloudBoard', {
      mode: 'shared-scene',
      boardId: activeId,
      operationId: 'manual-scene',
      document: { scene: scene(7) },
    })
    assert.equal((await db.doc('projectUsage/pro').get()).data().saves, 1)
    await db.doc('adminConfig/complimentaryUsers').set({ emails: [owner.auth.currentUser.email] })
    await owner.call('commitCloudBoard', {
      mode: 'shared-scene',
      boardId: activeId,
      operationId: 'complimentary-scene',
      document: { scene: scene(8) },
    })
    assert.equal((await db.doc('projectUsage/complimentary').get()).data().saves, 1)
    await db.doc('adminConfig/complimentaryUsers').set({ emails: [] })
    await ref.update({ expiresAt: Date.now() - 1 })
    assert.equal((await owner.call('getAccountUsage')).plan, 'free')
    await ref.delete()
  })
  await check('shared Free pool cap and operator pause preserve local/read/delete access', async () => {
    const policy = db.doc('adminConfig/freemiumPolicy'),
      pool = db.doc('projectUsage/free')
    await policy.set({ freeDailySaves: 2 })
    await pool.set({ day: new Date().toISOString().slice(0, 10), saves: 2 })
    await rejected(
      guest.call('commitCloudBoard', {
        mode: 'shared-scene',
        boardId: activeId,
        operationId: 'pool-full',
        document: { scene: scene(6) },
      }),
      'resource-exhausted',
    )
    await policy.set({ freeCloudPaused: true })
    assert.equal((await owner.call('getAccountUsage')).plan, 'free')
    await rejected(
      owner.call('reserveCloudAsset', { boardId: activeId, fileId: 'paused', bytes: 4, mimeType: 'image/png' }),
      'resource-exhausted',
    )
    await rejected(
      guest.call('admitCloudSession', { boardId: activeId, sessionId: 'paused-session' }),
      'resource-exhausted',
    )
    await policy.delete()
    await pool.set({ day: new Date().toISOString().slice(0, 10), saves: 0 })
  })
  await check('inventory includes retained inactive boards and does not delete on downgrade', async () => {
    const legacy = await client('legacy'),
      legacyUid = legacy.auth.currentUser.uid
    await db.doc(`users/${legacyUid}/projects/project`).set({ name: 'Legacy' })
    const document = { ...board(`${prefix}-legacy`).document, active: false }
    await db.doc(`users/${legacyUid}/projects/project/boards/${document.id}`).set(document)
    const account = await legacy.call('getAccountUsage')
    assert.equal(account.usage.boards, 1)
    assert.ok(account.usage.currentDocumentBytes > 0)
    assert.equal((await db.doc(`users/${legacyUid}/projects/project/boards/${document.id}`).get()).exists, true)
  })
  await check('expired unused upload reservations refund; recovery history bounded', async () => {
    const input = { boardId: activeId, fileId: 'unused-reservation', bytes: 4, mimeType: 'image/png' }
    const grant = await owner.call('reserveCloudAsset', input)
    await db.doc(`assetGrants/${grant.grantId}`).update({ expiresAt: Date.now() - 1 })
    const handlers = await import('../functions/lib/account-usage.js')
    await handlers.cleanUsageReservations.run({})
    assert.equal((await db.doc(`assetGrants/${grant.grantId}`).get()).exists, false)
    assert.equal((await owner.call('getAccountUsage')).usage.assetBytes, 4)
    for (let n = 0; n < 12; n++) await handlers.persistRecoveryScene(activeId, scene(n + 10).elements)
    assert.equal((await db.collection(`boardShares/${activeId}/history`).get()).size, 10)
  })
  await check('failed board commits cannot strand charged image assets', async () => {
    const boardId = `${prefix}-orphan`,
      otherUid = other.auth.currentUser.uid
    const grant = await other.call('reserveCloudAsset', {
      boardId,
      fileId: 'orphan-image',
      bytes: 4,
      mimeType: 'image/png',
    })
    await st.uploadBytes(st.ref(other.storage, grant.storagePath), new Uint8Array(4), {
      contentType: 'image/png',
      customMetadata: { quotaGrant: grant.grantId },
    })
    await other.call('confirmCloudAsset', { grantId: grant.grantId })
    assert.equal((await other.call('getAccountUsage')).usage.assetBytes, 4)
    await other.call('purgeCloudBoard', { boardId })
    const usage = (await db.doc(`accountUsage/${otherUid}`).get()).data()
    assert.equal(usage.assetBytes, 0)
    assert.equal(usage.boards, 0)
  })
  await check('owner-only deletion frees cloud board slot', async () => {
    await rejected(guest.call('purgeCloudBoard', { boardId: activeId }), 'permission-denied')
    await owner.call('purgeCloudBoard', { boardId: activeId })
    assert.equal((await owner.call('getAccountUsage')).usage.boards, 2)
    for (let n = 0; n < 30 && (await owner.call('getAccountUsage')).usage.assetBytes; n++)
      await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal((await owner.call('getAccountUsage')).usage.assetBytes, 0)
    await owner.call('commitCloudBoard', board(`${prefix}-replacement`))
    assert.equal((await owner.call('getAccountUsage')).usage.boards, 3)
  })
  console.log(`${passed} freemium integration checks passed`)
} finally {
  await Promise.all(clients.map((app) => fa.deleteApp(app)))
  await aa.deleteApp(admin)
}
