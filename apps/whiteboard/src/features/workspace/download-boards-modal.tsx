import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, Check } from 'lucide-react'
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
      await downloadExport(next, controller.current.signal)
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
        <Dialog.Content className="dialog-content" aria-describedby="download-desc">
          <Dialog.Title>Download {name}</Dialog.Title>
          <Dialog.Description id="download-desc">
            Download a ZIP of your selected formats, including images and unsynced edits.
          </Dialog.Description>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              className="ui-button ui-button--outline"
              disabled={Boolean(progress)}
              aria-label="Download formats"
            >
              Formats: {formats.join(', ') || 'Choose formats'} <ChevronDown size={14} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="google-share-dropdown-menu" sideOffset={6}>
                {exportFormats.map((format) => (
                  <DropdownMenu.CheckboxItem
                    key={format}
                    className="google-share-dropdown-item"
                    checked={formats.includes(format)}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) => {
                      setResult(null)
                      setFormats((previous) =>
                        checked ? [...previous, format] : previous.filter((item) => item !== format),
                      )
                    }}
                  >
                    <DropdownMenu.ItemIndicator>
                      <Check size={14} />
                    </DropdownMenu.ItemIndicator>
                    {format === 'excalidraw' ? 'Excalidraw (editable)' : format.toUpperCase()}
                  </DropdownMenu.CheckboxItem>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {progress && <p role="status">{progress}</p>}
          {error && <p role="alert">{error}</p>}
          {result && (
            <p role="status">
              {Object.keys(result.files).length} files downloaded. {result.failures.length} failed.
            </p>
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
          <div className="modal-actions">
            <button className="modal-btn-cancel" onClick={close}>
              {progress ? 'Cancel' : 'Close'}
            </button>
            {result?.failures.length ? (
              <button className="modal-btn-create" disabled={Boolean(progress)} onClick={() => void run(true)}>
                Retry failed exports
              </button>
            ) : null}
            <button
              className="modal-btn-create"
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
