import { initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';
initializeApp();
async function run() {
    const firestore = getFirestore();
    const rtdb = getDatabase();
    const boards = await firestore.collection('boardShares').get();
    for (const board of boards.docs) {
        const config = board.data();
        const readersByEmail = {};
        const editorsByEmail = {};
        for (const [email, collaborator] of Object.entries(config.collaborators ?? {})) {
            readersByEmail[email.toLowerCase()] = true;
            if (collaborator?.role === 'editor')
                editorsByEmail[email.toLowerCase()] = true;
        }
        for (const email of config.invitedEmails ?? [])
            readersByEmail[String(email).toLowerCase()] = true;
        await rtdb.ref(`boardAccess/${board.id}`).set({
            ownerId: config.ownerId ?? null,
            publicRead: config.generalAccess === 'anyone_with_link',
            publicWrite: config.generalAccess === 'anyone_with_link' && config.generalRole === 'editor',
            readersByEmail,
            editorsByEmail,
        });
        console.log(`Backfilled ${board.id}`);
    }
}
void run();
