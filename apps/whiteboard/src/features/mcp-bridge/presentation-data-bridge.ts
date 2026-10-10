import { useEffect, useMemo, useRef } from 'react'
import { createSlideDataHandler, slideDataOperations, type SlideDataContext } from './slide-data-operations'

/** Presentation recipients have a data adapter, never an editor mutation adapter. */
export function usePresentationDataBridge(context: SlideDataContext | null) {
  const latest = useRef(context)
  latest.current = context
  const handler = useMemo(createSlideDataHandler, [context?.boardId, context?.identity])
  const socketRef = useRef<WebSocket>()
  useEffect(() => () => handler.clear(), [handler])
  const enabled = Boolean(context?.role)
  useEffect(() => {
    if (!enabled) return
    let disposed = false,
      retry: number | undefined
    const publish = () => {
      const current = latest.current,
        socket = socketRef.current
      if (!current?.role || socket?.readyState !== WebSocket.OPEN) return
      socket.send(
        JSON.stringify({
          type: 'scene',
          boardId: current.boardId,
          scene: {
            elements: current.scene.elements,
            appState: { viewBackgroundColor: current.scene.background, theme: current.scene.theme },
          },
          selectionIds: [],
        }),
      )
    }
    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(import.meta.env.VITE_MCP_BRIDGE_URL ?? 'ws://127.0.0.1:8787')
      socketRef.current = socket
      socket.onopen = publish
      socket.onmessage = async ({ data }) => {
        const message = JSON.parse(data)
        if (message.type !== 'operation') return
        const operation = message.operation,
          current = latest.current
        try {
          if (!current?.role || !slideDataOperations.has(operation.type))
            throw new Error('Presentation access permits data operations only; drawing mutations require an editor.')
          const result = await handler.handle(operation, current)
          if (!disposed && socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: 'operation_result', operationId: operation.id, ok: true, data: result }))
        } catch (error) {
          if (!disposed && socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: 'operation_result',
                operationId: operation.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            )
        }
      }
      socket.onclose = () => {
        if (!disposed) retry = window.setTimeout(connect, 5000)
      }
    }
    window.addEventListener('focus', publish)
    connect()
    return () => {
      disposed = true
      window.clearTimeout(retry)
      window.removeEventListener('focus', publish)
      socketRef.current?.close()
    }
  }, [enabled, context?.boardId, context?.identity, context?.role, handler])
  useEffect(() => {
    const socket = socketRef.current
    if (context?.role && socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: 'scene',
          boardId: context.boardId,
          scene: {
            elements: context.scene.elements,
            appState: { viewBackgroundColor: context.scene.background, theme: context.scene.theme },
          },
          selectionIds: [],
        }),
      )
  }, [context?.scene.elements, context?.scene.background, context?.scene.theme])
}
