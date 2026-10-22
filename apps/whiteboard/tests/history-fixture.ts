/** Browser integration fixture imports the real store. Not imported by production application. */
export { boardHistoryStore, setWorkspaceIdentity } from '@agentic-whiteboard/storage'
export { convertToExcalidrawElements } from '@excalidraw/excalidraw'
if (import.meta.env.VITE_USE_FIREBASE_EMULATOR !== 'true' || !import.meta.env.VITE_FIREBASE_PROJECT_ID?.startsWith('demo-')) throw new Error('History fixtures require disposable demo emulators.')
export { enableNetwork, disableNetwork } from 'firebase/firestore'
export { getDocFromServer, doc } from 'firebase/firestore'
export { goOffline, goOnline } from 'firebase/database'
