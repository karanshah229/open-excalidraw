import { memo, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import { exportToSvg } from '@excalidraw/excalidraw'
import { Share2, Trash2, Lock } from 'lucide-react'
import { useAuth } from '../../lib/auth-context'
import { useTheme } from '../../lib/theme-context'
import type { BoardScene } from '@agentic-whiteboard/storage'
import { sharingService } from '../sharing/sharing-service'
import type { WorkspaceBoard } from './workspace-api'

const statusCopy = {
  synced: 'Synced',
  'local-only': 'Synced locally',
  'sync-failed': 'Sync failed',
  conflict: 'Conflict',
} as const

const PREVIEW_CACHE_VERSION = 'v5'
const previewSvgCache = new Map<string, string>()

function isColorDark(hexColor: string | undefined): boolean {
  if (!hexColor || hexColor === 'transparent' || hexColor === 'none') return false
  let hex = hexColor.trim()
  if (hex.startsWith('#')) hex = hex.slice(1)
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  }
  if (hex.length !== 6) return false
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false
  const brightness = (r * 299 + g * 587 + b * 114) / 1000
  return brightness < 128
}

export const BoardPreview = memo(function BoardPreview({
  board,
  onDelete,
  onShare,
  busy = false,
}: {
  board: WorkspaceBoard
  index?: number
  onDelete?: (board: WorkspaceBoard) => void
  onShare?: (board: WorkspaceBoard) => void
  busy?: boolean
}) {
  const { resolvedTheme } = useTheme()
  const { user } = useAuth()
  const isOwner = board.project.ownerId === (user?.uid ?? 'local-user')
  const isDark = resolvedTheme === 'dark'

  const containerRef = useRef<HTMLDivElement>(null)
  const sceneKey = `${user?.uid ?? 'anonymous'}:${board.id}:${board.updatedAt}:${board.revision}`
  const [remoteScene, setRemoteScene] = useState<{ key: string; scene: BoardScene } | null>(null)
  const scene = board.scene ?? (remoteScene?.key === sceneKey ? remoteScene.scene : undefined)
  useEffect(() => {
    if (board.scene || !containerRef.current) return
    let live = true
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      void sharingService
        .getSharedBoard(board.id, user?.email, user?.uid)
        .then((result) => {
          if (live && result.status === 'allowed' && result.config?.scene)
            setRemoteScene({ key: sceneKey, scene: result.config.scene })
        })
        .catch(() => {
          /* Keep a neutral placeholder when access or network changes. */
        })
    })
    observer.observe(containerRef.current)
    return () => {
      live = false
      observer.disconnect()
    }
  }, [board.id, board.scene, sceneKey, user?.email, user?.uid])

  const rawBgColor = scene?.appState?.viewBackgroundColor as string | undefined
  const isDarkBg = isColorDark(rawBgColor)
  // In dark mode, preserve dark thumbnail styling; only show custom background if it is genuinely dark.
  // In light mode, allow custom non-transparent background.
  const customBgColor = isDark
    ? isDarkBg
      ? rawBgColor
      : undefined
    : rawBgColor && rawBgColor !== 'transparent' && rawBgColor !== 'none'
      ? rawBgColor
      : undefined

  const sceneVersion =
    scene?.elements
      .map((element: any) => `${element.id}:${element.version}:${element.versionNonce}:${element.isDeleted}`)
      .join(',') ?? 'unloaded'
  const cacheKey = `${PREVIEW_CACHE_VERSION}:${user?.uid ?? 'anonymous'}:${board.id}:${board.updatedAt}:${board.revision}:${sceneVersion}:${resolvedTheme}:${customBgColor ?? 'default'}`

  const [svgHtml, setSvgHtml] = useState<string | null>(() => {
    return previewSvgCache.get(cacheKey) ?? null
  })

  useEffect(() => {
    if (previewSvgCache.has(cacheKey)) {
      setSvgHtml(previewSvgCache.get(cacheKey)!)
      return
    }

    const elements = (scene?.elements ?? []).filter((el: any) => !el.isDeleted)
    if (elements.length === 0) {
      setSvgHtml(null)
      return
    }

    let isMounted = true

    exportToSvg({
      elements: elements as any,
      appState: {
        exportBackground: false,
        exportWithDarkMode: isDark,
        theme: resolvedTheme,
      },
      files: (scene?.files ?? {}) as BinaryFiles,
      exportPadding: 16,
      skipInliningFonts: true,
      renderEmbeddables: false,
    })
      .then((svg: SVGSVGElement) => {
        if (!isMounted) return
        svg.querySelector('.style-fonts')?.remove()

        if (isDark) {
          svg.style.filter = 'invert(93%) hue-rotate(180deg)'
        }

        const viewBoxAttr = svg.getAttribute('viewBox')
        let origMinX = 0
        let origMinY = 0
        let contentWidth = 0
        let contentHeight = 0

        if (viewBoxAttr) {
          const parts = viewBoxAttr.split(/\s+/).map(Number)
          if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
            origMinX = parts[0]
            origMinY = parts[1]
            contentWidth = parts[2]
            contentHeight = parts[3]
          }
        }

        if (!contentWidth) {
          contentWidth = parseFloat(svg.getAttribute('width') || '0')
          contentHeight = parseFloat(svg.getAttribute('height') || '0')
        }

        if (contentWidth > 0 && contentHeight > 0) {
          // Add width-wise padding (8%, min 24px) so borders are never clipped by the card edges
          const padX = Math.max(contentWidth * 0.08, 24)
          const padY = Math.max(contentHeight * 0.08, 16)
          const targetAspect = 126 / 320

          const vbWidth = contentWidth + padX * 2
          const vbHeight = vbWidth * targetAspect
          const vbX = origMinX - padX
          const vbY = contentHeight < vbHeight ? origMinY - (vbHeight - contentHeight) / 2 : origMinY - padY

          svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbWidth} ${vbHeight}`)
          svg.setAttribute('preserveAspectRatio', 'xMidYMin slice')
          svg.removeAttribute('width')
          svg.removeAttribute('height')
          svg.style.width = '100%'
          svg.style.height = '100%'
          svg.style.display = 'block'
        }

        const html = svg.outerHTML
        if (previewSvgCache.size >= 200) previewSvgCache.clear()
        previewSvgCache.set(cacheKey, html)
        setSvgHtml(html)
      })
      .catch((error: unknown) => {
        console.error('Failed to generate board preview:', error)
        if (isMounted) setSvgHtml(null)
      })

    return () => {
      isMounted = false
    }
  }, [board.id, board.updatedAt, scene, isDark, resolvedTheme, cacheKey])

  const handleDelete = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (onDelete) {
      onDelete(board)
    }
  }

  return (
    <Link to="/boards/$boardId" params={{ boardId: board.id }} className="board-card" data-board-id={board.id}>
      <div
        ref={containerRef}
        className="board-preview-container"
        data-has-custom-bg={customBgColor ? 'true' : 'false'}
        style={customBgColor ? { backgroundColor: customBgColor } : undefined}
      >
        {svgHtml ? (
          <div className="board-preview-svg" dangerouslySetInnerHTML={{ __html: svgHtml }} />
        ) : (
          <div className="board-preview-empty" style={customBgColor ? { backgroundColor: customBgColor } : undefined}>
            <span className="board-preview-empty__label">{scene ? 'Empty board' : 'Open to view board'}</span>
          </div>
        )}
        {board.isPrivate && (
          <span className="board-private-badge" title="Private board">
            <Lock size={12} />
            Private
          </span>
        )}
        {isOwner && onShare ? (
          <button
            type="button"
            className="board-card-share-btn"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onShare(board)
            }}
            disabled={busy}
            title="Share board"
            aria-label="Share board"
          >
            <Share2 size={14} />
          </button>
        ) : null}
        {isOwner && onDelete ? (
          <button
            type="button"
            disabled={busy}
            className="board-card-delete-btn"
            onClick={handleDelete}
            title="Delete board"
            aria-label="Delete board"
          >
            <Trash2 size={16} />
          </button>
        ) : null}
      </div>
      <div className="board-card__content">
        <div className="board-card-title-row">
          <strong>{board.name}</strong>
        </div>
        <span>
          {board.project.name} · Edited {relativeTime(board.updatedAt)}
        </span>
        <small className={`sync-state sync-state--${board.syncStatus}`}>{statusCopy[board.syncStatus]}</small>
      </div>
    </Link>
  )
})

function relativeTime(value: string) {
  const diff = Date.now() - new Date(value).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`
  return 'yesterday'
}
