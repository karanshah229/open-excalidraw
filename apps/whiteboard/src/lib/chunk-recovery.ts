export const CHUNK_RECOVERY_KEY = 'agentic-whiteboard:chunk-recovery'

/** A deployment may remove chunks referenced by an already-open app shell. */
export function installChunkRecovery() {
  window.addEventListener('vite:preloadError', () => {
    // Never auto-reload an active drawing. Its unsaved work needs user control.
    if (document.querySelector('.excalidraw')) return
    try {
      const lastAttempt = Number(sessionStorage.getItem(CHUNK_RECOVERY_KEY) ?? 0)
      if (Date.now() - lastAttempt < 60_000) return
      sessionStorage.setItem(CHUNK_RECOVERY_KEY, String(Date.now()))
    } catch {
      // If the guard cannot persist, offer manual recovery rather than looping.
      return
    }
    window.location.reload()
  })
}
