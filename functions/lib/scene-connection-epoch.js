import { randomUUID } from 'node:crypto';
import { getDatabase } from 'firebase-admin/database';
import { HttpsError } from 'firebase-functions/v2/https';
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function canWriteBoard(board, project, uid, email, emailVerified = false) {
    if (!board)
        return false;
    if (board.ownerId === uid && board.ownerActive === true) {
        return !project || project.ownerActive === true;
    }
    if (board.blocked !== false)
        return false;
    if (project?.blocked === true)
        return false;
    if (board.ownerId === uid || board.publicWrite === true)
        return true;
    if (emailVerified && email && typeof board.editorEmails === 'string' && board.editorEmails.includes(`|${email}|`))
        return true;
    if (board.inheritProjectAccess !== true || !project)
        return false;
    return project.ownerId === uid || project.publicWrite === true || (emailVerified && Boolean(email) && typeof project.editorEmails === 'string' && project.editorEmails.includes(`|${email}|`));
}
/** Admin-authorized epoch rotation. The durable token survives presence onDisconnect cleanup. */
export async function mintSceneConnectionEpochForSession(input, boardId, sessionId, sceneGeneration, database = getDatabase()) {
    if (!input.uid)
        throw new HttpsError('unauthenticated', 'Authentication is required.');
    if (!validId(boardId) || !validId(sessionId))
        throw new HttpsError('invalid-argument', 'A valid board and session ID are required.');
    if (!Number.isSafeInteger(sceneGeneration) || Number(sceneGeneration) < 1)
        throw new HttpsError('invalid-argument', 'The loaded board generation is required.');
    const root = database.ref();
    const [boardSnapshot, gateSnapshot, roomGenerationSnapshot] = await Promise.all([
        root.child(`boardAccess/${boardId}`).get(),
        root.child(`system/sceneMaintenance/${boardId}`).get(),
        root.child(`boards/${boardId}/generation`).get(),
    ]);
    const gate = gateSnapshot.val();
    if (gate?.admissionClosed === true)
        throw new HttpsError('unavailable', 'Board collaboration is temporarily paused.');
    const admissionEpoch = Number.isSafeInteger(gate?.admissionEpoch) && gate.admissionEpoch >= 0
        ? gate.admissionEpoch
        : 0;
    const roomGeneration = roomGenerationSnapshot.val() ?? 1;
    if (!Number.isSafeInteger(roomGeneration) || roomGeneration !== sceneGeneration)
        throw new HttpsError('failed-precondition', 'This board changed generations. Reload it before reconnecting.', {
            reason: 'scene-generation-mismatch', generation: roomGeneration,
        });
    const board = boardSnapshot.val();
    const projectSnapshot = board?.projectId ? await root.child(`projectAccess/${board.projectId}`).get() : null;
    if (!canWriteBoard(board, projectSnapshot?.val(), input.uid, input.email, input.emailVerified)) {
        throw new HttpsError('permission-denied', 'Current board editing access is required.');
    }
    const epochRef = root.child(`system/sceneConnectionEpochs/${boardId}/${sessionId}`);
    const result = await epochRef.transaction((current) => {
        const generation = Number.isSafeInteger(current?.generation) && current.generation >= 0 ? current.generation + 1 : 1;
        return { userId: input.uid, generation, sceneGeneration, admissionEpoch, token: randomUUID(), issuedAt: Date.now() };
    });
    if (!result.committed || typeof result.snapshot.val()?.token !== 'string') {
        throw new HttpsError('unavailable', 'Could not authorize the collaboration connection.');
    }
    const record = result.snapshot.val();
    return { connectionEpoch: record.token, generation: record.generation };
}
