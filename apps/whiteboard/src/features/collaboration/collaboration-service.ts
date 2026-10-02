import {
  ref,
  set,
  update,
  onValue,
  onChildAdded,
  onChildChanged,
  onDisconnect,
  remove,
  goOnline,
  goOffline,
  type Database,
} from 'firebase/database'
import { ref as storageRef, uploadBytes, getDownloadURL, type FirebaseStorage } from 'firebase/storage'
import type { CollaboratorPresence, CollabUser, ElementDeltaRecord } from './types'

export const MAX_ELEMENT_PAYLOAD_BYTES = 262144 // 256KB

export function cleanPayload<T extends Record<string, any>>(obj: T): T {
  const clean: any = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      if (typeof value === 'number') {
        if (Number.isFinite(value)) clean[key] = value
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        clean[key] = cleanPayload(value)
      } else {
        clean[key] = value
      }
    }
  }
  return clean
}

export class CollaborationService {
  private rtdb: Database | undefined
  private storage: FirebaseStorage | undefined
  private activeSessionId: string | null = null
  private currentCursor: { x: number; y: number } | null = null
  private currentSelectedElementIds: string[] = []
  private isConnected: boolean = false

  constructor(rtdb?: Database, storage?: FirebaseStorage) {
    this.rtdb = rtdb
    this.storage = storage
  }

  setDatabase(rtdb: Database) {
    this.rtdb = rtdb
  }

  setStorage(storage: FirebaseStorage) {
    this.storage = storage
  }

  goOffline() {
    if (this.rtdb) {
      try {
        goOffline(this.rtdb)
      } catch {
        // ignore
      }
    }
  }

  goOnline() {
    if (this.rtdb) {
      try {
        goOnline(this.rtdb)
      } catch {
        // ignore
      }
    }
  }

  // ==========================================
  // PRESENCE & CURSORS
  // ==========================================

  /**
   * Initializes presence for the current session on the given board.
   * Listens to .info/connected to automatically re-arm onDisconnect and re-publish presence
   * after OS sleep/wake, network drops, or socket reconnects.
   */
  async joinBoardPresence(boardId: string, user: CollabUser): Promise<() => void> {
    if (!this.rtdb) return () => {}

    this.activeSessionId = user.sessionId
    const presenceRef = ref(this.rtdb, `presence/${boardId}/${user.sessionId}`)
    const connectedRef = ref(this.rtdb, '.info/connected')

    const publishPresence = async () => {
      if (!this.rtdb || !this.activeSessionId) return
      try {
        // 1. Re-arm server-side cleanup when WebSocket drops
        await onDisconnect(presenceRef).remove()

        // 2. Set full presence state (clean payload to prevent RTDB undefined errors)
        const presencePayload = cleanPayload({
          userId: user.uid,
          sessionId: user.sessionId,
          displayName: user.displayName,
          color: user.color,
          avatarUrl: user.avatarUrl,
          isAnonymous: user.isAnonymous,
          cursor: this.currentCursor,
          selectedElementIds: this.currentSelectedElementIds,
          joinedAt: user.joinedAt || Date.now(),
          lastSeen: Date.now(),
        })
        await set(presenceRef, presencePayload)
      } catch (err: any) {
        console.warn('[Collab] RTDB presence sync deferred or unavailable:', err?.message)
      }
    }

    // 1. Connection lifecycle listener: fires initially AND on every socket reconnection
    const unsubConnected = onValue(
      connectedRef,
      (snapshot) => {
        const connected = Boolean(snapshot.val())
        this.isConnected = connected
        if (connected) {
          void publishPresence()
        }
      },
      (err) => {
        console.warn('[Collab] .info/connected listener warning:', err?.message)
      },
    )

    // 2. OS sleep / tab visibility / online resume handlers
    const handleWake = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && this.rtdb) {
        try {
          goOnline(this.rtdb)
        } catch {
          // ignore
        }
        if (this.isConnected) {
          void publishPresence()
        }
      }
    }

    const handleOnline = () => {
      if (this.rtdb) {
        try {
          goOnline(this.rtdb)
        } catch {
          // ignore
        }
        if (this.isConnected) {
          void publishPresence()
        }
      }
    }

    const handleUnload = () => {
      if (this.rtdb && this.activeSessionId) {
        try {
          void remove(presenceRef)
        } catch {
          // ignore
        }
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleWake)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline)
      window.addEventListener('beforeunload', handleUnload)
      window.addEventListener('pagehide', handleUnload)
    }

    // Return cleanup function
    return () => {
      unsubConnected()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleWake)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline)
        window.removeEventListener('beforeunload', handleUnload)
        window.removeEventListener('pagehide', handleUnload)
      }
      if (this.rtdb) {
        try {
          // Trigger immediate client removal without cancelling server-side onDisconnect
          // so if network is lost during unmount, RTDB server still purges the presence
          void remove(presenceRef)
        } catch {
          // ignore cleanup error on unmount
        }
      }
      this.activeSessionId = null
      this.isConnected = false
    }
  }

  /**
   * Updates current user's cursor position and selection (throttled by caller).
   */
  async updatePresence(
    boardId: string,
    sessionId: string,
    cursor: { x: number; y: number } | null,
    selectedElementIds: string[] = [],
  ): Promise<void> {
    const validCursor =
      cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y) ? { x: cursor.x, y: cursor.y } : null
    this.currentCursor = validCursor
    this.currentSelectedElementIds = selectedElementIds
    if (!this.rtdb) return
    try {
      const presenceRef = ref(this.rtdb, `presence/${boardId}/${sessionId}`)
      await update(
        presenceRef,
        cleanPayload({
          cursor: validCursor,
          selectedElementIds,
          lastSeen: Date.now(),
        }),
      )
    } catch (err: any) {
      console.warn('[Collab] updatePresence error:', err?.message)
    }
  }

  /**
   * Sets a presence record directly (used in test suites or multi-user simulations).
   */
  async injectPresence(boardId: string, presence: CollaboratorPresence): Promise<void> {
    if (!this.rtdb) return
    const presenceRef = ref(this.rtdb, `presence/${boardId}/${presence.sessionId}`)
    await set(presenceRef, cleanPayload(presence))
  }

  /**
   * Removes a presence record directly.
   */
  async removePresence(boardId: string, sessionId: string): Promise<void> {
    if (!this.rtdb) return
    const presenceRef = ref(this.rtdb, `presence/${boardId}/${sessionId}`)
    await remove(presenceRef)
  }

  /**
   * Subscribes to live presence in the room. RTDB disconnect cleanup—not a
   * client-clock timeout—is authoritative for whether an idle peer is live.
   */
  subscribeToPresence(
    boardId: string,
    currentSessionId: string,
    callback: (activeCollaborators: CollaboratorPresence[]) => void,
  ): () => void {
    if (!this.rtdb) return () => {}
    const roomPresenceRef = ref(this.rtdb, `presence/${boardId}`)

    let latestRawPresence: Record<string, CollaboratorPresence> = {}

    const filterAndEmitActive = () => {
      const active: CollaboratorPresence[] = []

      for (const [key, presence] of Object.entries(latestRawPresence)) {
        if (!presence || key === currentSessionId) continue
        // Validate presence integrity
        if (!presence.displayName || !presence.color) continue
        active.push(presence)
      }

      callback(active)
    }

    try {
      const unsubValue = onValue(
        roomPresenceRef,
        (snapshot) => {
          if (!snapshot.exists()) {
            latestRawPresence = {}
            callback([])
            return
          }

          latestRawPresence = (snapshot.val() as Record<string, CollaboratorPresence>) || {}
          filterAndEmitActive()
        },
        (error) => {
          console.warn('[Collab] Presence subscription warning:', error?.message)
          callback([])
        },
      )

      return () => {
        unsubValue()
      }
    } catch {
      return () => {}
    }
  }

  // ==========================================
  // ELEMENT DELTA SYNC
  // ==========================================

  /**
   * Broadcasts a complete canonical element record to RTDB.
   *
   * RTDB retains only the latest value at an element path. Persisting a patch
   * there makes crash recovery impossible once the original full element has
   * been overwritten. The wire record is deliberately complete; versions and
   * nonces still provide LWW conflict resolution.
   */
  async broadcastElementDeltas(
    boardId: string,
    elements: any[],
    authorUid: string,
    previousElementsMap?: Map<string, any>,
  ): Promise<void> {
    if (!this.rtdb || elements.length === 0) return

    const now = Date.now()
    const updates: Record<string, ElementDeltaRecord> = {}

    for (const elem of elements) {
      if (!elem || !elem.id) continue

      const canonicalElement = cleanPayload({ ...elem, lastModifiedBy: authorUid })
      const serialized = JSON.stringify(canonicalElement)

      if (serialized.length > MAX_ELEMENT_PAYLOAD_BYTES) {
        console.warn(`[Collab] Element ${elem.id} exceeds 256KB payload limit. Skipping broadcast.`)
        continue
      }

      updates[`boards/${boardId}/elements/${elem.id}`] = {
        id: elem.id,
        version: Number(elem.version ?? 1),
        versionNonce: Number(elem.versionNonce ?? 0),
        lastModifiedBy: authorUid,
        updatedAt: now,
        data: serialized,
      }
    }

    if (Object.keys(updates).length > 0) {
      try {
        const rootRef = ref(this.rtdb)
        await update(rootRef, updates)
      } catch (err: any) {
        console.warn('[Collab] Element delta broadcast deferred or offline:', err?.message)
      }
    }
  }

  /**
   * Subscribes to element delta updates in RTDB.
   */
  subscribeToElements(boardId: string, onDeltaReceived: (element: any, meta: ElementDeltaRecord) => void): () => void {
    if (!this.rtdb) return () => {}
    const elementsRef = ref(this.rtdb, `boards/${boardId}/elements`)

    const handleSnapshot = (snap: any) => {
      const val = snap.val() as ElementDeltaRecord | null
      if (!val || !val.data) return
      try {
        const element = JSON.parse(val.data)
        onDeltaReceived(element, val)
      } catch (err) {
        console.error('[Collab] Failed to parse remote element delta:', err)
      }
    }

    try {
      const unsubAdd = onChildAdded(elementsRef, handleSnapshot, (err) => {
        console.warn('[Collab] Elements child_added subscription warning:', err?.message)
      })
      const unsubChange = onChildChanged(elementsRef, handleSnapshot, (err) => {
        console.warn('[Collab] Elements child_changed subscription warning:', err?.message)
      })

      return () => {
        unsubAdd()
        unsubChange()
      }
    } catch {
      return () => {}
    }
  }

  /**
   * Clears ephemeral elements for a board in RTDB when room downgrades to solo.
   */
  async clearBoardElements(boardId: string): Promise<void> {
    if (!this.rtdb) return
    try {
      const elementsRef = ref(this.rtdb, `boards/${boardId}/elements`)
      await remove(elementsRef)
    } catch {
      // ignore
    }
  }

  // ==========================================
  // ASSET / IMAGE DECOUPLING
  // ==========================================

  /**
   * Uploads an embedded image asset directly to Firebase Storage.
   * Decouples large binary blobs from RTDB.
   */
  async uploadImageAsset(boardId: string, fileId: string, dataUrl: string, mimeType = 'image/png'): Promise<string> {
    if (!this.storage) {
      throw new Error('Firebase Storage is not initialized')
    }

    const assetStorageRef = storageRef(this.storage, `boards/${boardId}/assets/${fileId}`)
    const blob = await fetch(dataUrl).then((res) => res.blob())
    await uploadBytes(assetStorageRef, blob, { contentType: mimeType })
    return getDownloadURL(assetStorageRef)
  }

  // ==========================================
  // STORAGE SNAPSHOT & COMPACTION
  // ==========================================

  /**
   * Prunes deleted tombstones and uploads full scene snapshot to Firebase Storage.
   */
  async saveSceneSnapshot(boardId: string, elements: any[], appState: Record<string, unknown>): Promise<void> {
    if (!this.storage) return

    // Prune deleted elements older than 5 minutes
    const cleanElements = elements.filter((e) => !e.isDeleted)
    const snapshotPayload = {
      elements: cleanElements,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor || '#ffffff',
      },
      updatedAt: new Date().toISOString(),
    }

    const json = JSON.stringify(snapshotPayload)
    const blob = new Blob([json], { type: 'application/json' })
    const snapshotRef = storageRef(this.storage, `boards/${boardId}/snapshots/latest.json`)
    await uploadBytes(snapshotRef, blob)
  }
}

/**
 * Creates a minimal delta patch of changed properties against the previous known element.
 * If previousElement is not provided (newly created element), returns the full element.
 */
export function createDeltaPatch(currentElement: any, previousElement?: any): any {
  if (!previousElement || !currentElement) {
    return currentElement
  }

  const patch: Record<string, any> = {
    id: currentElement.id,
    type: currentElement.type,
    version: Number(currentElement.version ?? 1),
    versionNonce: Number(currentElement.versionNonce ?? 0),
  }
  if (currentElement.lastModifiedBy) {
    patch.lastModifiedBy = currentElement.lastModifiedBy
  }

  // Find all keys that differ from previous state
  for (const [key, value] of Object.entries(currentElement)) {
    if (key === 'id' || key === 'type' || key === 'version' || key === 'versionNonce' || key === 'lastModifiedBy') {
      continue
    }
    const prevValue = previousElement[key]
    if (JSON.stringify(value) !== JSON.stringify(prevValue)) {
      // JSON serialization drops undefined, which would turn a removal into a
      // no-op on peers. Use null as the explicit wire representation instead.
      patch[key] = value === undefined ? null : value
    }
  }

  // A delta must represent removals too. Without this, removing a link,
  // binding, frame, or optional style leaves the old value on every peer.
  for (const key of Object.keys(previousElement)) {
    if (
      key === 'id' ||
      key === 'type' ||
      key === 'version' ||
      key === 'versionNonce' ||
      key === 'lastModifiedBy' ||
      Object.prototype.hasOwnProperty.call(currentElement, key)
    ) {
      continue
    }
    patch[key] = null
  }

  return patch
}

/**
 * Compares all persisted element properties other than replication metadata.
 * Excalidraw undo may restore an older version while changing text, points,
 * bindings, or styles, so geometry-only comparisons lose valid user edits.
 */
export function haveElementPropertiesChanged(previousElement: any, currentElement: any): boolean {
  if (!previousElement || !currentElement) return previousElement !== currentElement
  const ignored = new Set(['version', 'versionNonce', 'lastModifiedBy', 'updated'])
  const keys = new Set([...Object.keys(previousElement), ...Object.keys(currentElement)])
  for (const key of keys) {
    if (ignored.has(key)) continue
    const previousValue = previousElement[key]
    const currentValue = currentElement[key]
    if (JSON.stringify(previousValue) !== JSON.stringify(currentValue)) return true
  }
  return false
}

/**
 * Merges a remote delta patch over a local element baseline.
 */
export function applyDeltaPatch(localElement: any, patch: any): any {
  if (!localElement) {
    return patch
  }
  return {
    ...localElement,
    ...patch,
  }
}

/**
 * Validates that an element has minimum required properties to be a complete Excalidraw element.
 * Prevents partial delta patches from entering the scene without a local baseline.
 */
export function isValidExcalidrawElement(elem: any): boolean {
  return Boolean(
    elem &&
    typeof elem.id === 'string' &&
    typeof elem.type === 'string' &&
    typeof elem.x === 'number' &&
    !isNaN(elem.x) &&
    typeof elem.y === 'number' &&
    !isNaN(elem.y) &&
    typeof elem.width === 'number' &&
    !isNaN(elem.width) &&
    typeof elem.height === 'number' &&
    !isNaN(elem.height),
  )
}

/**
 * Deterministically computes whether a session is granted Active Editor status (capped at maxEditors, default 10).
 * Sorted by joinedAt ascending, tie-broken by sessionId.
 */
export function computeSessionEditorStatus(
  collaborators: CollaboratorPresence[],
  mySessionId: string,
  myJoinedAt: number,
  maxEditors = 10,
): { isEditor: boolean; editorCount: number; totalCount: number; rank: number } {
  const allSessionsMap = new Map<string, { sessionId: string; joinedAt: number }>()

  // My session
  allSessionsMap.set(mySessionId, {
    sessionId: mySessionId,
    joinedAt: myJoinedAt,
  })

  // Add remote collaborators
  for (const c of collaborators) {
    if (c && c.sessionId) {
      allSessionsMap.set(c.sessionId, {
        sessionId: c.sessionId,
        joinedAt: c.joinedAt ?? c.lastSeen ?? Date.now(),
      })
    }
  }

  const sorted = Array.from(allSessionsMap.values()).sort((a, b) => {
    if (a.joinedAt !== b.joinedAt) {
      return a.joinedAt - b.joinedAt
    }
    return a.sessionId.localeCompare(b.sessionId)
  })

  const rank = sorted.findIndex((s) => s.sessionId === mySessionId)
  const isEditor = rank >= 0 && rank < maxEditors
  const editorCount = Math.min(sorted.length, maxEditors)

  return {
    isEditor,
    editorCount,
    totalCount: sorted.length,
    rank: rank + 1,
  }
}
