import { useEffect, useState, useMemo, useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Globe, HelpCircle, Link2, Lock, Plus, Trash2, User as UserIcon } from 'lucide-react'
import { sharingService, type BoardShareConfig, type ShareAccessLevel } from '../features/sharing/sharing-service'
import { useAuth } from '../lib/auth-context'
import { useUser } from '../lib/user-context'
import type { BoardScene } from '@agentic-whiteboard/storage'

export interface ShareModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  boardId: string
  boardName: string
  ownerId?: string
  ownerName?: string
  ownerEmail?: string
  ownerPhotoURL?: string
  scene?: BoardScene
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ShareModal({
  open,
  onOpenChange,
  boardId,
  boardName,
  ownerId,
  ownerName,
  ownerEmail,
  ownerPhotoURL,
  scene,
}: ShareModalProps) {
  const { user: authUser } = useAuth()
  const { fullName, user: localUser } = useUser()

  const resolvedOwnerId = authUser?.uid || (ownerId && ownerId !== 'local-user' ? ownerId : 'local-user')
  const resolvedOwnerName = ownerName || fullName || authUser?.displayName || 'User'
  const resolvedOwnerEmail = ownerEmail || authUser?.email || localUser?.email || ''
  const resolvedOwnerPhoto = ownerPhotoURL || authUser?.photoURL || undefined

  const [shareConfig, setShareConfig] = useState<BoardShareConfig | null>(null)
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [imgError, setImgError] = useState(false)
  const copyTimeoutRef = useRef<number>()

  // Load current sharing configuration when modal opens
  useEffect(() => {
    if (!open) return
    let active = true

    sharingService
      .getShareConfig(boardId, {
        boardName,
        ownerId: resolvedOwnerId,
        ownerName: resolvedOwnerName,
        ownerEmail: resolvedOwnerEmail,
        ownerPhotoURL: resolvedOwnerPhoto,
        scene,
      })
      .then((config) => {
        if (active) {
          setShareConfig(config)
        }
      })

    return () => {
      active = false
      if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current)
    }
  }, [open, boardId, boardName, resolvedOwnerId, resolvedOwnerName, resolvedOwnerEmail, resolvedOwnerPhoto, scene])

  const effectiveConfig = useMemo<BoardShareConfig>(() => {
    if (shareConfig) {
      return {
        ...shareConfig,
        ownerId: authUser?.uid || (shareConfig.ownerId !== 'local-user' ? shareConfig.ownerId : 'local-user'),
        ownerName: shareConfig.ownerName || resolvedOwnerName,
        ownerEmail: shareConfig.ownerEmail || resolvedOwnerEmail,
        ownerPhotoURL: shareConfig.ownerPhotoURL || resolvedOwnerPhoto,
      }
    }
    return {
      boardId,
      boardName,
      ownerId: resolvedOwnerId,
      ownerName: resolvedOwnerName,
      ownerEmail: resolvedOwnerEmail,
      ownerPhotoURL: resolvedOwnerPhoto,
      generalAccess: 'restricted',
      generalRole: 'viewer',
      invitedEmails: [],
      collaborators: {},
      scene,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }, [
    shareConfig,
    boardId,
    boardName,
    authUser?.uid,
    resolvedOwnerId,
    resolvedOwnerName,
    resolvedOwnerEmail,
    resolvedOwnerPhoto,
    scene,
  ])

  const handleGeneralAccessChange = async (nextAccess: ShareAccessLevel) => {
    if (effectiveConfig.generalAccess === nextAccess) return
    const updated: BoardShareConfig = {
      ...effectiveConfig,
      generalAccess: nextAccess,
      scene: scene ?? effectiveConfig.scene,
    }
    setShareConfig(updated)
    try {
      await sharingService.saveShareConfig(updated)
    } catch (err) {
      console.error('Failed to update general access:', err)
    }
  }

  const handleGeneralRoleChange = async (nextRole: 'viewer' | 'editor') => {
    if (effectiveConfig.generalRole === nextRole) return
    const updated: BoardShareConfig = {
      ...effectiveConfig,
      generalRole: nextRole,
      scene: scene ?? effectiveConfig.scene,
    }
    setShareConfig(updated)
    try {
      await sharingService.saveShareConfig(updated)
    } catch (err) {
      console.error('Failed to update general role:', err)
    }
  }

  const handleCollaboratorRoleChange = async (email: string, role: 'viewer' | 'editor') => {
    const normalized = email.toLowerCase()
    const existing = effectiveConfig.collaborators[normalized]
    if (!existing || existing.role === role) return

    const updatedCollaborators = {
      ...effectiveConfig.collaborators,
      [normalized]: {
        ...existing,
        role,
      },
    }

    const updated: BoardShareConfig = {
      ...effectiveConfig,
      collaborators: updatedCollaborators,
      scene: scene ?? effectiveConfig.scene,
    }

    setShareConfig(updated)
    try {
      await sharingService.saveShareConfig(updated)
    } catch (err) {
      console.error('Failed to update collaborator role:', err)
    }
  }

  const handleAddEmail = async () => {
    const trimmed = emailInput.trim().toLowerCase()
    if (!trimmed) return
    if (!EMAIL_REGEX.test(trimmed)) {
      setEmailError('Please enter a valid email address')
      return
    }
    setEmailError(null)

    if (trimmed === resolvedOwnerEmail.toLowerCase() || effectiveConfig.invitedEmails.includes(trimmed)) {
      setEmailInput('')
      return
    }

    const updatedCollaborators = {
      ...effectiveConfig.collaborators,
      [trimmed]: {
        email: trimmed,
        role: 'viewer' as const,
        addedAt: new Date().toISOString(),
      },
    }

    const updatedInvited = Array.from(new Set([...effectiveConfig.invitedEmails, trimmed]))

    const updated: BoardShareConfig = {
      ...effectiveConfig,
      collaborators: updatedCollaborators,
      invitedEmails: updatedInvited,
      scene: scene ?? effectiveConfig.scene,
    }

    setShareConfig(updated)
    setEmailInput('')

    try {
      await sharingService.saveShareConfig(updated)
    } catch (err) {
      console.error('Failed to add collaborator:', err)
    }
  }

  const handleRemoveCollaborator = async (emailToRemove: string) => {
    const normalized = emailToRemove.toLowerCase()
    const nextCollaborators = { ...effectiveConfig.collaborators }
    delete nextCollaborators[normalized]

    const nextInvited = effectiveConfig.invitedEmails.filter((e) => e.toLowerCase() !== normalized)

    const updated: BoardShareConfig = {
      ...effectiveConfig,
      collaborators: nextCollaborators,
      invitedEmails: nextInvited,
      scene: scene ?? effectiveConfig.scene,
    }

    setShareConfig(updated)

    try {
      await sharingService.saveShareConfig(updated)
    } catch (err) {
      console.error('Failed to remove collaborator:', err)
    }
  }

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/boards/${boardId}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 2500)
    } catch (err) {
      console.error('Failed to copy link:', err)
    }
  }

  const handleDone = async () => {
    setIsSaving(true)
    try {
      await sharingService.saveShareConfig({
        ...effectiveConfig,
        scene: scene ?? effectiveConfig.scene,
      })
    } catch (err) {
      console.error('Failed to save share config on done:', err)
    } finally {
      setIsSaving(false)
      onOpenChange(false)
    }
  }

  const collaboratorsList = Object.values(effectiveConfig.collaborators)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay animate-fade-in" />
        <Dialog.Content className="dialog-content google-share-dialog animate-scale-in">
          {/* Header */}
          <div className="google-share-header">
            <Dialog.Title className="google-share-title" title={`Share '${boardName}'`}>
              Share '{boardName}'
            </Dialog.Title>

            <div className="google-share-header-actions">
              {/* FAQ / Help popover */}
              <Popover.Root>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className="google-share-icon-btn"
                    title="Sharing options explained"
                    aria-label="Sharing options explained"
                  >
                    <HelpCircle size={20} />
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content className="google-share-popover-info" sideOffset={6} align="end">
                    <p className="google-share-popover-title">Sharing options</p>
                    <div className="google-share-faq-item">
                      <strong>Restricted</strong>
                      <p>Only people added by email can access this board.</p>
                    </div>
                    <div className="google-share-faq-item">
                      <strong>Anyone with the link</strong>
                      <p>Anyone with the link can access without logging in.</p>
                    </div>
                    <div className="google-share-faq-item">
                      <strong>Viewer vs Editor</strong>
                      <p>
                        Viewers have read-only access (select with Cmd+A and copy with Cmd+C). Editors can edit
                        directly.
                      </p>
                    </div>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </div>
          </div>

          {/* Add people input */}
          <div className="google-share-input-section">
            <div className="google-share-input-box">
              <div className="google-share-input-row">
                <input
                  id="share-email-input"
                  type="email"
                  className="google-share-text-input"
                  placeholder="Add people by email..."
                  value={emailInput}
                  onChange={(e) => {
                    setEmailInput(e.target.value)
                    if (emailError) setEmailError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddEmail()
                    }
                  }}
                />
                {emailInput.trim() && (
                  <button type="button" className="google-share-add-btn" onClick={handleAddEmail}>
                    <Plus size={15} />
                    <span>Add</span>
                  </button>
                )}
              </div>
            </div>
            {emailError && <p className="google-share-error-message">{emailError}</p>}
          </div>

          {/* People with access */}
          <div className="google-share-section">
            <h3 className="google-share-section-title">People with access</h3>

            <div className="google-share-list">
              {/* Owner Row */}
              <div className="google-share-user-row">
                <div className="google-share-avatar-col">
                  {resolvedOwnerPhoto && !imgError ? (
                    <img
                      src={resolvedOwnerPhoto}
                      alt={resolvedOwnerName}
                      className="google-share-avatar-img"
                      referrerPolicy="no-referrer"
                      onError={() => setImgError(true)}
                    />
                  ) : (
                    <div className="google-share-avatar-placeholder">
                      {resolvedOwnerName.charAt(0).toUpperCase() || <UserIcon size={16} />}
                    </div>
                  )}
                </div>

                <div className="google-share-user-info">
                  <div className="google-share-user-name">
                    {resolvedOwnerName} <span className="google-share-you-tag">(you)</span>
                  </div>
                  {resolvedOwnerEmail && <div className="google-share-user-email">{resolvedOwnerEmail}</div>}
                </div>

                <div className="google-share-role-col">
                  <span className="google-share-owner-badge">Owner</span>
                </div>
              </div>

              {/* Invited Collaborators */}
              {collaboratorsList.map((collab) => (
                <div className="google-share-user-row" key={collab.email}>
                  <div className="google-share-avatar-col">
                    <div className="google-share-avatar-placeholder google-share-avatar-collaborator">
                      {collab.email.charAt(0).toUpperCase()}
                    </div>
                  </div>

                  <div className="google-share-user-info">
                    <div className="google-share-user-name">{collab.email}</div>
                  </div>

                  <div className="google-share-role-col">
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button type="button" className="google-share-role-trigger" aria-label="Change permission">
                          <span>{collab.role === 'editor' ? 'Editor' : 'Viewer'}</span>
                          <ChevronDown size={14} />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content className="google-share-dropdown-menu" sideOffset={4} align="end">
                          <DropdownMenu.Item
                            className={`google-share-dropdown-item ${collab.role === 'viewer' ? 'selected' : ''}`}
                            onSelect={() => handleCollaboratorRoleChange(collab.email, 'viewer')}
                          >
                            {collab.role === 'viewer' ? (
                              <Check size={16} className="google-share-check-icon" />
                            ) : (
                              <span className="google-share-empty-check" />
                            )}
                            <span>Viewer</span>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className={`google-share-dropdown-item ${collab.role === 'editor' ? 'selected' : ''}`}
                            onSelect={() => handleCollaboratorRoleChange(collab.email, 'editor')}
                          >
                            {collab.role === 'editor' ? (
                              <Check size={16} className="google-share-check-icon" />
                            ) : (
                              <span className="google-share-empty-check" />
                            )}
                            <span>Editor</span>
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className="google-share-dropdown-separator" />
                          <DropdownMenu.Item
                            className="google-share-dropdown-item google-share-dropdown-danger"
                            onSelect={() => handleRemoveCollaborator(collab.email)}
                          >
                            <Trash2 size={15} className="google-share-trash-icon" />
                            <span>Remove access</span>
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* General access */}
          <div className="google-share-section">
            <h3 className="google-share-section-title">General access</h3>

            <div className="google-share-general-row">
              <div
                className={`google-share-access-icon-badge ${
                  effectiveConfig.generalAccess === 'anyone_with_link' ? 'anyone-link' : 'restricted'
                }`}
              >
                {effectiveConfig.generalAccess === 'anyone_with_link' ? <Globe size={18} /> : <Lock size={18} />}
              </div>

              <div className="google-share-general-info">
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="google-share-general-select-btn"
                      aria-label="General access setting"
                    >
                      <span>
                        {effectiveConfig.generalAccess === 'anyone_with_link' ? 'Anyone with the link' : 'Restricted'}
                      </span>
                      <ChevronDown size={14} className="google-share-select-chevron" />
                    </button>
                  </DropdownMenu.Trigger>

                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className="google-share-dropdown-menu" sideOffset={4} align="start">
                      <DropdownMenu.Item
                        className={`google-share-dropdown-item ${
                          effectiveConfig.generalAccess === 'restricted' ? 'selected' : ''
                        }`}
                        onSelect={() => handleGeneralAccessChange('restricted')}
                      >
                        {effectiveConfig.generalAccess === 'restricted' ? (
                          <Check size={16} className="google-share-check-icon" />
                        ) : (
                          <span className="google-share-empty-check" />
                        )}
                        <span>Restricted</span>
                      </DropdownMenu.Item>

                      <DropdownMenu.Item
                        className={`google-share-dropdown-item ${
                          effectiveConfig.generalAccess === 'anyone_with_link' ? 'selected' : ''
                        }`}
                        onSelect={() => handleGeneralAccessChange('anyone_with_link')}
                      >
                        {effectiveConfig.generalAccess === 'anyone_with_link' ? (
                          <Check size={16} className="google-share-check-icon" />
                        ) : (
                          <span className="google-share-empty-check" />
                        )}
                        <span>Anyone with the link</span>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>

                <p className="google-share-general-desc">
                  {effectiveConfig.generalAccess === 'anyone_with_link'
                    ? effectiveConfig.generalRole === 'editor'
                      ? 'Anyone on the internet with the link can edit'
                      : 'Anyone on the internet with the link can view'
                    : 'Only people with access can open with the link'}
                </p>
              </div>

              {effectiveConfig.generalAccess === 'anyone_with_link' && (
                <div className="google-share-general-role-col">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button type="button" className="google-share-role-trigger" aria-label="General access role">
                        <span>{effectiveConfig.generalRole === 'editor' ? 'Editor' : 'Viewer'}</span>
                        <ChevronDown size={14} />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content className="google-share-dropdown-menu" sideOffset={4} align="end">
                        <DropdownMenu.Item
                          className={`google-share-dropdown-item ${
                            effectiveConfig.generalRole === 'viewer' ? 'selected' : ''
                          }`}
                          onSelect={() => handleGeneralRoleChange('viewer')}
                        >
                          {effectiveConfig.generalRole === 'viewer' ? (
                            <Check size={16} className="google-share-check-icon" />
                          ) : (
                            <span className="google-share-empty-check" />
                          )}
                          <span>Viewer</span>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className={`google-share-dropdown-item ${
                            effectiveConfig.generalRole === 'editor' ? 'selected' : ''
                          }`}
                          onSelect={() => handleGeneralRoleChange('editor')}
                        >
                          {effectiveConfig.generalRole === 'editor' ? (
                            <Check size={16} className="google-share-check-icon" />
                          ) : (
                            <span className="google-share-empty-check" />
                          )}
                          <span>Editor</span>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              )}
            </div>
          </div>

          {/* Footer actions */}
          <div className="google-share-footer">
            <button
              type="button"
              className={`google-share-copy-btn ${copied ? 'copied' : ''}`}
              onClick={handleCopyLink}
            >
              {copied ? <Check size={16} /> : <Link2 size={16} />}
              <span>{copied ? 'Link copied' : 'Copy link'}</span>
            </button>

            <button type="button" className="google-share-done-btn" onClick={handleDone} disabled={isSaving}>
              Done
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
