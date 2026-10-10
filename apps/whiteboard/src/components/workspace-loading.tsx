import { createContext, useCallback, useContext, useId, useLayoutEffect, useState, type ReactNode } from 'react'

type LoadingPhase = { message: string; percentage?: number }
const LoadingContext = createContext<((id: string, phase: LoadingPhase | null) => void) | null>(null)

/** Keep one spinner mounted while authentication, routes and data hand off loading. */
export function GlobalLoadingProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Map<string, LoadingPhase>>(() => new Map())
  const update = useCallback((id: string, phase: LoadingPhase | null) => {
    setMessages((previous) => {
      const next = new Map(previous)
      if (phase === null) next.delete(id)
      else next.set(id, phase)
      return next
    })
  }, [])
  const phase = Array.from(messages.values()).at(-1)

  return (
    <LoadingContext.Provider value={update}>
      {children}
      <div
        className="workspace-startup-loader"
        hidden={!phase}
        role="status"
        aria-live="polite"
        aria-label={phase?.message}
      >
        <span className="workspace-loader-mark" aria-hidden="true" />
        <p>{phase?.message}</p>
        {phase?.percentage !== undefined && (
          <span className="workspace-loading-percentage" aria-label="Board loading progress">
            {phase.percentage}%
          </span>
        )}
      </div>
    </LoadingContext.Provider>
  )
}

/** Declare a loading phase without creating another loading screen. */
export function WorkspaceLoading({
  message = 'Loading boards…',
  percentage,
}: {
  message?: string
  percentage?: number
}) {
  const update = useContext(LoadingContext)
  const id = useId()
  if (!update) throw new Error('WorkspaceLoading requires GlobalLoadingProvider')
  useLayoutEffect(() => {
    update(id, { message, percentage })
  }, [id, message, percentage, update])
  useLayoutEffect(() => () => update(id, null), [id, update])
  return null
}
