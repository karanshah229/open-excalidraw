import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { defineBoolean, defineString } from 'firebase-functions/params'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { canAccessAsset, isAssetParentActive, type AssetIdentity } from './asset-policy.js'

const region = defineString('SYNC_ACCESS_FUNCTION_REGION')
const enforceAppCheck = defineBoolean('ASSET_ENFORCE_APP_CHECK', { default: true })
const MAX_BYTES = 10 * 1024 * 1024
const ID = /^[A-Za-z0-9_-]{1,160}$/

async function locateBoard(ownerId: string, boardId: string, projectId?: string) {
  const db = getFirestore()
  const locationRef = db.doc(`boardAssetLocations/${boardId}`)
  const location = (await locationRef.get()).data()
  if (location && location.ownerId !== ownerId) throw new HttpsError('permission-denied', 'Board owner mismatch.')
  if (location && projectId && location.projectId !== projectId) {
    throw new HttpsError('permission-denied', 'Board project mismatch.')
  }
  let resolvedProject = location?.projectId ?? projectId
  if (!resolvedProject) {
    // One-time migration for descriptors written before the asset location index.
    const projects = await db.collection(`users/${ownerId}/projects`).get()
    for (const project of projects.docs) {
      if ((await project.ref.collection('boards').doc(boardId).get()).exists) {
        resolvedProject = project.id
        break
      }
    }
  }
  if (resolvedProject) {
    if (typeof resolvedProject !== 'string' || !ID.test(resolvedProject)) {
      throw new HttpsError('invalid-argument', 'Invalid project ID.')
    }
    const projectRef = db.doc(`users/${ownerId}/projects/${resolvedProject}`)
    const [project, board] = await Promise.all([projectRef.get(), projectRef.collection('boards').doc(boardId).get()])
    if (!isAssetParentActive(project.data()) || (board.exists && !isAssetParentActive(board.data()))) {
      throw new HttpsError('permission-denied', 'The board or project is deleted.')
    }
    // Bind the immutable board ID atomically; another owner cannot claim it.
    if (!location)
      await db.runTransaction(async (transaction) => {
        const current = (await transaction.get(locationRef)).data()
        if (current && (current.ownerId !== ownerId || current.projectId !== resolvedProject)) {
          throw new HttpsError('permission-denied', 'Board location mismatch.')
        }
        if (!current) transaction.create(locationRef, { ownerId, projectId: resolvedProject })
      })
    return { boardExists: board.exists }
  }
  return undefined
}

/** Image bytes are only served through live authorization; no download URL is issued. */
export const boardAsset = onCall(
  {
    region,
    enforceAppCheck: enforceAppCheck.value(),
    memory: '512MiB',
    timeoutSeconds: 60,
    maxInstances: 10,
    concurrency: 4,
  },
  async (request) => {
    const { storagePath, operation, projectId } = request.data ?? {}
    if (typeof storagePath !== 'string' || !['stat', 'upload', 'read'].includes(operation)) {
      throw new HttpsError('invalid-argument', 'A valid asset operation and path are required.')
    }
    const privatePath = /^users\/([^/]+)\/boards\/([^/]+)\/assets\/([^/]+)$/.exec(storagePath)
    const sharedPath = /^boards\/([^/]+)\/assets\/([^/]+)$/.exec(storagePath)
    const boardId = privatePath?.[2] ?? sharedPath?.[1]
    const fileId = privatePath?.[3] ?? sharedPath?.[2]
    if (!boardId || !fileId || !ID.test(boardId) || !ID.test(fileId)) {
      throw new HttpsError('invalid-argument', 'Invalid asset path.')
    }
    const identity = request.auth as AssetIdentity
    const db = getFirestore()
    const config = (await db.doc(`boardShares/${boardId}`).get()).data()
    const parentPolicy = config?.projectId
      ? (await db.doc(`projectShares/${config.projectId}`).get()).data()
      : undefined
    const sharedAllowed = Boolean(
      config &&
      typeof config.ownerId === 'string' &&
      ID.test(config.ownerId) &&
      canAccessAsset(config, identity, operation === 'upload', parentPolicy),
    )
    if (privatePath) {
      const ownerId = privatePath[1]
      if (!ID.test(ownerId)) throw new HttpsError('invalid-argument', 'Invalid owner ID.')
      // Initial project publication keeps the existing private-root descriptor.
      // Readers receive those bytes through the board's current sharing policy.
      // Only its owner may upload into the private namespace.
      if (config && (config.ownerId !== ownerId || !sharedAllowed)) {
        throw new HttpsError('permission-denied', 'Board access is required.')
      }
      if (identity?.uid !== ownerId && (operation === 'upload' || !sharedAllowed)) {
        throw new HttpsError('permission-denied', 'Board access is required.')
      }
      const location = await locateBoard(ownerId, boardId, projectId ?? config?.projectId ?? config?.sourceProjectId)
      if (!location || (!location.boardExists && operation === 'read')) {
        throw new HttpsError('permission-denied', 'Board was not found.')
      }
    } else {
      if (!sharedAllowed) throw new HttpsError('permission-denied', 'Board access is required.')
      const location = await locateBoard(config!.ownerId, boardId, config!.projectId ?? config!.sourceProjectId)
      if (location && !location.boardExists && (operation === 'read' || identity?.uid !== config!.ownerId)) {
        throw new HttpsError('permission-denied', 'Board was not found.')
      }
    }

    const file = getStorage().bucket().file(storagePath)
    let metadata
    try {
      ;[metadata] = await file.getMetadata()
    } catch (error) {
      if ((error as { code?: number }).code !== 404) throw error
    }
    const exists = Boolean(metadata)
    if (operation === 'stat') return { exists }
    if (operation === 'upload') {
      if (exists) return { exists: true }
      const { dataURL, mimeType } = request.data
      const match =
        typeof dataURL === 'string' && /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataURL)
      if (!match || match[1] !== mimeType) throw new HttpsError('invalid-argument', 'Valid image bytes are required.')
      const bytes = Buffer.from(match[2], 'base64')
      if (!bytes.length || bytes.length >= MAX_BYTES) {
        throw new HttpsError('invalid-argument', 'Images must be smaller than 10 MB.')
      }
      try {
        // GCS uploads do not mint Firebase download tokens. Never overwrite an
        // existing immutable file, including concurrent first uploads.
        await file.save(bytes, {
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { contentType: mimeType, cacheControl: 'private, no-store' },
        })
      } catch (error) {
        if ((error as { code?: number }).code !== 412) throw error
      }
      return { exists: true }
    }
    if (!metadata) throw new HttpsError('not-found', 'Image was not found.')
    if (Number(metadata.size) >= MAX_BYTES || !metadata.contentType?.startsWith('image/')) {
      throw new HttpsError('failed-precondition', 'Invalid stored image.')
    }
    const [bytes] = await file.download()
    return { dataURL: `data:${metadata.contentType};base64,${bytes.toString('base64')}` }
  },
)
