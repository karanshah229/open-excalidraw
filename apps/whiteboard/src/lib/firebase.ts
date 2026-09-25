import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, connectAuthEmulator, type Auth } from 'firebase/auth'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator,
  type Firestore,
} from 'firebase/firestore'
import { getDatabase, connectDatabaseEmulator, type Database } from 'firebase/database'
import { getStorage, connectStorageEmulator, type FirebaseStorage } from 'firebase/storage'

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  databaseURL:
    import.meta.env.VITE_FIREBASE_DATABASE_URL ||
    (import.meta.env.VITE_FIREBASE_PROJECT_ID
      ? `https://${import.meta.env.VITE_FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
      : undefined),
}

export const isFirebaseConfigured = Boolean(config.apiKey && config.authDomain && config.projectId && config.appId)

let app: FirebaseApp | undefined
let auth: Auth | undefined
let firestore: Firestore | undefined
let rtdb: Database | undefined
let storage: FirebaseStorage | undefined
let emulatorsConnected = false

function setupEmulators(_currentApp: FirebaseApp) {
  if (emulatorsConnected || import.meta.env.VITE_USE_FIREBASE_EMULATOR !== 'true') return
  emulatorsConnected = true
  const host = window.location.hostname || '127.0.0.1'

  if (auth) connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true })
  if (firestore) connectFirestoreEmulator(firestore, host, 8080)
  if (rtdb) connectDatabaseEmulator(rtdb, host, 9000)
  if (storage) connectStorageEmulator(storage, host, 9199)
}

export function getFirebaseAuth() {
  if (!isFirebaseConfigured) return undefined
  app ??= initializeApp(config)
  auth ??= getAuth(app)
  if (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' && !emulatorsConnected) {
    setupEmulators(app)
  }
  return auth
}

export function getFirestoreDb() {
  if (!isFirebaseConfigured) return undefined
  app ??= initializeApp(config)
  firestore ??= initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  })
  if (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' && !emulatorsConnected) {
    setupEmulators(app)
  }
  return firestore
}

export function getFirebaseRtdb() {
  if (!isFirebaseConfigured) return undefined
  app ??= initializeApp(config)
  rtdb ??= getDatabase(app)
  if (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' && !emulatorsConnected) {
    setupEmulators(app)
  }
  return rtdb
}

export function getFirebaseStorage() {
  if (!isFirebaseConfigured) return undefined
  app ??= initializeApp(config)
  storage ??= getStorage(app)
  if (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' && !emulatorsConnected) {
    setupEmulators(app)
  }
  return storage
}

export const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ prompt: 'select_account' })
