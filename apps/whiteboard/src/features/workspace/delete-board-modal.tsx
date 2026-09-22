import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'

interface DeleteBoardModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  boardName: string
  onConfirm: () => Promise<void> | void
}

export function DeleteBoardModal({ open, onOpenChange, boardName, onConfirm }: DeleteBoardModalProps) {
  const [isDeleting, setIsDeleting] = useState(false)

  const handleConfirm = async () => {
    if (isDeleting) return
    setIsDeleting(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to delete board:', error)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content delete-modal-content" aria-describedby="delete-board-desc">
          <Dialog.Title className="delete-board-title">Delete board</Dialog.Title>
          <Dialog.Description id="delete-board-desc" className="delete-board-desc">
            Are you sure you want to delete <strong>&ldquo;{boardName}&rdquo;</strong>? This action cannot be undone.
          </Dialog.Description>

          <div className="modal-actions">
            <button
              type="button"
              className="modal-btn-cancel"
              onClick={() => onOpenChange(false)}
              disabled={isDeleting}
            >
              Cancel
            </button>
            <button type="button" className="modal-btn-danger" onClick={handleConfirm} disabled={isDeleting}>
              {isDeleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
