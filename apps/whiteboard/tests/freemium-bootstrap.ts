// Local integration harness only; never loaded by the production entry point.
import * as firebase from '../src/lib/firebase'
import * as auth from 'firebase/auth'
if (firebase.getFirebaseApp()?.options.projectId !== 'demo-whiteboard-freemium' || location.hostname !== '127.0.0.1') {
  throw new Error('Freemium fixtures require the local demo project')
}
;(window as any).__freemium = {
  firebase,
  auth,
  account: await import('../src/features/account/cloud-api'),
  workspace: await import('../src/features/workspace/workspace-api'),
  recovery: await import('../src/features/sharing/guest-recovery'),
  sharing: await import('../src/features/sharing/sharing-service'),
}
await import('../src/main')
