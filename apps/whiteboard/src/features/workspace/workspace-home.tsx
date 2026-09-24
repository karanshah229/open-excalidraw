import { useEffect, useDeferredValue, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import type { BoardSyncStatus } from '@agentic-whiteboard/storage'
import { Button } from '../../components/ui/button'
import { BoardPreview } from './board-preview'
import { CreateBoardModal } from './create-board-modal'
import { DeleteBoardModal } from './delete-board-modal'
import { ShareModal } from '../../components/share-modal'
import { GroupHeader, type SortOrder, WorkspaceFilters } from './workspace-filters'
import { workspaceApi, type WorkspaceBoard } from './workspace-api'

const workspaceQueryKey = ['workspace'] as const

export function WorkspaceHome() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const searchParams = useSearch({ strict: false }) as { projectId?: string }
  const params = useParams({ strict: false }) as { projectId?: string }
  const queryProjectId = params.projectId || searchParams.projectId
  const isProjectPage = Boolean(queryProjectId)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [projectIds, setProjectIds] = useState<Set<string>>(() =>
    queryProjectId ? new Set([queryProjectId]) : new Set(),
  )

  const [navSlot, setNavSlot] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' ? document.getElementById('header-nav-slot') : null,
  )

  useEffect(() => {
    if (!navSlot) {
      setNavSlot(document.getElementById('header-nav-slot'))
    }
  }, [navSlot])

  useEffect(() => {
    if (searchParams.projectId && !params.projectId) {
      navigate({
        to: '/projects/$projectId',
        params: { projectId: searchParams.projectId },
        replace: true,
      })
    }
  }, [searchParams.projectId, params.projectId, navigate])

  useEffect(() => {
    setProjectIds(queryProjectId ? new Set([queryProjectId]) : new Set())
  }, [queryProjectId])

  const [statuses, setStatuses] = useState<Set<BoardSyncStatus>>(() => new Set())
  const [sortOrder, setSortOrder] = useState<SortOrder>('latest')
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [boardToDelete, setBoardToDelete] = useState<WorkspaceBoard | null>(null)
  const [boardToShare, setBoardToShare] = useState<WorkspaceBoard | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  const workspace = useQuery({ queryKey: workspaceQueryKey, queryFn: workspaceApi.listWorkspace, staleTime: Infinity })

  const handleCreateBoard = async ({
    boardName,
    projectId,
    newProjectName,
  }: {
    boardName: string
    projectId?: string
    newProjectName?: string
  }) => {
    let targetProjectId = projectId
    if (newProjectName) {
      const newProject = await workspaceApi.createProject(newProjectName)
      targetProjectId = newProject.id
    }
    if (!targetProjectId) {
      targetProjectId = workspace.data?.projects[0]?.id
    }
    if (!targetProjectId) throw new Error('No project is available.')

    const newBoard = await workspaceApi.createBoard(targetProjectId, boardName)
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKey })
    navigate({ to: '/boards/$boardId', params: { boardId: newBoard.id } })
  }

  const handleConfirmDelete = async () => {
    if (!boardToDelete) return
    await workspaceApi.deleteBoard(boardToDelete.id)
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKey })
    setBoardToDelete(null)
  }

  const currentProject = useMemo(
    () => workspace.data?.projects.find((p) => p.id === queryProjectId),
    [workspace.data?.projects, queryProjectId],
  )

  const boards = useMemo(
    () => filterBoards(workspace.data?.boards ?? [], deferredSearch, projectIds, statuses, sortOrder),
    [workspace.data?.boards, deferredSearch, projectIds, statuses, sortOrder],
  )
  const recentBoards = useMemo(
    () => boards.filter((board) => Date.now() - new Date(board.updatedAt).getTime() < 7 * 86_400_000),
    [boards],
  )
  const byProject = useMemo(
    () =>
      (workspace.data?.projects ?? [])
        .map((project) => ({ project, boards: boards.filter((board) => board.projectId === project.id) }))
        .filter((group) => group.boards.length > 0 || (isProjectPage && group.project.id === queryProjectId)),
    [workspace.data?.projects, boards, isProjectPage, queryProjectId],
  )

  if (workspace.isPending)
    return (
      <main className="workspace-shell">
        {navSlot && isProjectPage &&
          createPortal(
            <nav className="header-breadcrumb" aria-label="Breadcrumb">
              <Link to="/" className="breadcrumb-item breadcrumb-link" title="Workspace">
                Workspace
              </Link>
              <span className="breadcrumb-separator" aria-hidden="true">
                /
              </span>
              <span className="breadcrumb-item breadcrumb-current" title="Loading…">
                Loading…
              </span>
            </nav>,
            navSlot,
          )}
        <div className="workspace-loading">Loading your workspace…</div>
      </main>
    )
  if (workspace.isError)
    return (
      <main className="workspace-shell">
        <div className="workspace-loading">Could not load the local workspace.</div>
      </main>
    )

  return (
    <main className="workspace-shell">
      {navSlot && isProjectPage &&
        createPortal(
          <nav className="header-breadcrumb" aria-label="Breadcrumb">
            <Link to="/" className="breadcrumb-item breadcrumb-link" title="Workspace">
              Workspace
            </Link>
            <span className="breadcrumb-separator" aria-hidden="true">
              /
            </span>
            <span
              className="breadcrumb-item breadcrumb-current"
              title={currentProject?.name ?? (workspace.isPending ? 'Loading…' : 'Project')}
            >
              {currentProject?.name ?? (workspace.isPending ? 'Loading…' : 'Project')}
            </span>
          </nav>,
          navSlot,
        )}
      <section className="workspace-intro">
        <p>{isProjectPage && currentProject ? 'PROJECT' : 'WORKSPACE'}</p>
        <div className="intro-title">
          <div>
            <h1>{isProjectPage && currentProject ? currentProject.name : 'Your ideas, in one place.'}</h1>
            {!isProjectPage && (
              <span>Create and organize boards by project. Every change is saved to your workspace automatically.</span>
            )}
          </div>
          <Button onClick={() => setIsCreateModalOpen(true)}>
            <Plus size={16} />
            New board
          </Button>
        </div>
      </section>
      <WorkspaceFilters
        projects={workspace.data.projects}
        query={search}
        onQueryChange={setSearch}
        selectedProjectIds={projectIds}
        selectedStatuses={statuses}
        onToggleProject={(id) => {
          if (isProjectPage && id === queryProjectId && projectIds.has(id) && projectIds.size === 1) {
            navigate({ to: '/' })
            return
          }
          setProjectIds((current) => toggleSet(current, id))
        }}
        onToggleStatus={(status) => setStatuses((current) => toggleSet(current, status))}
        onClearFilters={() => {
          setProjectIds(new Set())
          setStatuses(new Set())
          if (isProjectPage) {
            navigate({ to: '/' })
          }
        }}
        sortOrder={sortOrder}
        onSort={setSortOrder}
      />
      {projectIds.size === 0 && recentBoards.length > 0 && (
        <section className="board-group">
          <GroupHeader
            name="Last 7 days"
            count={recentBoards.length}
            isOpen={!collapsedGroups.has('recent')}
            onToggle={() => toggleGroup('recent')}
          />
          {!collapsedGroups.has('recent') && (
            <BoardGrid
              boards={recentBoards}
              onDelete={(board) => setBoardToDelete(board)}
              onShare={(board) => setBoardToShare(board)}
            />
          )}
        </section>
      )}
      {byProject.map(({ project, boards: groupBoards }) => {
        const isGroupOpen = !collapsedGroups.has(project.id)
        return (
          <section className="board-group" key={project.id}>
            <GroupHeader
              name={project.name}
              count={groupBoards.length}
              newest={groupBoards[0] ? editedLabel(groupBoards[0].updatedAt) : undefined}
              isOpen={isGroupOpen}
              onToggle={() => toggleGroup(project.id)}
            />
            {isGroupOpen && (
              <BoardGrid
                boards={groupBoards}
                onDelete={(board) => setBoardToDelete(board)}
                onShare={(board) => setBoardToShare(board)}
              />
            )}
          </section>
        )
      })}
      {byProject.length === 0 && (
        <div className="empty-boards">
          {search || statuses.size > 0
            ? 'No boards match these filters.'
            : isProjectPage
              ? 'No boards in this project yet.'
              : 'No boards found.'}
        </div>
      )}

      <CreateBoardModal
        open={isCreateModalOpen}
        onOpenChange={setIsCreateModalOpen}
        projects={workspace.data.projects}
        defaultProjectId={queryProjectId}
        onCreateBoard={handleCreateBoard}
      />

      <DeleteBoardModal
        open={!!boardToDelete}
        onOpenChange={(open) => {
          if (!open) setBoardToDelete(null)
        }}
        boardName={boardToDelete?.name ?? ''}
        onConfirm={handleConfirmDelete}
      />

      {boardToShare && (
        <ShareModal
          open={!!boardToShare}
          onOpenChange={(open) => {
            if (!open) setBoardToShare(null)
          }}
          boardId={boardToShare.id}
          boardName={boardToShare.name}
          ownerId={boardToShare.project.ownerId}
          scene={boardToShare.scene}
        />
      )}
    </main>
  )
}

function BoardGrid({
  boards,
  onDelete,
  onShare,
}: {
  boards: Awaited<ReturnType<typeof workspaceApi.listWorkspace>>['boards']
  onDelete?: (board: WorkspaceBoard) => void
  onShare?: (board: WorkspaceBoard) => void
}) {
  return boards.length > 0 ? (
    <div className="board-grid">
      {boards.map((board, index) => (
        <BoardPreview
          key={board.id}
          board={board}
          index={index}
          onDelete={onDelete}
          onShare={onShare}
        />
      ))}
    </div>
  ) : (
    <div className="empty-boards">No boards match these filters.</div>
  )
}

function filterBoards<T extends { name: string; projectId: string; syncStatus: BoardSyncStatus; updatedAt: string }>(
  boards: T[],
  search: string,
  projectIds: Set<string>,
  statuses: Set<BoardSyncStatus>,
  order: SortOrder,
) {
  const normalized = search.trim().toLocaleLowerCase()
  const filtered = boards.filter(
    (board) =>
      (!normalized || board.name.toLocaleLowerCase().includes(normalized)) &&
      (projectIds.size === 0 || projectIds.has(board.projectId)) &&
      (statuses.size === 0 || statuses.has(board.syncStatus)),
  )
  return filtered.toSorted((left, right) => {
    if (order === 'latest') return right.updatedAt.localeCompare(left.updatedAt)
    if (order === 'oldest') return left.updatedAt.localeCompare(right.updatedAt)
    if (order === 'name-asc') return left.name.localeCompare(right.name)
    return right.name.localeCompare(left.name)
  })
}

function toggleSet<T>(current: Set<T>, value: T) {
  const next = new Set(current)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}

function editedLabel(value: string) {
  return Date.now() - new Date(value).getTime() < 86_400_000 ? 'just now' : 'yesterday'
}
