import { useEffect, useMemo, useRef, useState } from 'react'
import * as Checkbox from '@radix-ui/react-checkbox'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Filter, Search, SlidersHorizontal, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import type { Project } from '@agentic-whiteboard/storage'

export type SortOrder = 'latest' | 'oldest' | 'name-asc' | 'name-desc'
const sortOptions: Array<{ value: SortOrder; label: string }> = [
  { value: 'latest', label: 'Latest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
]

type FilterProps = {
  projects: Project[]
  query: string
  onQueryChange: (value: string) => void
  selectedProjectIds: Set<string>
  onToggleProject: (id: string) => void
  onClearFilters?: () => void
  sortOrder: SortOrder
  onSort: (sort: SortOrder) => void
}

export function WorkspaceFilters(props: FilterProps) {
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [projectSearch, setProjectSearch] = useState('')
  const visibleProjects = useMemo(() => {
    const query = projectSearch.trim().toLocaleLowerCase()
    return query ? props.projects.filter((project) => project.name.toLocaleLowerCase().includes(query)) : props.projects
  }, [projectSearch, props.projects])
  const activeFilterCount = props.selectedProjectIds.size > 0 ? 1 : 0

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) {
        return
      }

      const activeEl = document.activeElement as HTMLElement | null
      const isEditable =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        activeEl?.isContentEditable ||
        activeEl?.getAttribute('role') === 'textbox'

      if (isEditable) {
        return
      }

      if (document.querySelector('[role="dialog"]')) {
        return
      }

      event.preventDefault()
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div className="workspace-filters">
      <div className="search-wrap">
        <Search size={16} />
        <Input
          ref={searchInputRef}
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              searchInputRef.current?.blur()
            }
          }}
          placeholder="Search boards"
          aria-label="Search boards"
        />
        {props.query ? (
          <button
            type="button"
            className="search-clear-btn"
            onClick={() => {
              props.onQueryChange('')
              searchInputRef.current?.focus()
            }}
            aria-label="Clear search"
          >
            <X size={13} />
          </button>
        ) : (
          <kbd className="search-shortcut" title="Press '/' to focus" aria-hidden="true">
            <span className="search-shortcut-key">/</span>
          </kbd>
        )}
      </div>
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={`filter-trigger-btn ${activeFilterCount > 0 ? 'filter-trigger-btn--active' : ''}`}
            aria-label={activeFilterCount > 0 ? `Filter boards (${activeFilterCount} active)` : 'Filter boards'}
          >
            <Filter size={16} />
            {activeFilterCount > 0 && (
              <span className="filter-count-badge" aria-hidden="true">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="filter-popover animate-fade-in" align="end" sideOffset={8}>
            <div className="filter-popover-body">
              <div className="filter-header-row">
                <span className="filter-section-title">Project</span>
                {props.selectedProjectIds.size > 0 && (
                  <span className="filter-section-count">{props.selectedProjectIds.size}</span>
                )}
              </div>
              <div className="filter-search-wrap">
                <Search size={14} className="filter-search-icon" />
                <input
                  className="filter-search-input"
                  value={projectSearch}
                  onChange={(event) => setProjectSearch(event.target.value)}
                  placeholder="Search projects"
                  aria-label="Search projects"
                />
              </div>
              <div className="filter-options">
                {visibleProjects.length > 0 ? (
                  visibleProjects.map((project) => (
                    <FilterCheck
                      key={project.id}
                      checked={props.selectedProjectIds.has(project.id)}
                      onCheckedChange={() => props.onToggleProject(project.id)}
                      label={project.name}
                    />
                  ))
                ) : (
                  <span className="filter-empty-hint">No projects found</span>
                )}
              </div>
            </div>
            <div className="filter-bottom-bar">
              <button
                type="button"
                className="filter-clear-all-btn"
                onClick={props.onClearFilters}
                disabled={activeFilterCount === 0}
              >
                Clear all
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button variant="outline" size="icon" aria-label="Sort boards">
            <SlidersHorizontal size={16} />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="sort-popover" align="end" sideOffset={8}>
            {sortOptions.map((option) => (
              <button key={option.value} className="sort-option" onClick={() => props.onSort(option.value)}>
                {option.label}
                {props.sortOrder === option.value ? <Check size={16} /> : null}
              </button>
            ))}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

function FilterCheck({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean
  onCheckedChange: () => void
  label: string
}) {
  return (
    <label className="filter-check">
      <Checkbox.Root checked={checked} onCheckedChange={onCheckedChange} className="checkbox-root">
        <Checkbox.Indicator className="checkbox-indicator">
          <Check size={11} strokeWidth={2.5} />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <span>{label}</span>
    </label>
  )
}

export function GroupHeader({
  name,
  count,
  newest,
  isOpen = true,
  onToggle,
}: {
  name: string
  count: number
  newest?: string
  isOpen?: boolean
  onToggle?: () => void
}) {
  return (
    <button type="button" className="group-header" onClick={onToggle} aria-expanded={isOpen}>
      <div>
        <i /> <strong>{name}</strong>
      </div>
      <div>
        {newest ? <span className="edited-badge">Last edited {newest}</span> : null}
        <span className="count-badge">
          {count} {count === 1 ? 'board' : 'boards'}
        </span>
        <ChevronDown size={16} className={`group-header-chevron ${!isOpen ? 'group-header-chevron--closed' : ''}`} />
      </div>
    </button>
  )
}
