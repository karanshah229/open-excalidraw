/** Live E2E imports only; guards against emulator and production configurations. */
if (import.meta.env.VITE_FIREBASE_PROJECT_ID !== 'open-excalidraw-dev-2' || import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' || !['localhost', '127.0.0.1'].includes(location.hostname)) throw new Error('Live history fixture requires localhost with development Firebase.')
export { boardHistoryStore } from '@agentic-whiteboard/storage'
export { convertToExcalidrawElements } from '@excalidraw/excalidraw'
export { GoogleAuthProvider, signInWithCredential, signInAnonymously, updateCurrentUser } from 'firebase/auth'
export { enableNetwork, disableNetwork } from 'firebase/firestore'
export { goOffline, goOnline } from 'firebase/database'
