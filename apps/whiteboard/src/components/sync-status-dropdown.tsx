import { useMemo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import {
  AlertCircle,
  AlertTriangle,
  Calendar,
  Check,
  ChevronDown,
  Clock,
  Cloud,
  Copy,
  FileText,
  HardDrive,
  Info,
  Layers,
  Loader2,
  RefreshCw,
  User,
} from 'lucide-react'
import { useUser } from '../lib/user-context'
import { useAuth } from '../lib/auth-context'

export type EditorStatus =
  'Loading board' | 'Saving' | 'Synced locally' | 'Synced' | 'Sync failed' | 'Conflict' | 'Local save failed'

export interface SyncStatusDropdownProps {
  state: EditorStatus
  onKeepLocalConflict?: () => void
  lastSyncError?: string | null
  boardName: string
  createdAt?: string
  updatedAt?: string
  projectOwnerId?: string
  version?: number
  getSceneSize: () => { bytes: number; elementsCount: number }
}

interface StatusConfig {
  title: string
  description: string
  icon: typeof Check
  colorTheme: 'synced' | 'local' | 'saving' | 'error' | 'conflict'
}

function getStatusConfig(state: EditorStatus): StatusConfig {
  switch (state) {
    case 'Synced':
      return {
        title: 'All changes saved',
        description: 'Synced to cloud and this device.',
        icon: Cloud,
        colorTheme: 'synced',
      }
    case 'Synced locally':
      return {
        title: 'Synced locally',
        description: 'Saved to this device. Syncing to cloud.',
        icon: HardDrive,
        colorTheme: 'local',
      }
    case 'Saving':
      return {
        title: 'Saving',
        description: 'Saving edits',
        icon: Loader2,
        colorTheme: 'saving',
      }
    case 'Conflict':
      return {
        title: 'Sync conflict',
        description: 'Remote changes conflict with local edits.',
        icon: AlertTriangle,
        colorTheme: 'conflict',
      }
    case 'Sync failed':
      return {
        title: 'Cloud sync paused',
        description: 'Saved on this device. Retrying cloud sync.',
        icon: AlertCircle,
        colorTheme: 'error',
      }
    case 'Local save failed':
      return {
        title: 'Local save failed',
        description: 'Could not save on this device. Your latest edits may be unsaved.',
        icon: AlertCircle,
        colorTheme: 'error',
      }
    default:
      return {
        title: 'Sync status unavailable',
        description: 'Unable to determine whether the latest edits were saved.',
        icon: AlertCircle,
        colorTheme: 'error',
      }
  }
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

export function SyncStatusDropdown({
  state,
  onKeepLocalConflict,
  lastSyncError,
  boardName,
  createdAt,
  updatedAt,
  projectOwnerId,
  version,
  getSceneSize,
}: SyncStatusDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const { fullName, user } = useUser()
  const { user: authUser } = useAuth()

  const config = getStatusConfig(state)
  const StatusIcon = config.icon

  // Compute live scene size and element count when popover is open
  const sceneData = useMemo(() => {
    if (!isOpen) return { bytes: 0, elementsCount: 0 }
    return getSceneSize()
  }, [isOpen, getSceneSize])

  const filename = useMemo(() => {
    const trimmed = (boardName || 'Untitled').trim()
    return trimmed.toLowerCase().endsWith('.excalidraw') ? trimmed : `${trimmed}.excalidraw`
  }, [boardName])

  const isCurrentOwner = !projectOwnerId || projectOwnerId === 'local-user' || projectOwnerId === authUser?.uid

  const ownerName = isCurrentOwner ? `${fullName || authUser?.displayName || 'User'} (You)` : projectOwnerId

  const ownerEmail = isCurrentOwner ? user?.email || authUser?.email : undefined
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

  const pillType =
    state === 'Synced'
      ? 'saved'
      : state === 'Synced locally'
        ? 'local'
        : state === 'Sync failed' || state === 'Local save failed' || state === 'Conflict'
          ? 'error'
          : 'saving'

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`sync-status-pill sync-status-pill--${pillType}`}
          title="Click to view sync status and board details"
          aria-label="Sync status and board details"
        >
          {state === 'Synced' ? (
            <Check size={13} className="sync-status-icon sync-status-icon--saved" />
          ) : state === 'Synced locally' ? (
            <HardDrive size={13} className="sync-status-icon sync-status-icon--local" />
          ) : state === 'Sync failed' || state === 'Local save failed' || state === 'Conflict' ? (
            <AlertCircle size={13} className="sync-status-icon sync-status-icon--error" />
          ) : (
            <Loader2 size={13} className="sync-status-icon sync-status-icon--saving animate-spin" />
          )}
          <span>{state}</span>
          <span className="sync-status-pill-separator" aria-hidden="true" />
          <Info size={12} className="sync-status-pill-info" />
          <ChevronDown size={11} className="sync-status-chevron" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content className="sync-status-popover animate-fade-in" align="end" sideOffset={8}>
          {/* 1. Sync Status Section */}
          <div className="sync-simple-row">
            <div className={`sync-simple-icon-wrap sync-simple-icon-wrap--${config.colorTheme}`}>
              <StatusIcon size={15} className={`sync-simple-icon ${state === 'Saving' ? 'animate-spin' : ''}`} />
            </div>
            <div className="sync-simple-text">
              <span className="sync-simple-title">{config.title}</span>
              <span className="sync-simple-desc">{config.description}</span>
            </div>
          </div>

          {state === 'Conflict' && onKeepLocalConflict && (
            <div className="sync-conflict-box">
              <button
                type="button"
                className="sync-conflict-btn"
                onClick={() => {
                  onKeepLocalConflict()
                  setIsOpen(false)
                }}
              >
                <RefreshCw size={12} />
                <span>Keep Local Version</span>
              </button>
            </div>
          )}

          {lastSyncError && (state === 'Sync failed' || state === 'Local save failed') && (
            <div className="sync-error-banner">
              <AlertCircle size={12} className="sync-error-banner-icon" />
              <span>{lastSyncError}</span>
            </div>
          )}

          {/* Divider */}
          <div className="sync-status-divider" />

          {/* 2. Board Details Section */}
          <div className="board-info-list">
            {/* Filename */}
            <div className="board-info-item">
              <div className="board-info-item-label">
                <FileText size={13} className="board-info-item-icon" />
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
                  <Layers size={13} className="board-info-item-icon" />
                  <span>Version</span>
                </div>
                <div className="board-info-item-value-wrap">
                  <span className="board-info-item-value">v{version}</span>
                </div>
              </div>
            )}

            {/* Owner */}
            <div className="board-info-item">
              <div className="board-info-item-label">
                <User size={13} className="board-info-item-icon" />
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

            {/* Last updated */}
            <div className="board-info-item">
              <div className="board-info-item-label">
                <Clock size={13} className="board-info-item-icon" />
                <span>Last updated</span>
              </div>
              <div className="board-info-item-value-wrap board-info-item-value-wrap--stacked">
                <span className="board-info-item-value" title={updatedTime.formatted}>
                  {updatedTime.formatted}
                </span>
                {updatedTime.relative && <span className="board-info-item-subtext">({updatedTime.relative})</span>}
              </div>
            </div>

            {/* Created */}
            <div className="board-info-item">
              <div className="board-info-item-label">
                <Calendar size={13} className="board-info-item-icon" />
                <span>Created</span>
              </div>
              <div className="board-info-item-value-wrap">
                <span className="board-info-item-value" title={createdTime.formatted}>
                  {createdTime.formatted}
                </span>
              </div>
            </div>

            {/* File size */}
            <div className="board-info-item">
              <div className="board-info-item-label">
                <HardDrive size={13} className="board-info-item-icon" />
                <span>File size</span>
              </div>
              <div className="board-info-item-value-wrap board-info-item-value-wrap--stacked">
                <span className="board-info-item-value">{formatBytes(sceneData.bytes)}</span>
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
