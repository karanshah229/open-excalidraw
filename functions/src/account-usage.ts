import { createHash } from 'node:crypto'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { getDatabase } from 'firebase-admin/database'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { onObjectDeleted, onObjectFinalized } from 'firebase-functions/v2/storage'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { defineString } from 'firebase-functions/params'
import { PLAN_LIMITS, complimentaryPlan, firestoreDocumentBytes, periodAt, type Limits } from './usage-policy.js'

const region = defineString('SYNC_ACCESS_FUNCTION_REGION')
const storageRegion = defineString('STORAGE_FUNCTION_REGION', { default: 'asia-south1' })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    )
  return value
}
const logicalSceneHash = (scene: any) =>
  hash(
    JSON.stringify(
      stableValue({
        elements: (scene?.elements ?? []).map(({ lastModifiedBy: _author, ...element }: any) => element),
        appState: scene?.appState ?? {},
        files: Object.keys(scene?.files ?? {}).sort(),
      }),
    ),
  )
const id = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new HttpsError('invalid-argument', `Invalid ${label}.`)
  }
  return value
}
const uid = (request: CallableRequest): string => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to use cloud features.')
  return request.auth.uid
}
export function quota(metric: string, limit: number, message: string): never {
  throw new HttpsError('resource-exhausted', message, { kind: 'quota', metric, limit })
}

export async function ownerPlan(ownerId: string) {
  const [user, config, entitlement] = await Promise.all([
    getAuth().getUser(ownerId),
    getFirestore().doc('adminConfig/complimentaryUsers').get(),
    getFirestore().doc(`accountEntitlements/${ownerId}`).get(),
  ])
  const complimentary = complimentaryPlan(user.email, user.emailVerified, config.data()?.emails ?? []) === 'pro'
  const manual =
    entitlement.data()?.plan === 'pro' &&
    entitlement.data()?.active === true &&
    (!entitlement.data()?.expiresAt || Number(entitlement.data()?.expiresAt) > Date.now())
  const plan = complimentary || manual ? 'pro' : 'free'
  return { plan, source: complimentary ? 'complimentary' : manual ? 'manual' : 'free', limits: PLAN_LIMITS[plan] }
}

// Operator circuit breaker is deliberately separate from delayed billing metrics.
async function mutationPolicy(ownerId: string) {
  const [entitlement, config] = await Promise.all([
    ownerPlan(ownerId),
    getFirestore().doc('adminConfig/freemiumPolicy').get(),
  ])
  if (entitlement.plan === 'free' && config.data()?.freeCloudPaused === true) {
    quota(
      'sharedPool',
      0,
      'Free cloud capacity is temporarily paused. Keep editing locally or export a backup; existing cloud boards are retained.',
    )
  }
  const configured = config.data()?.freeDailySaves
  const freeDailySaves = Number.isSafeInteger(configured) && configured > 0 ? configured : 2000
  return { ...entitlement, freeDailySaves }
}

export function canRead(data: any, userId: string, email: unknown): boolean {
  return (
    data.ownerId === userId ||
    data.generalAccess === 'anyone_with_link' ||
    (typeof email === 'string' && (data.invitedEmails ?? []).includes(email.toLowerCase()))
  )
}
function canEdit(data: any, userId: string, email: unknown): boolean {
  return (
    data.ownerId === userId ||
    (data.generalAccess === 'anyone_with_link' && data.generalRole === 'editor') ||
    (typeof email === 'string' && data.collaborators?.[email.toLowerCase()]?.role === 'editor')
  )
}

/** Runs once under a server lease; clients cannot race inventory with new cloud writes. */
export async function ensureUsage(ownerId: string) {
  const db = getFirestore()
  const ref = db.doc(`accountUsage/${ownerId}`)
  const existing = await ref.get()
  if (existing.data()?.initialized) return
  const lease = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref)
    if (snapshot.data()?.initialized) return false
    if (Number(snapshot.data()?.initializingUntil ?? 0) > Date.now()) {
      throw new HttpsError('unavailable', 'Your cloud usage is being initialized. Try again shortly.')
    }
    tx.set(ref, { initializingUntil: Date.now() + 120000 }, { merge: true })
    return true
  })
  if (!lease) return
  try {
    const [projects, shares] = await Promise.all([
      db.collection(`users/${ownerId}/projects`).get(),
      db.collection('boardShares').where('ownerId', '==', ownerId).get(),
    ])
    const privateGroups = await Promise.all(projects.docs.map((project) => project.ref.collection('boards').get()))
    const records = new Map<string, any>()
    let currentDocumentBytes = 0
    for (const board of privateGroups.flatMap((group) => group.docs)) {
      const bytes = firestoreDocumentBytes(board.ref.path, board.data())
      currentDocumentBytes += bytes
      records.set(board.id, { projectId: board.ref.parent.parent!.id, privateBytes: bytes, sharedBytes: 0 })
    }
    for (const board of shares.docs) {
      const bytes = firestoreDocumentBytes(board.ref.path, board.data())
      currentDocumentBytes += bytes
      records.set(board.id, { ...(records.get(board.id) ?? { privateBytes: 0 }), sharedBytes: bytes })
    }
    // A missing bucket is tolerated only for empty emulated projects; production fails closed.
    let assetBytes = 0
    const roots = [`users/${ownerId}/boards/`, ...shares.docs.map((board) => `boards/${board.id}/assets/`)]
    for (const prefix of roots) {
      let files
      try {
        ;[files] = await getStorage().bucket().getFiles({ prefix })
      } catch (error: any) {
        if (process.env.FIREBASE_STORAGE_EMULATOR_HOST && error.code === 404) continue
        throw error
      }
      for (const file of files) {
        if (!file.name.includes('/assets/')) continue
        const bytes = Number(file.metadata.size ?? 0)
        assetBytes += bytes
        await db.doc(`assetGrants/${hash(file.name)}`).set({
          ownerId,
          storagePath: file.name,
          bytes,
          state: 'complete',
          generation: String(file.metadata.generation ?? ''),
          expiresAt: 0,
        })
      }
    }
    // Inventory can exceed the historical batch limit; chunk it without publishing ready state early.
    const entries = [...records.entries()]
    for (let index = 0; index < entries.length; index += 400) {
      const batch = db.batch()
      for (const [boardId, record] of entries.slice(index, index + 400))
        batch.set(ref.collection('boards').doc(boardId), record)
      await batch.commit()
    }
    await ref.set(
      {
        initialized: true,
        initializingUntil: 0,
        boards: records.size,
        assetBytes,
        currentDocumentBytes,
        saves: 0,
        day: periodAt().day,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
  } catch (error) {
    await ref.set({ initializingUntil: 0 }, { merge: true })
    throw error
  }
}

async function summary(ownerId: string) {
  await ensureUsage(ownerId)
  const [entitlement, snapshot] = await Promise.all([
    ownerPlan(ownerId),
    getFirestore().doc(`accountUsage/${ownerId}`).get(),
  ])
  const data = snapshot.data() ?? {}
  const period = periodAt()
  return {
    ...entitlement,
    usage: {
      boards: Number(data.boards ?? 0),
      assetBytes: Number(data.assetBytes ?? 0),
      currentDocumentBytes: Number(data.currentDocumentBytes ?? 0),
      saves: data.day === period.day ? Number(data.saves ?? 0) : 0,
    },
    resetsAt: period.resetsAt,
    paymentsAvailable: false,
  }
}
export const getAccountUsage = onCall({ region }, async (request) => summary(uid(request)))

export const requestProAccess = onCall({ region }, async (request) => {
  const userId = uid(request),
    user = await getAuth().getUser(userId)
  if (!user.emailVerified || !user.email)
    throw new HttpsError('failed-precondition', 'Verify your email before requesting Pro access.')
  const ref = getFirestore().doc(`proAccessRequests/${userId}`)
  await getFirestore().runTransaction(async (tx) => {
    const existing = await tx.get(ref)
    if (!existing.exists)
      tx.create(ref, { email: user.email, status: 'requested', createdAt: FieldValue.serverTimestamp() })
  })
  return { requested: true }
})

function checkSize(path: string, data: Record<string, unknown>, limits: Limits) {
  let bytes: number
  try {
    bytes = firestoreDocumentBytes(path, data)
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid cloud document values.')
  }
  if (bytes > limits.documentBytes)
    quota(
      'documentBytes',
      limits.documentBytes,
      'This board is too large to save to the cloud. Split it into smaller boards or export a backup.',
    )
  return bytes
}
async function validateAssets(scene: any, ownerId: string, boardId: string) {
  if (!scene || !Array.isArray(scene.elements) || !scene.appState || typeof scene.appState !== 'object') {
    throw new HttpsError('invalid-argument', 'A scene with elements and appState is required.')
  }
  const files = Object.values(scene.files ?? {}) as any[]
  for (const file of files) {
    if (
      file.dataURL ||
      typeof file.storagePath !== 'string' ||
      !(
        file.storagePath.startsWith(`users/${ownerId}/boards/${boardId}/assets/`) ||
        file.storagePath.startsWith(`boards/${boardId}/assets/`)
      )
    ) {
      throw new HttpsError('invalid-argument', 'Images must be uploaded to this board before saving.')
    }
    const grant = await getFirestore()
      .doc(`assetGrants/${hash(file.storagePath)}`)
      .get()
    if (grant.data()?.ownerId !== ownerId || grant.data()?.state !== 'complete') {
      throw new HttpsError('failed-precondition', 'An image upload is not complete. Retry cloud sync.')
    }
  }
}

/** One endpoint owns private/shared mutation and accounting; direct scene writes are denied by rules. */
export const commitCloudBoard = onCall({ region }, async (request) => {
  const userId = uid(request)
  const mode = request.data?.mode
  if (!['private', 'share-config', 'shared-scene'].includes(mode))
    throw new HttpsError('invalid-argument', 'Invalid cloud operation.')
  const boardId = id(request.data?.boardId, 'board ID')
  const operationId = id(request.data?.operationId, 'operation ID')
  const db = getFirestore()
  const sharedRef = db.doc(`boardShares/${boardId}`)
  const share = await sharedRef.get()
  const shareData = share.data()
  let ownerId = userId
  let projectId: string | undefined
  let target = sharedRef
  if (mode === 'private') {
    projectId = id(request.data?.projectId, 'project ID')
    target = db.doc(`users/${userId}/projects/${projectId}/boards/${boardId}`)
  } else if (shareData) {
    ownerId = shareData.ownerId
    if (mode === 'share-config' ? ownerId !== userId : !canEdit(shareData, userId, request.auth!.token.email)) {
      throw new HttpsError('permission-denied', 'You cannot change this board.')
    }
  } else if (mode === 'shared-scene') {
    throw new HttpsError('not-found', 'This shared board no longer exists.')
  }
  await ensureUsage(ownerId)
  const { limits, plan, source, freeDailySaves } = await mutationPolicy(ownerId)
  const poolRef = db.doc(
    `projectUsage/${source === 'complimentary' ? 'complimentary' : plan === 'free' ? 'free' : 'pro'}`,
  )
  const usageRef = db.doc(`accountUsage/${ownerId}`)
  const recordRef = usageRef.collection('boards').doc(boardId)
  const operationRef = usageRef.collection('operations').doc(hash(`${userId}:${mode}:${boardId}:${operationId}`))
  const payload = request.data?.document
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new HttpsError('invalid-argument', 'Cloud document is required.')
  if (payload.scene) await validateAssets(payload.scene, ownerId, boardId)
  const result = await db.runTransaction(async (tx) => {
    const [current, usage, record, operation, currentShare, pool] = await Promise.all([
      tx.get(target),
      tx.get(usageRef),
      tx.get(recordRef),
      tx.get(operationRef),
      tx.get(sharedRef),
      tx.get(poolRef),
    ])
    if (operation.exists) return { committed: true, revision: operation.data()?.revision, duplicate: true }
    if (record.data()?.deleting) throw new HttpsError('failed-precondition', 'This cloud board is being deleted.')
    const existing = current.data()
    if (mode !== 'private') {
      const live = currentShare.data()
      if (
        live &&
        (live.ownerId !== ownerId ||
          (mode === 'share-config' ? ownerId !== userId : !canEdit(live, userId, request.auth!.token.email)))
      ) {
        throw new HttpsError('permission-denied', 'Your board access changed.')
      }
    }
    let data: any
    if (mode === 'private') {
      if (record.data()?.projectId && record.data()!.projectId !== projectId)
        throw new HttpsError(
          'failed-precondition',
          'A cloud board cannot be duplicated across projects with the same ID.',
        )
      if (currentShare.exists && currentShare.data()?.ownerId !== userId)
        throw new HttpsError('permission-denied', 'This board ID belongs to another owner.')
      if (payload.id !== boardId || payload.projectId !== projectId || typeof payload.active !== 'boolean') {
        throw new HttpsError('invalid-argument', 'Invalid board identity.')
      }
      if (existing && Number(existing.revision ?? 0) !== Number(request.data?.baseRevision ?? 0)) {
        // Client reconciles elements with this revision, then submits a new operation ID.
        throw new HttpsError('aborted', 'The cloud board changed. Reconcile and retry.', {
          kind: 'conflict',
          document: existing,
        })
      }
      data = { ...payload, syncStatus: 'synced', syncAttempts: 0, nextSyncAt: null, lastSyncError: null }
      delete data._cloudHash
      if (
        !Number.isSafeInteger(data.revision) ||
        data.revision < 0 ||
        (existing && data.revision <= existing.revision)
      ) {
        throw new HttpsError('invalid-argument', 'A newer board revision is required.')
      }
    } else if (mode === 'share-config') {
      const allowed = [
        'boardName',
        'ownerName',
        'ownerEmail',
        'ownerPhotoURL',
        'generalAccess',
        'generalRole',
        'invitedEmails',
        'collaborators',
      ]
      data = { ...(existing ?? {}), boardId, ownerId, createdAt: existing?.createdAt ?? new Date().toISOString() }
      for (const key of allowed) if (payload[key] !== undefined) data[key] = payload[key]
      if (
        !['restricted', 'anyone_with_link'].includes(data.generalAccess) ||
        !['viewer', 'editor'].includes(data.generalRole) ||
        !Array.isArray(data.invitedEmails) ||
        data.invitedEmails.length > 100 ||
        typeof data.collaborators !== 'object'
      ) {
        throw new HttpsError('invalid-argument', 'Invalid sharing settings.')
      }
      // Sharing metadata is established before uploads; an existing scene remains intact.
    } else {
      if (!existing) throw new HttpsError('not-found', 'This shared board no longer exists.')
      data = { ...existing, scene: payload.scene }
      if (typeof payload.boardName === 'string') data.boardName = payload.boardName
    }
    data.updatedAt = mode === 'private' ? payload.updatedAt : new Date().toISOString()
    const bytes = checkSize(target.path, data, limits)
    const state = usage.data() ?? {}
    const boardRecord = record.data() ?? {}
    const byteKey = mode === 'private' ? 'privateBytes' : 'sharedBytes'
    const hashKey = mode === 'private' ? 'privateHash' : 'sharedHash'
    const sceneHash = hash(JSON.stringify(data.scene ?? null))
    const logicalHash = logicalSceneHash(data.scene)
    const countsSave = mode !== 'share-config' && Boolean(data.scene) && boardRecord.logicalHash !== logicalHash
    const day = periodAt().day
    const saves = state.day === day ? Number(state.saves ?? 0) : 0
    const pooledSaves = pool.data()?.day === day ? Number(pool.data()?.saves ?? 0) : 0
    if (countsSave && plan === 'free' && pooledSaves >= freeDailySaves)
      quota(
        'sharedPool',
        freeDailySaves,
        'Today’s shared Free cloud capacity is used. Local editing and export remain available; capacity resets tomorrow (UTC).',
      )
    if (!record.exists && limits.boards !== null && Number(state.boards ?? 0) >= limits.boards) {
      quota(
        'boards',
        limits.boards,
        'Your cloud board allowance is full. Keep this board locally, delete a cloud board permanently, or view Pro.',
      )
    }
    if (countsSave && saves >= limits.dailySaves)
      quota(
        'saves',
        limits.dailySaves,
        'Today’s cloud save allowance is used. Local edits can continue; cloud sync resumes tomorrow (UTC).',
      )
    const totalBytes = Number(state.currentDocumentBytes ?? 0) - Number(boardRecord[byteKey] ?? 0) + bytes
    if (totalBytes > limits.currentDocumentBytes && totalBytes > Number(state.currentDocumentBytes ?? 0)) {
      quota('currentDocumentBytes', limits.currentDocumentBytes, 'Your cloud document storage allowance is full.')
    }
    tx.set(target, data)
    tx.set(recordRef, {
      ...boardRecord,
      [byteKey]: bytes,
      [hashKey]: sceneHash,
      ...(mode !== 'share-config' && data.scene ? { logicalHash } : {}),
      ...(projectId ? { projectId } : {}),
    })
    tx.set(
      usageRef,
      {
        boards: Number(state.boards ?? 0) + (record.exists ? 0 : 1),
        currentDocumentBytes: totalBytes,
        saves: saves + (countsSave ? 1 : 0),
        day,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    if (countsSave)
      tx.set(poolRef, { day, saves: pooledSaves + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    tx.create(operationRef, { revision: data.revision ?? 0, createdAt: Date.now() })
    return { committed: true, revision: data.revision ?? 0, duplicate: false }
  })
  return result
})

export const reserveCloudAsset = onCall({ region }, async (request) => {
  const userId = uid(request)
  const boardId = id(request.data?.boardId, 'board ID')
  const fileId = id(request.data?.fileId, 'file ID')
  const bytes = Number(request.data?.bytes)
  const mimeType = request.data?.mimeType
  if (
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    typeof mimeType !== 'string' ||
    !/^image\/[\w.+-]+$/.test(mimeType)
  ) {
    throw new HttpsError('invalid-argument', 'A valid image size and type are required.')
  }
  const shared = request.data?.shared === true
  let ownerId = userId
  if (shared) {
    const board = await getFirestore().doc(`boardShares/${boardId}`).get()
    if (!board.exists || !canEdit(board.data(), userId, request.auth!.token.email))
      throw new HttpsError('permission-denied', 'You cannot upload to this board.')
    ownerId = board.data()!.ownerId
  }
  await ensureUsage(ownerId)
  const { limits, plan } = await mutationPolicy(ownerId)
  if (bytes >= limits.imageBytes)
    quota('imageBytes', limits.imageBytes, 'This image is too large for your plan. Compress it or view Pro.')
  const storagePath = shared
    ? `boards/${boardId}/assets/${fileId}`
    : `users/${ownerId}/boards/${boardId}/assets/${fileId}`
  const grantId = hash(storagePath)
  const db = getFirestore()
  const grantRef = db.doc(`assetGrants/${grantId}`)
  const usageRef = db.doc(`accountUsage/${ownerId}`)
  await db.runTransaction(async (tx) => {
    const [grant, usage, boardRecord] = await Promise.all([
      tx.get(grantRef),
      tx.get(usageRef),
      tx.get(usageRef.collection('boards').doc(boardId)),
    ])
    if (boardRecord.data()?.deleting) throw new HttpsError('failed-precondition', 'This board is being deleted.')
    if (!boardRecord.exists && limits.boards !== null && Number(usage.data()?.boards ?? 0) >= limits.boards)
      quota(
        'boards',
        limits.boards,
        'Your cloud board allowance is full. Keep this board and its images locally or delete a cloud board permanently.',
      )
    if (grant.exists) {
      if (grant.data()?.ownerId !== ownerId || grant.data()?.bytes !== bytes)
        throw new HttpsError('already-exists', 'This immutable image ID is already used.')
      if (grant.data()?.state === 'complete') return
      if (grant.data()?.uploaderId !== userId)
        throw new HttpsError('unavailable', 'Another collaborator is uploading this image. Retry shortly.')
      tx.update(grantRef, { expiresAt: Date.now() + 600000 })
      return
    }
    if (Number(usage.data()?.assetBytes ?? 0) + bytes > limits.assetBytes)
      quota(
        'assetBytes',
        limits.assetBytes,
        'Your cloud image storage allowance is full. Permanently delete a cloud board to free image space, or view Pro.',
      )
    tx.create(grantRef, {
      ownerId,
      uploaderId: userId,
      boardId,
      storagePath,
      bytes,
      mimeType,
      state: 'reserved',
      expiresAt: Date.now() + 600000,
    })
    tx.update(usageRef, {
      assetBytes: Number(usage.data()?.assetBytes ?? 0) + bytes,
      updatedAt: FieldValue.serverTimestamp(),
    })
  })
  const grant = await grantRef.get()
  return {
    grantId,
    storagePath,
    uploaded: grant.data()?.state === 'complete',
    ...(plan === 'free' && bytes >= limits.imageBytes * 0.8
      ? {
          warning: {
            metric: 'imageBytes',
            kind: 'warning',
            message:
              'This image is close to the Free upload limit. Compress large images to leave room for future changes.',
          },
        }
      : {}),
  }
})

export const confirmCloudAsset = onCall({ region }, async (request) => {
  const userId = uid(request)
  const grantId = id(request.data?.grantId, 'upload grant')
  const ref = getFirestore().doc(`assetGrants/${grantId}`)
  const grant = await ref.get()
  if (
    !grant.exists ||
    !['reserved', 'complete'].includes(grant.data()?.state) ||
    (grant.data()?.uploaderId !== userId && grant.data()?.ownerId !== userId)
  )
    throw new HttpsError('permission-denied', 'Invalid upload grant.')
  const [metadata] = await getStorage().bucket().file(grant.data()!.storagePath).getMetadata()
  if (Number(metadata.size) !== grant.data()!.bytes || metadata.contentType !== grant.data()!.mimeType)
    throw new HttpsError('failed-precondition', 'Uploaded image does not match its reservation.')
  await ref.update({ state: 'complete', generation: String(metadata.generation), expiresAt: 0 })
  return { complete: true }
})

export const accountAssetFinalized = onObjectFinalized({ region: storageRegion }, async (event) => {
  if (!event.data.name) return
  const ref = getFirestore().doc(`assetGrants/${hash(event.data.name)}`)
  await getFirestore().runTransaction(async (tx) => {
    const grant = await tx.get(ref)
    if (
      !grant.exists ||
      grant.data()?.state === 'deleting' ||
      Number(event.data.size) !== grant.data()?.bytes ||
      event.data.contentType !== grant.data()?.mimeType
    )
      return
    tx.update(ref, { state: 'complete', generation: String(event.data.generation), expiresAt: 0 })
  })
})
export const accountAssetDeleted = onObjectDeleted({ region: storageRegion }, async (event) => {
  if (!event.data.name) return
  const db = getFirestore(),
    ref = db.doc(`assetGrants/${hash(event.data.name)}`)
  await db.runTransaction(async (tx) => {
    const grant = await tx.get(ref)
    if (!grant.exists || (grant.data()?.generation && grant.data()?.generation !== String(event.data.generation)))
      return
    const usageRef = db.doc(`accountUsage/${grant.data()!.ownerId}`)
    const usage = await tx.get(usageRef)
    tx.set(
      usageRef,
      { assetBytes: Math.max(0, Number(usage.data()?.assetBytes ?? 0) - Number(grant.data()?.bytes ?? 0)) },
      { merge: true },
    )
    tx.delete(ref)
  })
})

export const admitCloudSession = onCall({ region }, async (request) => {
  const userId = uid(request),
    boardId = id(request.data?.boardId, 'board ID'),
    sessionId = id(request.data?.sessionId, 'session ID')
  const board = await getFirestore().doc(`boardShares/${boardId}`).get()
  if (!board.exists || !canRead(board.data(), userId, request.auth!.token.email))
    throw new HttpsError('permission-denied', 'You cannot join this board.')
  const { limits, plan } = await mutationPolicy(board.data()!.ownerId)
  const ref = getDatabase().ref(`sessionGrants/${boardId}`)
  const now = Date.now(),
    expiresAt = now + 3600000
  let full = false
  const admission = await ref.transaction((current) => {
    const sessions = Object.fromEntries(
      Object.entries(current ?? {}).filter(([, value]: any) => value.expiresAt > now),
    ) as Record<string, any>
    if (sessions[sessionId] && sessions[sessionId].userId !== userId) return
    if (!sessions[sessionId] && Object.keys(sessions).length >= limits.sessions) {
      full = true
      return
    }
    sessions[sessionId] = { userId, expiresAt }
    return sessions
  })
  if (!admission.committed) {
    if (full)
      quota(
        'sessions',
        limits.sessions,
        'This board’s live collaboration allowance is full. View a snapshot or ask its owner about Pro.',
      )
    throw new HttpsError('permission-denied', 'This session ID belongs to another user.')
  }
  await getDatabase().ref(`liveUsers/${boardId}/${userId}`).set({ expiresAt })
  const sessionsUsed = admission.snapshot.numChildren()
  return {
    expiresAt,
    sessions: limits.sessions,
    sessionsUsed,
    ...(plan === 'free' && sessionsUsed === limits.sessions
      ? {
          warning: {
            metric: 'sessions',
            kind: 'warning',
            message:
              'All Free live session slots for this board are in use. Additional tabs must wait for a slot or ask the owner about Pro.',
          },
        }
      : {}),
  }
})

export const purgeCloudBoard = onCall({ region }, async (request) => {
  const ownerId = uid(request),
    boardId = id(request.data?.boardId, 'board ID')
  await ensureUsage(ownerId)
  const db = getFirestore(),
    usageRef = db.doc(`accountUsage/${ownerId}`),
    recordRef = usageRef.collection('boards').doc(boardId)
  const sharedRef = db.doc(`boardShares/${boardId}`),
    shared = await sharedRef.get()
  if (shared.exists && shared.data()?.ownerId !== ownerId)
    throw new HttpsError('permission-denied', 'Only the board owner can delete it.')
  await db.runTransaction(async (tx) => {
    const value = await tx.get(recordRef)
    if (!value.exists) {
      tx.create(recordRef, { deleting: true, orphan: true })
      return { orphan: true }
    }
    tx.update(recordRef, { deleting: true })
    return value.data()!
  })
  await getDatabase().ref(`boardAccess/${boardId}`).remove()
  const prefixes = [
    `users/${ownerId}/boards/${boardId}/assets/`,
    ...(shared.exists ? [`boards/${boardId}/assets/`, `boards/${boardId}/snapshots/`] : []),
  ]
  const ownerAssets = await db.collection('assetGrants').where('ownerId', '==', ownerId).get()
  const assets = ownerAssets.docs.filter((asset) =>
    prefixes.some((prefix) => asset.data().storagePath.startsWith(prefix)),
  )
  for (let offset = 0; offset < assets.length; offset += 400) {
    const batch = db.batch()
    assets.slice(offset, offset + 400).forEach((asset) => batch.set(asset.ref, { state: 'deleting' }, { merge: true }))
    await batch.commit()
  }
  for (const prefix of prefixes) await getStorage().bucket().deleteFiles({ prefix, force: true })
  // Refund only after objects are gone; deletion events may already have refunded them.
  for (const asset of assets)
    await db.runTransaction(async (tx) => {
      const [current, usage] = await Promise.all([tx.get(asset.ref), tx.get(usageRef)])
      if (!current.exists) return
      tx.update(usageRef, {
        assetBytes: Math.max(0, Number(usage.data()?.assetBytes ?? 0) - Number(current.data()?.bytes ?? 0)),
      })
      tx.delete(asset.ref)
    })
  if (shared.exists) await db.recursiveDelete(sharedRef)
  await getDatabase().ref(`sessionGrants/${boardId}`).remove()
  await getDatabase().ref(`liveUsers/${boardId}`).remove()
  await getDatabase().ref(`boards/${boardId}`).remove()
  await getDatabase().ref(`activeSessions/${boardId}`).remove()
  await getDatabase().ref(`presence/${boardId}`).remove()
  await db.runTransaction(async (tx) => {
    const [current, usage] = await Promise.all([tx.get(recordRef), tx.get(usageRef)])
    if (!current.exists) return
    if (current.data()?.projectId)
      tx.delete(db.doc(`users/${ownerId}/projects/${current.data()!.projectId}/boards/${boardId}`))
    tx.delete(recordRef)
    tx.update(usageRef, {
      boards: Math.max(0, Number(usage.data()?.boards ?? 0) - (current.data()?.orphan ? 0 : 1)),
      currentDocumentBytes: Math.max(
        0,
        Number(usage.data()?.currentDocumentBytes ?? 0) -
          Number(current.data()?.privateBytes ?? 0) -
          Number(current.data()?.sharedBytes ?? 0),
      ),
    })
  })
  return { deleted: true }
})

export const cleanUsageReservations = onSchedule({ region, schedule: 'every 60 minutes' }, async () => {
  const db = getFirestore()
  const pending = await db.collection('assetGrants').where('state', '==', 'reserved').get()
  for (const item of pending.docs) {
    if (Number(item.data().expiresAt) > Date.now()) continue
    const file = getStorage().bucket().file(item.data().storagePath)
    const [exists] = await file.exists()
    if (exists) {
      const [metadata] = await file.getMetadata()
      await item.ref.update({ state: 'complete', generation: String(metadata.generation), expiresAt: 0 })
      continue
    }
    await db.runTransaction(async (tx) => {
      const grant = await tx.get(item.ref)
      if (!grant.exists || grant.data()?.state !== 'reserved' || grant.data()!.expiresAt > Date.now()) return
      const usageRef = db.doc(`accountUsage/${grant.data()!.ownerId}`),
        usage = await tx.get(usageRef)
      tx.update(usageRef, { assetBytes: Math.max(0, Number(usage.data()?.assetBytes ?? 0) - grant.data()!.bytes) })
      tx.delete(item.ref)
    })
  }
  const accounts = await db.collection('accountUsage').get()
  for (const account of accounts.docs) {
    const old = await account.ref
      .collection('operations')
      .where('createdAt', '<', Date.now() - 7 * 86400000)
      .limit(400)
      .get()
    if (old.empty) continue
    const batch = db.batch()
    old.docs.forEach((item) => batch.delete(item.ref))
    await batch.commit()
  }
  for (const account of accounts.docs) await pruneRecoveryHistory(account.id)
})

function encodeFirestore(value: any, inArray = false): any {
  if (Array.isArray(value)) {
    const items = value.map((item) => encodeFirestore(item, true))
    return inArray ? { _agenticWhiteboardNestedArray: items } : items
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeFirestore(item)]))
  return value
}

export const commitCloudElements = onCall({ region }, async (request) => {
  const userId = uid(request),
    boardId = id(request.data?.boardId, 'board ID'),
    sessionId = id(request.data?.sessionId, 'session ID')
  const patches = request.data?.elements
  if (!Array.isArray(patches) || patches.length > 1000)
    throw new HttpsError('invalid-argument', 'Invalid element batch.')
  const [board, grant] = await Promise.all([
    getFirestore().doc(`boardShares/${boardId}`).get(),
    getDatabase().ref(`sessionGrants/${boardId}/${sessionId}`).get(),
  ])
  if (
    !board.exists ||
    !canEdit(board.data(), userId, request.auth!.token.email) ||
    grant.val()?.userId !== userId ||
    grant.val()?.expiresAt <= Date.now()
  )
    throw new HttpsError('permission-denied', 'A current editor session is required.')
  const { limits, plan, source, freeDailySaves } = await mutationPolicy(board.data()!.ownerId)
  const pool = await getFirestore()
    .doc(`projectUsage/${source === 'complimentary' ? 'complimentary' : plan === 'free' ? 'free' : 'pro'}`)
    .get()
  if (plan === 'free' && pool.data()?.day === periodAt().day && Number(pool.data()?.saves ?? 0) >= freeDailySaves)
    quota(
      'sharedPool',
      freeDailySaves,
      'Today’s shared Free cloud capacity is used. Keep editing locally; capacity resets tomorrow (UTC).',
    )
  await ensureUsage(board.data()!.ownerId)
  const usage = await getFirestore().doc(`accountUsage/${board.data()!.ownerId}`).get()
  if (usage.data()?.day === periodAt().day && Number(usage.data()?.saves ?? 0) >= limits.dailySaves)
    quota('saves', limits.dailySaves, 'Today’s cloud save allowance is used. Your changes remain on this device.')
  const records: Record<string, any> = {}
  for (const element of patches) {
    const elementId = id(element?.id, 'element ID')
    if (
      typeof element.type !== 'string' ||
      !['x', 'y', 'width', 'height', 'version', 'versionNonce'].every(
        (key) => typeof element[key] === 'number' && Number.isFinite(element[key]),
      )
    ) {
      throw new HttpsError('invalid-argument', 'Invalid drawing element.')
    }
    const data = JSON.stringify({ ...element, lastModifiedBy: userId })
    if (Buffer.byteLength(data, 'utf8') >= 262144)
      quota(
        'elementBytes',
        262144,
        'This drawing element is too large for live collaboration. It remains on this device.',
      )
    records[elementId] = {
      id: elementId,
      version: element.version,
      versionNonce: element.versionNonce,
      lastModifiedBy: userId,
      updatedAt: Date.now(),
      data,
    }
  }
  let tooLarge = false
  const result = await getDatabase()
    .ref(`boards/${boardId}/elements`)
    .transaction((current) => {
      const next = { ...(current ?? {}) }
      for (const [key, record] of Object.entries(records)) {
        const previous = next[key]
        if (
          !previous ||
          record.version > previous.version ||
          (record.version === previous.version && record.versionNonce <= previous.versionNonce)
        )
          next[key] = record
      }
      const elements = new Map<string, any>(
        (board.data()?.scene?.elements ?? []).map((element: any) => [element.id, element]),
      )
      for (const record of Object.values(next) as any[]) {
        const element = JSON.parse(record.data)
        const previous = elements.get(element.id)
        if (
          !previous ||
          element.version > previous.version ||
          (element.version === previous.version && element.versionNonce <= previous.versionNonce)
        )
          elements.set(element.id, element)
      }
      const candidate = {
        ...board.data(),
        scene: { ...board.data()?.scene, elements: encodeFirestore([...elements.values()]) },
      }
      if (firestoreDocumentBytes(board.ref.path, candidate) > limits.documentBytes) {
        tooLarge = true
        return
      }
      return next
    })
  if (!result.committed && tooLarge)
    quota(
      'documentBytes',
      limits.documentBytes,
      'This board has reached its cloud size allowance. Split it or export a backup.',
    )
  return { committed: result.committed }
})

export async function persistRecoveryScene(boardId: string, elements: any[]) {
  const db = getFirestore(),
    boardRef = db.doc(`boardShares/${boardId}`)
  const board = await boardRef.get()
  if (!board.exists) return
  const ownerId = board.data()!.ownerId
  await ensureUsage(ownerId)
  const { limits, plan, source, freeDailySaves } = await mutationPolicy(ownerId)
  const poolRef = db.doc(
    `projectUsage/${source === 'complimentary' ? 'complimentary' : plan === 'free' ? 'free' : 'pro'}`,
  )
  const usageRef = db.doc(`accountUsage/${ownerId}`),
    recordRef = usageRef.collection('boards').doc(boardId)
  await db.runTransaction(async (tx) => {
    const [current, usage, record, pool] = await Promise.all([
      tx.get(boardRef),
      tx.get(usageRef),
      tx.get(recordRef),
      tx.get(poolRef),
    ])
    if (!current.exists || record.data()?.deleting) return
    const data = current.data()!
    const revision = Number(data.snapshotRevision ?? 0) + 1
    const scene = { ...(data.scene ?? {}), elements: encodeFirestore(elements) }
    const updatedAt = new Date().toISOString()
    const next = { ...data, scene, snapshotRevision: revision, updatedAt }
    const bytes = checkSize(boardRef.path, next, limits)
    const total = Number(usage.data()?.currentDocumentBytes ?? 0) - Number(record.data()?.sharedBytes ?? 0) + bytes
    if (total > limits.currentDocumentBytes && total > Number(usage.data()?.currentDocumentBytes ?? 0))
      quota(
        'currentDocumentBytes',
        limits.currentDocumentBytes,
        'Cloud document storage is full; recovery deltas have been retained.',
      )
    tx.set(boardRef, next)
    tx.set(
      recordRef,
      { sharedBytes: bytes, sharedHash: hash(JSON.stringify(scene)), logicalHash: logicalSceneHash(scene) },
      { merge: true },
    )
    const day = periodAt().day,
      logicalHash = logicalSceneHash(scene)
    const countsSave = record.data()?.logicalHash !== logicalHash
    const saves = usage.data()?.day === day ? Number(usage.data()?.saves ?? 0) : 0
    const pooledSaves = pool.data()?.day === day ? Number(pool.data()?.saves ?? 0) : 0
    if (countsSave && saves >= limits.dailySaves)
      quota(
        'saves',
        limits.dailySaves,
        'Recovery is pending until the next cloud save period; live deltas have been retained.',
      )
    if (countsSave && plan === 'free' && pooledSaves >= freeDailySaves)
      quota('sharedPool', freeDailySaves, 'Free cloud capacity is full; live recovery deltas have been retained.')
    tx.update(usageRef, { currentDocumentBytes: total, day, saves: saves + (countsSave ? 1 : 0) })
    if (countsSave) tx.set(poolRef, { day, saves: pooledSaves + 1 }, { merge: true })
    tx.create(boardRef.collection('history').doc(String(revision).padStart(12, '0')), {
      revision,
      scene,
      ownerId,
      reason: 'abandoned-room-compaction',
      createdAt: updatedAt,
    })
  })
  await pruneRecoveryHistory(ownerId)
}

async function pruneRecoveryHistory(ownerId: string) {
  const db = getFirestore(),
    { limits } = await ownerPlan(ownerId)
  const boards = await db.collection('boardShares').where('ownerId', '==', ownerId).get()
  const histories = await Promise.all(
    boards.docs.map((board) => board.ref.collection('history').orderBy('createdAt', 'desc').get()),
  )
  const remove: FirebaseFirestore.QueryDocumentSnapshot[] = []
  const retained: { doc: FirebaseFirestore.QueryDocumentSnapshot; bytes: number }[] = []
  const expiry = Date.now() - limits.historyDays * 86400000
  for (const group of histories)
    group.docs.forEach((doc, index) => {
      if (index >= limits.historyCount || Date.parse(doc.data().createdAt) < expiry) remove.push(doc)
      else retained.push({ doc, bytes: firestoreDocumentBytes(doc.ref.path, doc.data()) })
    })
  retained.sort((a, b) => Date.parse(b.doc.data().createdAt) - Date.parse(a.doc.data().createdAt))
  let bytes = 0
  for (const item of retained) {
    if (bytes + item.bytes > limits.historyBytes) remove.push(item.doc)
    else bytes += item.bytes
  }
  for (let index = 0; index < remove.length; index += 400) {
    const batch = db.batch()
    remove.slice(index, index + 400).forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
  }
}
