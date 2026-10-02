# Image upload persistence

The editor previously saved image elements without Excalidraw's separate binary-file map. Reloading restored an element's `fileId` but none of its bytes. Firebase Storage was initialized and had a standalone upload helper, but the editor's persistence path did not use it.

The editor now captures the third `onChange` argument (`files`), saves it in the local IndexedDB scene, and supplies it to `initialData.files`. Board copies, previews, SVG exports, scene reconciliation, and transitions from collaboration retain the files. Optional `scene.files` preserves compatibility with older documents. Deleted elements retain their files for undo.

Cloud writes upload image bytes before committing scene references. Private workspace assets use `users/{uid}/boards/{boardId}/assets/{fileId}`; shared assets use `boards/{boardId}/assets/{fileId}`. Sharing a board copies its locally hydrated assets into the shared path after establishing its access policy. Firestore stores file metadata and `storagePath`, with an empty `dataURL`, so image bytes do not consume its document-size budget. Reads use authenticated Firebase Storage `getBytes` and hydrate data URLs before rendering. Shared snapshots also deliver assets to active collaborators.

Image IDs identify immutable content. Uploads are deduplicated within a browser session. Upload failures reject the cloud save; local bytes remain available for retry. Images at or above 10 MiB are retained locally but cannot sync. Assets are retained for undo; garbage collection after board deletion is a separate lifecycle concern.

## Deployment

1. Enable a Firebase Storage bucket for the target project and set `VITE_FIREBASE_STORAGE_BUCKET` to its exact name in the relevant app environment.
2. Deploy `storage.rules` with `firebase deploy --only storage --project YOUR_PROJECT_ID`. Private workspace paths require their owner; shared paths follow the board's access policy.
3. Configure the bucket's CORS policy to allow `GET` from the deployed app origins and any development origins. Direct SDK browser downloads require bucket CORS configuration ([Firebase documentation](https://firebase.google.com/docs/storage/web/download-files#cors_configuration)). Example configuration:

   ```json
   [{ "origin": ["https://YOUR_APP_ORIGIN", "http://127.0.0.1:5173"], "method": ["GET"], "maxAgeSeconds": 3600 }]
   ```

   Save this as `cors.json`, then apply it with `gsutil cors set cors.json gs://YOUR_BUCKET_NAME`.

4. Build and deploy the updated app. Keep existing Firebase Auth and App Check configuration valid for the deployed origin.

Old scenes whose image bytes were never saved cannot reconstruct them from `fileId`; reinsert those images once after this fix.

## Verification

- `node tests/image-persistence.test.mjs`: real editor save/reload against IndexedDB with Firebase disabled. Failed before the fix because the restored image data was undefined.
- `firebase emulators:exec --only auth,firestore,storage --project demo-image-persistence --config image-persistence.firebase.json 'node tests/image-persistence.test.mjs --cloud'`: private workspace cloud sync and shared-board upload/download, Firestore metadata-only storage, denied private reads by another identity, and rejection of missing upload bytes.
- `pnpm check`: TypeScript checks for all workspace packages.
