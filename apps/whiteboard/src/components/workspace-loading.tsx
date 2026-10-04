/** One stable startup screen across authentication and workspace discovery. */
export function WorkspaceLoading() {
  return (
    <div className="workspace-startup-loader" role="status" aria-live="polite" aria-label="Loading workspace">
      <span className="workspace-loader-mark" aria-hidden="true" />
      <p>Fetching your ideas…</p>
    </div>
  )
}
