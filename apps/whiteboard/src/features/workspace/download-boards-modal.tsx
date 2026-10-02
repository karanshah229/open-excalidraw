import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import { FilterCheck } from './workspace-filters'
import { ChevronDown } from 'lucide-react'
import { exportFormats, type ExportFormat, type ExportResult } from './export-boards'

export function DownloadBoardsModal({
  projectId,
  name,
  onClose,
}: {
  projectId?: string
  name: string
  onClose: () => void
}) {
  const [formats, setFormats] = useState<ExportFormat[]>(['excalidraw'])
  const [progress, setProgress] = useState<string | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const run = async (retry = false) => {
    if (controller.current) return
    controller.current = new AbortController()
    setError('')
    setProgress('Preparing boards…')
    try {
      const { exportBoards, downloadExport } = await import('./export-boards')
      const next = await exportBoards({
        projectId,
        formats,
        signal: controller.current.signal,
        previous: retry ? (result ?? undefined) : undefined,
        onProgress: (done, total) => setProgress(`Preparing ${done} of ${total} boards…`),
      })
      controller.current.signal.throwIfAborted()
      await downloadExport(next, controller.current.signal, projectId ? `${name}-boards` : 'my-boards')
      setResult(next)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Download failed.')
    } finally {
      controller.current = null
      setProgress(null)
    }
  }
  const close = () => {
    controller.current?.abort()
    onClose()
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content google-share-dialog download-boards-dialog"
          aria-describedby="download-desc"
        >
          <div className="google-share-header">
            <Dialog.Title className="google-share-title">Download {name}</Dialog.Title>
          </div>
          <Dialog.Description id="download-desc" className="project-dialog-description">
            Download a ZIP with your boards, images, and unsynced edits.
          </Dialog.Description>
          <div className="download-format-field">
            <span className="download-field-label">File formats</span>
            <Popover.Root>
              <Popover.Trigger
                className="download-format-trigger"
                disabled={Boolean(progress)}
                aria-label="Download formats"
              >
                <span>
                  {formats
                    .map((format) => (format === 'excalidraw' ? 'Excalidraw' : format.toUpperCase()))
                    .join(', ') || 'Choose formats'}
                </span>
                <ChevronDown size={16} />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="filter-popover download-format-popover" align="start" sideOffset={8}>
                  <div className="filter-popover-body">
                    <span className="filter-section-title">Include formats</span>
                    <div className="filter-options">
                      {exportFormats.map((format) => (
                        <FilterCheck
                          key={format}
                          label={format === 'excalidraw' ? 'Excalidraw (editable)' : format.toUpperCase()}
                          checked={formats.includes(format)}
                          onCheckedChange={() => {
                            setResult(null)
                            setFormats((previous) =>
                              previous.includes(format)
                                ? previous.filter((item) => item !== format)
                                : [...previous, format],
                            )
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
          <div className="download-status-area" aria-live="polite">
            {progress ? (
              <p role="status">{progress}</p>
            ) : error ? (
              <p role="alert" className="download-error">
                {error}
              </p>
            ) : result ? (
              <p role="status">
                {Object.keys(result.files).length} files downloaded. {result.failures.length} failed.
              </p>
            ) : (
              <p className="download-hint">Select one or more formats. PNG and SVG include the canvas background.</p>
            )}
            {result?.failures.length ? (
              <ul className="export-failures">
                {result.failures.map((failure) => (
                  <li key={`${failure.boardId}-${failure.format}`}>
                    {failure.boardName} ({failure.format}): {failure.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="download-retry-row">
            <button
              className="google-share-copy-btn"
              style={{ visibility: result?.failures.length ? 'visible' : 'hidden' }}
              disabled={!result?.failures.length || Boolean(progress)}
              onClick={() => void run(true)}
            >
              Retry failed exports
            </button>
          </div>
          <div className="google-share-footer">
            <button className="google-share-copy-btn" onClick={close}>
              {progress ? 'Cancel' : 'Close'}
            </button>
            <button
              className="google-share-done-btn"
              disabled={!formats.length || Boolean(progress)}
              onClick={() => void run()}
            >
              Download ZIP
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
