#!/usr/bin/env node
import { createRequire } from 'node:module'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'

const requireFromFunctions = createRequire(new URL('../functions/package.json', import.meta.url))
const { applicationDefault, initializeApp } = requireFromFunctions('firebase-admin/app')
const { FieldPath, getFirestore } = requireFromFunctions('firebase-admin/firestore')
const plannerUrl = new URL('../functions/lib/scene-maintenance-planner.js', import.meta.url)

function usage() {
  console.error('Usage: node scripts/scene-maintenance-dry-run.mjs --project <firebase-project-id> --board <board-id> [--output <new-json-file>]')
  console.error('Read-only with respect to Firebase. --output persists a sanitized local report without overwriting an existing file.')
  console.error('Build functions first so functions/lib/scene-maintenance-planner.js exists.')
}

function parseArgs(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!['--project', '--board', '--output'].includes(key) || !argv[index + 1] || argv[index + 1].startsWith('--'))
      throw new Error('Invalid arguments.')
    if (args.has(key)) throw new Error('Duplicate arguments.')
    args.set(key, argv[++index])
  }
  const project = args.get('--project')
  const board = args.get('--board')
  if (!project || !board || (args.size !== 2 && args.size !== 3)) throw new Error('Both project and board are required.')
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error('Invalid Firebase project ID.')
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(board)) throw new Error('Invalid board ID.')
  return { project, board, outputPath: args.get('--output') }
}

const safePathSegment = (value) => typeof value === 'string' && value.length > 0 &&
  value.length <= 256 && ![...value].some((character) => character === '/' || character.charCodeAt(0) <= 0x1f)
const safeProjectSegment = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch {
    usage()
    process.exitCode = 2
    return
  }

  let planSceneMaintenance
  try {
    ;({ planSceneMaintenance } = await import(plannerUrl.href))
  } catch {
    console.error('Planner build is missing. Run `pnpm --filter @agentic-whiteboard/functions build` first.')
    process.exitCode = 2
    return
  }

  initializeApp({ credential: applicationDefault(), projectId: args.project })
  const db = getFirestore()
  const pageSize = 200
  const censusErrors = []
  let censusComplete = true

  async function readCollection(path) {
    const collection = db.collection(path)
    const documents = []
    let cursor
    while (true) {
      let query = collection.orderBy(FieldPath.documentId()).limit(pageSize)
      if (cursor) query = query.startAfter(cursor)
      const page = await query.get()
      documents.push(...page.docs)
      if (page.size < pageSize) break
      cursor = page.docs.at(-1)
    }
    return documents
  }

  async function census(label, work) {
    try {
      return await work()
    } catch {
      censusComplete = false
      censusErrors.push(`${label}: read failed; census is incomplete`)
      return null
    }
  }

  const root = `boardScenes/${args.board}`
  const headSnapshot = await census('head', () => db.doc(root).get())
  const headData = headSnapshot?.exists ? headSnapshot.data() : null
  const [revisionSnapshots, versionSnapshots, pinSnapshots, uploadSnapshots, chunkSnapshots, shareSnapshot] =
    await Promise.all([
      census('revisions', () => readCollection(`${root}/revisions`)),
      census('versions', () => readCollection(`${root}/versions`)),
      census('readerPins', () => readCollection(`${root}/readerPins`)),
      census('uploads', () => readCollection(`${root}/uploads`)),
      census('chunks', () => readCollection(`${root}/chunks`)),
      census('board sharing metadata', () => db.doc(`boardShares/${args.board}`).get()),
    ])
  const maintenanceJobSnapshots = await census('maintenanceJobs', () => readCollection(`${root}/maintenanceJobs`))

  const revisions = []
  for (const revisionSnapshot of revisionSnapshots ?? []) {
    const pages = await census(`revision pages ${revisionSnapshot.id}`, () =>
      readCollection(`${root}/revisions/${revisionSnapshot.id}/pages`),
    )
    revisions.push({
      id: revisionSnapshot.id,
      data: revisionSnapshot.data(),
      pages: (pages ?? []).map((page) => ({ id: page.id, data: page.data() })),
    })
  }

  const head = headData
    ? {
        headRevisionId: headData.headRevisionId ?? null,
        generation: headData.generation,
        sceneFormatVersion: headData.sceneFormatVersion,
        ownerId: headData.ownerId,
        projectId: headData.projectId ?? null,
      }
    : null

  // Verify the requested Firebase project and board binding through trusted metadata.
  // The CLI never trusts client-supplied owner/project information from scene payloads.
  let ownershipVerified = false
  if (safePathSegment(head?.ownerId) && safeProjectSegment(head?.projectId)) {
    const privateBoardSnapshot = await census('private board metadata', () =>
      db.doc(`users/${head.ownerId}/projects/${head.projectId}/boards/${args.board}`).get(),
    )
    const privateProjectSnapshot = await census('private project metadata', () =>
      db.doc(`users/${head.ownerId}/projects/${head.projectId}`).get(),
    )
    const projectPolicySnapshot = await census('project sharing metadata', () =>
      db.doc(`projectShares/${head.projectId}`).get(),
    )
    const shareData = shareSnapshot?.exists ? shareSnapshot.data() : null
    const privateBoard = privateBoardSnapshot?.exists ? privateBoardSnapshot.data() : null
    const privateProject = privateProjectSnapshot?.exists ? privateProjectSnapshot.data() : null
    const projectPolicy = projectPolicySnapshot?.exists ? projectPolicySnapshot.data() : null
    ownershipVerified = Boolean(
      privateBoard && privateBoard.active !== false && privateProject &&
      !privateProject.deletedAt &&
      privateBoard.id === args.board && privateBoard.projectId === head.projectId &&
      privateProject.ownerId === head.ownerId &&
      (!shareData || (shareData.boardId === args.board && shareData.ownerId === head.ownerId &&
        shareData.projectId === head.projectId && !shareData.deletedAt && shareData.pending !== true)) &&
      (!projectPolicy || (projectPolicy.ownerId === head.ownerId && !projectPolicy.deletedAt)),
    )
  } else if (safePathSegment(head?.ownerId) && head.projectId === null) {
    const shareData = shareSnapshot?.exists ? shareSnapshot.data() : null
    ownershipVerified = Boolean(shareData && shareData.boardId === args.board && shareData.ownerId === head.ownerId &&
      !shareData.deletedAt && shareData.pending !== true &&
      (shareData.projectId ?? null) === null)
  }
  if (!ownershipVerified) {
    censusComplete = false
    censusErrors.push('board ownership binding: could not verify requested board ownership')
  }

  const docs = (snapshots) => (snapshots ?? []).map((snapshot) => ({ id: snapshot.id, data: snapshot.data() }))
  const maintenanceJobs = docs(maintenanceJobSnapshots)
  const chunkDocuments = docs(chunkSnapshots)
  const chunksById = new Map(chunkDocuments.map((chunk) => [chunk.id, chunk.data]))
  const writerProtocolVersions = {}
  for (const snapshot of [...(revisionSnapshots ?? []), ...(uploadSnapshots ?? [])]) {
    const version = snapshot.data()?.sceneProtocolVersion
    const key = Number.isSafeInteger(version) ? `v${version}` : 'legacy-or-missing'
    writerProtocolVersions[key] = (writerProtocolVersions[key] ?? 0) + 1
  }
  const plan = planSceneMaintenance(
    {
      censusComplete,
      ownershipVerified,
      head,
      revisions,
      versions: docs(versionSnapshots),
      readerPins: docs(pinSnapshots),
      uploads: docs(uploadSnapshots),
      maintenanceJobs,
      chunks: docs(chunkSnapshots),
    },
    Date.now(),
  )
  const storedPayloadBytes = chunkDocuments.reduce((total, chunk) =>
    total + (typeof chunk.data.payload === 'string' ? Buffer.byteLength(chunk.data.payload, 'utf8') : 0), 0)
  const reachableIds = new Set(plan.reachableChunks.map((chunk) => chunk.id))
  const reachablePayloadBytes = [...reachableIds].reduce((total, chunkId) => {
    const chunk = chunksById.get(chunkId)
    return total + (typeof chunk?.payload === 'string' ? Buffer.byteLength(chunk.payload, 'utf8') : 0)
  }, 0)
  const output = {
    mode: 'dry-run-only',
    canAuthorizeDeletion: false,
    deletionDisclaimer: 'Upload expiresAt + 48h is only an age-eligibility screen. It is not durable quarantine evidence and cannot authorize deletion. A future collector must persist its own quarantine timestamp and take a fresh fenced census.',
    firebaseProjectId: args.project,
    boardId: args.board,
    generatedAt: new Date().toISOString(),
    censusComplete,
    censusErrors,
    counts: {
      revisions: revisions.length,
      versions: versionSnapshots?.length ?? 0,
      readerPins: pinSnapshots?.length ?? 0,
      uploads: uploadSnapshots?.length ?? 0,
      maintenanceJobs: maintenanceJobs.length,
      chunks: chunkSnapshots?.length ?? 0,
      writerProtocolVersions,
    },
    payloadBytes: {
      stored: storedPayloadBytes,
      reachable: reachablePayloadBytes,
      candidateEstimatedDocumentBytes: plan.candidateBytes,
    },
    plan,
  }
  const report = `${JSON.stringify(output, null, 2)}\n`
  if (args.outputPath) {
    const reportFile = await open(resolve(args.outputPath), 'wx', 0o600)
    try {
      await reportFile.writeFile(report, 'utf8')
    } finally {
      await reportFile.close()
    }
  }
  process.stdout.write(report)
  if (!plan.safeToCollect) process.exitCode = 1
}

void main().catch(() => {
  // Do not print Firebase errors, which can include project or credential details.
  process.stderr.write('Dry-run failed before producing a complete census. No writes were attempted.\n')
  process.exitCode = 1
})
