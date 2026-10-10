const PINNED_KEY = 'agentic-whiteboard:sidebar-pinned:v1'

export function readSidebarPinned(): boolean {
  try {
    return localStorage.getItem(PINNED_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveSidebarPinned(pinned: boolean): void {
  try {
    localStorage.setItem(PINNED_KEY, String(pinned))
  } catch {
    // Native sidebar still works when browser storage is unavailable.
  }
}
