import type { BoardScene } from '@agentic-whiteboard/storage'
import { reconcileElementsLWW } from '../collaboration/reconcile'

export type SharedSceneDraft = { key: string; revision: string; scene: BoardScene }
const storeName = 'drafts'
let database: Promise<IDBDatabase> | undefined

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('agentic-whiteboard:shared-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      database = undefined
      reject(request.error)
    }
  }))
}

export async function readSharedSceneDraft(boardId: string, uid: string): Promise<SharedSceneDraft | undefined> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).get(`${uid}:${boardId}`)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// Merge inside the transaction so another tab cannot overwrite a newer draft.
export async function saveSharedSceneDraft(boardId: string, uid: string, scene: BoardScene): Promise<SharedSceneDraft> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const key = `${uid}:${boardId}`
    let draft: SharedSceneDraft
    const request = store.get(key)
    request.onsuccess = () => {
      const previous = request.result as SharedSceneDraft | undefined
      draft = {
        key,
        revision: crypto.randomUUID(),
        scene: previous
          ? {
              ...scene,
              elements: reconcileElementsLWW(previous.scene.elements, scene.elements),
              files: { ...previous.scene.files, ...scene.files },
            }
          : scene,
      }
      store.put(draft)
    }
    transaction.oncomplete = () => resolve(draft)
    transaction.onerror = transaction.onabort = () => reject(transaction.error)
  })
}

// Acknowledging an older upload must never erase edits made while it was in flight.
export async function acknowledgeSharedSceneDraft(draft: SharedSceneDraft): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.get(draft.key)
    request.onsuccess = () => {
      if (request.result?.revision === draft.revision) store.delete(draft.key)
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = transaction.onabort = () => reject(transaction.error)
  })
}
