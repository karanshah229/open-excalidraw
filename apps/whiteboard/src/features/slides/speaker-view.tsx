import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, AArrowDown, AArrowUp, X } from 'lucide-react'
import type { SceneSnapshot } from '../scene/scene-session'
import type { Slide } from './slide-model'
import { SlidePreview } from './slide-preview'
import { SlideNotes } from './slide-notes'

// Both windows use the same React state. Notes are rendered only into this popup.
export function useSpeakerWindow() {
  const [host, setHost] = useState<{ window: Window; root: HTMLElement } | null>(null)
  const current = useRef(host)
  current.current = host
  function close() {
    current.current?.window.close()
    current.current = null
    setHost(null)
  }
  function open(source: HTMLElement) {
    if (current.current && !current.current.window.closed && current.current.root.isConnected) {
      current.current.window.focus()
      return true
    }
    current.current?.window.close()
    const popup = window.open('', '_blank', 'popup,width=900,height=700')
    if (!popup) return false
    popup.document.title = 'Speaker view — OpenExcalidraw'
    const base = popup.document.createElement('base')
    base.href = document.baseURI
    popup.document.head.append(base)
    for (const style of document.querySelectorAll('link[rel="stylesheet"], style')) {
      popup.document.head.append(style.cloneNode(true))
    }
    popup.document.body.className = 'speaker-window-body'
    const root = popup.document.createElement('div')
    root.style.fontFamily = getComputedStyle(source).fontFamily
    popup.document.body.append(root)
    const next = { window: popup, root }
    current.current = next
    setHost(next)
    return true
  }
  useEffect(() => {
    if (!host) return
    const timer = window.setInterval(() => {
      if (host.window.closed || !host.root.isConnected) {
        host.window.close()
        if (current.current === host) {
          current.current = null
          setHost(null)
        }
      }
    }, 500)
    return () => window.clearInterval(timer)
  }, [host])
  useEffect(() => {
    const closePopup = () => current.current?.window.close()
    window.addEventListener('pagehide', closePopup)
    return () => {
      window.removeEventListener('pagehide', closePopup)
      closePopup()
    }
  }, [])
  return { host, open, close }
}

export function SpeakerView({
  host,
  slides,
  active,
  scene,
  onGo,
  onEnd,
  boardId,
  projectId,
  identity,
  cloud,
}: {
  host: { window: Window; root: HTMLElement }
  slides: Slide[]
  active: Slide
  scene: SceneSnapshot
  onGo: (index: number) => void
  onEnd: () => void
  boardId: string
  projectId: string
  identity: string
  cloud: boolean
}) {
  const viewRef = useRef<HTMLElement>(null)
  const [notesSize, setNotesSize] = useState(20)
  const position = slides.indexOf(active)
  const [clock, setClock] = useState({ started: Date.now(), elapsed: 0, paused: false })
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const endOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onEnd()
    }
    host.window.document.addEventListener('keydown', endOnEscape, true)
    return () => host.window.document.removeEventListener('keydown', endOnEscape, true)
  }, [host, onEnd])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    host.root.className = `excalidraw speaker-view${scene.theme === 'dark' ? ' theme--dark' : ''}`
    viewRef.current?.focus()
  }, [host, scene.theme])
  useEffect(() => {
    viewRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active.id])
  const elapsed = clock.elapsed + (clock.paused ? 0 : Math.max(0, now - clock.started))
  const seconds = Math.floor(elapsed / 1000)
  const time = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  return createPortal(
    <section
      ref={viewRef}
      tabIndex={-1}
      aria-label="Speaker view"
      className="speaker-view-layout"
      onKeyDown={(event) => {
        event.stopPropagation()
        if ((event.target as HTMLElement).closest('textarea, input, select')) return
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? slides.length - 1
              : ['ArrowRight', 'PageDown', ' '].includes(event.key)
                ? position + 1
                : ['ArrowLeft', 'PageUp'].includes(event.key)
                  ? position - 1
                  : null
        if (index !== null && !(event.key === ' ' && (event.target as HTMLElement).closest('button'))) {
          event.preventDefault()
          onGo(index)
        }
      }}
    >
      <div className="speaker-view-body">
        <div className="speaker-view-preview">
          <SlidePreview slide={active} scene={scene} large renderWidth={1600} />
        </div>
        <div className="speaker-view-controls">
          <button className="speaker-view-end" aria-label="End presentation" onClick={onEnd}>
            <X size={18} /> End
          </button>
          <nav aria-label="Speaker navigation">
            <button
              disabled={position <= 0}
              aria-label="Previous slide"
              onClick={() => {
                onGo(position - 1)
                viewRef.current?.focus()
              }}
            >
              <ChevronLeft size={18} />
            </button>
            <span>
              {position + 1} / {slides.length}
            </span>
            <button
              disabled={position >= slides.length - 1}
              aria-label="Next slide"
              onClick={() => {
                onGo(position + 1)
                viewRef.current?.focus()
              }}
            >
              <ChevronRight size={18} />
            </button>
          </nav>
          <div className="speaker-view-clock">
            <output aria-label="Presentation timer">{time}</output>
            <button
              aria-label={clock.paused ? 'Resume timer' : 'Pause timer'}
              onClick={() => {
                const timestamp = Date.now()
                setClock({
                  started: timestamp,
                  elapsed: clock.elapsed + (clock.paused ? 0 : timestamp - clock.started),
                  paused: !clock.paused,
                })
                setNow(timestamp)
              }}
            >
              {clock.paused ? <Play size={16} /> : <Pause size={16} />}
            </button>
            <button
              aria-label="Reset timer"
              onClick={() => {
                const timestamp = Date.now()
                setClock({ started: timestamp, elapsed: 0, paused: clock.paused })
                setNow(timestamp)
              }}
            >
              <RotateCcw size={16} />
            </button>
          </div>
        </div>
        <div className="speaker-filmstrip" aria-label="Slides">
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              aria-label={`Go to slide ${index + 1}`}
              aria-current={slide.id === active.id ? 'true' : undefined}
              onClick={() => {
                onGo(index)
                viewRef.current?.focus()
              }}
            >
              <span>{index + 1}</span>
              <SlidePreview slide={slide} scene={scene} renderWidth={240} />
            </button>
          ))}
        </div>
        <aside className="presenter-notes" aria-label="Presenter speaker notes" style={{ fontSize: notesSize }}>
          <SlideNotes
            key={`${identity}:${active.id}`}
            boardId={boardId}
            projectId={projectId}
            slideId={active.id}
            identity={identity}
            cloud={cloud}
            inputId="presenter-notes-input"
            readOnly
          />
          <footer className="speaker-notes-footer">
            <span>Share only the presentation window.</span>
            <button
              aria-label="Decrease notes text size"
              disabled={notesSize <= 14}
              onClick={() => setNotesSize((size) => Math.max(14, size - 2))}
            >
              <AArrowDown size={18} />
            </button>
            <button
              aria-label="Increase notes text size"
              disabled={notesSize >= 36}
              onClick={() => setNotesSize((size) => Math.min(36, size + 2))}
            >
              <AArrowUp size={18} />
            </button>
          </footer>
        </aside>
      </div>
    </section>,
    host.root,
  )
}
