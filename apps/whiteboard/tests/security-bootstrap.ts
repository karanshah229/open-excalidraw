// Loaded only by the security browser harness, never by the application entrypoint.
import * as firebase from '../src/lib/firebase'
import * as auth from 'firebase/auth'
import * as firestore from 'firebase/firestore'
import * as database from 'firebase/database'
import * as storage from 'firebase/storage'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'

const app = firebase.getFirebaseApp()!
if (app.options.projectId !== 'demo-whiteboard-security' || location.hostname !== '127.0.0.1') {
  throw new Error('Security fixtures require the local demo project')
}
auth.connectAuthEmulator(firebase.getFirebaseAuth()!, 'http://127.0.0.1:19099', { disableWarnings: true })
firestore.connectFirestoreEmulator(firebase.getFirestoreDb()!, '127.0.0.1', 18080)
database.connectDatabaseEmulator(firebase.getFirebaseRtdb()!, '127.0.0.1', 19000)
storage.connectStorageEmulator(firebase.getFirebaseStorage()!, '127.0.0.1', 19199)
connectFunctionsEmulator(getFunctions(app, 'us-central1'), '127.0.0.1', 15001)
;(window as any).__security = {
  firebase, auth, firestore, database, storage,
  workspace: await import('../src/features/workspace/workspace-api'),
  sharing: await import('../src/features/sharing/sharing-service'),
}
await import('../src/main')
