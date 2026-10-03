import { useMemo, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Dialog from '@radix-ui/react-dialog'
import { MoreVertical } from 'lucide-react'
import { projectService, type VisibleProject } from '../sharing/project-service'
import { sharingService, type BoardShareConfig } from '../sharing/sharing-service'
import { ShareModal } from '../../components/share-modal'
import { workspaceApi, workspaceStore } from './workspace-api'

export type ProjectAction = 'share' | 'rename' | 'download' | 'archive' | 'delete'
export function ProjectMenu({
  project,
  canManage,
  onAction,
}: {
  project: VisibleProject
  canManage: boolean
  onAction: (action: ProjectAction) => void
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button className="project-menu-trigger" type="button" aria-label={`Project actions for ${project.name}`}>
          <MoreVertical size={18} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="google-share-dropdown-menu" align="end" sideOffset={6}>
          {(canManage ? ['share', 'rename', 'download', 'archive', 'delete'] : ['download', 'archive']).map(
            (action) => (
              <DropdownMenu.Item
                key={action}
                className={`google-share-dropdown-item ${action === 'delete' ? 'google-share-dropdown-danger' : ''}`}
                onSelect={() => onAction(action as ProjectAction)}
              >
                {action === 'archive' && project.archived ? 'Unarchive' : action[0].toUpperCase() + action.slice(1)}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function ProjectActionModal({
  project,
  action,
  onClose,
  onComplete,
}: {
  project: VisibleProject
  action: Exclude<ProjectAction, 'download' | 'archive'>
  onClose: () => void
  onComplete: (patch?: Partial<VisibleProject>) => void
}) {
  const [name, setName] = useState(project.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const prepared = useRef(false)
  const initialConfig = useMemo<BoardShareConfig | undefined>(
    () =>
      project.sharePolicy
        ? {
            ...project.sharePolicy,
            boardId: project.id,
            boardName: project.name,
            ownerId: project.ownerId,
            ownerName: project.ownerName ?? '',
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          }
        : undefined,
    [project],
  )
  if (action === 'share')
    return (
      <ShareModal
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
        boardId={project.id}
        boardName={project.name}
        ownerId={project.ownerId}
        resourceType="project"
        initialConfig={initialConfig}
        shareUrl={`${location.origin}/?projectId=${project.id}`}
        onShareConfigSaved={() => onComplete()}
        onSaveConfig={async (config) => {
          if (!prepared.current) {
            const boards =
              project.isShared && project.role === 'editor' ? [] : await workspaceStore.listBoards(project.id)
            const candidates = await Promise.all(
              boards.map(async (board) => {
                const cached = sharingService.cachedShareConfig(board.id)
                if (cached?.accessRevision && cached.projectId === project.id) return null
                const policy = await sharingService.getShareConfig(board.id, {
                  boardName: board.name,
                  ownerId: project.ownerId,
                })
                return !policy.accessRevision || policy.projectId !== project.id
                  ? { ...policy, projectId: project.id }
                  : null
              }),
            )
            const unpublished = candidates.filter((policy) => policy !== null)
            if (unpublished.length) {
              await workspaceApi.flushCloud()
              // Bound first-publication work without serializing every board round trip.
              for (let offset = 0; offset < unpublished.length; offset += 8)
                await Promise.all(
                  unpublished
                    .slice(offset, offset + 8)
                    .map((policy) => sharingService.saveShareConfig(policy, { workspaceFlushed: true })),
                )
            }
            prepared.current = true
          }
          await projectService.manage(project.id, 'share', { policy: config })
        }}
      />
    )
  const save = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (action === 'rename') {
        await workspaceApi.renameProject(project.id, name)
        onComplete({ id: project.id, name: name.trim() })
      } else {
        await workspaceApi.deleteProject(project.id)
        onComplete()
      }
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Project could not be updated.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay animate-fade-in" />
        <Dialog.Content
          className={`dialog-content google-share-dialog project-edit-dialog ${action === 'delete' ? 'project-delete-dialog' : ''} animate-scale-in`}
          aria-describedby="project-action-desc"
        >
          <div className="google-share-header">
            <Dialog.Title className="google-share-title">
              {action === 'rename' ? 'Rename project' : 'Delete project'}
            </Dialog.Title>
          </div>
          <Dialog.Description id="project-action-desc" className="project-dialog-description">
            {action === 'delete'
              ? `Delete “${project.name}”? All board links in this project will stop working.`
              : 'Give this project a name that’s easy to recognize.'}
          </Dialog.Description>
          {action === 'rename' && (
            <form
              id="rename-project-form"
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <label className="project-name-field">
                Project name
                <input
                  className="google-share-text-input project-name-input"
                  aria-label="Project name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={200}
                  disabled={busy}
                  autoFocus
                  onFocus={(event) => event.target.select()}
                />
              </label>
            </form>
          )}
          {(action === 'rename' || error) && (
            <div className="project-form-status" role="alert">
              {error}
            </div>
          )}
          <div className="google-share-footer project-dialog-footer">
            <button className="google-share-copy-btn" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className={action === 'delete' ? 'google-share-done-btn project-delete-btn' : 'google-share-done-btn'}
              disabled={busy || !name.trim()}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : action === 'delete' ? 'Delete project' : 'Save'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
