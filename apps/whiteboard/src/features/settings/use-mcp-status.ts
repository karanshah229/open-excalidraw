import { useCallback, useEffect, useRef, useState } from 'react'

export type McpServerStatus = 'checking' | 'running' | 'offline' | 'blocked'
export type DeviceAccessPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown'

export interface McpStatusInfo {
  status: McpServerStatus
  isChecking: boolean
  isRetriggering: boolean
  bridgeUrl: string
  lastChecked: Date | null
  error?: string
  isStarting: boolean
  isStopping: boolean
  managedByVite: boolean
  permissionState: DeviceAccessPermissionState
  isPermissionBlocked: boolean
  checkStatus: () => void
  retriggerPermission: () => Promise<void>
  startServer: () => Promise<void>
  stopServer: () => Promise<void>
}

const LOCAL_NETWORK_PERMISSION_NAMES = [
  'loopback-network',
  'local-network',
  'local-network-access',
]

async function queryDevicePermission(): Promise<{
  state: DeviceAccessPermissionState
  permissionStatus?: PermissionStatus
}> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
    return { state: 'unknown' }
  }
  for (const name of LOCAL_NETWORK_PERMISSION_NAMES) {
    try {
      const res = await navigator.permissions.query({ name: name as any })
      return { state: res.state as DeviceAccessPermissionState, permissionStatus: res }
    } catch {
      // Permission descriptor not supported by this browser version
    }
  }
  return { state: 'unknown' }
}

export function useMcpStatus(): McpStatusInfo {
  const bridgeUrl = import.meta.env.VITE_MCP_BRIDGE_URL ?? 'ws://127.0.0.1:8787'
  const [status, setStatus] = useState<McpServerStatus>('checking')
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [isStarting, setIsStarting] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [managedByVite, setManagedByVite] = useState(false)
  const [permissionState, setPermissionState] = useState<DeviceAccessPermissionState>('unknown')
  const [isPermissionBlocked, setIsPermissionBlocked] = useState(false)
  const [isRetriggering, setIsRetriggering] = useState(false)

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

  const checkStatus = useCallback(async () => {
    setStatus('checking')
    setError(undefined)
    void checkViteProcess()

    // 1. Check browser device access permission
    const perm = await queryDevicePermission()
    setPermissionState(perm.state)

    if (perm.state === 'denied') {
      setIsPermissionBlocked(true)
      setStatus('blocked')
      setError('Access to apps and services on this device was blocked by your browser.')
      setLastChecked(new Date())
      return
    }

    setIsPermissionBlocked(false)

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

      timerRef.current = window.setTimeout(async () => {
        if (!resolved) {
          resolved = true
          const recheck = await queryDevicePermission()
          if (recheck.state === 'denied') {
            setIsPermissionBlocked(true)
            setPermissionState('denied')
            setStatus('blocked')
            setError('Access to apps and services on this device was blocked by your browser.')
          } else {
            setStatus('offline')
            setError('Connection timed out. Ensure the MCP server is running.')
          }
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
          setIsPermissionBlocked(false)
          setStatus('running')
          setError(undefined)
          setLastChecked(new Date())
          setTimeout(() => {
            try {
              ws.close()
            } catch {
              /* ignore */
            }
          }, 500)
        }
      }

      ws.onerror = async () => {
        if (!resolved) {
          resolved = true
          if (timerRef.current) window.clearTimeout(timerRef.current)
          const recheck = await queryDevicePermission()
          if (recheck.state === 'denied') {
            setIsPermissionBlocked(true)
            setPermissionState('denied')
            setStatus('blocked')
            setError('Access to apps and services on this device was blocked by your browser.')
          } else {
            setStatus('offline')
            setError('Failed to connect to MCP server bridge.')
          }
          setLastChecked(new Date())
        }
      }

      ws.onclose = async () => {
        if (!resolved) {
          resolved = true
          if (timerRef.current) window.clearTimeout(timerRef.current)
          const recheck = await queryDevicePermission()
          if (recheck.state === 'denied') {
            setIsPermissionBlocked(true)
            setPermissionState('denied')
            setStatus('blocked')
            setError('Access to apps and services on this device was blocked by your browser.')
          } else {
            setStatus('offline')
          }
          setLastChecked(new Date())
        }
      }
    } catch (err) {
      if (!resolved) {
        resolved = true
        const recheck = await queryDevicePermission()
        if (recheck.state === 'denied') {
          setIsPermissionBlocked(true)
          setPermissionState('denied')
          setStatus('blocked')
          setError('Access to apps and services on this device was blocked by your browser.')
        } else {
          setStatus('offline')
          setError(err instanceof Error ? err.message : 'Failed to connect')
        }
        setLastChecked(new Date())
      }
    }
  }, [bridgeUrl, checkViteProcess])

  const retriggerPermission = useCallback(async () => {
    setIsRetriggering(true)
    setStatus('checking')
    setError(undefined)

    try {
      const perm = await queryDevicePermission()
      setPermissionState(perm.state)

      if (perm.state === 'denied') {
        setIsPermissionBlocked(true)
        setStatus('blocked')
        setError('Permission is still blocked in your browser settings. Follow the instructions to allow access.')
        setLastChecked(new Date())
        return
      }

      setIsPermissionBlocked(false)

      // Probe loopback to trigger the browser prompt if state is 'prompt'
      try {
        await fetch('http://127.0.0.1:8787/', { mode: 'no-cors' }).catch(() => {})
      } catch {
        /* ignore */
      }

      await checkStatus()
    } finally {
      setIsRetriggering(false)
    }
  }, [checkStatus])

  const startServer = useCallback(async () => {
    if (isPermissionBlocked) {
      setError('Cannot start server while device access is blocked by your browser.')
      return
    }
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
      void checkStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start')
      void checkStatus()
    } finally {
      setIsStarting(false)
    }
  }, [bridgeUrl, checkStatus, isPermissionBlocked])

  const stopServer = useCallback(async () => {
    if (isPermissionBlocked) {
      setError('Cannot stop server while device access is blocked by your browser.')
      return
    }
    setIsStopping(true)
    try {
      await fetch('/api/mcp/stop', { method: 'POST' })
      setManagedByVite(false)
      await new Promise((r) => setTimeout(r, 600))
      void checkStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop')
    } finally {
      setIsStopping(false)
    }
  }, [checkStatus, isPermissionBlocked])

  // Watch for permission changes
  useEffect(() => {
    let active = true
    let cleanup: (() => void) | undefined

    void queryDevicePermission().then(({ permissionStatus, state }) => {
      if (!active) return
      setPermissionState(state)
      if (state === 'denied') {
        setIsPermissionBlocked(true)
        setStatus('blocked')
      }
      if (permissionStatus) {
        const handler = () => {
          const updatedState = permissionStatus.state as DeviceAccessPermissionState
          setPermissionState(updatedState)
          if (updatedState === 'denied') {
            setIsPermissionBlocked(true)
            setStatus('blocked')
          } else {
            setIsPermissionBlocked(false)
            void checkStatus()
          }
        }
        permissionStatus.addEventListener('change', handler)
        cleanup = () => permissionStatus.removeEventListener('change', handler)
      }
    })

    return () => {
      active = false
      if (cleanup) cleanup()
    }
  }, [checkStatus])

  // Re-check on tab focus in case user changed browser site settings
  useEffect(() => {
    const handleFocus = async () => {
      const perm = await queryDevicePermission()
      setPermissionState(perm.state)
      if (perm.state === 'denied') {
        setIsPermissionBlocked(true)
        setStatus('blocked')
      } else if (isPermissionBlocked && perm.state === 'granted') {
        setIsPermissionBlocked(false)
        void checkStatus()
      }
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [checkStatus, isPermissionBlocked])

  useEffect(() => {
    void checkStatus()
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
    isChecking: status === 'checking',
    isRetriggering,
    bridgeUrl,
    lastChecked,
    error,
    isStarting,
    isStopping,
    managedByVite,
    permissionState,
    isPermissionBlocked,
    checkStatus,
    retriggerPermission,
    startServer,
    stopServer,
  }
}
