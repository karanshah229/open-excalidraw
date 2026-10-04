// Test-only entrypoint. Never imported by the production app.
import * as firebase from '../src/lib/firebase'
import * as auth from 'firebase/auth'
import * as firestore from 'firebase/firestore'
import * as database from 'firebase/database'
import * as excalidraw from '@excalidraw/excalidraw'
import * as storage from 'firebase/storage'
import * as projects from '../src/features/sharing/project-service'
import * as workspace from '../src/features/workspace/workspace-api'
import * as exports from '../src/features/workspace/export-boards'
import * as sharing from '../src/features/sharing/sharing-service'
if (firebase.getFirebaseApp()?.options.projectId !== 'demo-projects' || location.hostname !== '127.0.0.1')
  throw new Error('Projects tests require the local demo project.')
;(window as any).__projectsTest = {
  firebase,
  auth,
  firestore,
  database,
  storage,
  projects,
  workspace,
  sharing,
  excalidraw,
  exports,
}
await import('../src/main')
