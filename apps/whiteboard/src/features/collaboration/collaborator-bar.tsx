import React, { memo, useState } from 'react'
import type { CollaboratorPresence, CollabUser } from './types'

interface CollaboratorBarProps {
  currentUser?: CollabUser | null
  collaborators: CollaboratorPresence[]
}

export function getCollaboratorInitials(displayName: string, isAnonymous?: boolean): string {
  if (isAnonymous || displayName.startsWith('Anonymous ')) {
    const city = displayName.replace(/^Anonymous\s*/i, '').trim()
    const cityLetter = city.length > 0 ? city[0].toUpperCase() : 'A'
    return `A${cityLetter}`
  }
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
  }
  return displayName.slice(0, 2).toUpperCase()
}

interface AvatarItemProps {
  displayName: string
  color: string
  avatarUrl?: string
  isAnonymous?: boolean
  isSelf?: boolean
}

const AvatarItem = memo(function AvatarItem({ displayName, color, avatarUrl, isAnonymous, isSelf }: AvatarItemProps) {
  const [imgError, setImgError] = useState(false)
  const initials = getCollaboratorInitials(displayName, isAnonymous)
  const title = isSelf ? `${displayName} (You)` : displayName
  const showImage = Boolean(avatarUrl && !imgError)

  return (
    <div className="collab-avatar" style={{ backgroundColor: color }} title={title} aria-label={title}>
      {showImage ? (
        <img src={avatarUrl} alt={displayName} className="collab-avatar-img" onError={() => setImgError(true)} />
      ) : (
        <span className="collab-avatar-initials">{initials}</span>
      )}
      <span className="collab-status-dot" />
    </div>
  )
})

export const CollaboratorBar = memo(function CollaboratorBar({ collaborators }: CollaboratorBarProps) {
  if (!collaborators || collaborators.length === 0) return null

  // Limit display to 5 active collaborators with an overflow badge
  const displayCollaborators = collaborators.slice(0, 5)
  const overflowCount = Math.max(0, collaborators.length - 5)

  return (
    <div className="collab-bar">
      {/* Remote Collaborators */}
      {displayCollaborators.map((collab) => (
        <AvatarItem
          key={collab.sessionId}
          displayName={collab.displayName}
          color={collab.color}
          avatarUrl={collab.avatarUrl}
          isAnonymous={collab.isAnonymous}
        />
      ))}

      {/* Overflow Indicator */}
      {overflowCount > 0 ? (
        <div className="collab-overflow" title={`${overflowCount} more collaborator${overflowCount > 1 ? 's' : ''}`}>
          +{overflowCount}
        </div>
      ) : null}
    </div>
  )
})
