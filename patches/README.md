# Excalidraw image compatibility and placement cursor

`@excalidraw__excalidraw@0.18.1.patch` accepts the ICO MIME alias `image/vnd.microsoft.icon` alongside Excalidraw's existing image whitelist. Chrome supplies that alias for `.ico` files, while upstream 0.18.1 accepts only `image/x-icon` despite listing ICO in its picker.

The patch also replaces the pending image preview cursor with `move`, after image decoding/cache initialization completes. It removes the extra thumbnail encoding for the custom cursor. Excalidraw's existing placement/cancellation handlers still reset the cursor; direct insertion keeps its existing reset behavior.

Both `dist/dev` and `dist/prod` are patched. The generated production diff is large because the upstream artifact is minified. The upstream picker, file decoding, and byte persistence remain intact. The format E2E suite asserts `move` before placement and a cleared pending image/no `wait` cursor after placement for every format.

pnpm applies this version-scoped patch on install through `pnpm-workspace.yaml`; the lockfile contains its content hash. When updating Excalidraw, check whether upstream accepts both ICO MIME types and supports the desired placement cursor, then remove or rebase the patch. Run `pnpm test:images:formats`, `pnpm test:images:formats:cloud`, and `pnpm test:images:formats:prod-bundle` after changing it.

## Slide frames

The same patch adds two optional host props: `frameTool: { label, createCustomData(elements) }` and `getFrameLabel(frame, elements)`. The first adds **Components → Slide** beside ordinary Frame, keeps tool intent local to the engine, and tags the frame at native creation time so metadata and drawing share one undo step. The second derives the displayed slide number without changing the saved native frame name or its title editor. The ordinary Frame action/shortcut resets slide intent.

These hooks are forwarded through the engine wrapper and typed in its declarations. Both development and production artifacts must be patched together. Rebase these narrow hooks when upgrading Excalidraw, preserving the existing ICO/cursor changes. Run `pnpm test:slides`, `pnpm test:slides:prod`, and the image suites above after patch changes.

## Experimental shared sidebar

`DefaultSidebar` accepts an optional `header` React node, allowing the host to supply its section title/actions through `Sidebar.Header` while preserving native pin and close behavior. Default tab content (Library and Search) and host-added tabs share the native sidebar. Both bundles and the generated props declaration expose this addition.

The internal host/fallback arbitration now reads the subscribed render count rather than the instance's registration snapshot. That snapshot can be stale when desktop/mobile trees remount and previously let the fallback and host render together. Development and production slideshow browser suites cover a single sidebar across desktop/mobile resizing and tab switching. Recheck this arbitration when upgrading Excalidraw; retain the native sidebar as the single visibility/docking owner.

Resize observation also triggers a render when editor breakpoints change. Window resize can update dimensions before the observer runs; without this render, the native device context and pin/mobile controls could remain stale until the next scene change. Responsive browser checks cover this behavior in both bundles.
