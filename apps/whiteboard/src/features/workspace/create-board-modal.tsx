import { useState, useEffect, useMemo } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Plus, Search, X } from 'lucide-react'
import type { Project } from '@agentic-whiteboard/storage'

interface CreateBoardModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  defaultProjectId?: string
  initialBoardName?: string
  onCreateBoard: (params: { boardName: string; projectId?: string; newProjectName?: string }) => Promise<void>
}

export function CreateBoardModal({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  initialBoardName,
  onCreateBoard,
}: CreateBoardModalProps) {
  const [boardName, setBoardName] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [isCreatingProject, setIsCreatingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Reset form whenever modal opens
  useEffect(() => {
    if (open) {
      setBoardName(initialBoardName || '')
      setSelectedProjectId(defaultProjectId || (projects[0]?.id ?? ''))
      setIsCreatingProject(projects.length === 0)
      setNewProjectName('')
      setIsSubmitting(false)
      setIsDropdownOpen(false)
      setSearchQuery('')
    }
  }, [open, projects, defaultProjectId, initialBoardName])

  const selectedProject = projects.find((p) => p.id === selectedProjectId)
  const selectedLabel = isCreatingProject
    ? newProjectName.trim()
      ? `New: ${newProjectName.trim()}`
      : 'Create new project'
    : (selectedProject?.name ?? 'Select project')

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return projects
    return projects.filter((project) => project.name.toLowerCase().includes(q))
  }, [projects, searchQuery])

  const selectProject = (projectId: string) => {
    setSelectedProjectId(projectId)
    setIsCreatingProject(false)
    setIsDropdownOpen(false)
    setSearchQuery('')
  }

  const startCreateProject = (initialName?: string) => {
    setIsCreatingProject(true)
    setSelectedProjectId('')
    if (initialName) {
      setNewProjectName(initialName)
    }
    setIsDropdownOpen(false)
    setSearchQuery('')
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredProjects.length > 0) {
        selectProject(filteredProjects[0].id)
      } else if (searchQuery.trim()) {
        startCreateProject(searchQuery.trim())
      }
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (isSubmitting) return

    setIsSubmitting(true)
    try {
      const creatingProj = isCreatingProject || projects.length === 0
      await onCreateBoard({
        boardName: boardName.trim() || 'Untitled board',
        projectId: creatingProj ? undefined : selectedProjectId || projects[0]?.id,
        newProjectName: creatingProj ? newProjectName.trim() || 'General' : undefined,
      })
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to create board:', error)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby="create-board-desc">
          <Dialog.Title className="create-board-title">Create new board</Dialog.Title>
          <Dialog.Description id="create-board-desc" className="create-board-desc">
            Choose where this board belongs. You can make a new project without leaving this flow.
          </Dialog.Description>

          <form onSubmit={handleSubmit}>
            <div className="modal-field">
              <label htmlFor="board-name-input">
                <strong>Board name</strong>
              </label>
              <input
                id="board-name-input"
                className="modal-input"
                type="text"
                value={boardName}
                onChange={(e) => setBoardName(e.target.value)}
                placeholder="Untitled board"
                autoFocus
              />
            </div>

            <div className="modal-field">
              <label id="project-label" htmlFor="project-select">
                <strong>Project</strong>
              </label>
              <Popover.Root
                open={isDropdownOpen}
                onOpenChange={(openState) => {
                  setIsDropdownOpen(openState)
                  if (!openState) setSearchQuery('')
                }}
              >
                <Popover.Trigger asChild>
                  <button
                    id="project-select"
                    type="button"
                    className="project-dropdown-trigger"
                    aria-labelledby="project-label project-select"
                    aria-expanded={isDropdownOpen}
                  >
                    <span className="project-dropdown-trigger-label">{selectedLabel}</span>
                    <ChevronDown size={18} className="project-dropdown-arrow" />
                  </button>
                </Popover.Trigger>

                <Popover.Portal>
                  <Popover.Content className="project-dropdown-popover" align="start" sideOffset={5}>
                    <div className="project-dropdown-search-wrap">
                      <Search size={14} className="project-dropdown-search-icon" />
                      <input
                        type="text"
                        className="project-dropdown-search-input"
                        placeholder="Search projects..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        autoFocus
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          className="project-dropdown-search-clear"
                          onClick={() => setSearchQuery('')}
                          aria-label="Clear search"
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>

                    <div className="project-dropdown-list" role="listbox">
                      {filteredProjects.length > 0 ? (
                        filteredProjects.map((project) => {
                          const isSelected = !isCreatingProject && selectedProjectId === project.id
                          return (
                            <button
                              key={project.id}
                              type="button"
                              className={`project-dropdown-item ${isSelected ? 'selected' : ''}`}
                              onClick={() => selectProject(project.id)}
                              role="option"
                              aria-selected={isSelected}
                            >
                              <span className="project-dropdown-item-name">{project.name}</span>
                              {isSelected ? <Check size={16} className="project-dropdown-check" /> : null}
                            </button>
                          )
                        })
                      ) : (
                        <div className="project-dropdown-empty">No projects found</div>
                      )}
                    </div>

                    <div className="project-dropdown-divider" />

                    <button
                      type="button"
                      className={`project-dropdown-item project-dropdown-create-btn ${isCreatingProject ? 'selected' : ''}`}
                      onClick={() =>
                        startCreateProject(
                          searchQuery.trim() &&
                            !projects.some((p) => p.name.toLowerCase() === searchQuery.trim().toLowerCase())
                            ? searchQuery.trim()
                            : undefined,
                        )
                      }
                    >
                      <div className="project-dropdown-create-label">
                        <Plus size={15} className="project-dropdown-plus-icon" />
                        <span>
                          {searchQuery.trim() ? `Create "${searchQuery.trim()}"...` : 'Create new project...'}
                        </span>
                      </div>
                      {isCreatingProject ? <Check size={16} className="project-dropdown-check" /> : null}
                    </button>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </div>

            {isCreatingProject && (
              <div className="modal-field animate-fade-in">
                <label htmlFor="new-project-name">
                  <strong>New project name</strong>
                </label>
                <input
                  id="new-project-name"
                  className="modal-input"
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="e.g. Design Systems"
                  autoFocus
                />
              </div>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button type="submit" className="modal-btn-create" disabled={isSubmitting}>
                {isSubmitting ? 'Creating…' : 'Create board'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
