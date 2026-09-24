import { useMemo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Calendar, Check, Clock, Copy, FileText, HardDrive, Info, Layers, User } from 'lucide-react'
import { useUser } from '../lib/user-context'
import { useAuth } from '../lib/auth-context'

export interface BoardInfoDropdownProps {
  boardName: string
  createdAt?: string
  updatedAt?: string
  projectOwnerId?: string
  version?: number
  getSceneSize: () => { bytes: number; elementsCount: number }
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const val = bytes / Math.pow(k, i)
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${sizes[i]}`
}

function formatTimestamp(isoString?: string | null): { formatted: string; relative: string } {
  if (!isoString) return { formatted: '—', relative: '' }
  const date = new Date(isoString)
  if (isNaN(date.getTime())) return { formatted: '—', relative: '' }

  const formatted = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date)

  const diffMs = Date.now() - date.getTime()
  let relative: string
  if (diffMs < 0 || diffMs < 45_000) {
    relative = 'just now'
  } else if (diffMs < 3_600_000) {
    const mins = Math.floor(diffMs / 60_000)
    relative = `${mins}m ago`
  } else if (diffMs < 86_400_000) {
    const hours = Math.floor(diffMs / 3_600_000)
    relative = `${hours}h ago`
  } else {
    const days = Math.floor(diffMs / 86_400_000)
    relative = days === 1 ? 'yesterday' : `${days}d ago`
  }

  return { formatted, relative }
}

export function BoardInfoDropdown({
  boardName,
  createdAt,
  updatedAt,
  projectOwnerId,
  version,
  getSceneSize,
}: BoardInfoDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const { fullName, user } = useUser()
  const { user: authUser } = useAuth()

  // Compute live scene size and element count when popover is open
  const sceneData = useMemo(() => {
    if (!isOpen) return { bytes: 0, elementsCount: 0 }
    return getSceneSize()
  }, [isOpen, getSceneSize])

  const filename = useMemo(() => {
    const trimmed = (boardName || 'Untitled').trim()
    return trimmed.toLowerCase().endsWith('.excalidraw') ? trimmed : `${trimmed}.excalidraw`
  }, [boardName])

  const isCurrentOwner =
    !projectOwnerId ||
    projectOwnerId === 'local-user' ||
    projectOwnerId === authUser?.uid

  const ownerName = isCurrentOwner
    ? `${fullName || authUser?.displayName || 'User'} (You)`
    : projectOwnerId

  const ownerEmail = isCurrentOwner ? (user?.email || authUser?.email) : undefined

  const updatedTime = useMemo(() => formatTimestamp(updatedAt), [updatedAt])
  const createdTime = useMemo(() => formatTimestamp(createdAt), [createdAt])

  const handleCopyFilename = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(filename)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="board-info-trigger"
          title="Board details"
          aria-label="Board details"
        >
          <Info size={14} />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="board-info-popover animate-fade-in"
          align="end"
          sideOffset={8}
        >
          <div className="board-info-header">
            <span className="board-info-header-title">Board details</span>
          </div>

          <div className="board-info-list">
            {/* 1. Filename */}
            <div className="board-info-item">
              <div className="board-info-item-label">
                <FileText size={14} className="board-info-item-icon" />
                <span>Filename</span>
              </div>
              <div className="board-info-item-value-wrap">
                <span className="board-info-item-value board-info-item-value--filename" title={filename}>
                  {filename}
                </span>
                <button
                  type="button"
                  className="board-info-copy-btn"
                  onClick={handleCopyFilename}
                  title="Copy filename"
                  aria-label="Copy filename"
                >
                  {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                </button>
              </div>
            </div>

            {/* Version */}
            {typeof version === 'number' && (
              <div className="board-info-item">
                <div className="board-info-item-label">
                  <Layers size={14} className="board-info-item-icon" />
                  <span>Version</span>
                </div>
                <div className="board-info-item-value-wrap">
                  <span className="board-info-item-value">v{version}</span>
                </div>
              </div>
            )}

            {/* 2. Owner */}
            <div className="board-info-item">
              <div className="board-info-item-label">
                <User size={14} className="board-info-item-icon" />
                <span>Owner</span>
              </div>
              <div className="board-info-item-value-wrap board-info-item-value-wrap--stacked">
                <span className="board-info-item-value" title={ownerName}>
                  {ownerName}
                </span>
                {ownerEmail && (
                  <span className="board-info-item-subtext" title={ownerEmail}>
                    {ownerEmail}
                  </span>
                )}
              </div>
            </div>

            {/* 3. Last updated at */}
            <div className="board-info-item">
              <div className="board-info-item-label">
                <Clock size={14} className="board-info-item-icon" />
                <span>Last updated at</span>
              </div>
              <div className="board-info-item-value-wrap board-info-item-value-wrap--stacked">
                <span className="board-info-item-value" title={updatedTime.formatted}>
                  {updatedTime.formatted}
                </span>
                {updatedTime.relative && (
                  <span className="board-info-item-subtext">
                    ({updatedTime.relative})
                  </span>
                )}
              </div>
            </div>

            {/* 4. Created at */}
            <div className="board-info-item">
              <div className="board-info-item-label">
                <Calendar size={14} className="board-info-item-icon" />
                <span>Created at</span>
              </div>
              <div className="board-info-item-value-wrap">
                <span className="board-info-item-value" title={createdTime.formatted}>
                  {createdTime.formatted}
                </span>
              </div>
            </div>

            {/* 5. File size */}
            <div className="board-info-item">
              <div className="board-info-item-label">
                <HardDrive size={14} className="board-info-item-icon" />
                <span>File size</span>
              </div>
              <div className="board-info-item-value-wrap board-info-item-value-wrap--stacked">
                <span className="board-info-item-value">
                  {formatBytes(sceneData.bytes)}
                </span>
                <span className="board-info-item-subtext">
                  {sceneData.elementsCount} element{sceneData.elementsCount === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
