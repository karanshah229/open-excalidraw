import { getFirestore } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
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
export function verifiedEmail(request) {
    return request.auth?.token.email_verified === true ? String(request.auth.token.email ?? '').toLowerCase() : undefined;
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
export async function mirrorPolicy(kind, targetId, policy) {
    const projection = accessProjection(policy);
    await getDatabase()
        .ref(`${kind}Access/${targetId}`)
        .transaction((current) => {
        // Callables and repair triggers may mirror the same revision concurrently.
        if (current && Number(current.version ?? -1) > projection.version)
            return;
        if (current && Object.entries(projection).every(([key, value]) => current[key] === value))
            return;
        return projection;
    });
}
export async function mirrorCurrentPolicy(kind, targetId) {
    const snapshot = await getFirestore().doc(`${kind}Shares/${targetId}`).get();
    if (snapshot.exists)
        await mirrorPolicy(kind, targetId, snapshot.data());
}
