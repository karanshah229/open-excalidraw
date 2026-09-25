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
  type Database,
} from 'firebase/database'
import { ref as storageRef, uploadBytes, getDownloadURL, type FirebaseStorage } from 'firebase/storage'
import type { CollaboratorPresence, CollabUser, ElementDeltaRecord } from './types'

export const MAX_ELEMENT_PAYLOAD_BYTES = 262144 // 256KB
export const STALE_PRESENCE_TIMEOUT_MS = 15000 // 15 seconds

export function cleanPayload<T extends Record<string, any>>(obj: T): T {
  const clean: any = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      clean[key] = value
    }
  }
  return clean
}

export class CollaborationService {
  private rtdb: Database | undefined
  private storage: FirebaseStorage | undefined
  private activeSessionId: string | null = null
  private heartbeatInterval: number | null = null
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

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleWake)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline)
    }

    // 3. Heartbeat every 10 seconds: keeps presence fresh AND self-heals complete profile if wiped
    if (this.heartbeatInterval && typeof window !== 'undefined') {
      window.clearInterval(this.heartbeatInterval)
    }
    if (typeof window !== 'undefined') {
      this.heartbeatInterval = window.setInterval(() => {
        if (!this.rtdb || !this.activeSessionId || !this.isConnected) return
        try {
          void update(
            presenceRef,
            cleanPayload({
              userId: user.uid,
              sessionId: user.sessionId,
              displayName: user.displayName,
              color: user.color,
              avatarUrl: user.avatarUrl,
              isAnonymous: user.isAnonymous,
              lastSeen: Date.now(),
            }),
          )
        } catch {
          // silent heartbeat ignore
        }
      }, 10000)
    }

    // Return cleanup function
    return () => {
      if (this.heartbeatInterval && typeof window !== 'undefined') {
        window.clearInterval(this.heartbeatInterval)
        this.heartbeatInterval = null
      }
      unsubConnected()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleWake)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline)
      }
      if (this.rtdb) {
        try {
          void onDisconnect(presenceRef).cancel()
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
    this.currentCursor = cursor
    this.currentSelectedElementIds = selectedElementIds
    if (!this.rtdb) return
    try {
      const presenceRef = ref(this.rtdb, `presence/${boardId}/${sessionId}`)
      await update(
        presenceRef,
        cleanPayload({
          cursor,
          selectedElementIds,
          lastSeen: Date.now(),
        }),
      )
    } catch {
      // silent ignore when offline
    }
  }

  /**
   * Subscribes to live presence in the room. Filters out stale cursors, corrupt nodes, and own session.
   * Periodically prunes expired collaborators automatically.
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
      const now = Date.now()
      const active: CollaboratorPresence[] = []

      for (const [key, presence] of Object.entries(latestRawPresence)) {
        if (!presence || key === currentSessionId) continue
        // Validate presence integrity
        if (!presence.displayName || !presence.color) continue
        // Filter out ghost entries that missed heartbeats
        if (now - presence.lastSeen < STALE_PRESENCE_TIMEOUT_MS) {
          active.push(presence)
        }
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

      // Periodic check every 5s so disconnected collaborators disappear without needing incoming DB events
      const pruneInterval = typeof window !== 'undefined' ? window.setInterval(filterAndEmitActive, 5000) : null

      return () => {
        unsubValue()
        if (pruneInterval !== null && typeof window !== 'undefined') {
          window.clearInterval(pruneInterval)
        }
      }
    } catch {
      return () => {}
    }
  }

  // ==========================================
  // ELEMENT DELTA SYNC
  // ==========================================

  /**
   * Broadcasts element mutations as deltas to RTDB.
   * Validates size limit to prevent memory exhaustion / vandalism.
   */
  async broadcastElementDeltas(boardId: string, elements: any[], authorUid: string): Promise<void> {
    if (!this.rtdb || elements.length === 0) return

    const now = Date.now()
    const updates: Record<string, ElementDeltaRecord> = {}

    for (const elem of elements) {
      if (!elem || !elem.id) continue
      const serialized = JSON.stringify(elem)
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
