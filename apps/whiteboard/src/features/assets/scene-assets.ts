import type { BoardFile, BoardScene } from '@agentic-whiteboard/storage'
import { getBytes, ref, uploadBytes } from 'firebase/storage'
import { getFirebaseStorage } from '../../lib/firebase'
import { cloudCall } from '../account/cloud-api'

const uploads = new Map<string, Promise<void>>()
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Keep image bytes out of Firestore's size-limited scene documents. */
export async function storeSceneAssets(scene: BoardScene, assetRoot: string): Promise<BoardScene> {
  if (!Object.keys(scene.files ?? {}).length) return scene
  const storage = getFirebaseStorage()
  if (!storage) throw new Error('Firebase Storage is required to sync image files.')
  const entries = await Promise.all(
    Object.entries(scene.files ?? {}).map(async ([id, file]) => {
      if (!file.dataURL.startsWith('data:')) throw new Error(`Image ${id} has no local file data.`)
      const storagePath = `${assetRoot}/${encodeURIComponent(id)}`
      // Excalidraw file IDs identify immutable content. Deduplicate concurrent saves.
      let upload = uploads.get(storagePath)
      if (!upload) {
        upload = (async () => {
          const blob = await (await fetch(file.dataURL)).blob()
          if (blob.size >= MAX_IMAGE_BYTES) throw new Error('Images must be smaller than 10 MB to sync.')
          const segments = assetRoot.split('/')
          const shared = segments[0] === 'boards'
          const boardId = shared ? segments[1] : segments[3]
          const reservation = await cloudCall<{ grantId: string; storagePath: string; uploaded: boolean }>('reserveCloudAsset', {
            boardId, fileId: id, bytes: blob.size, mimeType: file.mimeType, shared,
          })
          if (!reservation.uploaded) {
            await uploadBytes(ref(storage, reservation.storagePath), blob, { contentType: file.mimeType,
              customMetadata: { quotaGrant: reservation.grantId } })
            await cloudCall('confirmCloudAsset', { grantId: reservation.grantId })
          }
        })()
        uploads.set(storagePath, upload)
        upload.catch(() => uploads.delete(storagePath))
        // Bound bookkeeping for long-lived editor sessions.
        if (uploads.size > 256) uploads.delete(uploads.keys().next().value!)
      }
      await upload
      return [id, { ...file, dataURL: '', storagePath }] as const
    }),
  )
  return { ...scene, files: Object.fromEntries(entries) }
}

/** Download with Firebase authorization rather than exposing permanent download tokens. */
export async function restoreSceneAssets(scene: BoardScene, knownFiles: BoardScene['files'] = {}): Promise<BoardScene> {
  const entries = await Promise.all(
    Object.entries(scene.files ?? {}).map(async ([id, file]) => {
      if (file.dataURL || !file.storagePath) return [id, file] as const
      const known = knownFiles[id]
      // Reuse immutable image content during element-only snapshot updates.
      if (known?.dataURL && known.mimeType === file.mimeType) return [id, { ...file, dataURL: known.dataURL }] as const
      const storage = getFirebaseStorage()
      if (!storage) throw new Error('Firebase Storage is required to load image files.')
      const bytes = await getBytes(ref(storage, file.storagePath), MAX_IMAGE_BYTES)
      const dataURL = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(new Blob([bytes], { type: file.mimeType }))
      })
      return [id, { ...file, dataURL } satisfies BoardFile] as const
    }),
  )
  return { ...scene, files: Object.fromEntries(entries) }
}
