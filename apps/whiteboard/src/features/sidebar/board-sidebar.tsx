import { useCallback, useEffect, useState, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DefaultSidebar, Sidebar } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { saveSidebarPinned } from './sidebar-preferences'
import { CircleHelp, Library, Presentation, Search } from 'lucide-react'

const panels = [
  { id: 'library', label: 'Library', icon: Library },
  { id: 'slides', label: 'Slides', icon: Presentation },
  { id: 'search', label: 'Search', icon: Search },
] as const

type SidebarState = ReturnType<ExcalidrawImperativeAPI['getAppState']>['openSidebar']

/** Native sidebar owns visibility/docking. The rail only selects its tabs. */
export function BoardSidebar({
  api,
  containerRef,
  slideCount,
  slidesHeader,
  children,
  theme,
  onSlidesVisibilityChange,
}: {
  api: ExcalidrawImperativeAPI | null
  containerRef: MutableRefObject<HTMLElement | null>
  slideCount: number
  slidesHeader: ReactNode
  children: ReactNode
  theme: 'light' | 'dark'
  onSlidesVisibilityChange: (visible: boolean) => void
}) {
  const [active, setActive] = useState<SidebarState>(null)
  const observe = useCallback(
    (sidebar: SidebarState) => {
      setActive(sidebar)
      onSlidesVisibilityChange(sidebar?.name === 'default' && sidebar.tab === 'slides')
    },
    [onSlidesVisibilityChange],
  )
  useEffect(() => {
    if (!api) return
    const update = () => observe(api.getAppState().openSidebar)
    update()
    return api.onChange(update)
  }, [api, observe])
  const selected = active?.name === 'default' ? active.tab : null
  const title = panels.find((panel) => panel.id === selected)?.label ?? 'Library'
  return (
    <>
      <DefaultSidebar
        className="board-sidebar"
        onStateChange={observe}
        onDock={saveSidebarPinned}
        header={
          <Sidebar.Header className="board-sidebar-header">
            {selected === 'slides' ? (
              <div className="board-sidebar-actions">{slidesHeader}</div>
            ) : (
              <strong>{title}</strong>
            )}
          </Sidebar.Header>
        }
      >
        <Sidebar.Tab tab="slides">{children}</Sidebar.Tab>
      </DefaultSidebar>
      {containerRef.current &&
        createPortal(
          <nav
            className={`board-panel-rail excalidraw${theme === 'dark' ? ' theme--dark' : ''}`}
            aria-label="Board panels"
          >
            {panels.map((panel) => (
              <button
                key={panel.id}
                className={`sidebar-trigger board-panel-button${panel.id === 'slides' ? ' slides-toggle' : ''}`}
                aria-label={panel.label}
                title={panel.id === 'slides' ? `Slides · ${slideCount}` : panel.label}
                aria-pressed={selected === panel.id}
                onClick={() => {
                  api?.toggleSidebar({ name: 'default', tab: panel.id })
                  containerRef.current?.querySelector<HTMLElement>('.excalidraw-container')?.focus()
                }}
              >
                <panel.icon size={19} />
              </button>
            ))}
            <button
              className="sidebar-trigger board-panel-button board-panel-help"
              aria-label="Help"
              title="Help · ?"
              onClick={() => api?.updateScene({ appState: { openDialog: { name: 'help' } } })}
            >
              <CircleHelp size={19} />
            </button>
          </nav>,
          containerRef.current,
        )}
    </>
  )
}
