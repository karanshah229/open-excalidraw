import { useCallback, useEffect, useRef, useState } from 'react'

export type McpServerStatus = 'checking' | 'running' | 'offline'

export interface McpStatusInfo {
  status: McpServerStatus
  bridgeUrl: string
  lastChecked: Date | null
  error?: string
  isStarting: boolean
  isStopping: boolean
  managedByVite: boolean
  checkStatus: () => void
  startServer: () => Promise<void>
  stopServer: () => Promise<void>
}

export function useMcpStatus(): McpStatusInfo {
  const bridgeUrl = import.meta.env.VITE_MCP_BRIDGE_URL ?? 'ws://127.0.0.1:8787'
  const [status, setStatus] = useState<McpServerStatus>('checking')
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [isStarting, setIsStarting] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [managedByVite, setManagedByVite] = useState(false)
  const socketRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<number | null>(null)

  const checkViteProcess = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp/process')
      if (res.ok) {
        const data = (await res.json()) as { running: boolean }
        setManagedByVite(Boolean(data.running))
      }
    } catch {
      /* not running with vite dev server or endpoint unavailable */
    }
  }, [])

  const checkStatus = useCallback(() => {
    setStatus('checking')
    setError(undefined)
    checkViteProcess()

    if (socketRef.current) {
      try {
        socketRef.current.close()
      } catch {
        /* ignore */
      }
      socketRef.current = null
    }

    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
    }

    let resolved = false

    try {
      const ws = new WebSocket(bridgeUrl)
      socketRef.current = ws

      timerRef.current = window.setTimeout(() => {
        if (!resolved) {
          resolved = true
          setStatus('offline')
          setError('Connection timed out. Ensure the MCP server is running.')
          setLastChecked(new Date())
          try {
            ws.close()
          } catch {
            /* ignore */
          }
        }
      }, 2500)

      ws.onopen = () => {
        if (!resolved) {
          resolved = true
          if (timerRef.current) window.clearTimeout(timerRef.current)
          setStatus('running')
          setError(undefined)
          setLastChecked(new Date())
          // Close probe socket gently after verifying connection
          setTimeout(() => {
            try {
              ws.close()
            } catch {
              /* ignore */
            }
          }, 500)
        }
      }

      ws.onerror = () => {
        if (!resolved) {
          resolved = true
          if (timerRef.current) window.clearTimeout(timerRef.current)
          setStatus('offline')
          setError('Failed to connect to MCP server bridge.')
          setLastChecked(new Date())
        }
      }

      ws.onclose = () => {
        if (!resolved) {
          resolved = true
          if (timerRef.current) window.clearTimeout(timerRef.current)
          setStatus('offline')
          setLastChecked(new Date())
        }
      }
    } catch (err) {
      if (!resolved) {
        resolved = true
        setStatus('offline')
        setError(err instanceof Error ? err.message : 'Failed to connect')
        setLastChecked(new Date())
      }
    }
  }, [bridgeUrl, checkViteProcess])

  const startServer = useCallback(async () => {
    setIsStarting(true)
    setError(undefined)
    try {
      const res = await fetch('/api/mcp/start', { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to start MCP server')
      }
      setManagedByVite(true)

      // Poll until connected
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 600))
        const isOnline = await new Promise<boolean>((resolve) => {
          try {
            const probe = new WebSocket(bridgeUrl)
            const timeout = setTimeout(() => {
              probe.close()
              resolve(false)
            }, 1000)
            probe.onopen = () => {
              clearTimeout(timeout)
              probe.close()
              resolve(true)
            }
            probe.onerror = () => {
              clearTimeout(timeout)
              resolve(false)
            }
          } catch {
            resolve(false)
          }
        })

        if (isOnline) {
          setStatus('running')
          setLastChecked(new Date())
          setIsStarting(false)
          return
        }
      }
      checkStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start')
      checkStatus()
    } finally {
      setIsStarting(false)
    }
  }, [bridgeUrl, checkStatus])

  const stopServer = useCallback(async () => {
    setIsStopping(true)
    try {
      await fetch('/api/mcp/stop', { method: 'POST' })
      setManagedByVite(false)
      await new Promise((r) => setTimeout(r, 600))
      checkStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop')
    } finally {
      setIsStopping(false)
    }
  }, [checkStatus])

  useEffect(() => {
    checkStatus()
    return () => {
      if (socketRef.current) {
        try {
          socketRef.current.close()
        } catch {
          /* ignore */
        }
      }
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [checkStatus])

  return {
    status,
    bridgeUrl,
    lastChecked,
    error,
    isStarting,
    isStopping,
    managedByVite,
    checkStatus,
    startServer,
    stopServer,
  }
}
