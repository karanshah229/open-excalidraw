/** Synchronous mutation fence shared by editor timers, note drafts and async command handlers. */
export type HistoryEditingState = { blocked: boolean; epoch: number; generation?: number; restoreFence?: number }
const states = new Map<string, HistoryEditingState>()
export function historyEditingState(boardId: string): HistoryEditingState {
  return states.get(boardId) ?? { blocked: false, epoch: 0 }
}
export function setHistoryEditingState(boardId: string, next: Omit<HistoryEditingState, 'epoch'>, invalidate = false) {
  const previous = historyEditingState(boardId)
  if (!invalidate && previous.blocked === next.blocked && previous.generation === next.generation && previous.restoreFence === next.restoreFence) return previous
  const value = { ...next, epoch: previous.epoch + Number(invalidate || previous.blocked !== next.blocked || previous.generation !== next.generation) }
  states.set(boardId, value)
  window.dispatchEvent(new CustomEvent('board-history-editing-state', { detail: { boardId, ...value } }))
  return value
}
export function assertHistoryMutationAllowed(boardId: string, epoch?: number) {
  const state = historyEditingState(boardId)
  if (state.blocked || (epoch !== undefined && epoch !== state.epoch))
    throw new Error('Board restoration paused this mutation. Reload the current board before retrying.')
}
