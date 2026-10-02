import { getFirestore } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
const region = defineString('SYNC_ACCESS_FUNCTION_REGION');
const triggerRegion = defineString('FIRESTORE_FUNCTION_REGION');
const timestamp = () => new Date().toISOString();
const fail = (message) => {
    throw new HttpsError('permission-denied', message);
};
function id(value) {
    if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value))
        throw new HttpsError('invalid-argument', 'Invalid ID.');
    return value;
}
function identity(request) {
    if (!request.auth || request.auth.token.firebase?.sign_in_provider === 'anonymous') {
        throw new HttpsError('unauthenticated', 'Sign in to manage your workspace.');
    }
    return request.auth.uid;
}
export function policyRole(policy, uid, email) {
    if (!policy || policy.deletedAt || policy.pending)
        return null;
    if (uid && policy.ownerId === uid)
        return 'owner';
    const direct = email && policy.invitedEmails?.includes(email) ? (policy.collaborators?.[email]?.role ?? 'viewer') : null;
    if (direct === 'editor' || (policy.generalAccess === 'anyone_with_link' && policy.generalRole === 'editor'))
        return 'editor';
    if (direct || policy.generalAccess === 'anyone_with_link')
        return 'viewer';
    return null;
}
function verifiedEmail(request) {
    return request.auth?.token.email_verified === true ? String(request.auth.token.email ?? '').toLowerCase() : undefined;
}
function sanitizePolicy(input) {
    const collaborators = {};
    for (const [email, value] of Object.entries(input.collaborators ?? {})) {
        const normalized = email.trim().toLowerCase();
        if (!/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(normalized))
            throw new HttpsError('invalid-argument', 'Invalid email.');
        collaborators[normalized] = {
            email: normalized,
            role: value.role === 'editor' ? 'editor' : 'viewer',
            addedAt: value.addedAt ?? timestamp(),
        };
    }
    return {
        generalAccess: input.generalAccess === 'anyone_with_link' ? 'anyone_with_link' : 'restricted',
        generalRole: input.generalRole === 'editor' ? 'editor' : 'viewer',
        collaborators,
        invitedEmails: Object.keys(collaborators),
    };
}
export function accessProjection(policy) {
    const emails = Object.keys(policy.collaborators ?? {}).filter((email) => policy.invitedEmails?.includes(email));
    return {
        version: Number(policy.accessRevision ?? 0) * 2 + (policy.pending ? 0 : 1),
        ownerId: policy.ownerId ?? '',
        projectId: policy.projectId ?? '',
        inheritProjectAccess: policy.inheritProjectAccess !== false,
        blocked: Boolean(policy.deletedAt || policy.pending),
        publicRead: policy.generalAccess === 'anyone_with_link',
        publicWrite: policy.generalAccess === 'anyone_with_link' && policy.generalRole === 'editor',
        // Strings avoid invalid RTDB email keys; delimiters make membership exact.
        readerEmails: `|${emails.join('|')}|`,
        editorEmails: `|${emails.filter((email) => policy.collaborators[email].role === 'editor').join('|')}|`,
    };
}
export async function mirrorCurrentPolicy(kind, targetId) {
    const snapshot = await getFirestore().doc(`${kind}Shares/${targetId}`).get();
    if (!snapshot.exists)
        return;
    const projection = accessProjection(snapshot.data());
    await getDatabase()
        .ref(`${kind}Access/${targetId}`)
        .transaction((current) => {
        if (current && Number(current.version ?? -1) > projection.version)
            return;
        return projection;
    });
}
async function mutatePolicy(kind, targetId, ownerId, patch, initial = {}) {
    const db = getFirestore(), ref = db.doc(`${kind}Shares/${targetId}`);
    const revision = await db.runTransaction(async (tx) => {
        const current = await tx.get(ref), data = current.data() ?? initial;
        if (data.ownerId && data.ownerId !== ownerId)
            fail('Only the owner can manage sharing.');
        if (data.deletedAt && !patch.deletedAt)
            fail('This item was deleted.');
        const revision = Number(data.accessRevision ?? 0) + 1;
        // Replace maps, never recursively merge omitted collaborators.
        tx.set(ref, { ...data, ...patch, ownerId, accessRevision: revision, pending: true, updatedAt: timestamp() });
        return revision;
    });
    await mirrorCurrentPolicy(kind, targetId);
    await db.runTransaction(async (tx) => {
        const current = await tx.get(ref);
        if (current.data()?.accessRevision !== revision)
            throw new HttpsError('aborted', 'Sharing changed. Reload and retry.');
        tx.update(ref, { pending: false });
    });
    await mirrorCurrentPolicy(kind, targetId);
}
export const mirrorProjectAccess = onDocumentWritten({ document: 'projectShares/{projectId}', region: triggerRegion }, async (event) => {
    await mirrorCurrentPolicy('project', event.params.projectId);
});
export const manageProject = onCall({ region }, async (request) => {
    const uid = identity(request), projectId = id(request.data?.projectId), action = request.data?.action;
    const db = getFirestore(), ref = db.doc(`users/${uid}/projects/${projectId}`);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data()?.ownerId !== uid || snapshot.data()?.deletedAt)
        fail('Project owner access required.');
    const project = snapshot.data();
    if (action === 'rename') {
        const name = String(request.data.name ?? '')
            .trim()
            .slice(0, 200);
        if (!name)
            throw new HttpsError('invalid-argument', 'Enter a project name.');
        await db.runTransaction(async (tx) => {
            const latest = await tx.get(ref), share = await tx.get(db.doc(`projectShares/${projectId}`));
            if (latest.data()?.deletedAt)
                fail('Project was deleted.');
            tx.update(ref, { name, updatedAt: timestamp(), revision: Number(latest.data()?.revision ?? 0) + 1 });
            if (share.exists)
                tx.update(share.ref, { name, updatedAt: timestamp() });
        });
    }
    else if (action === 'share' || action === 'delete') {
        if (action === 'delete') {
            const boards = await db.collection(`users/${uid}/projects/${projectId}/boards`).get();
            for (const board of boards.docs) {
                const share = db.doc(`boardShares/${board.id}`);
                if (!(await share.get()).exists)
                    await share.create({
                        boardId: board.id,
                        projectId,
                        ownerId: uid,
                        boardName: board.data().name,
                        generalAccess: 'restricted',
                        generalRole: 'viewer',
                        invitedEmails: [],
                        collaborators: {},
                        inheritProjectAccess: true,
                        accessRevision: 1,
                        pending: false,
                    });
                else
                    await share.update({ projectId });
                await mirrorCurrentPolicy('board', board.id);
            }
        }
        await mutatePolicy('project', projectId, uid, action === 'delete' ? { deletedAt: timestamp() } : sanitizePolicy(request.data.policy ?? {}), {
            projectId,
            name: project.name,
            ownerId: uid,
            ownerName: request.auth?.token.name ?? 'Owner',
            createdAt: project.createdAt,
            generalAccess: 'restricted',
            generalRole: 'viewer',
            collaborators: {},
            invitedEmails: [],
        });
        if (action === 'delete')
            await ref.update({ deletedAt: timestamp(), updatedAt: timestamp() });
    }
    else
        throw new HttpsError('invalid-argument', 'Unknown project action.');
    return { ok: true };
});
export const manageBoardAccess = onCall({ region }, async (request) => {
    const uid = identity(request), boardId = id(request.data?.boardId), db = getFirestore();
    const existing = await db.doc(`boardShares/${boardId}`).get();
    const projectId = id(existing.data()?.projectId ?? request.data?.projectId);
    const parent = await db.doc(`users/${uid}/projects/${projectId}`).get();
    const board = await db.doc(`users/${uid}/projects/${projectId}/boards/${boardId}`).get();
    if (!parent.exists ||
        parent.data()?.ownerId !== uid ||
        parent.data()?.deletedAt ||
        !board.exists ||
        board.data()?.active === false) {
        fail('Board owner access required.');
    }
    const action = request.data.action;
    const patch = action === 'private'
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
                    : null;
    if (!patch)
        throw new HttpsError('invalid-argument', 'Unknown board action.');
    await mutatePolicy('board', boardId, uid, { ...patch, projectId }, {
        boardId,
        projectId,
        boardName: board.data().name,
        ownerId: uid,
        ownerName: request.auth?.token.name ?? 'Owner',
        ownerEmail: request.auth?.token.email ?? '',
        generalAccess: 'restricted',
        generalRole: 'viewer',
        invitedEmails: [],
        collaborators: {},
        inheritProjectAccess: true,
        scene: board.data().scene,
        createdAt: board.data().createdAt,
    });
    if (action === 'delete')
        await board.ref.update({ active: false, updatedAt: timestamp() });
    return { ok: true };
});
export const listSharedProjects = onCall({ region }, async (request) => {
    const db = getFirestore(), targetId = request.data?.projectId ? id(request.data.projectId) : undefined;
    const uid = request.auth?.uid, email = verifiedEmail(request);
    let policies;
    if (targetId)
        policies = [await db.doc(`projectShares/${targetId}`).get()];
    else {
        if (!uid || !email)
            return { projects: [], boards: [] };
        policies = (await db.collection('projectShares').where('invitedEmails', 'array-contains', email).get()).docs;
    }
    const projects = [], boards = [];
    for (const snapshot of policies) {
        if (!snapshot.exists)
            continue;
        const policy = snapshot.data(), role = policyRole(policy, uid, email);
        if (!role || (!targetId && policy.ownerId === uid))
            continue;
        const boardSnapshots = await db
            .collection(`users/${policy.ownerId}/projects/${snapshot.id}/boards`)
            .where('active', '==', true)
            .get();
        const configs = boardSnapshots.empty
            ? []
            : await db.getAll(...boardSnapshots.docs.map((board) => db.doc(`boardShares/${board.id}`)));
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
        });
        for (let index = 0; index < boardSnapshots.docs.length; index++) {
            const board = boardSnapshots.docs[index], config = configs[index].data();
            if (!config || config.deletedAt || config.pending)
                continue;
            const directRole = policyRole(config, uid, email);
            if (config.inheritProjectAccess === false && !directRole)
                continue;
            const data = board.data();
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
                role: directRole === 'editor' || directRole === 'owner'
                    ? directRole
                    : config.inheritProjectAccess !== false
                        ? role
                        : directRole,
            });
        }
    }
    return { projects, boards };
});
export const createProjectBoard = onCall({ region }, async (request) => {
    const uid = identity(request), projectId = id(request.data.projectId), boardId = id(request.data.boardId);
    const db = getFirestore(), policy = (await db.doc(`projectShares/${projectId}`).get()).data();
    const role = policyRole(policy, uid, verifiedEmail(request));
    if (role !== 'owner' && role !== 'editor')
        fail('Project editing access required.');
    const ref = db.doc(`users/${policy.ownerId}/projects/${projectId}/boards/${boardId}`);
    const createdAt = timestamp();
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
    };
    await db.runTransaction(async (tx) => {
        const parent = await tx.get(db.doc(`projectShares/${projectId}`)), existing = await tx.get(ref);
        const currentRole = policyRole(parent.data(), uid, verifiedEmail(request));
        if (currentRole !== 'owner' && currentRole !== 'editor')
            fail('Project editing access was revoked.');
        if (existing.exists)
            throw new HttpsError('already-exists', 'Board already exists.');
        tx.create(ref, board);
        tx.create(db.doc(`boardShares/${boardId}`), {
            boardId,
            projectId,
            ownerId: policy.ownerId,
            boardName: board.name,
            ownerName: policy.ownerName,
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
        });
    });
    await mirrorCurrentPolicy('board', boardId);
    return board;
});
// Publishes offline owner-created boards after their private cloud sync succeeds.
export const publishProjectBoard = onDocumentWritten({ document: 'users/{ownerId}/projects/{projectId}/boards/{boardId}', region: triggerRegion }, async (event) => {
    const { ownerId, projectId, boardId } = event.params;
    const db = getFirestore(), privateRef = db.doc(`users/${ownerId}/projects/${projectId}/boards/${boardId}`);
    const policyRef = db.doc(`boardShares/${boardId}`);
    await db.runTransaction(async (tx) => {
        const board = await tx.get(privateRef), project = await tx.get(db.doc(`projectShares/${projectId}`)), existing = await tx.get(policyRef);
        if (!board.exists)
            return;
        const data = board.data();
        if (existing.exists) {
            if (existing.data()?.ownerId !== ownerId)
                return;
            if (data.active === false && !existing.data()?.deletedAt)
                tx.update(policyRef, {
                    deletedAt: timestamp(),
                    accessRevision: Number(existing.data()?.accessRevision ?? 0) + 1,
                    pending: false,
                    projectId,
                });
            else if (!existing.data()?.projectId)
                tx.update(policyRef, { projectId });
            return;
        }
        if (!project.exists ||
            project.data()?.ownerId !== ownerId ||
            !policyRole(project.data(), ownerId) ||
            data.active === false)
            return;
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
        });
    });
    await mirrorCurrentPolicy('board', boardId);
});
