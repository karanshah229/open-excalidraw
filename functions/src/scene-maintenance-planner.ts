import { chunkDocumentBytes, SCENE_FORMAT_VERSION } from './scene-codec.js'
import { createHash } from 'node:crypto'

/** The planner intentionally accepts plain data so it can be used without Firebase or I/O. */
export type MaintenanceDocument<T extends Record<string, unknown> = Record<string, unknown>> = {
  id: string
  data: T
}

export type SceneMaintenanceHead = {
  headRevisionId: string | null
  generation: number
  sceneFormatVersion: number
  ownerId: string
  projectId: string | null
}

export type SceneMaintenanceRevision = MaintenanceDocument<{
  generation: number
  sceneFormatVersion: number
  pageCount: number
  chunkCount: number
  [key: string]: unknown
}> & {
  pages: MaintenanceDocument<{ references: unknown[] }>[]
}

export type SceneMaintenanceInput = {
  /** False unless every requested collection and subcollection was fully enumerated. */
  censusComplete: boolean
  head: SceneMaintenanceHead | null
  revisions: SceneMaintenanceRevision[]
  versions: MaintenanceDocument[]
  readerPins: MaintenanceDocument[]
  uploads: MaintenanceDocument[]
  maintenanceJobs: MaintenanceDocument[]
  chunks: MaintenanceDocument[]
  /** Must be explicitly recorded by the census caller when the board binding is verified. */
  ownershipVerified: boolean
  /** Dry-run age screen only; never persisted quarantine evidence or deletion authority. */
  ageScreenDelayMs?: number
}

export type SceneMaintenanceDiagnostic = {
  code: string
  message: string
  documentId?: string
  blocksCollection: boolean
}

export type SceneMaintenancePlan = {
  safeToCollect: boolean
  assetsPolicy: 'preserve-all'
  reachableChunks: { id: string; reasons: string[] }[]
  /** `ageScreenEligibleAt` is an expiry+delay filter only; it is not durable quarantine evidence. */
  candidateOrphans: { id: string; bytes: number; uploadId: string; ageScreenEligibleAt: number }[]
  candidateBytes: number
  preservedChunkIds: string[]
  unknownChunkIds: string[]
  diagnostics: SceneMaintenanceDiagnostic[]
}

// Dry-run age screen only. The collector must later persist its own quarantineAt
// and use a fresh fenced census before it can consider deleting anything.
const DEFAULT_AGE_SCREEN_DELAY_MS = 48 * 60 * 60 * 1000
const MAX_PAGES = 6
const MAX_PAGE_REFERENCES = 100
const MAX_CHUNKS = 512
const digestPattern = /^[a-f0-9]{64}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function timestampMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (isRecord(value) && typeof value.toMillis === 'function') {
    try {
      const parsed = (value.toMillis as () => unknown)()
      return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
}

function validPrincipal(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    ![...value].some((character) => character === '/' || character.charCodeAt(0) <= 0x1f)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function digestMatches(payload: string, expected: string): boolean {
  return createHash('sha256').update(payload, 'utf8').digest('hex') === expected.toLowerCase()
}

/**
 * Produces a read-only conservative plan. It never mutates input or storage.
 * Committed revision documents are all treated as roots during the initial rollout.
 * `expiresAt + age screen delay` is not a quarantine timestamp or deletion authority.
 */
export function planSceneMaintenance(input: SceneMaintenanceInput, now: number | Date): SceneMaintenancePlan {
  const nowMs = now instanceof Date ? now.getTime() : now
  const diagnostics: SceneMaintenanceDiagnostic[] = []
  const blocking = (code: string, message: string, documentId?: string) =>
    diagnostics.push({ code, message, ...(documentId ? { documentId } : {}), blocksCollection: true })
  const advisory = (code: string, message: string, documentId?: string) =>
    diagnostics.push({ code, message, ...(documentId ? { documentId } : {}), blocksCollection: false })

  if (!Number.isFinite(nowMs)) blocking('invalid-clock', 'Planner clock must be a finite timestamp.')
  if (!input.censusComplete) blocking('incomplete-census', 'At least one required collection was not fully enumerated.')
  if (!input.ownershipVerified) blocking('unverified-ownership', 'Board ownership and project binding were not verified.')
  const ageScreenDelayMs = input.ageScreenDelayMs ?? DEFAULT_AGE_SCREEN_DELAY_MS
  if (!Number.isFinite(ageScreenDelayMs) || ageScreenDelayMs < 0)
    blocking('invalid-age-screen-policy', 'Age-screen delay must be a finite nonnegative duration.')

  const revisions = new Map<string, SceneMaintenanceRevision>()
  for (const revision of input.revisions) {
    if (!validId(revision.id) || revisions.has(revision.id)) {
      blocking('invalid-revision-id', 'Revision identifier is invalid or duplicated.', revision.id)
      continue
    }
    revisions.set(revision.id, revision)
  }

  const reachable = new Map<string, Set<string>>()
  const referencesByChunk = new Map<string, { revisionId: string; generation: number; digest: string }[]>()
  const mark = (chunkId: string, reason: string) => {
    const reasons = reachable.get(chunkId) ?? new Set<string>()
    reasons.add(reason)
    reachable.set(chunkId, reasons)
  }

  if (!input.head || !validId(input.head.headRevisionId) || !Number.isSafeInteger(input.head.generation) || input.head.generation < 1 ||
      input.head.sceneFormatVersion !== SCENE_FORMAT_VERSION || !validPrincipal(input.head.ownerId) ||
      (input.head.projectId !== null && !validId(input.head.projectId))) {
    blocking('invalid-head', 'Head is missing, malformed, or uses an unsupported scene format.')
  } else if (!revisions.has(input.head.headRevisionId)) {
    blocking('missing-head-revision', 'The current head revision is absent from the complete revision census.', input.head.headRevisionId)
  } else {
    const currentRevision = revisions.get(input.head.headRevisionId)!
    if (currentRevision.data.generation !== input.head.generation ||
        currentRevision.data.sceneFormatVersion !== input.head.sceneFormatVersion)
      blocking('head-revision-mismatch', 'Head generation or format does not match its current revision.', input.head.headRevisionId)
  }

  for (const revision of revisions.values()) {
    const data = revision.data
    if (
      !Number.isSafeInteger(data.generation) || data.generation < 1 ||
      data.sceneFormatVersion !== SCENE_FORMAT_VERSION ||
      !Number.isSafeInteger(data.pageCount) || data.pageCount < 1 || data.pageCount > MAX_PAGES ||
      !Number.isSafeInteger(data.chunkCount) || data.chunkCount < 1 || data.chunkCount > MAX_CHUNKS ||
      typeof data.candidateDigest !== 'string' || !digestPattern.test(data.candidateDigest) ||
      !Array.isArray(revision.pages) || revision.pages.length !== data.pageCount
    ) {
      blocking('malformed-revision', 'Revision metadata or its page census is incomplete or unsupported.', revision.id)
      continue
    }
    const seenPages = new Set<string>()
    const seenChunks = new Set<string>()
    let invalid = false
    for (const page of revision.pages) {
      if (!validId(page.id) || seenPages.has(page.id) || !/^\d{6}$/.test(page.id)) {
        blocking('malformed-revision-page', 'Revision page identifier is invalid or duplicated.', `${revision.id}/${page.id}`)
        invalid = true
        continue
      }
      seenPages.add(page.id)
      const expectedPage = String(Number(page.id)).padStart(6, '0')
      if (expectedPage !== page.id || Number(page.id) >= data.pageCount || !Array.isArray(page.data?.references) ||
          page.data.references.length < 1 || page.data.references.length > MAX_PAGE_REFERENCES) {
        blocking('malformed-revision-page', 'Revision page references are malformed or out of bounds.', `${revision.id}/${page.id}`)
        invalid = true
        continue
      }
      for (const rawReference of page.data.references) {
        if (!isRecord(rawReference) || !validId(rawReference.chunkId) || typeof rawReference.digest !== 'string' || !digestPattern.test(rawReference.digest)) {
          blocking('malformed-chunk-reference', 'Revision contains an invalid chunk reference.', `${revision.id}/${page.id}`)
          invalid = true
          continue
        }
        if (seenChunks.has(rawReference.chunkId)) {
          blocking('duplicate-chunk-reference', 'Revision references one chunk more than once.', rawReference.chunkId)
          invalid = true
          continue
        }
        seenChunks.add(rawReference.chunkId)
        const references = referencesByChunk.get(rawReference.chunkId) ?? []
        references.push({ revisionId: revision.id, generation: data.generation, digest: rawReference.digest })
        referencesByChunk.set(rawReference.chunkId, references)
        mark(rawReference.chunkId, revision.id === input.head?.headRevisionId ? 'current-head' : 'revision')
      }
    }
    const expectedPageIds = Array.from({ length: data.pageCount }, (_, slot) => String(slot).padStart(6, '0'))
    if (invalid || seenChunks.size !== data.chunkCount || expectedPageIds.some((pageId) => !seenPages.has(pageId))) {
      if (!invalid) blocking('revision-chunk-count-mismatch', 'Revision reference count does not match its metadata.', revision.id)
      continue
    }
  }

  // Versions and pins are validated as durable roots even though the initial policy
  // already preserves every revision. Unknown references must never be ignored.
  for (const version of input.versions) {
    const revisionId = version.data.revisionId
    if (!validId(version.id) || !validId(revisionId) || !revisions.has(revisionId)) {
      blocking('unknown-version-root', 'Version has a malformed or missing revision target.', version.id)
      continue
    }
    const revision = revisions.get(revisionId)!
    for (const page of revision.pages ?? [])
      for (const reference of page.data?.references ?? [])
        if (isRecord(reference) && validId(reference.chunkId)) mark(reference.chunkId, `version:${version.id}`)
  }
  for (const pin of input.readerPins) {
    const revisionIds = pin.data.revisionIds
    const expiresAt = timestampMillis(pin.data.expiresAt)
    const createdAt = timestampMillis(pin.data.createdAt)
    const maxExpiresAt = timestampMillis(pin.data.maxExpiresAt)
    const pinGeneration = pin.data.generation
    if (!validId(pin.id) || !validPrincipal(pin.data.uid) || !validPrincipal(pin.data.ownerId) || pin.data.ownerId !== input.head?.ownerId ||
        !isInteger(pinGeneration) || pinGeneration < 1 || expiresAt === null || createdAt === null || maxExpiresAt === null ||
        maxExpiresAt <= createdAt || maxExpiresAt - createdAt > 30 * 60_000 || expiresAt > maxExpiresAt ||
        !Array.isArray(revisionIds) || revisionIds.length < 1 || revisionIds.length > 20 ||
        revisionIds.some((revisionId) => !validId(revisionId) || !revisions.has(revisionId))) {
      blocking('unknown-reader-pin-root', 'Reader pin has malformed or missing revision targets.', pin.id)
      continue
    }
    const targets = (revisionIds as string[]).map((revisionId) => revisions.get(revisionId)!)
    if (targets.some((revision) => revision.data.generation !== pinGeneration ||
        revision.data.sceneFormatVersion !== SCENE_FORMAT_VERSION)) {
      blocking('reader-pin-generation-mismatch', 'Reader pin generation or format does not match its revision targets.', pin.id)
      continue
    }
    if (expiresAt <= nowMs || maxExpiresAt <= nowMs) {
      advisory('expired-reader-pin', 'Well-formed reader pin has expired and is ignored as a root.', pin.id)
      continue
    }
    for (const revisionId of revisionIds as string[]) {
      const revision = revisions.get(revisionId)!
      for (const page of revision.pages ?? [])
        for (const reference of page.data?.references ?? [])
          if (isRecord(reference) && validId(reference.chunkId)) mark(reference.chunkId, `reader-pin:${pin.id}`)
    }
  }

  for (const job of input.maintenanceJobs) {
    if (!validId(job.id)) {
      blocking('invalid-maintenance-job-id', 'Maintenance job identifier is invalid.', job.id)
      continue
    }
    const status = job.data.status
    if (status === 'complete' || status === 'cancelled') continue
    const revisionIds = job.data.protectedRevisionIds
    const chunkIds = job.data.protectedChunkIds
    const leaseUntil = timestampMillis(job.data.leaseUntil)
    if (!Array.isArray(revisionIds) || !Array.isArray(chunkIds) ||
        revisionIds.some((revisionId) => !validId(revisionId) || !revisions.has(revisionId)) ||
        chunkIds.some((chunkId) => !validId(chunkId)) || leaseUntil === null ||
        !validPrincipal(job.data.ownerId) || job.data.ownerId !== input.head?.ownerId) {
      blocking('unknown-maintenance-job-roots', 'Active job has malformed ownership, lease, or protected roots.', job.id)
      continue
    }
    for (const revisionId of revisionIds as string[]) {
      const revision = revisions.get(revisionId)!
      for (const page of revision.pages ?? [])
        for (const reference of page.data?.references ?? [])
          if (isRecord(reference) && validId(reference.chunkId)) mark(reference.chunkId, `job:${job.id}`)
    }
    for (const chunkId of chunkIds as string[]) mark(chunkId, `job:${job.id}`)
    if (leaseUntil <= nowMs) advisory('expired-maintenance-job', 'Job lease has expired; roots remain conservatively protected pending recovery.', job.id)
  }

  const chunks = new Map<string, MaintenanceDocument>()
  for (const chunk of input.chunks) {
    if (!validId(chunk.id) || chunks.has(chunk.id)) {
      blocking('invalid-chunk-id', 'Chunk identifier is invalid or duplicated.', chunk.id)
      continue
    }
    chunks.set(chunk.id, chunk)
  }

  for (const [chunkId, reasons] of reachable) {
    const chunk = chunks.get(chunkId)
    if (!chunk) {
      blocking('missing-referenced-chunk', 'A protected revision references a chunk absent from the census.', chunkId)
      continue
    }
    const data = chunk.data
    if (typeof data.payload !== 'string' || typeof data.digest !== 'string' || !digestPattern.test(data.digest) ||
        !digestMatches(data.payload, data.digest) || !isInteger(data.generation) || data.generation < 1 ||
        !validId(data.uploadId) || !validPrincipal(data.uploaderUid) ||
        !isInteger(data.slot) || data.slot < 0 || data.kind !== 'records') {
      blocking('malformed-reachable-chunk', 'A protected chunk has malformed content or provenance.', chunkId)
      continue
    }
    if (input.head && data.generation !== input.head.generation && reasons.has('current-head'))
      blocking('head-generation-mismatch', 'Current head references a chunk from another generation.', chunkId)
    for (const reference of referencesByChunk.get(chunkId) ?? []) {
      if (data.generation !== reference.generation || data.digest !== reference.digest)
        blocking('revision-chunk-mismatch', 'Chunk generation or digest does not match its protected revision.', chunkId)
    }
  }

  const uploads = new Map<string, MaintenanceDocument>()
  for (const upload of input.uploads) {
    if (!validId(upload.id) || uploads.has(upload.id)) {
      blocking('invalid-upload-id', 'Upload identifier is invalid or duplicated.', upload.id)
      continue
    }
    const data = upload.data
    const createdAt = timestampMillis(data.createdAt)
    const expiresAt = timestampMillis(data.expiresAt)
    if (!validPrincipal(data.uploaderUid) || !validId(data.expectedHeadRevisionId) ||
        !isInteger(data.generation) || data.generation < 1 ||
        data.sceneFormatVersion !== SCENE_FORMAT_VERSION ||
        !isInteger(data.pageCount) || data.pageCount < 1 || data.pageCount > MAX_PAGES ||
        !isInteger(data.chunkCount) || data.chunkCount < 1 || data.chunkCount > MAX_CHUNKS ||
        !isInteger(data.newChunkCount) || data.newChunkCount < 0 || data.newChunkCount > data.chunkCount ||
        typeof data.candidateDigest !== 'string' || !digestPattern.test(data.candidateDigest) ||
        createdAt === null || expiresAt === null || expiresAt <= createdAt ||
        (data.leaseUntil != null && timestampMillis(data.leaseUntil) === null) ||
        (data.leaseId != null && (typeof data.leaseId !== 'string' || data.leaseId.length === 0)) ||
        ((data.leaseId == null) !== (data.leaseUntil == null)) ||
        (data.status != null && data.status !== 'committed') ||
        ((data.status === 'committed') !== (data.receipt !== undefined))) {
      blocking('malformed-upload-provenance', 'Upload metadata is incomplete or invalid.', upload.id)
      continue
    }
    if (!revisions.has(data.expectedHeadRevisionId) ||
        revisions.get(data.expectedHeadRevisionId)!.data.generation !== data.generation) {
      blocking('unknown-upload-base', 'Upload base revision is missing or belongs to another generation.', upload.id)
      continue
    }
    if (data.status === 'committed') {
      const receipt = data.receipt
      if (!isRecord(receipt)) {
        blocking('invalid-committed-receipt', 'Committed upload receipt is malformed.', upload.id)
        continue
      }
      const receiptRevisionId = receipt.revisionId
      const receiptRevision = validId(receiptRevisionId) ? revisions.get(receiptRevisionId) : undefined
      if (!receiptRevision || receiptRevisionId !== upload.id ||
          !isInteger(receipt.generation) || receipt.generation !== data.generation ||
          typeof receipt.candidateDigest !== 'string' || receipt.candidateDigest !== data.candidateDigest ||
          receiptRevision.data.generation !== receipt.generation ||
          receiptRevision.data.candidateDigest !== receipt.candidateDigest) {
        blocking('invalid-committed-receipt', 'Committed upload receipt does not resolve to its valid revision.', upload.id)
        continue
      }
    }
    uploads.set(upload.id, upload)
  }

  const slotsByUpload = new Map<string, Set<number>>()
  const unknownChunkIds = new Set<string>()
  const candidateOrphans: SceneMaintenancePlan['candidateOrphans'] = []
  const preservedChunkIds = new Set<string>()
  const allIds = new Set([...chunks.keys(), ...reachable.keys()])
  const referencedByAnyRevision = new Set(reachable.keys())

  for (const chunkId of allIds) {
    const chunk = chunks.get(chunkId)
    if (!chunk) {
      unknownChunkIds.add(chunkId)
      continue
    }
    const data = chunk.data
    if (referencedByAnyRevision.has(chunkId)) {
      preservedChunkIds.add(chunkId)
      continue
    }
    const uploadId = data.uploadId
    const upload = typeof uploadId === 'string' ? uploads.get(uploadId) : undefined
    const slot = data.slot
    const newChunkCount = upload?.data.newChunkCount
    if (typeof uploadId !== 'string' || !upload || data.uploaderUid !== upload.data.uploaderUid || data.generation !== upload.data.generation ||
        !isInteger(slot) || slot < 0 || !isInteger(newChunkCount) || slot >= newChunkCount) {
      unknownChunkIds.add(chunkId)
      blocking('unknown-chunk-provenance', 'Unreferenced chunk cannot be proven to belong to a valid upload.', chunkId)
      continue
    }
    const slots = slotsByUpload.get(uploadId) ?? new Set<number>()
    if (slots.has(slot)) {
      unknownChunkIds.add(chunkId)
      blocking('duplicate-upload-slot', 'Two chunks claim the same upload slot.', uploadId)
      continue
    }
    slots.add(slot)
    slotsByUpload.set(uploadId, slots)

    const expiresAt = timestampMillis(upload.data.expiresAt)!
    const ageScreenEligibleAt = expiresAt + ageScreenDelayMs
    const leaseUntil = timestampMillis(upload.data.leaseUntil)
    const isCommitted = upload.data.status === 'committed' || upload.data.receipt !== undefined
    const payload = data.payload
    if (typeof payload !== 'string' || typeof data.digest !== 'string' ||
        !digestPattern.test(data.digest) || !digestMatches(payload, data.digest) || data.kind !== 'records') {
      unknownChunkIds.add(chunkId)
      blocking('malformed-orphan-chunk', 'Orphan chunk payload or digest is malformed.', chunkId)
      continue
    }
    if (isCommitted) {
      preservedChunkIds.add(chunkId)
      advisory('committed-upload-chunk-preserved', 'Chunk belongs to a committed upload and is preserved.', chunkId)
    } else if (expiresAt > nowMs || upload.data.leaseId != null || upload.data.leaseUntil != null ||
        (leaseUntil !== null && leaseUntil > nowMs)) {
      preservedChunkIds.add(chunkId)
      advisory('upload-still-protected', 'Upload has not expired or still has a validator lease record.', chunkId)
    } else if (ageScreenEligibleAt > nowMs) {
      preservedChunkIds.add(chunkId)
      advisory('age-screen-pending', 'Upload has expired but has not passed the dry-run age screen.', chunkId)
    } else {
      candidateOrphans.push({ id: chunkId, bytes: chunkDocumentBytes(payload), uploadId, ageScreenEligibleAt })
    }
  }

  for (const chunkId of reachable.keys()) if (chunks.has(chunkId)) preservedChunkIds.add(chunkId)
  const safeToCollect = !diagnostics.some((diagnostic) => diagnostic.blocksCollection)
  const candidates = safeToCollect ? candidateOrphans.sort((a, b) => a.id.localeCompare(b.id)) : []
  if (!safeToCollect) {
    for (const candidate of candidateOrphans) {
      preservedChunkIds.add(candidate.id)
    }
  }
  return {
    safeToCollect,
    assetsPolicy: 'preserve-all',
    reachableChunks: [...reachable.entries()]
      .map(([id, reasons]) => ({ id, reasons: [...reasons].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    candidateOrphans: candidates,
    candidateBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
    preservedChunkIds: [...preservedChunkIds].sort(),
    unknownChunkIds: [...unknownChunkIds].sort(),
    diagnostics,
  }
}
