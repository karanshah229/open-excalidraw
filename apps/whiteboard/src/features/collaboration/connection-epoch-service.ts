import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions'
import { getFirebaseApp, getSyncAccessFunctionRegion } from '../../lib/firebase'

let functions: ReturnType<typeof getFunctions> | undefined
export async function mintSceneConnectionEpoch(boardId: string, sessionId: string, sceneGeneration: number): Promise<string> {
  const app = getFirebaseApp()
  const region = getSyncAccessFunctionRegion()
  if (!app || !region) throw new Error('Collaboration service region is not configured.')
  if (!functions) {
    functions = getFunctions(app, region)
    if (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true') {
      connectFunctionsEmulator(
        functions,
        window.location.hostname,
        Number(import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT || 5001),
      )
    }
  }
  const response = await httpsCallable<
    { boardId: string; sessionId: string; sceneGeneration: number },
    { connectionEpoch: string; generation: number }
  >(functions, 'mintSceneConnectionEpoch')({ boardId, sessionId, sceneGeneration })
  if (typeof response.data?.connectionEpoch !== 'string' || response.data.connectionEpoch.length === 0) {
    throw new Error('Collaboration service returned an invalid connection epoch.')
  }
  return response.data.connectionEpoch
}
