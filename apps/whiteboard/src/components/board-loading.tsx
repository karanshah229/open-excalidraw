import { useLayoutEffect, useState } from 'react'
import { useLocation } from '@tanstack/react-router'
import { WorkspaceLoading } from './workspace-loading'

export function BoardLoading() {
  const pathname = useLocation({ select: (location) => location.pathname })
  const boardId = pathname.split('/')[2]
  const [progress, setProgress] = useState<{ boardId: string; percentage: number }>()

  useLayoutEffect(() => {
    const onProgress = (event: Event) => {
      const { completed, total } = (event as CustomEvent<{ completed: number; total: number }>).detail
      if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return
      setProgress({ boardId, percentage: Math.round(Math.min(1, Math.max(0, completed / total)) * 100) })
    }
    window.addEventListener(`board-load:${boardId}`, onProgress)
    return () => window.removeEventListener(`board-load:${boardId}`, onProgress)
  }, [boardId])

  return (
    <WorkspaceLoading
      message="Loading board…"
      percentage={progress?.boardId === boardId ? progress.percentage : undefined}
    />
  )
}
