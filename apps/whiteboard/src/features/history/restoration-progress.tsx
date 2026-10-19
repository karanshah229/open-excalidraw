import * as Dialog from '@radix-ui/react-dialog'
import './history-dialog.css'

export function RestorationProgress({ open, error, onRetry }: { open: boolean; error?: string; onRetry?: () => void }) {
  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="history-overlay history-progress-overlay" />
        <Dialog.Content className="history-confirm history-progress" data-testid="history-restoration-progress" onEscapeKeyDown={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()}>
          <Dialog.Title>Restoring board</Dialog.Title>
          <Dialog.Description>Editing is paused while the board is restored. You can edit again when the replacement finishes loading.</Dialog.Description>
          {error ? <><p role="alert" className="history-error">{error}</p><button className="history-button" onClick={onRetry}>Retry loading restored board</button></> : <p role="status">Restoration in progress…</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
