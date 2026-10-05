# Excalidraw image compatibility and placement cursor

`@excalidraw__excalidraw@0.18.1.patch` accepts the ICO MIME alias `image/vnd.microsoft.icon` alongside Excalidraw's existing image whitelist. Chrome supplies that alias for `.ico` files, while upstream 0.18.1 accepts only `image/x-icon` despite listing ICO in its picker.

The patch also replaces the pending image preview cursor with `move`, after image decoding/cache initialization completes. It removes the extra thumbnail encoding for the custom cursor. Excalidraw's existing placement/cancellation handlers still reset the cursor; direct insertion keeps its existing reset behavior.

Both `dist/dev` and `dist/prod` are patched. The generated production diff is large because the upstream artifact is minified. The upstream picker, file decoding, and byte persistence remain intact. The format E2E suite asserts `move` before placement and a cleared pending image/no `wait` cursor after placement for every format.

pnpm applies this version-scoped patch on install through `pnpm-workspace.yaml`; the lockfile contains its content hash. When updating Excalidraw, check whether upstream accepts both ICO MIME types and supports the desired placement cursor, then remove or rebase the patch. Run `pnpm test:images:formats`, `pnpm test:images:formats:cloud`, and `pnpm test:images:formats:prod-bundle` after changing it.
