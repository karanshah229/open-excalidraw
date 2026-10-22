import { createHash, randomUUID } from 'node:crypto'
import { FieldPath, getFirestore, Timestamp, type DocumentData, type DocumentReference, type QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { planSceneMaintenance, type MaintenanceDocument, type SceneMaintenanceInput } from './scene-maintenance-planner.js'

const PAGE_SIZE = 200
const EVIDENCE_BATCH = 100
const CENSUS_READ_CONCURRENCY = 8
const MAX_CENSUS_DOCUMENTS = 10_000
const MAX_CENSUS_BYTES = 128 * 1024 * 1024
const MAX_DELETE_BATCH_BYTES = 6 * 1024 * 1024
const QUARANTINE_DELAY_MS = 48 * 60 * 60_000
const WORKER_LEASE_MS = 5 * 60_000

type Snapshot = QueryDocumentSnapshot<DocumentData>
type Census = {
  input: SceneMaintenanceInput
  evidence: { collection: string; id: string; updateTime: string; digest: string }[]
  count: number
  bytes: number
}

function sha256(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}
function payloadDigest(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
function startLeaseHeartbeat(
  controlRef: DocumentReference,
  jobRef: DocumentReference,
  jobId: string,
  epoch: number,
  token: string,
) {
  const db = getFirestore()
  let failure: unknown
  let stopped = false
  let pending: Promise<void> | null = null
  const renew = async () => {
    if (stopped) return
    if (pending) return pending
    pending = db.runTransaction(async (tx) => {
      const control = validControl((await tx.get(controlRef)).data()), job = (await tx.get(jobRef)).data()
      if (control.admission !== 'closed' || control.epoch !== epoch || control.jobId !== jobId || control.token !== token ||
          !job || job.status !== 'running' || job.epoch !== epoch || job.token !== token ||
          !(job.leaseUntil instanceof Timestamp) || job.leaseUntil.toMillis() <= Date.now())
        throw maintenanceFenceError()
      const leaseUntil = Timestamp.fromMillis(Date.now() + WORKER_LEASE_MS)
      tx.update(jobRef, { leaseUntil, heartbeatAt: Timestamp.now() })
      tx.update(controlRef, { leaseUntil, updatedAt: Timestamp.now() })
    }).then(() => undefined).finally(() => { pending = null })
    return pending
  }
  const timer = setInterval(() => { void renew().catch((error) => { failure = error }) }, 60_000)
  return {
    async check() {
      if (failure) throw failure
      await renew()
      if (failure) throw failure
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      if (pending) await pending.catch(() => undefined)
    },
  }
}
function maintenanceFenceError(): Error {
  const error = new Error('Scene maintenance fence changed.')
  error.name = 'SceneMaintenanceFenceError'
  return error
}
function validControl(data: DocumentData | undefined) {
  if (!data) return { admission: 'open' as const, epoch: 1 }
  if ((data.admission !== 'open' && data.admission !== 'closed') || !Number.isSafeInteger(data.epoch) || data.epoch < 1)
    throw new Error('Invalid maintenance control; refusing maintenance.')
  return data as { admission: 'open' | 'closed'; epoch: number; jobId?: string; token?: string; leaseUntil?: Timestamp }
}

async function readCollection(path: string, census: Census, mapper: (snapshot: Snapshot) => void) {
  const db = getFirestore(), ref = db.collection(path)
  let cursor: Snapshot | undefined
  while (true) {
    let query = ref.orderBy(FieldPath.documentId()).limit(PAGE_SIZE)
    if (cursor) query = query.startAfter(cursor)
    const page = await query.get()
    if (page.empty) return
    for (const snapshot of page.docs) {
      census.count++
      const data = snapshot.data()
      const bytes = Buffer.byteLength(JSON.stringify(data) ?? '', 'utf8')
      census.bytes += bytes
      if (census.count > MAX_CENSUS_DOCUMENTS || census.bytes > MAX_CENSUS_BYTES)
        throw new Error('Scene maintenance census limit exceeded; no destructive plan is available.')
      census.evidence.push({ collection: path, id: snapshot.id, updateTime: snapshot.updateTime.toDate().toISOString(), digest: sha256(data) })
      mapper(snapshot)
    }
    cursor = page.docs[page.docs.length - 1]
    if (page.size < PAGE_SIZE) return
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await map(items[index])
    }
  }))
  return results
}

async function readCensus(boardId: string, ownershipVerified: boolean): Promise<Census> {
  const db = getFirestore(), root = `boardScenes/${boardId}`
  const headSnapshot = await db.doc(root).get()
  const headData = headSnapshot.data()
  if (!headData) throw new Error('Board scene head is missing.')
  const census: Census = {
    input: { censusComplete: true, head: headData as SceneMaintenanceInput['head'], revisions: [], versions: [],
      readerPins: [], uploads: [], maintenanceJobs: [], chunks: [], ownershipVerified },
    evidence: [{ collection: 'head', id: boardId, updateTime: headSnapshot.updateTime?.toDate().toISOString() ?? '', digest: sha256(headData) }],
    count: 1,
    bytes: Buffer.byteLength(JSON.stringify(headData) ?? '', 'utf8'),
  }
  const revisions = new Map<string, { data: DocumentData; pages: MaintenanceDocument<{ references: unknown[] }>[] }>()
  await Promise.all([
    readCollection(`${root}/revisions`, census, (snapshot) => revisions.set(snapshot.id, { data: snapshot.data(), pages: [] })),
    readCollection(`${root}/versions`, census, (snapshot) => census.input.versions.push({ id: snapshot.id, data: snapshot.data() })),
    readCollection(`${root}/readerPins`, census, (snapshot) => census.input.readerPins.push({ id: snapshot.id, data: snapshot.data() })),
    readCollection(`${root}/uploads`, census, (snapshot) => census.input.uploads.push({ id: snapshot.id, data: snapshot.data() })),
    readCollection(`${root}/maintenanceJobs`, census, (snapshot) => census.input.maintenanceJobs.push({ id: snapshot.id, data: snapshot.data() })),
    readCollection(`${root}/chunks`, census, (snapshot) => census.input.chunks.push({ id: snapshot.id, data: snapshot.data() })),
  ])
  await mapWithConcurrency([...revisions.entries()], CENSUS_READ_CONCURRENCY, async ([revisionId, revision]) => {
    await readCollection(`${root}/revisions/${revisionId}/pages`, census, (snapshot) =>
      revision.pages.push({ id: snapshot.id, data: snapshot.data() as { references: unknown[] } }),
    )
  })
  census.input.revisions = [...revisions.entries()].map(([id, value]) => ({ id, data: value.data, pages: value.pages })) as SceneMaintenanceInput['revisions']
  return census
}

async function writeEvidencePages(
  boardId: string,
  jobId: string,
  epoch: number,
  token: string,
  entries: unknown[],
  group: 'censusPages' | 'quarantinePages' | 'deletePages',
) {
  const db = getFirestore(), root = `boardScenes/${boardId}`, jobRef = db.doc(`${root}/maintenanceJobs/${jobId}`), controlRef = db.doc(`${root}/maintenance/control`)
  let pageIndex = 0
  for (let start = 0; start < entries.length; start += EVIDENCE_BATCH, pageIndex++) {
    const page = entries.slice(start, start + EVIDENCE_BATCH)
    const pageRef = db.doc(`${root}/maintenanceJobs/${jobId}/${group}/${String(pageIndex).padStart(6, '0')}`)
    const active = await db.runTransaction(async (tx) => {
      const control = validControl((await tx.get(controlRef)).data()), job = (await tx.get(jobRef)).data()
      if (control.admission !== 'closed' || control.epoch !== epoch || control.jobId !== jobId || control.token !== token ||
          !job || !['running', 'lease-expired-awaiting-recovery'].includes(job.status) || job.epoch !== epoch || job.token !== token)
        throw maintenanceFenceError()
      if (!(job.leaseUntil instanceof Timestamp) || job.leaseUntil.toMillis() <= Date.now()) {
        if (job.status !== 'lease-expired-awaiting-recovery')
          tx.update(jobRef, { status: 'lease-expired-awaiting-recovery', leaseExpiredAt: Timestamp.now() })
        return false
      }
      const renewed = Timestamp.fromMillis(Date.now() + WORKER_LEASE_MS)
      if (!(await tx.get(pageRef)).exists) tx.create(pageRef, { epoch, token, index: pageIndex, entries: page, createdAt: Timestamp.now() })
      tx.update(jobRef, { leaseUntil: renewed, heartbeatAt: Timestamp.now() })
      tx.update(controlRef, { leaseUntil: renewed, updatedAt: Timestamp.now() })
      return true
    })
    if (!active) throw new Error('Scene maintenance worker lease expired; explicit recovery is required.')
  }
}

/**
 * Server-internal orphan quarantine proposal. It never deletes objects and is deliberately
 * not exported from the Functions entrypoint. Physical collection requires a later reviewed phase.
 */
export async function quarantineSceneOrphanChunks(boardId: string): Promise<{
  jobId: string
  epoch: number
  status: 'proposal-only' | 'blocked' | 'deferred-census-limit'
  candidateCount: number
  candidateBytes: number
  physicalDeletion: 'deferred'
  gateClosedDurationMs?: number
}> {
  const db = getFirestore(), root = `boardScenes/${boardId}`, headRef = db.doc(root), controlRef = db.doc(`${root}/maintenance/control`)
  const jobId = `gc_${randomUUID()}`, token = randomUUID(), jobRef = db.doc(`${root}/maintenanceJobs/${jobId}`)
  const startedAt = Date.now()
  const epoch = await db.runTransaction(async (tx) => {
    const controlData = (await tx.get(controlRef)).data(), head = (await tx.get(headRef)).data()
    if (!head) throw new Error('Cannot maintain a board without a scene head.')
    const control = validControl(controlData)
    if (control.admission === 'closed') throw new Error('Board admission is closed; explicit recovery is required.')
    const activeJobs = await tx.get(db.collection(`${root}/maintenanceJobs`).where('status', '==', 'running').limit(1))
    if (!activeJobs.empty) throw new Error('An Admin scene writer job is active; refuse to close admission.')
    const nextEpoch = control.epoch + 1
    tx.create(jobRef, { status: 'running', kind: 'orphan-quarantine', ownerId: head.ownerId, epoch: nextEpoch, token,
      leaseUntil: Timestamp.fromMillis(Date.now() + WORKER_LEASE_MS), protectedRevisionIds: [], protectedChunkIds: [],
      phase: 'census', createdAt: Timestamp.now(), policyVersion: 1 })
    const controlDataNext = { admission: 'closed', epoch: nextEpoch, jobId, token,
      leaseUntil: Timestamp.fromMillis(Date.now() + WORKER_LEASE_MS), phase: 'census', updatedAt: Timestamp.now() }
    if (controlData) tx.update(controlRef, controlDataNext)
    else tx.create(controlRef, controlDataNext)
    tx.update(headRef, { maintenanceAdmission: 'closed', maintenanceEpoch: nextEpoch })
    return nextEpoch
  })
  const gateClosedAt = Date.now()
  const heartbeat = startLeaseHeartbeat(controlRef, jobRef, jobId, epoch, token)

  const finishWithoutDelete = async (status: 'blocked' | 'deferred-census-limit', detail: string) => {
    await heartbeat.stop()
    const recovered = await db.runTransaction(async (tx) => {
      const control = validControl((await tx.get(controlRef)).data()), job = (await tx.get(jobRef)).data(), head = (await tx.get(headRef)).data()
      if (control.admission !== 'closed' || control.epoch !== epoch || control.jobId !== jobId || control.token !== token || !job)
        throw maintenanceFenceError()
      if (!head) throw maintenanceFenceError()
      if (!(job.leaseUntil instanceof Timestamp) || job.leaseUntil.toMillis() <= Date.now()) {
        if (job.status !== 'lease-expired-awaiting-recovery')
          tx.update(jobRef, { status: 'lease-expired-awaiting-recovery', leaseExpiredAt: Timestamp.now() })
        return false
      }
      tx.update(jobRef, { status: 'cancelled', outcome: status, detail, completedAt: Timestamp.now(), leaseUntil: null,
        gateClosedDurationMs: Date.now() - gateClosedAt })
      tx.update(controlRef, { admission: 'open', epoch, jobId: null, token: null, leaseUntil: null, phase: null, updatedAt: Timestamp.now() })
      tx.update(headRef, { maintenanceAdmission: 'open', maintenanceEpoch: epoch })
      return true
    })
    if (!recovered) throw new Error('Scene maintenance worker lease expired; explicit recovery is required.')
    return { jobId, epoch, status, candidateCount: 0, candidateBytes: 0,
      gateClosedDurationMs: Date.now() - gateClosedAt, physicalDeletion: 'deferred' as const }
  }

  try {
    const shareSnapshot = await db.doc(`boardShares/${boardId}`).get(), share = shareSnapshot.data()
    const currentHead = (await headRef.get()).data()
    if (!share || share.deletedAt || share.pending || share.active === false || !currentHead ||
        share.ownerId !== currentHead.ownerId || (share.projectId ?? null) !== (currentHead.projectId ?? null))
      return await finishWithoutDelete('blocked', 'Ownership binding could not be verified.')
    let ownershipVerified = true
    const projectId = share.projectId ?? null
    if (projectId) {
      const ownerId = String(share.ownerId)
      const [privateProject, privateBoard, projectShare] = await Promise.all([
        db.doc(`users/${ownerId}/projects/${projectId}`).get(),
        db.doc(`users/${ownerId}/projects/${projectId}/boards/${boardId}`).get(),
        db.doc(`projectShares/${projectId}`).get(),
      ])
      const projectData = privateProject.data(), boardData = privateBoard.data(), projectShareData = projectShare.data()
      ownershipVerified = Boolean(privateProject.exists && privateBoard.exists &&
        projectData?.ownerId === ownerId && !projectData.deletedAt && !projectData.pending && projectData.active !== false &&
        boardData?.active === true && !boardData.deletedAt && !boardData.pending &&
        (!projectShare.exists || (projectShareData?.ownerId === ownerId && !projectShareData.deletedAt &&
          !projectShareData.pending && projectShareData.active !== false)) && share.projectId === projectId)
    }
    await heartbeat.check()
    const census = await readCensus(boardId, ownershipVerified)
    await heartbeat.check()
    const plan = planSceneMaintenance(census.input, Date.now())
    await writeEvidencePages(boardId, jobId, epoch, token, census.evidence, 'censusPages')
    if (!plan.safeToCollect)
      return await finishWithoutDelete('blocked', `Fresh census was incomplete or invalid: ${plan.diagnostics.map((item) => item.code).join(',')}`)
    const quarantinedAt = Timestamp.now()
    const proposals = plan.candidateOrphans.map((candidate) => ({
      chunkId: candidate.id,
      uploadId: candidate.uploadId,
      bytes: candidate.bytes,
      digest: String(census.input.chunks.find((item) => item.id === candidate.id)?.data.digest ?? ''),
      slot: census.input.chunks.find((item) => item.id === candidate.id)?.data.slot,
      generation: census.input.chunks.find((item) => item.id === candidate.id)?.data.generation,
      uploaderUid: census.input.chunks.find((item) => item.id === candidate.id)?.data.uploaderUid,
      uploadGeneration: census.input.uploads.find((item) => item.id === candidate.uploadId)?.data.generation,
      uploadUploaderUid: census.input.uploads.find((item) => item.id === candidate.uploadId)?.data.uploaderUid,
      uploadSceneFormatVersion: census.input.uploads.find((item) => item.id === candidate.uploadId)?.data.sceneFormatVersion,
      uploadCandidateDigest: census.input.uploads.find((item) => item.id === candidate.uploadId)?.data.candidateDigest,
      expectedHeadRevisionId: census.input.uploads.find((item) => item.id === candidate.uploadId)?.data.expectedHeadRevisionId,
      uploadCreatedAt: census.input.uploads.find((item) => item.id === candidate.uploadId)?.data.createdAt,
      uploadExpiresAt: census.input.uploads.find((item) => item.id === candidate.uploadId)?.data.expiresAt,
      uploadNewChunkCount: census.input.uploads.find((item) => item.id === candidate.uploadId)?.data.newChunkCount,
      ageScreenEligibleAt: Timestamp.fromMillis(candidate.ageScreenEligibleAt),
      quarantinedAt,
      deleteNotBefore: Timestamp.fromMillis(quarantinedAt.toMillis() + QUARANTINE_DELAY_MS),
    }))
    await writeEvidencePages(boardId, jobId, epoch, token, proposals, 'quarantinePages')
    await heartbeat.stop()
    const completed = await db.runTransaction(async (tx) => {
      const control = validControl((await tx.get(controlRef)).data()), job = (await tx.get(jobRef)).data(), head = (await tx.get(headRef)).data()
      if (control.admission !== 'closed' || control.epoch !== epoch || control.jobId !== jobId || control.token !== token ||
          !job || job.epoch !== epoch || job.token !== token) throw maintenanceFenceError()
      if (!head) throw maintenanceFenceError()
      if (job.status !== 'running' || !(job.leaseUntil instanceof Timestamp) || job.leaseUntil.toMillis() <= Date.now()) {
        if (job.status === 'running') tx.update(jobRef, { status: 'lease-expired-awaiting-recovery', leaseExpiredAt: Timestamp.now() })
        return false
      }
      tx.update(jobRef, { status: 'complete', outcome: 'proposal-only', phase: 'physical-deletion-deferred', censusComplete: true,
        censusCount: census.count, censusBytes: census.bytes, censusDigest: sha256(census.evidence), candidateCount: proposals.length,
        candidateBytes: plan.candidateBytes, censusDurationMs: Date.now() - startedAt,
        gateClosedDurationMs: Date.now() - gateClosedAt,
        diagnostics: plan.diagnostics.map((item) => item.code), completedAt: Timestamp.now(), leaseUntil: null })
      tx.update(controlRef, { admission: 'open', epoch, jobId: null, token: null, leaseUntil: null, phase: null, updatedAt: Timestamp.now() })
      tx.update(headRef, { maintenanceAdmission: 'open', maintenanceEpoch: epoch })
      return true
    })
    if (!completed) throw new Error('Scene maintenance worker lease expired; explicit recovery is required.')
    return { jobId, epoch, status: 'proposal-only', candidateCount: proposals.length, candidateBytes: plan.candidateBytes,
      gateClosedDurationMs: Date.now() - gateClosedAt, physicalDeletion: 'deferred' }
  } catch (error) {
    // Failures and lease expiry intentionally leave the gate closed for explicit recovery.
    if (error instanceof Error && error.message.includes('census limit exceeded'))
      return await finishWithoutDelete('deferred-census-limit', error.message)
    throw error
  } finally {
    await heartbeat.stop()
  }
}

/** Explicit recovery for a crashed proposal-only run. This is safe only because this module never deletes objects. */
export async function recoverSceneMaintenanceProposal(boardId: string, jobId: string, expectedEpoch: number) {
  const db = getFirestore(), root = `boardScenes/${boardId}`, headRef = db.doc(root), controlRef = db.doc(`${root}/maintenance/control`)
  const jobRef = db.doc(`${root}/maintenanceJobs/${jobId}`)
  return db.runTransaction(async (tx) => {
    const control = validControl((await tx.get(controlRef)).data()), job = (await tx.get(jobRef)).data(), head = (await tx.get(headRef)).data()
    if (!job || job.kind === 'orphan-chunk-collection' || control.admission !== 'closed' || control.jobId !== jobId || control.epoch !== expectedEpoch ||
        job.epoch !== expectedEpoch || job.token !== control.token || !['running', 'lease-expired-awaiting-recovery'].includes(job.status))
      throw maintenanceFenceError()
    if (!(job.leaseUntil instanceof Timestamp) || job.leaseUntil.toMillis() > Date.now())
      throw new Error('Maintenance worker lease has not expired; recovery is not allowed.')
    tx.update(jobRef, { status: 'cancelled', outcome: 'abandoned-no-delete', recoveredAt: Timestamp.now(), leaseUntil: null,
      recovery: 'fenced-and-reopened; quarantine proposals are non-authoritative' })
    tx.update(controlRef, { admission: 'open', epoch: expectedEpoch + 1, jobId: null, token: null,
      leaseUntil: null, phase: null, updatedAt: Timestamp.now() })
    if (!head) throw maintenanceFenceError()
    tx.update(headRef, { maintenanceAdmission: 'open', maintenanceEpoch: expectedEpoch + 1 })
    return { recovered: true, newEpoch: expectedEpoch + 1 }
  })
}

/**
 * Internal-only physical collection. A proposal is merely a quarantine timer: this operation
 * closes admission again, takes a complete fresh census, persists that evidence, and then
 * rechecks every upload/chunk under the same epoch immediately before deleting chunks only.
 */
export async function collectQuarantinedOrphanChunks(boardId: string, sourceJobId: string, options: { allowSyntheticCanaryFastTrack?: boolean } = {}): Promise<{
  jobId: string
  epoch: number
  deletedChunkCount: number
  status: 'complete' | 'complete-noop' | 'blocked' | 'deferred-census-limit'
  gateClosedDurationMs?: number
  deleteBatchCount?: number
  deleteTransactionRetryCount?: number
  maxDeleteBatchDurationMs?: number
}> {
  const db = getFirestore(), root = `boardScenes/${boardId}`, headRef = db.doc(root)
  const controlRef = db.doc(`${root}/maintenance/control`), jobId = `collect_${randomUUID()}`
  const token = randomUUID(), jobRef = db.doc(`${root}/maintenanceJobs/${jobId}`), sourceRef = db.doc(`${root}/maintenanceJobs/${sourceJobId}`)
  const startedAt = Date.now()
  const requestedFastTrack = options.allowSyntheticCanaryFastTrack === true
  const epoch = await db.runTransaction(async (tx) => {
    const controlData = (await tx.get(controlRef)).data(), head = (await tx.get(headRef)).data()
    if (!head) throw new Error('Cannot maintain a board without a scene head.')
    if (requestedFastTrack && (!/^scene_maintenance_canary_[A-Za-z0-9_-]{8,120}$/.test(boardId) || head.sceneMaintenanceCanary !== true))
      throw new Error('Immediate collection is restricted to explicitly marked synthetic canary boards.')
    const control = validControl(controlData)
    if (control.admission !== 'open') throw new Error('Board admission is closed; explicit recovery is required.')
    const activeJobs = await tx.get(db.collection(`${root}/maintenanceJobs`).where('status', '==', 'running').limit(1))
    if (!activeJobs.empty) throw new Error('An Admin scene writer job is active; refuse to close admission.')
    const nextEpoch = control.epoch + 1
    tx.create(jobRef, { status: 'running', kind: 'orphan-chunk-collection', ownerId: head.ownerId, epoch: nextEpoch, token,
      leaseUntil: Timestamp.fromMillis(Date.now() + WORKER_LEASE_MS), protectedRevisionIds: [], protectedChunkIds: [],
      phase: 'fresh-census', sourceJobId, createdAt: Timestamp.now(), policyVersion: 1,
      syntheticCanaryFastTrack: requestedFastTrack })
    const nextControl = { admission: 'closed', epoch: nextEpoch, jobId, token,
      leaseUntil: Timestamp.fromMillis(Date.now() + WORKER_LEASE_MS), phase: 'fresh-census', updatedAt: Timestamp.now() }
    if (controlData) tx.update(controlRef, nextControl)
    else tx.create(controlRef, nextControl)
    tx.update(headRef, { maintenanceAdmission: 'closed', maintenanceEpoch: nextEpoch })
    return nextEpoch
  })
  const gateClosedAt = Date.now()
  const heartbeat = startLeaseHeartbeat(controlRef, jobRef, jobId, epoch, token)

  const finish = async (status: 'blocked' | 'deferred-census-limit' | 'complete-noop', detail: string) => {
    await heartbeat.stop()
    const reopened = await db.runTransaction(async (tx) => {
      const control = validControl((await tx.get(controlRef)).data()), job = (await tx.get(jobRef)).data(), head = (await tx.get(headRef)).data()
      if (control.admission !== 'closed' || control.epoch !== epoch || control.jobId !== jobId || control.token !== token || !job)
        throw maintenanceFenceError()
      if (!head) throw maintenanceFenceError()
      if (!(job.leaseUntil instanceof Timestamp) || job.leaseUntil.toMillis() <= Date.now()) {
        if (job.status !== 'lease-expired-awaiting-recovery') tx.update(jobRef, { status: 'lease-expired-awaiting-recovery', leaseExpiredAt: Timestamp.now() })
        return false
      }
      tx.update(jobRef, { status: status === 'complete-noop' ? 'complete' : 'cancelled', outcome: status, detail,
        deletedChunkCount: 0, completedAt: Timestamp.now(), leaseUntil: null,
        gateClosedDurationMs: Date.now() - gateClosedAt })
      tx.update(controlRef, { admission: 'open', epoch, jobId: null, token: null, leaseUntil: null, phase: null, updatedAt: Timestamp.now() })
      tx.update(headRef, { maintenanceAdmission: 'open', maintenanceEpoch: epoch })
      return true
    })
    if (!reopened) throw new Error('Scene maintenance worker lease expired; explicit recovery is required.')
    return { jobId, epoch, deletedChunkCount: 0, status, gateClosedDurationMs: Date.now() - gateClosedAt }
  }

  try {
    const source = (await sourceRef.get()).data()
    await heartbeat.check()
    if (!source || source.status !== 'complete' || source.outcome !== 'proposal-only' || source.censusComplete !== true ||
        source.ownerId !== (await headRef.get()).data()?.ownerId)
      return await finish('blocked', 'Source quarantine job is missing, incomplete, or has invalid ownership.')
    const sourcePages: { refPath: string; updateTime: string; digest: string; entries: Record<string, unknown>[] }[] = []
    const sourceEntries: Record<string, unknown>[] = []
    const sourceReceipts = new Map<string, { data: DocumentData; evidence: { collection: string; id: string; updateTime: string; digest: string } }>()
    let sourcePageBytes = 0
    const pageCollection = db.collection(`${root}/maintenanceJobs/${sourceJobId}/quarantinePages`)
    let pageCursor: Snapshot | undefined
    while (true) {
      let pageQuery = pageCollection.orderBy(FieldPath.documentId()).limit(PAGE_SIZE)
      if (pageCursor) pageQuery = pageQuery.startAfter(pageCursor)
      const pageSnaps = await pageQuery.get()
      if (pageSnaps.empty) break
      for (const page of pageSnaps.docs) {
        const data = page.data()
        sourcePageBytes += Buffer.byteLength(JSON.stringify(data) ?? '', 'utf8')
        if (sourcePages.length >= MAX_CENSUS_DOCUMENTS || sourcePageBytes > MAX_CENSUS_BYTES ||
            page.id !== String(sourcePages.length).padStart(6, '0') || data.epoch !== source.epoch || data.token !== source.token ||
            data.index !== sourcePages.length || !Array.isArray(data.entries) || data.entries.length > EVIDENCE_BATCH)
          return await finish('blocked', 'Source quarantine page metadata is malformed or exceeds the census limit.')
        const entries = data.entries as Record<string, unknown>[]
        for (const entry of entries) {
          if (!entry || typeof entry.chunkId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(entry.chunkId) ||
              typeof entry.uploadId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(entry.uploadId) ||
              typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.digest) ||
              typeof entry.slot !== 'number' || !Number.isSafeInteger(entry.slot) || entry.slot < 0 ||
              typeof entry.generation !== 'number' || !Number.isSafeInteger(entry.generation) || entry.generation < 1 ||
              typeof entry.uploaderUid !== 'string' || typeof entry.uploadCandidateDigest !== 'string' ||
              typeof entry.uploadGeneration !== 'number' || !Number.isSafeInteger(entry.uploadGeneration) || entry.uploadGeneration < 1 ||
              typeof entry.uploadUploaderUid !== 'string' || typeof entry.uploadSceneFormatVersion !== 'number' ||
              typeof entry.expectedHeadRevisionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(entry.expectedHeadRevisionId) ||
              !(entry.uploadCreatedAt instanceof Timestamp) ||
              !(entry.uploadExpiresAt instanceof Timestamp) || !(entry.ageScreenEligibleAt instanceof Timestamp) ||
              !(entry.quarantinedAt instanceof Timestamp) || !(entry.deleteNotBefore instanceof Timestamp) ||
              typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
              typeof entry.uploadNewChunkCount !== 'number' || !Number.isSafeInteger(entry.uploadNewChunkCount) ||
              entry.slot >= entry.uploadNewChunkCount || entry.uploadExpiresAt.toMillis() <= entry.uploadCreatedAt.toMillis() ||
              entry.deleteNotBefore.toMillis() !== entry.quarantinedAt.toMillis() + QUARANTINE_DELAY_MS)
            return await finish('blocked', 'Source quarantine entry lacks complete chunk ownership evidence.')
          sourceEntries.push(entry)
        }
        sourcePages.push({ refPath: page.ref.path, updateTime: page.updateTime.toDate().toISOString(), digest: sha256(data), entries })
      }
      pageCursor = pageSnaps.docs[pageSnaps.docs.length - 1]
      if (pageSnaps.size < PAGE_SIZE) break
    }
    if (!Number.isSafeInteger(source.candidateCount) || source.candidateCount < 0 || sourceEntries.length !== source.candidateCount)
      return await finish('blocked', 'Source quarantine proposal pages are incomplete.')
    const receiptCollection = db.collection(`${root}/maintenanceJobs/${sourceJobId}/collectionReceipts`)
    let receiptCursor: Snapshot | undefined
    while (true) {
      let receiptQuery = receiptCollection.orderBy(FieldPath.documentId()).limit(PAGE_SIZE)
      if (receiptCursor) receiptQuery = receiptQuery.startAfter(receiptCursor)
      const receiptPage = await receiptQuery.get()
      if (receiptPage.empty) break
      for (const receipt of receiptPage.docs) {
        sourcePageBytes += Buffer.byteLength(JSON.stringify(receipt.data()) ?? '', 'utf8')
        if (sourceReceipts.size >= MAX_CENSUS_DOCUMENTS || sourcePageBytes > MAX_CENSUS_BYTES)
          return await finish('blocked', 'Collection receipt census exceeds the configured safety limit.')
        const data = receipt.data()
        if (receipt.id !== data.chunkId || !/^[A-Za-z0-9_-]{1,160}$/.test(receipt.id) ||
            typeof data.uploadId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(data.uploadId) || typeof data.digest !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(data.digest) || typeof data.slot !== 'number' || !Number.isSafeInteger(data.slot) ||
            typeof data.generation !== 'number' || !Number.isSafeInteger(data.generation) || typeof data.uploaderUid !== 'string' ||
            data.sourceJobId !== sourceJobId)
          return await finish('blocked', 'Collection receipt is malformed.')
        sourceReceipts.set(receipt.id, { data, evidence: { collection: 'collectionReceipts', id: receipt.id,
          updateTime: receipt.updateTime.toDate().toISOString(), digest: sha256(data) } })
      }
      receiptCursor = receiptPage.docs[receiptPage.docs.length - 1]
      if (receiptPage.size < PAGE_SIZE) break
    }
    const sourceByChunkId = new Map(sourceEntries.map((entry) => [entry.chunkId as string, entry]))
    for (const [chunkId, receipt] of sourceReceipts) {
      const proposal = sourceByChunkId.get(chunkId)
      if (!proposal || receipt.data.uploadId !== proposal.uploadId || receipt.data.digest !== proposal.digest ||
          receipt.data.slot !== proposal.slot || receipt.data.generation !== proposal.generation ||
          receipt.data.uploaderUid !== proposal.uploaderUid)
        return await finish('blocked', 'Collection receipt does not match a durable quarantine proposal.')
    }
    if (source.candidateCount === 0) {
      if (sourceReceipts.size) return await finish('blocked', 'Zero-candidate quarantine unexpectedly has collection receipts.')
      return await finish('complete-noop', 'Quarantine has no orphan chunk candidates.')
    }

    const head = (await headRef.get()).data()!
    const shareSnap = await db.doc(`boardShares/${boardId}`).get(), share = shareSnap.data()
    if (!share || share.deletedAt || share.pending || share.active === false ||
        share.ownerId !== head.ownerId || (share.projectId ?? null) !== (head.projectId ?? null))
      return await finish('blocked', 'Board ownership binding could not be verified.')
    let ownershipVerified = true
    const projectId = share.projectId ?? null
    if (projectId) {
      const ownerId = String(share.ownerId)
      const [privateProject, privateBoard, projectShare] = await Promise.all([
        db.doc(`users/${ownerId}/projects/${projectId}`).get(),
        db.doc(`users/${ownerId}/projects/${projectId}/boards/${boardId}`).get(),
        db.doc(`projectShares/${projectId}`).get(),
      ])
      const projectData = privateProject.data(), boardData = privateBoard.data(), projectShareData = projectShare.data()
      ownershipVerified = Boolean(privateProject.exists && privateBoard.exists &&
        projectData?.ownerId === ownerId && !projectData.deletedAt && !projectData.pending && projectData.active !== false &&
        boardData?.active === true && !boardData.deletedAt && !boardData.pending &&
        (!projectShare.exists || (projectShareData?.ownerId === ownerId && !projectShareData.deletedAt &&
          !projectShareData.pending && projectShareData.active !== false)) && share.projectId === projectId)
    }
    await heartbeat.check()
    const census = await readCensus(boardId, ownershipVerified)
    await heartbeat.check()
    if (census.count + sourcePages.length + sourceReceipts.size > MAX_CENSUS_DOCUMENTS || census.bytes + sourcePageBytes > MAX_CENSUS_BYTES)
      return await finish('deferred-census-limit', 'Combined fresh census and quarantine evidence exceeds the configured safety limit.')
    census.evidence.push(...sourcePages.map((page) => ({ collection: 'quarantinePages', id: page.refPath, updateTime: page.updateTime, digest: page.digest })))
    census.evidence.push(...[...sourceReceipts.values()].map((receipt) => receipt.evidence))
    const plan = planSceneMaintenance(census.input, Date.now())
    await writeEvidencePages(boardId, jobId, epoch, token, census.evidence, 'censusPages')
    if (!plan.safeToCollect) return await finish('blocked', `Fresh census was incomplete or invalid: ${plan.diagnostics.map((item) => item.code).join(',')}`)
    const current = new Map(census.input.chunks.map((chunk) => [chunk.id, chunk]))
    const uploads = new Map(census.input.uploads.map((upload) => [upload.id, upload]))
    const candidateMap = new Map(plan.candidateOrphans.map((candidate) => [candidate.id, candidate]))
    const nowMs = Date.now()
    const approved = sourceEntries.filter((entry) => requestedFastTrack || (entry.deleteNotBefore as Timestamp).toMillis() <= nowMs)
    if (!approved.length) return await finish('blocked', 'No quarantine proposal has completed its durable delay.')
    const approvedIds = new Set<string>()
    const alreadyCollected = new Set<string>()
    for (const entry of approved) {
      const chunkId = entry.chunkId as string, uploadId = entry.uploadId as string
      const chunk = current.get(chunkId), upload = uploads.get(uploadId), candidate = candidateMap.get(chunkId)
      const receipt = sourceReceipts.get(chunkId)?.data
      if (approvedIds.has(chunkId) || !upload || upload.data.candidateDigest !== entry.uploadCandidateDigest ||
          upload.data.uploaderUid !== entry.uploadUploaderUid || upload.data.generation !== entry.uploadGeneration ||
          upload.data.sceneFormatVersion !== entry.uploadSceneFormatVersion || upload.data.newChunkCount !== entry.uploadNewChunkCount ||
          upload.data.expectedHeadRevisionId !== entry.expectedHeadRevisionId || upload.data.createdAt instanceof Timestamp === false ||
          (upload.data.createdAt as Timestamp).toMillis() !== (entry.uploadCreatedAt as Timestamp).toMillis() ||
          !(upload.data.expiresAt instanceof Timestamp) || upload.data.expiresAt.toMillis() !== (entry.uploadExpiresAt as Timestamp).toMillis() ||
          upload.data.status === 'committed' || upload.data.receipt !== undefined || upload.data.leaseId != null || upload.data.leaseUntil != null ||
          upload.data.expiresAt.toMillis() > nowMs) {
        return await finish('blocked', 'At least one quarantined chunk no longer matches the fresh orphan census.')
      }
      if (!chunk) {
        if (!receipt || receipt.uploadId !== uploadId || receipt.digest !== entry.digest || receipt.slot !== entry.slot ||
            receipt.generation !== entry.generation || receipt.uploaderUid !== entry.uploaderUid)
          return await finish('blocked', 'A missing quarantined chunk has no matching durable collection receipt.')
        alreadyCollected.add(chunkId)
        approvedIds.add(chunkId)
        continue
      }
      if (!candidate || candidate.uploadId !== uploadId || chunk.data.digest !== entry.digest || chunk.data.slot !== entry.slot ||
          chunk.data.generation !== entry.generation || chunk.data.uploaderUid !== entry.uploaderUid ||
          candidate.bytes !== entry.bytes || candidate.ageScreenEligibleAt > nowMs ||
          candidate.ageScreenEligibleAt !== (entry.ageScreenEligibleAt as Timestamp).toMillis() || receipt)
        return await finish('blocked', 'At least one quarantined chunk no longer matches the fresh orphan census.')
      approvedIds.add(chunkId)
    }
    const deleteEntries = approved.filter((entry) => !alreadyCollected.has(entry.chunkId as string))
    const deleteBatches: typeof deleteEntries[] = []
    let currentBatch: typeof deleteEntries = [], currentBatchBytes = 0
    for (const entry of deleteEntries) {
      const chunk = current.get(entry.chunkId as string)
      const upload = uploads.get(entry.uploadId as string)
      if (!chunk || !upload) return await finish('blocked', 'A candidate disappeared before deletion planning.')
      const bytes = Buffer.byteLength(JSON.stringify(chunk.data) ?? '', 'utf8') +
        Buffer.byteLength(JSON.stringify(upload.data) ?? '', 'utf8') + 512
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_DELETE_BATCH_BYTES)
        return await finish('blocked', 'A candidate exceeds the conservative Firestore deletion transaction byte limit.')
      if (currentBatch.length >= 48 || currentBatchBytes + bytes > MAX_DELETE_BATCH_BYTES) {
        deleteBatches.push(currentBatch)
        currentBatch = []
        currentBatchBytes = 0
      }
      currentBatch.push(entry)
      currentBatchBytes += bytes
    }
    if (currentBatch.length) deleteBatches.push(currentBatch)
    await writeEvidencePages(boardId, jobId, epoch, token, deleteEntries, 'deletePages')
    await db.runTransaction(async (tx) => {
      const control = validControl((await tx.get(controlRef)).data()), job = (await tx.get(jobRef)).data()
      if (control.admission !== 'closed' || control.epoch !== epoch || control.jobId !== jobId || control.token !== token ||
          !job || job.status !== 'running' || !(job.leaseUntil instanceof Timestamp) || job.leaseUntil.toMillis() <= Date.now())
        throw maintenanceFenceError()
      tx.update(jobRef, { phase: 'delete-ready', censusComplete: true, censusCount: census.count, censusBytes: census.bytes,
        censusDigest: sha256(census.evidence), deleteEvidenceDigest: sha256(deleteEntries), candidateCount: approved.length })
    })

    let deletedChunkCount = 0
    let deleteBatchCount = 0
    let deleteTransactionRetryCount = 0
    let maxDeleteBatchDurationMs = 0
    for (const batch of deleteBatches) {
      const batchStartedAt = Date.now()
      let transactionAttempts = 0
      const result = await db.runTransaction(async (tx) => {
        transactionAttempts++
        const control = validControl((await tx.get(controlRef)).data()), job = (await tx.get(jobRef)).data()
        if (control.admission !== 'closed' || control.epoch !== epoch || control.jobId !== jobId || control.token !== token ||
            !job || job.status !== 'running' || job.epoch !== epoch || job.token !== token) throw maintenanceFenceError()
        if (!(job.leaseUntil instanceof Timestamp) || job.leaseUntil.toMillis() <= Date.now()) {
          tx.update(jobRef, { status: 'lease-expired-awaiting-recovery', leaseExpiredAt: Timestamp.now() })
          return false
        }
        const refs = batch.map((entry) => ({
          entry,
          chunk: db.doc(`${root}/chunks/${entry.chunkId as string}`),
          upload: db.doc(`${root}/uploads/${entry.uploadId as string}`),
          receipt: db.doc(`${root}/maintenanceJobs/${sourceJobId}/collectionReceipts/${entry.chunkId as string}`),
        }))
        const snapshots = await Promise.all(refs.flatMap(({ chunk, upload, receipt }) => [tx.get(chunk), tx.get(upload), tx.get(receipt)]))
        let newlyDeleted = 0
        const chunksToDelete: DocumentReference[] = []
        for (let i = 0; i < refs.length; i++) {
          const { entry, receipt: receiptRef } = refs[i]
          const chunk = snapshots[i * 3].data(), upload = snapshots[i * 3 + 1].data(), receiptSnapshot = snapshots[i * 3 + 2]
          if (receiptSnapshot.exists) {
            const receipt = receiptSnapshot.data()
            if (chunk || receipt?.sourceJobId !== sourceJobId || receipt?.uploadId !== entry.uploadId ||
                receipt?.digest !== entry.digest || receipt?.slot !== entry.slot || receipt?.generation !== entry.generation ||
                receipt?.uploaderUid !== entry.uploaderUid)
              throw new Error('Durable collection receipt conflicts with the current chunk; refusing deletion.')
            continue
          }
          if (!chunk || !upload || typeof chunk.payload !== 'string' || payloadDigest(chunk.payload) !== chunk.digest ||
              chunk.kind !== 'records' || chunk.uploadId !== entry.uploadId || chunk.digest !== entry.digest || chunk.slot !== entry.slot ||
              chunk.generation !== entry.generation || chunk.uploaderUid !== entry.uploaderUid ||
              upload.uploaderUid !== entry.uploadUploaderUid || upload.generation !== entry.uploadGeneration ||
              upload.sceneFormatVersion !== entry.uploadSceneFormatVersion || upload.newChunkCount !== entry.uploadNewChunkCount ||
              upload.candidateDigest !== entry.uploadCandidateDigest || upload.expectedHeadRevisionId !== entry.expectedHeadRevisionId ||
              !(upload.createdAt instanceof Timestamp) || upload.createdAt.toMillis() !== (entry.uploadCreatedAt as Timestamp).toMillis() ||
              !(upload.expiresAt instanceof Timestamp) || upload.expiresAt.toMillis() !== (entry.uploadExpiresAt as Timestamp).toMillis() ||
              upload.expiresAt.toMillis() > Date.now() || upload.status === 'committed' || upload.receipt !== undefined ||
              upload.leaseId != null || upload.leaseUntil != null)
            throw new Error('Quarantined chunk changed after the fenced census; refusing deletion.')
          tx.create(receiptRef, { sourceJobId, chunkId: entry.chunkId, uploadId: entry.uploadId, digest: entry.digest,
            slot: entry.slot, generation: entry.generation, uploaderUid: entry.uploaderUid, deletedAt: Timestamp.now(), epoch, token })
          chunksToDelete.push(refs[i].chunk)
          newlyDeleted++
        }
        for (const chunk of chunksToDelete) tx.delete(chunk)
        const renewed = Timestamp.fromMillis(Date.now() + WORKER_LEASE_MS)
        const batchDurationMs = Date.now() - batchStartedAt
        tx.update(jobRef, {
          leaseUntil: renewed,
          heartbeatAt: Timestamp.now(),
          deletedChunkCount: (job.deletedChunkCount ?? 0) + newlyDeleted,
          deleteBatchCount: (job.deleteBatchCount ?? 0) + 1,
          deleteTransactionRetryCount: (job.deleteTransactionRetryCount ?? 0) + Math.max(0, transactionAttempts - 1),
          totalDeleteBatchDurationMs: (job.totalDeleteBatchDurationMs ?? 0) + batchDurationMs,
          maxDeleteBatchDurationMs: Math.max(job.maxDeleteBatchDurationMs ?? 0, batchDurationMs),
        })
        tx.update(controlRef, { leaseUntil: renewed, updatedAt: Timestamp.now() })
        return newlyDeleted
      })
      if (result === false) throw new Error('Scene maintenance worker lease expired; explicit recovery is required.')
      deletedChunkCount += result
      deleteBatchCount++
      deleteTransactionRetryCount += Math.max(0, transactionAttempts - 1)
      maxDeleteBatchDurationMs = Math.max(maxDeleteBatchDurationMs, Date.now() - batchStartedAt)
    }
    await heartbeat.stop()
    const complete = await db.runTransaction(async (tx) => {
      const control = validControl((await tx.get(controlRef)).data()), job = (await tx.get(jobRef)).data()
      if (control.admission !== 'closed' || control.epoch !== epoch || control.jobId !== jobId || control.token !== token || !job)
        throw maintenanceFenceError()
      if (!(job.leaseUntil instanceof Timestamp) || job.leaseUntil.toMillis() <= Date.now()) {
        tx.update(jobRef, { status: 'lease-expired-awaiting-recovery', leaseExpiredAt: Timestamp.now() })
        return false
      }
      tx.update(jobRef, { status: 'complete', outcome: 'orphan-chunks-collected', phase: 'complete', censusComplete: true,
        censusCount: census.count, censusBytes: census.bytes, censusDigest: sha256(census.evidence), candidateCount: approved.length,
        deletedChunkCount: deletedChunkCount + alreadyCollected.size, censusDurationMs: Date.now() - startedAt,
        syntheticCanaryFastTrack: requestedFastTrack,
        gateClosedDurationMs: Date.now() - gateClosedAt,
        deleteBatchCount: job.deleteBatchCount ?? deleteBatchCount,
        deleteTransactionRetryCount: job.deleteTransactionRetryCount ?? deleteTransactionRetryCount,
        totalDeleteBatchDurationMs: job.totalDeleteBatchDurationMs ?? 0,
        maxDeleteBatchDurationMs: job.maxDeleteBatchDurationMs ?? maxDeleteBatchDurationMs,
        completedAt: Timestamp.now(), leaseUntil: null })
      tx.update(controlRef, { admission: 'open', epoch, jobId: null, token: null, leaseUntil: null, phase: null, updatedAt: Timestamp.now() })
      tx.update(headRef, { maintenanceAdmission: 'open', maintenanceEpoch: epoch })
      return true
    })
    if (!complete) throw new Error('Scene maintenance worker lease expired; explicit recovery is required.')
    return { jobId, epoch, deletedChunkCount: deletedChunkCount + alreadyCollected.size, status: 'complete',
      gateClosedDurationMs: Date.now() - gateClosedAt, deleteBatchCount, deleteTransactionRetryCount, maxDeleteBatchDurationMs }
  } catch (error) {
    if (error instanceof Error && error.message.includes('census limit exceeded')) return await finish('deferred-census-limit', error.message)
    throw error
  } finally {
    await heartbeat.stop()
  }
}

/** Explicitly fences and reopens an expired collector. Any partial deletes were limited to its persisted orphan-only plan. */
export async function recoverAbandonedSceneChunkCollection(boardId: string, jobId: string, expectedEpoch: number) {
  const db = getFirestore(), root = `boardScenes/${boardId}`, controlRef = db.doc(`${root}/maintenance/control`)
  const headRef = db.doc(root), jobRef = db.doc(`${root}/maintenanceJobs/${jobId}`), replacementToken = randomUUID()
  return db.runTransaction(async (tx) => {
    const control = validControl((await tx.get(controlRef)).data()), head = (await tx.get(headRef)).data(), job = (await tx.get(jobRef)).data()
    if (!head || !job || control.admission !== 'closed' || control.jobId !== jobId || control.epoch !== expectedEpoch ||
        job.kind !== 'orphan-chunk-collection' || job.epoch !== expectedEpoch || job.token !== control.token ||
        !['running', 'lease-expired-awaiting-recovery'].includes(job.status) || job.ownerId !== head.ownerId)
      throw maintenanceFenceError()
    if (!(job.leaseUntil instanceof Timestamp) || job.leaseUntil.toMillis() > Date.now())
      throw new Error('Collection worker lease has not expired; recovery is not allowed.')
    if (job.phase === 'delete-ready' && (job.censusComplete !== true || typeof job.censusDigest !== 'string' ||
        typeof job.deleteEvidenceDigest !== 'string' || !Number.isSafeInteger(job.candidateCount)))
      throw new Error('Collection evidence is incomplete; admission remains closed for manual review.')
    const nextEpoch = expectedEpoch + 1
    tx.update(jobRef, { status: 'cancelled', outcome: 'recovered-partial-safe', previousToken: job.token,
      token: replacementToken, recoveredAt: Timestamp.now(), leaseUntil: null,
      recovery: 'epoch advanced; remaining chunks require a fresh quarantine and census' })
    tx.update(controlRef, { admission: 'open', epoch: nextEpoch, jobId: null, token: null,
      leaseUntil: null, phase: null, lastRecoveryAt: Timestamp.now(), updatedAt: Timestamp.now() })
    tx.update(headRef, { maintenanceAdmission: 'open', maintenanceEpoch: nextEpoch })
    return { recovered: true, newEpoch: nextEpoch, deletedChunkCount: job.deletedChunkCount ?? 0 }
  })
}

/** Fences a timed-out Admin BulkWriter and retains all declared output roots for future censuses. */
export async function recoverAbandonedSceneWriterJob(boardId: string, jobId: string, expectedEpoch: number) {
  const db = getFirestore(), root = `boardScenes/${boardId}`, controlRef = db.doc(`${root}/maintenance/control`)
  const headRef = db.doc(root), jobRef = db.doc(`${root}/maintenanceJobs/${jobId}`), replacementToken = randomUUID()
  return db.runTransaction(async (tx) => {
    const control = validControl((await tx.get(controlRef)).data()), head = (await tx.get(headRef)).data(), job = (await tx.get(jobRef)).data()
    if (!head || !job || control.admission !== 'open' || control.epoch !== expectedEpoch || job.epoch !== expectedEpoch ||
        job.status !== 'running' || !['bootstrap', 'checkpoint'].includes(job.kind)) throw maintenanceFenceError()
    if (!(job.leaseUntil instanceof Timestamp) || job.leaseUntil.toMillis() > Date.now())
      throw new Error('Admin writer job lease has not expired; recovery is not allowed.')
    if (job.ownerId !== head.ownerId || !Array.isArray(job.protectedRevisionIds) || !Array.isArray(job.protectedChunkIds))
      throw new Error('Admin writer job roots are malformed; recovery is not allowed.')
    const nextEpoch = expectedEpoch + 1
    tx.update(jobRef, { status: 'abandoned-protected', previousToken: job.token, token: replacementToken,
      fencedAt: Timestamp.now(), recovery: 'publication-fenced; declared roots remain protected' })
    tx.update(controlRef, { epoch: nextEpoch, lastRecoveryAt: Timestamp.now(), updatedAt: Timestamp.now() })
    tx.update(headRef, { maintenanceAdmission: 'open', maintenanceEpoch: nextEpoch })
    return { recovered: true, newEpoch: nextEpoch, protectedRevisionIds: job.protectedRevisionIds, protectedChunkIds: job.protectedChunkIds }
  })
}
