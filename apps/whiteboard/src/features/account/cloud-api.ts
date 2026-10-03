import { connectFunctionsEmulator, getFunctions, httpsCallable, type Functions } from 'firebase/functions'
import { getFirebaseApp, getSyncAccessFunctionRegion } from '../../lib/firebase'

export type AccountUsage = {
  plan: 'free' | 'pro'
  source: 'free' | 'complimentary' | 'manual'
  limits: {
    boards: number | null
    assetBytes: number
    imageBytes: number
    documentBytes: number
    currentDocumentBytes: number
    sessions: number
    dailySaves: number
    historyCount: number
    historyDays: number
  }
  usage: { boards: number; assetBytes: number; currentDocumentBytes: number; saves: number }
  resetsAt: string
  paymentsAvailable: false
}
export type CloudLimit = { message: string; metric?: string; limit?: number; kind?: string }
let connected: Functions | undefined

export async function cloudCall<T = any>(name: string, data: unknown): Promise<T> {
  const app = getFirebaseApp()
  if (!app) throw new Error('Cloud features are not configured. Your local workspace remains available.')
  const region =
    getSyncAccessFunctionRegion() || (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' ? 'us-central1' : undefined)
  if (!region) throw new Error('The cloud function region is not configured.')
  const functions = getFunctions(app, region)
  if (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' && connected !== functions) {
    connectFunctionsEmulator(
      functions,
      window.location.hostname || '127.0.0.1',
      Number(import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT || 5001),
    )
    connected = functions
  }
  try {
    const result = await httpsCallable<unknown, T>(functions, name)(data)
    if (name !== 'getAccountUsage' && name !== 'admitCloudSession' && name !== 'commitCloudElements') {
      window.dispatchEvent(new Event('account-usage-changed'))
    }
    const warning = (result.data as any)?.warning
    if (warning) window.dispatchEvent(new CustomEvent<CloudLimit>('cloud-limit', { detail: warning }))
    return result.data
  } catch (error: any) {
    if (error.code === 'functions/resource-exhausted') {
      window.dispatchEvent(
        new CustomEvent<CloudLimit>('cloud-limit', { detail: { ...error.details, message: error.message } }),
      )
    }
    throw error
  }
}

export function cloudDocumentSize(path: string, data: Record<string, unknown>): number {
  const encoder = new TextEncoder()
  const stringBytes = (value: string) => encoder.encode(value).length + 1
  function valueBytes(value: unknown): number {
    if (value === null || typeof value === 'boolean') return 1
    if (typeof value === 'number') return 8
    if (typeof value === 'string') return stringBytes(value)
    if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + valueBytes(item), 0)
    if (value && typeof value === 'object') return mapBytes(value as Record<string, unknown>) + 32
    return 0
  }
  function mapBytes(value: Record<string, unknown>): number {
    return Object.entries(value).reduce((sum, [key, item]) => sum + stringBytes(key) + valueBytes(item), 0)
  }
  return path.split('/').reduce((sum, part) => sum + stringBytes(part), 16) + mapBytes(data) + 32
}

export function pauseUntil(error: any): string {
  if (error?.code === 'functions/resource-exhausted') {
    // Save allowance resets daily. Other quotas require cleanup/upgrade; avoid a retry storm.
    if (
      error.details?.metric === 'saves' ||
      (error.details?.metric === 'sharedPool' && Number(error.details?.limit) > 0)
    ) {
      const day = new Date().toISOString().slice(0, 10)
      return new Date(Date.parse(day) + 86400000).toISOString()
    }
    return new Date(Date.now() + 3600000).toISOString()
  }
  return new Date(Date.now() + 60000).toISOString()
}
