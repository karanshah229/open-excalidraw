import { useEffect, useRef, useState } from 'react'
import {
  acknowledgeNote,
  callNote,
  MAX_NOTE_LENGTH,
  noteKey,
  readNoteDraft,
  writeNoteDraft,
  type NoteDraft,
  type RemoteNote,
} from './notes-store'

export function SlideNotes({
  boardId,
  projectId,
  slideId,
  identity,
  cloud,
  inputId = 'slide-notes-input',
  readOnly = false,
}: {
  boardId: string
  projectId: string
  slideId: string
  identity: string
  cloud: boolean
  readOnly?: boolean
  inputId?: string
}) {
  const [text, setText] = useState(''),
    [status, setStatus] = useState('Loading notes…'),
    [syncFailed, setSyncFailed] = useState(false)
  const [ready, setReady] = useState(false),
    [conflict, setConflict] = useState<RemoteNote | null>(null)
  const [reload, setReload] = useState(0)
  const draftRef = useRef<NoteDraft>(),
    queue = useRef(Promise.resolve()),
    timer = useRef<number>()
  const retryRef = useRef<() => void>(() => {})

  useEffect(() => {
    let active = true,
      saving = false,
      blocked = false
    const key = noteKey(identity, boardId, slideId)
    draftRef.current = undefined
    setText('')
    setReady(false)
    setConflict(null)
    setStatus('Loading notes…')
    setSyncFailed(false)
    const failed = (error: unknown) => {
      if (!active) return
      const code = (error as { code?: string })?.code ?? ''
      if (code.includes('permission-denied') || code.includes('unauthenticated')) {
        blocked = true
        setReady(false)
        setText('')
        setStatus('Speaker notes require editor access.')
      } else {
        setSyncFailed(cloud)
        if (!navigator.onLine) setStatus('Saved on this device · offline')
        else if (code.includes('invalid-argument')) setStatus('Saved on this device · cloud rejected this note')
        else if (code.includes('resource-exhausted')) setStatus('Saved on this device · cloud sync limit reached')
        else setStatus('Saved on this device · cloud notes service unavailable')
      }
    }
    const sync = async () => {
      if (!active || saving || blocked || !cloud || !navigator.onLine || !draftRef.current) return
      saving = true
      try {
        await queue.current
        if (!active) return
        const draft = draftRef.current!
        const remote = await callNote(
          draft.dirty && !readOnly ? 'write' : 'read',
          boardId,
          projectId,
          slideId,
          draft.dirty && !readOnly ? draft : undefined,
        )
        if (!active) return
        // A read may race typing; do not replace or advance the base of that new draft.
        if (!draft.dirty && draftRef.current?.mutationId !== draft.mutationId) return
        if (remote.conflict) {
          blocked = true
          setConflict(remote)
          setStatus('Notes changed elsewhere · your draft is preserved')
          return
        }
        if (readOnly) {
          if (!draft.dirty) setText(remote.text)
          setSyncFailed(false)
          setStatus(draft.dirty ? 'Unsynced draft · edit notes on the board to sync' : 'Edit notes on the board')
          return
        }
        const next = await acknowledgeNote(draft, remote)
        if (!active) return
        draftRef.current = next
        setSyncFailed(false)
        setText(next.text)
        setStatus(next.dirty ? 'Saving notes…' : 'All notes saved')
      } catch (error) {
        failed(error)
      } finally {
        saving = false
      }
    }
    retryRef.current = () => {
      void sync()
    }
    void (async () => {
      try {
        await queue.current
        const cached = await readNoteDraft(key)
        if (!active) return
        let draft = cached ?? { key, text: '', revision: 0, dirty: false, mutationId: crypto.randomUUID() }
        draftRef.current = draft
        setText(draft.text)
        if (cloud && navigator.onLine) {
          const remote = await callNote('read', boardId, projectId, slideId)
          if (!active) return
          if (draft.dirty && draft.revision !== remote.revision) {
            blocked = true
            setConflict(remote)
            setStatus('Notes changed elsewhere · your draft is preserved')
          } else if (!draft.dirty) draft = { ...draft, text: remote.text, revision: remote.revision }
        }
        if (!active) return
        draftRef.current = draft
        setText(draft.text)
        setReady(true)
        if (!blocked) {
          setStatus(readOnly ? 'Edit notes on the board' : cloud ? 'Saved on this device' : 'Saved locally')
          void sync()
        }
      } catch (error) {
        if (active && draftRef.current) setReady(true)
        failed(error)
      }
    })()
    window.addEventListener('online', retryRef.current)
    const retry = retryRef.current
    const interval = window.setInterval(retry, 15000)
    return () => {
      active = false
      window.clearTimeout(timer.current)
      window.clearInterval(interval)
      window.removeEventListener('online', retry)
    }
  }, [boardId, projectId, slideId, identity, cloud, reload, readOnly])

  function change(value: string) {
    if (readOnly) return
    setText(value)
    const draft = { ...draftRef.current!, text: value, dirty: true, mutationId: crypto.randomUUID() }
    draftRef.current = draft
    queue.current = queue.current.catch(() => {}).then(() => writeNoteDraft(draft))
    void queue.current.catch(() => setStatus('Could not save notes on this device'))
    setStatus(cloud ? 'Saving notes…' : 'Saved locally')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => retryRef.current(), 600)
  }

  async function resolveConflict(useRemote: boolean) {
    if (readOnly) return
    const remote = conflict!,
      draft = draftRef.current!
    await queue.current
    const next = {
      ...draft,
      text: useRemote ? remote.text : draft.text,
      revision: remote.revision,
      dirty: !useRemote,
      mutationId: crypto.randomUUID(),
    }
    await writeNoteDraft(next)
    draftRef.current = next
    setText(next.text)
    setConflict(null)
    setReload((value) => value + 1)
  }

  return (
    <section className="slide-notes" aria-label="Speaker notes">
      <label htmlFor={inputId}>
        Speaker notes <span>Only board editors can read these</span>
      </label>
      <textarea
        id={inputId}
        value={text}
        readOnly={readOnly}
        disabled={!ready}
        maxLength={MAX_NOTE_LENGTH}
        placeholder="Talking points for this slide…"
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <p role="status">{status}</p>
      {syncFailed && (
        <button
          type="button"
          className="slide-notes-retry"
          onClick={() => {
            setSyncFailed(false)
            setStatus('Retrying cloud sync…')
            retryRef.current()
          }}
        >
          Retry cloud sync
        </button>
      )}
      {conflict && (
        <div className="slide-note-conflict">
          <details>
            <summary>View cloud version</summary>
            <pre>{conflict.text || '(Empty notes)'}</pre>
          </details>
          {!readOnly && (
            <button
              onClick={() =>
                void resolveConflict(false).catch(() =>
                  setStatus('Could not save the resolved notes · your draft is preserved'),
                )
              }
            >
              Use my draft
            </button>
          )}
          {!readOnly && (
            <button
              onClick={() =>
                void resolveConflict(true).catch(() =>
                  setStatus('Could not save the resolved notes · your draft is preserved'),
                )
              }
            >
              Use cloud version
            </button>
          )}
        </div>
      )}
    </section>
  )
}
