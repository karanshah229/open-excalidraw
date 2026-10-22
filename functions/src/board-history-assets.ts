import { createHash, randomUUID } from 'node:crypto'
import { getFirestore, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { HttpsError } from 'firebase-functions/v2/https'
import { assertContentWritable } from './board-history-model.js'
import type { ScenePayload } from './scene-codec.js'

function assertAssetNamespace(boardId: string, storagePath: string, ownerId: string) {
  const prefixes = [`users/${ownerId}/boards/${boardId}/assets/`, `boards/${boardId}/assets/`]
  if (
    !prefixes.some(
      (prefix) => storagePath.startsWith(prefix) && /^[A-Za-z0-9_-]{1,160}$/.test(storagePath.slice(prefix.length)),
    )
  )
    throw new HttpsError('permission-denied', 'Asset belongs to another board.')
}
export const assetResourceId = (path: string) => createHash('sha256').update(path).digest('hex')
export async function reserveBoardAssetUpload(boardId: string, storagePath: string, generation: number, fence: number) {
  const db = getFirestore(),
    reservationId = randomUUID(),
    resourceRef = db.doc(`boardScenes/${boardId}/assetResources/${assetResourceId(storagePath)}`)
  await db.runTransaction(async (tx) => {
    const head = (await tx.get(db.doc(`boardScenes/${boardId}`))).data(),
      resource = (await tx.get(resourceRef)).data()
    if (!head) throw new HttpsError('not-found', 'Board not found.')
    assertAssetNamespace(boardId, storagePath, head.ownerId)
    assertContentWritable(head, generation, fence)
    if (resource?.state === 'deleting')
      throw new HttpsError('unavailable', 'This asset is being cleaned up. Retry the upload.')
    if (resource?.state === 'uploading' && resource.leaseUntil.toMillis() > Date.now())
      throw new HttpsError('unavailable', 'This image upload is already in progress.')
    tx.set(
      resourceRef,
      {
        storagePath,
        state: 'uploading',
        reservationId,
        leaseUntil: Timestamp.fromMillis(Date.now() + 120_000),
        createdAt: resource?.createdAt ?? Timestamp.now(),
      },
      { merge: true },
    )
  })
  return reservationId
}
export async function completeBoardAssetUpload(
  boardId: string,
  storagePath: string,
  reservationId: string,
  objectGeneration: string,
) {
  if (typeof objectGeneration !== 'string' || !/^[0-9]+$/.test(objectGeneration))
    throw new HttpsError('failed-precondition', 'An exact storage object generation is required.')
  const db = getFirestore(),
    ref = db.doc(`boardScenes/${boardId}/assetResources/${assetResourceId(storagePath)}`)
  await db.runTransaction(async (tx) => {
    const resource = (await tx.get(ref)).data()
    if (resource?.reservationId !== reservationId || resource.state === 'deleting')
      throw new HttpsError('aborted', 'Asset upload reservation was superseded.')
    tx.update(ref, { state: 'ready', objectGeneration, leaseUntil: null })
  })
}
export async function indexSceneAssets(boardId: string, revisionId: string, scene: ScenePayload) {
  const db = getFirestore(),
    resources: { id: string; objectGeneration: string }[] = []
  const head = (await db.doc(`boardScenes/${boardId}`).get()).data()
  if (!head) throw new HttpsError('not-found', 'Board not found.')
  for (const file of Object.values(scene.files ?? {}) as any[]) {
    if (!file.storagePath) continue
    assertAssetNamespace(boardId, file.storagePath, head.ownerId)
    const path = file.storagePath,
      id = assetResourceId(path),
      resourceRef = db.doc(`boardScenes/${boardId}/assetResources/${id}`)
    let resource = (await resourceRef.get()).data()
    if (!resource) {
      let metadata
      try {
        ;[metadata] = await getStorage().bucket().file(path).getMetadata()
      } catch {
        throw new HttpsError('failed-precondition', 'Upload all images before publishing this scene.')
      }
      await db.runTransaction(async (tx) => {
        const existing = (await tx.get(resourceRef)).data()
        if (!existing)
          tx.create(resourceRef, {
            storagePath: path,
            state: 'ready',
            objectGeneration: String(metadata.generation),
            createdAt: Timestamp.now(),
          })
      })
      resource = (await resourceRef.get()).data()!
    }
    if (
      resource.state !== 'ready' ||
      typeof resource.objectGeneration !== 'string' ||
      !/^[0-9]+$/.test(resource.objectGeneration)
    )
      throw new HttpsError('unavailable', 'Image upload or cleanup is in progress.')
    resources.push({ id, objectGeneration: resource.objectGeneration })
    await db.doc(`boardScenes/${boardId}/assetReferences/${id}/revisions/${revisionId}`).set({ storagePath: path })
  }
  return resources
}
export async function validateSceneAssetResources(
  tx: Transaction,
  boardId: string,
  resources: { id: string; objectGeneration: string }[],
) {
  if (!resources.length) return
  const db = getFirestore(),
    rows = await tx.getAll(
      ...resources.map((resource) => db.doc(`boardScenes/${boardId}/assetResources/${resource.id}`)),
    )
  rows.forEach((row, slot) => {
    const resource = row.data()
    if (resource?.state !== 'ready' || resource.objectGeneration !== resources[slot].objectGeneration)
      throw new HttpsError('aborted', 'An image resource changed during publication. Retry the save.')
  })
}
