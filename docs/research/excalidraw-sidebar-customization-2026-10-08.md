# Excalidraw sidebar customization exploration

Date: 2026-10-08. Scope: public customization APIs and upstream source for our installed `@excalidraw/excalidraw@0.18.1`; no implementation change.

## Recommendation

Move Slides into the existing **default sidebar** as another tab, preserving native Library, canvas search, close and docking behavior. A vertical external icon rail can control that sidebar through the public API. The desktop structure needs no additional patch. Runtime testing exposed a responsive fallback bug in 0.18.1, so production adoption needs a small lifecycle fix. Exact replacement of the native header is a separate extension; its public customization options are limited.

## What the installed version supports

| Requirement                         | Public support in 0.18.1                                           | Constraints                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Slides beside Library/search        | `DefaultSidebar` children containing `Sidebar.Tab tab="slides"`    | Built-in Library/search tabs remain present.                                                |
| Add a native Slides tab button      | `DefaultSidebar.TabTriggers` containing `Sidebar.TabTrigger`       | Appends to the existing search/Library header buttons; does not replace them.               |
| External vertical icon rail         | App-owned buttons calling `api.toggleSidebar`                      | Use name `default` and explicit tab; keep rail outside disappearing sidebar content.        |
| Only one panel open                 | Native `appState.openSidebar`                                      | It contains a single sidebar name and optional tab.                                         |
| Native docking                      | Leave `DefaultSidebar` docking props unset                         | Retains preference; search is force-docked when feasible.                                   |
| Custom close/Present actions        | App-owned content in Slides tab; custom `Sidebar.Header` available | DefaultSidebar already renders one global header; adding another Header duplicates headers. |
| Preserve state on switching/closing | App-owned state above sidebar                                      | Native sidebar contents unmount on close; tab contents have no supported `forceMount` prop. |
| Width                               | CSS customization                                                  | Width is based on `--right-sidebar-width`; no public width or drag-resize API.              |

These conclusions follow the tagged [DefaultSidebar implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/DefaultSidebar.tsx), [Sidebar implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/Sidebar/Sidebar.tsx), and [SidebarTab implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/Sidebar/SidebarTab.tsx). Installed declarations confirm both components are public exports and the corresponding props exist.

## Rail behavior and trigger caveat

For icon click, `api.toggleSidebar({ name: "default", tab: "slides" })` toggles that exact tab: clicking another icon switches tabs; clicking the active icon closes. Add `force: true` when the desired behavior is always opening or selecting. Observe active state through `DefaultSidebar.onStateChange` or the API change subscription. [Tagged API implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/App.tsx#L3963-L4002), [official API documentation](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api#togglesidebar).

Do **not** use one `Sidebar.Trigger` per default-sidebar tab without a wrapper: in 0.18.1 its checkbox checks only sidebar name. Clicking a second trigger while `default` is already open closes it rather than switching tabs. `DefaultSidebar.Trigger` is also tunneled into the editor's existing Library-button location, so it is suitable for replacing that button's content, not positioning an independent rail. [Trigger implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/Sidebar/SidebarTrigger.tsx), [DefaultSidebar implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/DefaultSidebar.tsx).

The external rail should carry the `sidebar-trigger` class or another deliberate outside-click exemption: native outside-click handling exempts that class. Otherwise an icon event can close an undocked panel before the app selects the next tab. [Sidebar outside-click implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/Sidebar/Sidebar.tsx#L87-L125).

## State, previews and mobile

Keep slide selection, notes drafts, preview cache, prewarming and presentation session in the existing board-level controller above the tab. Restore Slides scroll position explicitly after remount. Moving the controller into `Sidebar.Tab` would unnecessarily reset those resources. The current tab wrapper renders Radix Content without `forceMount`; relying on inactive-tab local state persistence is unsafe. [SidebarTab source](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/Sidebar/SidebarTab.tsx).

`UIOptions.dockedSidebarBreakpoint` governs whether the pin button appears and whether a docked sidebar reserves room for editor controls. Below the breakpoint the sidebar overlays the editor and closes on outside click/Escape, even when docking preference remains set. Native sidebar logic handles this; the new rail still needs app CSS for small screens and safe-area spacing. A compact horizontal row on mobile is an app design choice, not an automatic feature of the rail. [Official UIOptions](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/ui-options#dockedsidebarbreakpoint), [Sidebar source](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/Sidebar/Sidebar.tsx), [header pin eligibility](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/Sidebar/SidebarHeader.tsx).

## What needs styling versus a patch

- **App styling only:** vertical rail; tab-active appearance; hide redundant native horizontal triggers; rail-aware right offsets; consistent native theme variables. Those selectors need regression tests on dependency upgrades.
- **App implementation only:** panel registry, tab routing, tooltip/accessibility labels, state and scroll retention; optional resize handle.
- **Patch or upstream API extension:** a clean default-header replacement slot that preserves Library/search internals, arbitrary repositioning/reordering/removal of built-in header triggers through props, native drag resizing.

The default header and Library/search renderers are hard-coded inside `DefaultSidebar`; public child insertion and trigger tunnels do not replace them. A scoped CSS adaptation is enough for an initial rail, but a header slot is preferable if we insist on entirely removing or restructuring that native header. [DefaultSidebar source](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/DefaultSidebar.tsx#L87-L106).

Width should use the same `--right-sidebar-width` value for the panel and docked UI reservation. The editor sets `302px` inline on its root, so overriding it from a parent does not work without changing the root value or overriding that declaration. Avoid changing only `.sidebar` width: native LayerUI would reserve the wrong amount of space. Adding a rail requires accounting for its width too. [Root width declaration](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/App.tsx#L1545-L1555), [sidebar CSS](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/Sidebar/Sidebar.scss#L3-L39), [LayerUI reservation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/LayerUI.tsx#L520-L535).

## Documentation/version caveats

Current [official Sidebar docs](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/children-components/sidebar) cover composition, custom triggers and docking but do not explain `DefaultSidebar`'s extension tunnels. They also list `Sidebar.style`; our installed 0.18.1 `SidebarProps` has `className` but no typed `style` prop. Use installed declarations and tagged source as the compatibility boundary rather than assuming everything on current docs works unchanged.

Validation for the eventual change should cover switching Slides/Library/search, repeated active-icon clicks, outside clicks, dock/undock, small-screen overlay behavior, notes/cache/scroll retention, and clean audience/Speaker View windows. A disposable runtime probe also passed against our installed package: Slides/Library/search switching, one sidebar, external rail, docking, draft retention above the tab, local tab state resetting, CSS width override, and narrow-screen outside-click close. Run `node tests/sidebar-customization-probe.mjs`; it creates and removes its own standalone fixture without changing the board UI. Screenshots are saved under `.system_generated/sidebar-exploration/`.

## Runtime proof and a version-specific blocker

The reproducible [browser probe](../../tests/sidebar-customization-probe.mjs) uses native Excalidraw with disposable fixtures; it does not change the app implementation or installed package files. Desktop checks confirmed native Library/search/Slides switching, a single sidebar, active-icon collapse, header close, docking, persistent external rail, and CSS width customization. A draft held by the parent survived tab changes and collapse; a component-local counter reset, confirming that tab contents remount.

**Responsive bug:** after resizing from desktop to mobile, unmodified 0.18.1 renders two `.sidebar` elements. The newly mounted native fallback covers the app-provided sidebar, leaving the custom Slides tab apparently empty. Merely detecting the notes element as “visible” is insufficient: it can exist in the covered instance. The probe checks sidebar count as well as content.

The underlying [withInternalFallback implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/hoc/withInternalFallback.tsx) subscribes to a mount-count atom but decides whether to show the fallback using an instance-local snapshot of that count. A responsive fallback remount can leave this snapshot stale. In the isolated probe, reading the current subscribed count for the `> 1` check fixes the duplication. This is a two-line source adjustment, applied only during the probe's in-memory dependency transformation.

- `node tests/sidebar-customization-probe.mjs`: reproduces the mobile failure (`2 !== 1`).
- `SIDEBAR_FALLBACK_FIX=1 node tests/sidebar-customization-probe.mjs`: passes all checks, including a single mobile sidebar and outside-click closing below the docking breakpoint.

This validates the candidate fix in development. Applying it to our dependency patch still requires matching the production bundle and regression checks for the other components that use this shared fallback helper. No production fix was applied during this exploration.

Probe screenshots: [desktop](../../.system_generated/sidebar-exploration/candidate-fix/desktop-slides.png), [narrow screen with candidate fix](../../.system_generated/sidebar-exploration/candidate-fix/narrow-slides.png). The fixture is a behavior probe, not a proposed visual design.

## Proposed integration in our app

1. In `board-editor.tsx`, render one `DefaultSidebar` inside `Excalidraw`, containing a `Sidebar.Tab` for Slides. Keep native Library and search. Use the existing `openSidebar` state as the single source of truth.
2. Add an app-owned right icon rail outside the collapsible content. Reserve its width in the editor layout rather than overlaying board controls. Route each icon through the exact-tab API; hide Slides when the board has no slides. Remove the redundant native Library launcher through scoped styling or a controlled trigger replacement.
3. Split the existing `SlidesPanel` into a board-level controller and tab content. Keep selection, notes drafts, preview cache, warm-up and presentation/Speaker View lifecycle above the tab. Cancel thumbnail warm-up while Slides is inactive; restore its scroll position on remount. Presentation must continue independently of sidebar visibility.
4. Remove floating Slides positioning and the mutual-close workaround. Add a small default-header slot to our existing dependency patch if we want title, Present, pin and collapse on one row without CSS rearrangement. The slot should reuse `Sidebar.Header` so native close/dock behavior remains intact.
5. Apply and test the responsive fallback fix. Add end-to-end checks for active-icon collapse, Library/Slides/search switching, docking, desktop-to-mobile and back, notes/cache/scroll retention, presentation survival and read-only access.

Sidebar selection is local UI state. Our current board save path persists theme/background/grid/snap settings and elements, not `openSidebar`; no backend or collaboration-protocol changes are required for this integration. Keep future panel definitions small (id, label, icon, visibility and content), rather than introducing another sidebar state system.
