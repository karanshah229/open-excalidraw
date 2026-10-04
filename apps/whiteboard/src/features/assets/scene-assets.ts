import type { BoardFile, BoardScene } from '@agentic-whiteboard/storage'
import { projectCall } from '../sharing/project-service'

const uploads = new Map<string, Promise<void>>()
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Server authorization applies to every byte transfer; locators are not public URLs. */
export async function requestBoardAsset(input: {
  operation: 'stat' | 'upload' | 'read'
  storagePath: string
  projectId?: string
  dataURL?: string
  mimeType?: string
}): Promise<{ exists?: boolean; dataURL?: string }> {
  return projectCall('boardAsset', input)
}

/** Keep image bytes out of Firestore's size-limited scene documents. */
export async function storeSceneAssets(scene: BoardScene, assetRoot: string, projectId?: string): Promise<BoardScene> {
  if (!Object.keys(scene.files ?? {}).length) return scene
  const entries = await Promise.all(
    Object.entries(scene.files ?? {}).map(async ([id, file]) => {
      const storagePath = `${assetRoot}/${encodeURIComponent(id)}`
      // Publishing a board may retain its owner's private-root receipt. The
      // gateway authorizes that same object for recipients using current policy.
      const privateReceipt = /^users\/[^/]+\/boards\/([^/]+)\/assets\/([^/]+)$/.exec(file.storagePath ?? '')
      const sharedBoardId = /^boards\/([^/]+)\/assets$/.exec(assetRoot)?.[1]
      if (
        file.storagePath === storagePath ||
        (privateReceipt?.[1] === sharedBoardId && privateReceipt?.[2] === encodeURIComponent(id))
      ) {
        return [id, { ...file, dataURL: '' }] as const
      }
      // Excalidraw file IDs identify immutable content. Deduplicate concurrent saves.
      let upload = uploads.get(storagePath)
      if (!upload) {
        upload = (async () => {
          const { exists } = await requestBoardAsset({ operation: 'stat', storagePath, projectId })
          if (exists) return
          // Copying a synced private scene to a shared path can receive only
          // a locator. Existing destination objects need no bytes at all.
          const sourceFile = file.dataURL.startsWith('data:')
            ? file
            : (await restoreSceneAssets({ ...scene, files: { [id]: file } })).files![id]
          if (!sourceFile.dataURL.startsWith('data:')) throw new Error(`Image ${id} has no local file data.`)
          const blob = await (await fetch(sourceFile.dataURL)).blob()
          if (blob.size >= MAX_IMAGE_BYTES) throw new Error('Images must be smaller than 10 MB to sync.')
          await requestBoardAsset({
            operation: 'upload',
            storagePath,
            projectId,
            dataURL: sourceFile.dataURL,
            mimeType: file.mimeType,
          })
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
      const { dataURL } = await requestBoardAsset({ operation: 'read', storagePath: file.storagePath })
      if (!dataURL) throw new Error(`Image ${id} has no stored bytes.`)
      return [id, { ...file, dataURL } satisfies BoardFile] as const
    }),
  )
  return { ...scene, files: Object.fromEntries(entries) }
}
