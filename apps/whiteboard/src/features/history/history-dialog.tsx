import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Calendar, Loader2, X } from 'lucide-react'
import { useTheme } from '../../lib/theme-context'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../../components/ui/accordion'
import { Excalidraw, MainMenu, restoreElements } from '@excalidraw/excalidraw'
import { getSlides } from '../slides/slide-model'
import { groupHistory, mergeHistoryPages, type HistoryEntry, type HistorySnapshot, type HistorySource } from './history-model'
import './history-dialog.css'
type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  source: HistorySource
  canRestore: boolean
  isDirty(): Promise<boolean>
  onRestoreStart(): void
  onRestoreComplete(): Promise<void>
  onRestoreFailed(): void
}

/** Independent view-only canvas. No live editor callbacks, asset cache, MCP target or notes store. */
function SnapshotPreview({ snapshot }: { snapshot: HistorySnapshot }) {
  const { resolvedTheme } = useTheme()
  const scene = snapshot.scene
  const elements = useMemo(() => restoreElements(scene.elements as any, null), [scene.elements])
  const slides = useMemo(() => getSlides(elements), [elements])
  return (
    <>
      <h3 data-testid="history-preview-name">{snapshot.entry.name}</h3>
      <div className="history-preview-canvas" data-testid="history-preview-canvas">
        <Excalidraw
          key={snapshot.entry.id}
          initialData={{ elements, appState: { ...scene.appState, viewModeEnabled: true }, files: scene.files as any, scrollToContent: true }}
          theme={resolvedTheme}
          viewModeEnabled
          zenModeEnabled
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, clearCanvas: false, changeViewBackgroundColor: false, toggleTheme: false } }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.Help />
          </MainMenu>
        </Excalidraw>
      </div>
      <div className="history-preview-notes" data-testid="history-preview-notes">
        {slides.map((slide, index) => (
          <section key={slide.id}>
            <h4>{slide.name || `Slide ${index + 1}`}</h4>
            <div>{snapshot.notes[slide.id] || 'No speaker notes'}</div>
          </section>
        ))}
      </div>
    </>
  )
}

export default function HistoryDialog({ open, onOpenChange, source, canRestore, isDirty, onRestoreStart, onRestoreComplete, onRestoreFailed }: Props) {
  const [closedGroups, setClosedGroups] = useState<string[]>([])
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [cursor, setCursor] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [snapshot, setSnapshot] = useState<HistorySnapshot>()
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const listEpoch = useRef(0)
  const previewEpoch = useRef(0)
  const previewAbort = useRef<AbortController>()
  const previewCache = useRef(new Map<string, HistorySnapshot>())
  const previewCacheSource = useRef(source)
  const mounted = useRef(true)
  const restoreStarted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const select = useCallback(async (entry: HistoryEntry) => {
    if (previewCacheSource.current !== source) {
      previewCache.current.clear()
      previewCacheSource.current = source
    }
    const epoch = ++previewEpoch.current
    previewAbort.current?.abort()
    const cached = previewCache.current.get(entry.id)
    if (cached) {
      setSelectedId(entry.id)
      setSnapshot(cached)
      setPreviewLoading(false)
      setError('')
      return
    }
    const abort = new AbortController()
    previewAbort.current = abort
    setSelectedId(entry.id)
    setSnapshot(undefined)
    setPreviewLoading(true)
    setError('')
    try {
      const value = await source.preview(entry.id, abort.signal)
      if (epoch === previewEpoch.current) {
        previewCache.current.set(entry.id, value)
        setSnapshot(value)
      }
    } catch (reason) {
      if (epoch === previewEpoch.current) setError(reason instanceof Error ? reason.message : 'Could not preview this version.')
    } finally {
      if (epoch === previewEpoch.current) setPreviewLoading(false)
    }
  }, [source])
  useEffect(() => {
    const epoch = ++listEpoch.current
    ++previewEpoch.current
    previewAbort.current?.abort()
    setSnapshot(undefined)
    setSelectedId(undefined)
    setConfirm(false)
    setError('')
    if (!open) return
    setEntries([])
    setClosedGroups([])
    setLoading(true)
    void source.list().then((page) => {
      if (epoch !== listEpoch.current) return
      setEntries(page.entries)
      setCursor(page.cursor)
      const latest = page.entries.reduce<HistoryEntry | undefined>((newest, entry) => {
        if (!newest) return entry
        const timestamp = (value: HistoryEntry) => Date.parse(value.capturedAt ?? value.createdAt) || 0
        return timestamp(entry) > timestamp(newest) ? entry : newest
      }, undefined)
      if (latest) void select(latest)
    }).catch((reason) => {
      if (epoch === listEpoch.current) setError(reason instanceof Error ? reason.message : 'Could not load history.')
    }).finally(() => { if (epoch === listEpoch.current) setLoading(false) })
    return () => { ++listEpoch.current; ++previewEpoch.current; previewAbort.current?.abort() }
  }, [open, source, select])

  const groups = useMemo(() => groupHistory(entries), [entries])
  const restoreDisabledReason = restoring ? 'Restoration is in progress.'
    : !snapshot ? (previewLoading ? '' : 'Select a version to restore.')
    : !canRestore ? 'Restoration is unavailable while this board is read-only or locked.'
    : snapshot.entry.current ? 'This is the current version.'
    : snapshot.entry.restorable === false ? 'This version is saved on this device only. It must sync to the cloud before it can be restored.'
    : ''
  const loadMore = async () => {
    if (!cursor || loading) return
    const epoch = listEpoch.current
    setLoading(true)
    setError('')
    try {
      const page = await source.list(cursor)
      if (epoch !== listEpoch.current) return
      setEntries((previous) => mergeHistoryPages(previous, page.entries))
      setCursor(page.cursor)
    } catch (reason) {
      if (epoch === listEpoch.current) setError(reason instanceof Error ? reason.message : 'Could not load more versions.')
    } finally {
      if (epoch === listEpoch.current) setLoading(false)
    }
  }
  const restore = async () => {
    if (!snapshot || snapshot.entry.current || snapshot.entry.restorable === false || !canRestore || restoreStarted.current) return
    restoreStarted.current = true
    setConfirm(false)
    setRestoring(true)
    setError('')
    onRestoreStart()
    try {
      await source.restore(snapshot.entry.id, crypto.randomUUID())
      await onRestoreComplete()
      if (mounted.current) onOpenChange(false)
    } catch (reason) {
      onRestoreFailed()
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Restore failed. Your pending changes are preserved.')
    } finally {
      restoreStarted.current = false
      if (mounted.current) setRestoring(false)
    }
  }
  const requestRestore = async () => {
    if (!snapshot || restoring || !canRestore) return
    try {
      if (await isDirty()) setConfirm(true)
      else await restore()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not check pending changes. Restore has not started.')
    }
  }
  return (
    <>
      <Dialog.Root open={open} onOpenChange={(value) => { if (!restoring) onOpenChange(value) }}>
        <Dialog.Portal>
          <Dialog.Overlay className="history-overlay" />
          <Dialog.Content className="history-dialog" data-testid="board-history-dialog" onEscapeKeyDown={(event) => { if (restoring) event.preventDefault() }} onInteractOutside={(event) => event.preventDefault()}>
            <div className="history-dialog-header">
              <Dialog.Title>Board history</Dialog.Title>
              <Dialog.Close className="history-button history-close" disabled={restoring} aria-label="Close board history"><X size={20} aria-hidden="true" /></Dialog.Close>
            </div>
            <Dialog.Description className="history-dialog-description">Every saved version is kept for 30 days. Restoring hides later versions and keeps current sharing.</Dialog.Description>
            {error ? <p role="alert" className="history-error">{error}</p> : null}
            <div className="history-layout">
              <aside className="history-list" aria-label="Saved board versions">
                <Accordion type="multiple" value={groups.filter((group) => !closedGroups.includes(group.day)).map((group) => group.day)} onValueChange={(days) => setClosedGroups(groups.filter((group) => !days.includes(group.day)).map((group) => group.day))}>
                  {groups.map((group) => (
                    <AccordionItem key={group.day} value={group.day} data-testid="history-date-group">
                      <AccordionTrigger disabled={restoring}><Calendar size={16} aria-hidden="true" /><span>{group.day}</span><span className="history-group-count">{group.entries.length}</span></AccordionTrigger>
                      <AccordionContent>
                        {group.entries.map((entry) => (
                          <button className="history-entry" type="button" key={entry.id} data-version-id={entry.id} aria-pressed={entry.id === selectedId} onClick={() => void select(entry)} disabled={restoring}>
                            <time dateTime={entry.capturedAt ?? entry.createdAt}>{new Date(entry.capturedAt ?? entry.createdAt).toLocaleString()}</time>
                            <small>{[entry.current ? 'Current' : null, entry.origin === 'local' ? 'Saved on device' : 'Saved to cloud'].filter(Boolean).join(' · ')}</small>
                            {entry.actorLabel ? <small>{entry.actorLabel}</small> : null}
                          </button>
                        ))}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
                {!loading && !entries.length ? <p>No saved versions yet.</p> : null}
                {loading ? <p role="status">Loading versions…</p> : null}
                {cursor ? <button className="history-button" disabled={loading || restoring} onClick={() => void loadMore()}>Load more versions</button> : null}
              </aside>
              <section className="history-preview" aria-label="Version preview">
                {previewLoading ? <div className="history-preview-loading" role="status" aria-label="Loading version preview"><Loader2 className="history-preview-spinner" size={28} aria-hidden="true" /></div> : snapshot ? <SnapshotPreview key={snapshot.entry.id} snapshot={snapshot} /> : <p>Select a version to preview it.</p>}
                <div className="history-actions">
                  {restoreDisabledReason ? <p className="history-restore-reason" data-testid="history-restore-reason">{restoreDisabledReason}</p> : null}
                  <button className="history-button history-button-primary" data-testid="history-restore" disabled={Boolean(restoreDisabledReason) || previewLoading || !snapshot} onClick={() => void requestRestore()}>Restore this version</button>
                </div>
              </section>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={confirm} onOpenChange={setConfirm}>
        <Dialog.Portal>
          <Dialog.Overlay className="history-overlay" style={{ zIndex: 702 }} />
          <Dialog.Content className="history-confirm" data-testid="history-data-loss-confirmation">
            <Dialog.Title>Discard unsynced changes?</Dialog.Title>
            <Dialog.Description>All changes not yet synced to the cloud will be lost, including speaker notes and saved local versions. Later versions will become unavailable.</Dialog.Description>
            <div className="history-actions">
              <Dialog.Close className="history-button">Cancel</Dialog.Close>
              <button className="history-button history-button-primary" data-testid="history-confirm-restore" onClick={() => void restore()}>Discard changes and restore</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
