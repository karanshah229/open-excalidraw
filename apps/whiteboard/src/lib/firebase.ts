import { initializeApp, type FirebaseApp } from 'firebase/app'
import { initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check'
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

const env =
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env
    : typeof process !== 'undefined' && process.env
      ? (process.env as any)
      : {}

const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  databaseURL:
    env.VITE_FIREBASE_DATABASE_URL ||
    (env.VITE_FIREBASE_PROJECT_ID ? `https://${env.VITE_FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com` : undefined),
}

export const isFirebaseConfigured = Boolean(config.apiKey && config.authDomain && config.projectId && config.appId)

let app: FirebaseApp | undefined
let appCheck: AppCheck | undefined
let appCheckInitialized = false
let auth: Auth | undefined
let firestore: Firestore | undefined
let rtdb: Database | undefined
let storage: FirebaseStorage | undefined
const connectedEmulators = new Set<string>()

export function initAppCheck(firebaseApp: FirebaseApp): AppCheck | undefined {
  if (appCheckInitialized) return appCheck
  appCheckInitialized = true

  // Never run App Check in non-browser environments (SSR, Node tests)
  if (typeof window === 'undefined') return undefined

  // Never run App Check when connected to local Firebase emulators
  if (env.VITE_USE_FIREBASE_EMULATOR === 'true') return undefined

  const siteKey = env.VITE_RECAPTCHA_SITE_KEY || env.VITE_FIREBASE_APPCHECK_KEY

  const isLocalhost =
    typeof window.location !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '[::1]')

  // Enable debug token in development mode or on localhost
  if (env.DEV || isLocalhost) {
    const rawToken = env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN
    const debugToken = rawToken === 'true' || rawToken === true || !rawToken ? true : rawToken
    // @ts-expect-error Firebase App Check global debug token
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken
  }

  if (!siteKey) {
    if (env.PROD && !isLocalhost) {
      console.warn('[Firebase App Check] VITE_RECAPTCHA_SITE_KEY is not defined. App Check is inactive.')
    }
    return undefined
  }

  try {
    appCheck = initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    })
  } catch (err) {
    console.error('[Firebase App Check] Failed to initialize App Check:', err)
  }

  return appCheck
}

export function getFirebaseApp(): FirebaseApp | undefined {
  if (!isFirebaseConfigured) return undefined
  if (!app) {
    app = initializeApp(config)
    initAppCheck(app)
  }
  return app
}

function setupEmulators(_currentApp: FirebaseApp) {
  if (env.VITE_USE_FIREBASE_EMULATOR !== 'true') return
  const host = typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : '127.0.0.1'

  if (auth && !connectedEmulators.has('auth')) {
    connectAuthEmulator(auth, `http://${host}:${Number(env.VITE_FIREBASE_AUTH_EMULATOR_PORT || 9099)}`, { disableWarnings: true })
    connectedEmulators.add('auth')
  }
  if (firestore && !connectedEmulators.has('firestore')) {
    connectFirestoreEmulator(firestore, host, Number(env.VITE_FIREBASE_FIRESTORE_EMULATOR_PORT || 8080))
    connectedEmulators.add('firestore')
  }
  if (rtdb && !connectedEmulators.has('rtdb')) {
    connectDatabaseEmulator(rtdb, host, Number(env.VITE_FIREBASE_DATABASE_EMULATOR_PORT || 9000))
    connectedEmulators.add('rtdb')
  }
  if (storage && !connectedEmulators.has('storage')) {
    connectStorageEmulator(storage, host, Number(env.VITE_FIREBASE_STORAGE_EMULATOR_PORT || 9199))
    connectedEmulators.add('storage')
  }
}

export function getFirebaseAuth() {
  const currentApp = getFirebaseApp()
  if (!currentApp) return undefined
  auth ??= getAuth(currentApp)
  if (env.VITE_USE_FIREBASE_EMULATOR === 'true') {
    setupEmulators(currentApp)
  }
  return auth
}

export function getFirestoreDb() {
  const currentApp = getFirebaseApp()
  if (!currentApp) return undefined
  firestore ??= initializeFirestore(currentApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  })
  if (env.VITE_USE_FIREBASE_EMULATOR === 'true') {
    setupEmulators(currentApp)
  }
  return firestore
}

export function getFirebaseRtdb() {
  const currentApp = getFirebaseApp()
  if (!currentApp) return undefined
  rtdb ??= getDatabase(currentApp)
  if (env.VITE_USE_FIREBASE_EMULATOR === 'true') {
    setupEmulators(currentApp)
  }
  return rtdb
}

export function getFirebaseStorage() {
  const currentApp = getFirebaseApp()
  if (!currentApp) return undefined
  storage ??= getStorage(currentApp)
  if (env.VITE_USE_FIREBASE_EMULATOR === 'true') {
    setupEmulators(currentApp)
  }
  return storage
}

export function getFirebaseAppCheck() {
  return appCheck
}

/** Must match the deployed `SYNC_ACCESS_FUNCTION_REGION`. */
export function getSyncAccessFunctionRegion(): string | undefined {
  return env.VITE_FIREBASE_SYNC_ACCESS_FUNCTION_REGION
}

export const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ prompt: 'select_account' })
