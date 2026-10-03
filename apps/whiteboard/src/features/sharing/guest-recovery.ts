import type { BoardScene } from '@agentic-whiteboard/storage'

type Recovery = { scene: BoardScene; operationId: string }
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('whiteboard-shared-recovery', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('scenes')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function saveGuestRecovery(key: string, scene: BoardScene): Promise<string> {
  const db = await database(),
    operationId = crypto.randomUUID()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('scenes', 'readwrite')
      tx.objectStore('scenes').put({ scene, operationId } satisfies Recovery, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
  return operationId
}
export async function readGuestRecovery(key: string): Promise<Recovery | undefined> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('scenes').objectStore('scenes').get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}
export async function clearGuestRecovery(key: string, operationId: string): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('scenes', 'readwrite'),
        store = tx.objectStore('scenes'),
        request = store.get(key)
      request.onsuccess = () => {
        if (request.result?.operationId === operationId) store.delete(key)
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
