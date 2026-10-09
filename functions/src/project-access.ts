import { policyRole, strongestRole } from './access-role.js'
export { policyRole } from './access-role.js'
import { getFirestore } from 'firebase-admin/firestore'
import { getDatabase } from 'firebase-admin/database'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { defineString } from 'firebase-functions/params'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'

const region = defineString('SYNC_ACCESS_FUNCTION_REGION')
const triggerRegion = defineString('FIRESTORE_FUNCTION_REGION')
type Policy = Record<string, any>
const timestamp = () => new Date().toISOString()
const fail = (message: string): never => {
  throw new HttpsError('permission-denied', message)
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value))
    throw new HttpsError('invalid-argument', 'Invalid ID.')
  return value
}
function identity(request: CallableRequest) {
  if (!request.auth || request.auth.token.firebase?.sign_in_provider === 'anonymous') {
    throw new HttpsError('unauthenticated', 'Sign in to manage your workspace.')
  }
  return request.auth.uid
}
function verifiedEmail(request: CallableRequest) {
  return request.auth?.token.email_verified === true ? String(request.auth.token.email ?? '').toLowerCase() : undefined
}
function validShareRole(role: unknown) {
  if (!['viewer', 'editor', 'presentation'].includes(String(role)))
    throw new HttpsError('invalid-argument', 'Unknown sharing role.')
  return role as 'viewer' | 'editor' | 'presentation'
}
function sanitizePolicy(input: Policy): Policy {
  const collaborators: Policy = {}
  for (const [email, value] of Object.entries(input.collaborators ?? {}) as [string, Policy][]) {
    const normalized = email.trim().toLowerCase()
    if (!/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(normalized)) throw new HttpsError('invalid-argument', 'Invalid email.')
    collaborators[normalized] = {
      email: normalized,
      role: validShareRole(value.role ?? 'viewer'),
      addedAt: value.addedAt ?? timestamp(),
    }
  }
  return {
    generalAccess: input.generalAccess === 'anyone_with_link' ? 'anyone_with_link' : 'restricted',
    generalRole: validShareRole(input.generalRole ?? 'viewer'),
    collaborators,
    invitedEmails: Object.keys(collaborators),
  }
}
export function accessProjection(policy: Policy): Policy {
  const emails = Object.keys(policy.collaborators ?? {}).filter((email) => policy.invitedEmails?.includes(email))
  return {
    version: Number(policy.accessRevision ?? 0) * 2 + (policy.pending ? 0 : 1),
    ownerId: policy.ownerId ?? '',
    projectId: policy.projectId ?? '',
    inheritProjectAccess: policy.inheritProjectAccess !== false,
    blocked: Boolean(policy.deletedAt || policy.pending),
    ownerActive: !policy.deletedAt,
    publicRead: policy.generalAccess === 'anyone_with_link',
    publicWrite: policy.generalAccess === 'anyone_with_link' && policy.generalRole === 'editor',
    // Strings avoid invalid RTDB email keys; delimiters make membership exact.
    readerEmails: `|${emails.join('|')}|`,
    editorEmails: `|${emails.filter((email) => policy.collaborators[email].role === 'editor').join('|')}|`,
  }
}
async function mirrorPolicy(kind: 'board' | 'project', targetId: string, policy: Policy) {
  const projection = accessProjection(policy)
  await getDatabase()
    .ref(`${kind}Access/${targetId}`)
    .transaction((current) => {
      // Callables and repair triggers may mirror the same revision concurrently.
      if (current && Number(current.version ?? -1) > projection.version) return
      if (current && Object.entries(projection).every(([key, value]) => current[key] === value)) return
      return projection
    })
}
export async function mirrorCurrentPolicy(kind: 'board' | 'project', targetId: string) {
  const snapshot = await getFirestore().doc(`${kind}Shares/${targetId}`).get()
  if (snapshot.exists) await mirrorPolicy(kind, targetId, snapshot.data()!)
}
async function mutatePolicy(
  kind: 'board' | 'project',
  targetId: string,
  ownerId: string,
  patch: Policy,
  initial: Policy = {},
  actor?: { uid: string; email?: string },
  expectedRevision?: number,
) {
  const db = getFirestore(),
    ref = db.doc(`${kind}Shares/${targetId}`)
  const pendingPolicy = await db.runTransaction(async (tx) => {
    const current = await tx.get(ref),
      data = current.data() ?? initial
    if (data.ownerId && data.ownerId !== ownerId) fail('Project ownership changed.')
    if (actor && actor.uid !== ownerId && policyRole({ ...data, pending: false }, actor.uid, actor.email) !== 'editor')
      fail('Project editor access required.')
    if (data.deletedAt && !patch.deletedAt) fail('This item was deleted.')
    const same = (left: unknown, right: unknown): boolean => {
      if (left === right) return true
      if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
      const a = Object.keys(left),
        b = Object.keys(right)
      return (
        a.length === b.length &&
        a.every((key) => Object.hasOwn(right, key) && same((left as Policy)[key], (right as Policy)[key]))
      )
    }
    if (current.exists && !data.pending && Object.entries(patch).every(([key, value]) => same(data[key], value)))
      return data
    if (expectedRevision != null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
      throw new HttpsError('invalid-argument', 'Invalid access revision.')
    const justRegistered =
      kind === 'board' &&
      expectedRevision === 0 &&
      data.accessRevision === 1 &&
      data.generalAccess === 'restricted' &&
      data.generalRole === 'viewer' &&
      data.inheritProjectAccess !== false &&
      !data.invitedEmails?.length &&
      !Object.keys(data.collaborators ?? {}).length
    if (expectedRevision != null && expectedRevision !== Number(data.accessRevision ?? 0) && !justRegistered)
      throw new HttpsError('aborted', 'Sharing changed. Refresh permissions and retry.')
    const revision = Number(data.accessRevision ?? 0) + 1
    // Replace maps, never recursively merge omitted collaborators.
    const next = { ...data, ...patch, ownerId, accessRevision: revision, pending: true, updatedAt: timestamp() }
    tx.set(ref, next)
    return next
  })
  if (!pendingPolicy.pending) return pendingPolicy
  await mirrorPolicy(kind, targetId, pendingPolicy)
  const committedPolicy = await db.runTransaction(async (tx) => {
    const current = await tx.get(ref)
    if (current.data()?.accessRevision !== pendingPolicy.accessRevision)
      throw new HttpsError('aborted', 'Sharing changed. Reload and retry.')
    tx.update(ref, { pending: false })
    return { ...current.data()!, pending: false }
  })
  await mirrorPolicy(kind, targetId, committedPolicy)
  return committedPolicy
}
export const mirrorProjectAccess = onDocumentWritten(
  { document: 'projectShares/{projectId}', region: triggerRegion },
  async (event) => {
    await mirrorCurrentPolicy('project', event.params.projectId)
  },
)

function policyMetadata(policy: Policy) {
  const { scene: _scene, ...metadata } = policy
  return metadata
}

export const manageProject = onCall({ region }, async (request) => {
  const uid = identity(request),
    projectId = id(request.data?.projectId),
    action = request.data?.action
  const db = getFirestore()
  if (action === 'repair') {
    // Private namespace ownership is authoritative for legacy/imported projects.
    // An existing global policy owned elsewhere must never be reassigned.
    const ref = db.doc(`users/${uid}/projects/${projectId}`)
    await db.runTransaction(async (tx) => {
      const [snapshot, policy] = await Promise.all([tx.get(ref), tx.get(db.doc(`projectShares/${projectId}`))])
      if (!snapshot.exists || snapshot.data()?.deletedAt || (policy.exists && policy.data()?.ownerId !== uid))
        fail('Owned project repair required.')
      const project = snapshot.data()!
      if (project.ownerId === uid && project.id === projectId) return
      tx.update(ref, {
        id: projectId,
        ownerId: uid,
        members: [
          { principalId: uid, role: 'owner' },
          ...(project.members ?? []).filter((member: Policy) => member.role !== 'owner' && member.principalId !== uid),
        ],
      })
    })
    return { ok: true }
  }
  const currentPolicy = await db.doc(`projectShares/${projectId}`).get()
  const ownerId = currentPolicy.data()?.ownerId ?? uid
  const email = verifiedEmail(request)
  const canManage = uid === ownerId || policyRole({ ...currentPolicy.data(), pending: false }, uid, email) === 'editor'
  if (!canManage) fail('Project editor access required.')
  const ref = db.doc(`users/${ownerId}/projects/${projectId}`)
  const snapshot = await ref.get()
  if (!snapshot.exists || snapshot.data()?.ownerId !== ownerId || snapshot.data()?.deletedAt)
    fail('Project management access required.')
  const project = snapshot.data()!
  if (action === 'rename') {
    const name = String(request.data.name ?? '')
      .trim()
      .slice(0, 200)
    if (!name) throw new HttpsError('invalid-argument', 'Enter a project name.')
    await db.runTransaction(async (tx) => {
      const latest = await tx.get(ref),
        share = await tx.get(db.doc(`projectShares/${projectId}`))
      if (uid !== ownerId && policyRole({ ...share.data(), pending: false }, uid, email) !== 'editor')
        fail('Project editor access required.')
      if (latest.data()?.deletedAt) fail('Project was deleted.')
      tx.update(ref, { name, updatedAt: timestamp(), revision: Number(latest.data()?.revision ?? 0) + 1 })
      if (share.exists) tx.update(share.ref, { name, updatedAt: timestamp() })
    })
  } else if (action === 'share' || action === 'delete') {
    if (action === 'delete') {
      const boards = await db.collection(`users/${ownerId}/projects/${projectId}/boards`).get()
      for (const board of boards.docs) {
        const share = db.doc(`boardShares/${board.id}`)
        if (!(await share.get()).exists)
          await share.create({
            boardId: board.id,
            projectId,
            ownerId,
            boardName: board.data().name,
            generalAccess: 'restricted',
            generalRole: 'viewer',
            invitedEmails: [],
            collaborators: {},
            inheritProjectAccess: true,
            accessRevision: 1,
            pending: false,
          })
        else await share.update({ projectId })
        await mirrorCurrentPolicy('board', board.id)
      }
    }
    const committed = await mutatePolicy(
      'project',
      projectId,
      ownerId,
      action === 'delete' ? { deletedAt: timestamp() } : sanitizePolicy(request.data.policy ?? {}),
      {
        projectId,
        name: project.name,
        ownerId,
        ownerName: request.auth?.token.name ?? 'Owner',
        ownerEmail: request.auth?.token.email ?? '',
        createdAt: project.createdAt,
        generalAccess: 'restricted',
        generalRole: 'viewer',
        collaborators: {},
        invitedEmails: [],
      },
      { uid, email },
      request.data.expectedRevision,
    )
    if (action === 'share') return { ok: true, policy: policyMetadata(committed) }
    if (action === 'delete') await ref.update({ deletedAt: timestamp(), updatedAt: timestamp() })
  } else throw new HttpsError('invalid-argument', 'Unknown project action.')
  return { ok: true }
})

export const manageBoardAccess = onCall({ region }, async (request) => {
  const uid = identity(request),
    boardId = id(request.data?.boardId),
    db = getFirestore()
  const existing = await db.doc(`boardShares/${boardId}`).get()
  const projectId = id(existing.data()?.projectId ?? request.data?.projectId)
  const [parent, board] = await Promise.all([
    db.doc(`users/${uid}/projects/${projectId}`).get(),
    db.doc(`users/${uid}/projects/${projectId}/boards/${boardId}`).get(),
  ])
  if (
    !parent.exists ||
    parent.data()?.ownerId !== uid ||
    parent.data()?.deletedAt ||
    !board.exists ||
    board.data()?.active === false
  ) {
    fail('Board owner access required.')
  }
  const action = request.data.action
  if (action === 'capabilities') return { presentationSharing: true }
  const patch =
    action === 'private'
      ? { ...sanitizePolicy({}), inheritProjectAccess: false }
      : action === 'inherit'
        ? { inheritProjectAccess: true }
        : action === 'share'
          ? {
              ...sanitizePolicy(request.data.policy ?? {}),
              inheritProjectAccess: request.data.policy?.inheritProjectAccess !== false,
            }
          : action === 'delete'
            ? { deletedAt: timestamp() }
            : null
  if (!patch) throw new HttpsError('invalid-argument', 'Unknown board action.')
  const committed = await mutatePolicy(
    'board',
    boardId,
    uid,
    { ...patch, projectId },
    {
      boardId,
      projectId,
      boardName: board.data()!.name,
      ownerId: uid,
      ownerName: request.auth?.token.name ?? 'Owner',
      ownerEmail: request.auth?.token.email ?? '',
      generalAccess: 'restricted',
      generalRole: 'viewer',
      invitedEmails: [],
      collaborators: {},
      inheritProjectAccess: true,
      scene: board.data()!.scene,
      createdAt: board.data()!.createdAt,
    },
    undefined,
    request.data.expectedRevision,
  )
  if (action === 'delete') await board.ref.update({ active: false, updatedAt: timestamp() })
  return { ok: true, policy: policyMetadata(committed) }
})

export const listSharedProjects = onCall({ region }, async (request) => {
  const db = getFirestore(),
    targetId = request.data?.projectId ? id(request.data.projectId) : undefined
  const uid = request.auth?.uid,
    email = verifiedEmail(request)
  // A single homepage call returns owned sharing metadata without drawing payloads.
  // Server-owned policy documents establish ownership; clients cannot write these fields.
  const fields = [
    'boardId',
    'boardName',
    'projectId',
    'name',
    'ownerId',
    'ownerName',
    'ownerEmail',
    'ownerPhotoURL',
    'generalAccess',
    'generalRole',
    'invitedEmails',
    'collaborators',
    'inheritProjectAccess',
    'accessRevision',
    'pending',
    'deletedAt',
    'createdAt',
    'updatedAt',
  ]
  const ownedPromise = request.data?.includeOwnedPolicies
    ? Promise.all([
        db
          .collection('projectShares')
          .where('ownerId', '==', identity(request))
          .select(...fields)
          .get(),
        db
          .collection('boardShares')
          .where('ownerId', '==', identity(request))
          .select(...fields)
          .get(),
      ]).then(([projects, boards]) => ({
        projects: projects.docs.map((snapshot) => ({ ...snapshot.data(), projectId: snapshot.id })),
        boards: boards.docs.map((snapshot) => ({ ...snapshot.data(), boardId: snapshot.id })),
      }))
    : Promise.resolve(undefined)
  const policiesPromise = targetId
    ? db
        .doc(`projectShares/${targetId}`)
        .get()
        .then((snapshot) => [snapshot])
    : uid && email
      ? db
          .collection('projectShares')
          .where('invitedEmails', 'array-contains', email)
          .get()
          .then((snapshot) => snapshot.docs)
      : Promise.resolve([])
  const directPromise =
    request.data?.includeDirectBoards && uid && email && !targetId
      ? db
          .collection('boardShares')
          .where('invitedEmails', 'array-contains', email)
          .select(...fields)
          .get()
      : Promise.resolve(null)
  const [ownedPolicies, policies, directSnapshots] = await Promise.all([ownedPromise, policiesPromise, directPromise])
  const projects: Policy[] = [],
    boards: Policy[] = []
  for (const snapshot of policies) {
    if (!snapshot.exists) continue
    const policy = snapshot.data()!,
      role = policyRole(policy, uid, email)
    if (!role || (!targetId && policy.ownerId === uid)) continue
    const boardSnapshots = await db
      .collection(`users/${policy.ownerId}/projects/${snapshot.id}/boards`)
      .where('active', '==', true)
      .select('name', 'createdAt', 'updatedAt', 'revision')
      .get()
    const configs = boardSnapshots.empty
      ? []
      : await db.getAll(...boardSnapshots.docs.map((board) => db.doc(`boardShares/${board.id}`)), { fieldMask: fields })
    projects.push({
      id: snapshot.id,
      name: policy.name,
      ownerId: policy.ownerId,
      ownerName: policy.ownerName,
      members: [],
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
      role,
      isShared: true,
      ...(role === 'owner' || role === 'editor'
        ? {
            sharePolicy: {
              generalAccess: policy.generalAccess,
              generalRole: policy.generalRole,
              collaborators: policy.collaborators ?? {},
              invitedEmails: policy.invitedEmails ?? [],
              ownerEmail: policy.ownerEmail ?? '',
              accessRevision: policy.accessRevision ?? 0,
            },
          }
        : {}),
    })
    for (let index = 0; index < boardSnapshots.docs.length; index++) {
      const board = boardSnapshots.docs[index],
        config = configs[index].data()
      if (!config || config.deletedAt || config.pending) continue
      const directRole = policyRole(config, uid, email)
      if (config.inheritProjectAccess === false && !directRole) continue
      const data = board.data()!
      boards.push({
        id: board.id,
        projectId: snapshot.id,
        name: config.boardName ?? data.name,
        active: true,
        createdAt: data.createdAt,
        updatedAt: config.updatedAt ?? data.updatedAt,
        revision: data.revision ?? 0,
        baseRevision: data.revision ?? 0,
        syncStatus: 'synced',
        syncAttempts: 0,
        nextSyncAt: null,
        lastSyncError: null,
        inheritProjectAccess: config.inheritProjectAccess !== false,
        role: strongestRole(directRole, config.inheritProjectAccess !== false ? role : null),
      })
    }
  }
  const directBoards: Policy[] = []
  for (const snapshot of directSnapshots?.docs ?? []) {
    const config = snapshot.data(),
      role = policyRole(config, uid, email)
    if (!role || config.ownerId === uid || boards.some((board) => board.id === snapshot.id)) continue
    // A direct board invitation does not grant access to its project or sibling boards.
    let parent: Policy | undefined, board: Policy | undefined
    if (config.projectId) {
      const [parentSnapshot, boardSnapshot, projectPolicy] = await db.getAll(
        db.doc(`users/${config.ownerId}/projects/${config.projectId}`),
        db.doc(`users/${config.ownerId}/projects/${config.projectId}/boards/${snapshot.id}`),
        db.doc(`projectShares/${config.projectId}`),
        { fieldMask: ['name', 'deletedAt', 'pending', 'active', 'createdAt', 'revision'] },
      )
      if (projectPolicy.data()?.deletedAt || projectPolicy.data()?.pending) continue
      parent = parentSnapshot.data()
      board = boardSnapshot.data()
      if (!parent || parent.deletedAt || !board || board.active !== true) continue
    }
    directBoards.push({
      id: snapshot.id,
      projectId: config.projectId ?? `shared-${config.ownerId}`,
      name: config.boardName ?? board?.name ?? 'Untitled board',
      active: true,
      createdAt: board?.createdAt ?? config.createdAt,
      updatedAt: config.updatedAt,
      revision: board?.revision ?? 0,
      baseRevision: board?.revision ?? 0,
      syncStatus: 'synced',
      syncAttempts: 0,
      nextSyncAt: null,
      lastSyncError: null,
      role,
      project: {
        id: config.projectId ?? `shared-${config.ownerId}`,
        // Do not disclose a private parent project's name through a board invitation.
        name: 'Shared boards',
        ownerId: config.ownerId,
        members: [],
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
        isShared: true,
      },
    })
  }
  return { projects, boards, ...(directSnapshots ? { directBoards } : {}), ...(ownedPolicies ? { ownedPolicies } : {}) }
})

export const createProjectBoard = onCall({ region }, async (request) => {
  const uid = identity(request),
    projectId = id(request.data.projectId),
    boardId = id(request.data.boardId)
  const db = getFirestore(),
    policy = (await db.doc(`projectShares/${projectId}`).get()).data()
  const role = policyRole(policy, uid, verifiedEmail(request))
  if (role !== 'owner' && role !== 'editor') fail('Project editing access required.')
  const ref = db.doc(`users/${policy!.ownerId}/projects/${projectId}/boards/${boardId}`)
  const createdAt = timestamp()
  const board = {
    id: boardId,
    projectId,
    name: String(request.data.name ?? 'Untitled')
      .trim()
      .slice(0, 200),
    creatorId: uid,
    active: true,
    createdAt,
    updatedAt: createdAt,
    revision: 0,
    baseRevision: 0,
    syncStatus: 'synced',
    syncAttempts: 0,
    nextSyncAt: null,
    lastSyncError: null,
    formatVersion: 1,
    scene: { elements: [], appState: { viewBackgroundColor: 'transparent' }, files: {} },
  }
  await db.runTransaction(async (tx) => {
    const parent = await tx.get(db.doc(`projectShares/${projectId}`)),
      existing = await tx.get(ref)
    const currentRole = policyRole(parent.data(), uid, verifiedEmail(request))
    if (currentRole !== 'owner' && currentRole !== 'editor') fail('Project editing access was revoked.')
    if (existing.exists) throw new HttpsError('already-exists', 'Board already exists.')
    tx.create(ref, board)
    tx.create(db.doc(`boardShares/${boardId}`), {
      boardId,
      projectId,
      ownerId: policy!.ownerId,
      boardName: board.name,
      ownerName: policy!.ownerName,
      createdAt,
      updatedAt: createdAt,
      scene: board.scene,
      inheritProjectAccess: true,
      generalAccess: 'restricted',
      generalRole: 'viewer',
      invitedEmails: [],
      collaborators: {},
      accessRevision: 1,
      pending: false,
    })
  })
  await mirrorCurrentPolicy('board', boardId)
  return board
})

// Publishes offline owner-created boards after their private cloud sync succeeds.
export const publishProjectBoard = onDocumentWritten(
  { document: 'users/{ownerId}/projects/{projectId}/boards/{boardId}', region: triggerRegion },
  async (event) => {
    const { ownerId, projectId, boardId } = event.params
    const db = getFirestore(),
      privateRef = db.doc(`users/${ownerId}/projects/${projectId}/boards/${boardId}`)
    const policyRef = db.doc(`boardShares/${boardId}`)
    await db.runTransaction(async (tx) => {
      const board = await tx.get(privateRef),
        project = await tx.get(db.doc(`projectShares/${projectId}`)),
        privateProject = await tx.get(db.doc(`users/${ownerId}/projects/${projectId}`)),
        existing = await tx.get(policyRef)
      if (!board.exists) return
      const data = board.data()!
      if (existing.exists) {
        if (existing.data()?.ownerId !== ownerId) return
        if (data.active === false && !existing.data()?.deletedAt)
          tx.update(policyRef, {
            deletedAt: timestamp(),
            accessRevision: Number(existing.data()?.accessRevision ?? 0) + 1,
            pending: false,
            projectId,
          })
        else if (!existing.data()?.projectId) tx.update(policyRef, { projectId })
        return
      }
      if (
        !privateProject.exists ||
        privateProject.data()?.deletedAt ||
        (project.exists && (project.data()?.ownerId !== ownerId || project.data()?.deletedAt)) ||
        data.active === false
      )
        return
      tx.create(policyRef, {
        boardId,
        projectId,
        ownerId,
        boardName: data.name,
        ownerName: project.data()?.ownerName ?? 'Owner',
        generalAccess: 'restricted',
        generalRole: 'viewer',
        collaborators: {},
        invitedEmails: [],
        inheritProjectAccess: true,
        scene: data.scene,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        accessRevision: 1,
        pending: false,
      })
    })
    await mirrorCurrentPolicy('board', boardId)
  },
)
