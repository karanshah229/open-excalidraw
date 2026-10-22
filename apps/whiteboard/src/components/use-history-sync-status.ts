import { useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { getFirebaseAuth } from '../lib/firebase'

type HistorySyncStatus = { pending: number; failed: number; error?: string; checking: boolean }
const empty: HistorySyncStatus = { pending: 0, failed: 0, checking: false }

/** Current content and historical capture receipts are independent sync outcomes. */
export function useHistorySyncStatus(boardId: string | undefined, enabled: boolean, open: boolean): HistorySyncStatus {
  const [identity, setIdentity] = useState(() => getFirebaseAuth()?.currentUser?.uid)
  useEffect(() => {
    const auth = enabled ? getFirebaseAuth() : null
    if (!auth) {
      setIdentity(undefined)
      return
    }
    return onAuthStateChanged(auth, (user) => setIdentity(user?.uid))
  }, [enabled])
  const scope = enabled && boardId && identity ? `${identity}:${boardId}` : ''
  const [state, setState] = useState<HistorySyncStatus & { scope: string }>({ ...empty, scope: '' })
  useEffect(() => {
    if (!scope || !boardId || !identity) {
      setState({ ...empty, scope: '' })
      return
    }
    let disposed = false,
      reading = false,
      readAgain = false
    const stillCurrent = () => !disposed && getFirebaseAuth()?.currentUser?.uid === identity
    const refresh = async () => {
      if (!stillCurrent()) return
      if (reading) {
        readAgain = true
        return
      }
      reading = true
      try {
        const { boardHistoryStore } = await import('@agentic-whiteboard/storage')
        const entries = (await boardHistoryStore.listOutbox(boardId)).filter(
          (entry) => entry.identity === identity && !entry.receipt,
        )
        if (!stillCurrent()) return
        const blocked = entries.filter((entry) => entry.retryState === 'blocked')
        setState({
          scope,
          pending: entries.length,
          failed: blocked.length,
          error: blocked.find((entry) => entry.lastError)?.lastError,
          checking: false,
        })
      } catch (error) {
        if (stillCurrent())
          setState({
            scope,
            pending: 0,
            failed: 0,
            checking: false,
            error: error instanceof Error ? error.message : 'Could not read history upload status.',
          })
      } finally {
        reading = false
        if (readAgain && stillCurrent()) {
          readAgain = false
          void refresh()
        }
      }
    }
    const onBoardEvent = (event: Event) => {
      if ((event as CustomEvent<{ boardId?: string }>).detail?.boardId === boardId) void refresh()
    }
    const onRefresh = () => {
      void refresh()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    void refresh()
    window.addEventListener('board-history-local-save', onBoardEvent)
    window.addEventListener('board-history-sync-status', onBoardEvent)
    window.addEventListener(`board-sync:${boardId}`, onRefresh)
    window.addEventListener('focus', onRefresh)
    document.addEventListener('visibilitychange', onVisible)
    const timer = open ? window.setInterval(onVisible, 2000) : undefined
    return () => {
      disposed = true
      window.removeEventListener('board-history-local-save', onBoardEvent)
      window.removeEventListener('board-history-sync-status', onBoardEvent)
      window.removeEventListener(`board-sync:${boardId}`, onRefresh)
      window.removeEventListener('focus', onRefresh)
      document.removeEventListener('visibilitychange', onVisible)
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [scope, boardId, identity, open])
  if (!scope) return empty
  if (getFirebaseAuth()?.currentUser?.uid !== identity) return { ...empty, checking: true }
  return state.scope === scope ? state : { ...empty, checking: true }
}
