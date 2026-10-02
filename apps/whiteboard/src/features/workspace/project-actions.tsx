import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Dialog from '@radix-ui/react-dialog'
import { MoreHorizontal } from 'lucide-react'
import { doc, getDoc } from 'firebase/firestore'
import { getFirestoreDb } from '../../lib/firebase'
import { projectService, type ProjectPolicy, type VisibleProject } from '../sharing/project-service'
import { sharingService } from '../sharing/sharing-service'
import { workspaceApi, workspaceStore } from './workspace-api'

export type ProjectAction = 'share' | 'rename' | 'download' | 'archive' | 'delete'
export function ProjectMenu({
  project,
  isOwner,
  onAction,
}: {
  project: VisibleProject
  isOwner: boolean
  onAction: (action: ProjectAction) => void
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="project-menu-trigger" type="button" aria-label={`Project actions for ${project.name}`}>
          <MoreHorizontal size={18} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="google-share-dropdown-menu" align="end" sideOffset={6}>
          {(isOwner ? ['share', 'rename', 'download', 'archive', 'delete'] : ['download', 'archive']).map((action) => (
            <DropdownMenu.Item
              key={action}
              className={`google-share-dropdown-item ${action === 'delete' ? 'google-share-dropdown-danger' : ''}`}
              onSelect={() => onAction(action as ProjectAction)}
            >
              {action === 'archive' && project.archived ? 'Unarchive' : action[0].toUpperCase() + action.slice(1)}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

const emptyPolicy: ProjectPolicy = {
  generalAccess: 'restricted',
  generalRole: 'viewer',
  collaborators: {},
  invitedEmails: [],
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
  onComplete: () => void
}) {
  const [name, setName] = useState(project.name)
  const [policy, setPolicy] = useState<ProjectPolicy>(emptyPolicy)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(action !== 'share')
  const [loading, setLoading] = useState(action === 'share')
  const [error, setError] = useState('')
  useEffect(() => {
    if (action !== 'share') return
    let live = true
    const db = getFirestoreDb()
    if (!db) {
      setError('Sharing requires cloud configuration.')
      setLoading(false)
      return
    }
    void getDoc(doc(db, 'projectShares', project.id))
      .then((snapshot) => {
        if (live) {
          setPolicy(snapshot.exists() ? (snapshot.data() as ProjectPolicy) : emptyPolicy)
          setLoading(false)
          setLoaded(true)
        }
      })
      .catch((error) => {
        if (live) {
          setError(error.message)
          setLoading(false)
          setLoaded(false)
        }
      })
    return () => {
      live = false
    }
  }, [action, project.id])
  const save = async () => {
    if (busy || loading || !loaded) return
    setBusy(true)
    setError('')
    try {
      if (action === 'rename') await workspaceApi.renameProject(project.id, name)
      if (action === 'delete') await workspaceApi.deleteProject(project.id)
      if (action === 'share') {
        await workspaceApi.flushCloud()
        // Provision every existing board before granting project access. Preserve direct policies and exceptions.
        const boards = await workspaceStore.listBoards(project.id)
        for (const board of boards) {
          const config = await sharingService.getShareConfig(board.id, {
            boardName: board.name,
            ownerId: project.ownerId,
          })
          await sharingService.saveShareConfig({ ...config, projectId: project.id })
        }
        await projectService.manage(project.id, 'share', { policy })
      }
      onComplete()
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Project could not be updated.')
    } finally {
      setBusy(false)
    }
  }
  const add = () => {
    const normalized = email.trim().toLowerCase()
    if (!/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(normalized)) {
      setError('Enter a valid email address.')
      return
    }
    setPolicy((previous) => ({
      ...previous,
      collaborators: {
        ...previous.collaborators,
        [normalized]: { email: normalized, role: 'viewer', addedAt: new Date().toISOString() },
      },
    }))
    setEmail('')
    setError('')
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby="project-action-desc">
          <Dialog.Title>{action[0].toUpperCase() + action.slice(1)} project</Dialog.Title>
          <Dialog.Description id="project-action-desc">
            {action === 'delete'
              ? `Delete “${project.name}”? All contained board links will stop working. Stored content will be retained.`
              : action === 'share'
                ? 'Share existing and future boards. Boards with custom access keep their own permissions.'
                : 'Update this project’s name.'}
          </Dialog.Description>
          {action === 'rename' && (
            <label className="modal-field">
              Project name
              <input
                className="modal-input"
                aria-label="Project name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            </label>
          )}
          {action === 'share' && (
            <fieldset disabled={busy || loading || !loaded} className="project-share-fields">
              <label>
                General access
                <select
                  aria-label="Project general access"
                  value={policy.generalAccess}
                  onChange={(event) =>
                    setPolicy((previous) => ({
                      ...previous,
                      generalAccess: event.target.value as ProjectPolicy['generalAccess'],
                    }))
                  }
                >
                  <option value="restricted">Restricted</option>
                  <option value="anyone_with_link">Anyone with the link</option>
                </select>
              </label>
              {policy.generalAccess === 'anyone_with_link' && (
                <label>
                  Link role
                  <select
                    aria-label="Project link role"
                    value={policy.generalRole}
                    onChange={(event) =>
                      setPolicy((previous) => ({
                        ...previous,
                        generalRole: event.target.value as ProjectPolicy['generalRole'],
                      }))
                    }
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                </label>
              )}
              <label>
                Add people by email
                <input
                  className="modal-input"
                  aria-label="Project collaborator email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <button type="button" className="ui-button ui-button--outline" onClick={add}>
                Add person
              </button>
              {Object.values(policy.collaborators ?? {}).map((person) => (
                <div className="project-person" key={person.email}>
                  <span>{person.email}</span>
                  <select
                    aria-label={`Role for ${person.email}`}
                    value={person.role}
                    onChange={(event) =>
                      setPolicy((previous) => ({
                        ...previous,
                        collaborators: {
                          ...previous.collaborators,
                          [person.email]: { ...person, role: event.target.value as 'editor' | 'viewer' },
                        },
                      }))
                    }
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button
                    aria-label={`Remove ${person.email}`}
                    type="button"
                    onClick={() =>
                      setPolicy((previous) => ({
                        ...previous,
                        collaborators: Object.fromEntries(
                          Object.entries(previous.collaborators).filter(([key]) => key !== person.email),
                        ),
                      }))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                className="ui-button ui-button--outline"
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(`${location.origin}/?projectId=${project.id}`)
                    .catch((error) => setError(error.message))
                }}
              >
                Copy project link
              </button>
            </fieldset>
          )}
          {loading && <p role="status">Loading sharing settings…</p>}
          {error && <p role="alert">{error}</p>}
          <div className="modal-actions">
            <button className="modal-btn-cancel" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className={action === 'delete' ? 'modal-btn-danger' : 'modal-btn-create'}
              disabled={busy || loading || !loaded || (action === 'rename' && !name.trim())}
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
