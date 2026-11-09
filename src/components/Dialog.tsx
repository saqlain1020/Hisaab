import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

interface DialogRequest {
  title: string
  message?: string
  input?: { label: string; value: string; placeholder?: string }
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** Return an error message to keep the dialog open. */
  validate?: (value: string) => Promise<string | null> | string | null
  resolve: (v: string | boolean | null) => void
}

let active: DialogRequest | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function open(req: Omit<DialogRequest, 'resolve'>) {
  return new Promise<string | boolean | null>((resolve) => {
    active?.resolve(null)
    active = { ...req, resolve }
    emit()
  })
}

/** Yes/no question. Resolves true when confirmed. */
export async function confirmDialog(opts: Omit<DialogRequest, 'resolve' | 'input' | 'validate'>) {
  return (await open(opts)) === true
}

/** One-field prompt. Resolves the text, or null when cancelled. */
export async function promptDialog(opts: Omit<DialogRequest, 'resolve'> & { input: DialogRequest['input'] }) {
  const v = await open(opts)
  return typeof v === 'string' ? v : null
}

export function DialogHost() {
  const req = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => active,
  )
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setValue(req?.input?.value ?? '')
    setError(null)
    setBusy(false)
    if (req?.input) setTimeout(() => inputRef.current?.select(), 50)
  }, [req])

  if (!req) return null

  const close = (v: string | boolean | null) => {
    if (active === req) active = null
    req.resolve(v)
    emit()
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (req.input) {
      if (req.validate) {
        setBusy(true)
        const err = await req.validate(value)
        setBusy(false)
        if (err) return setError(err)
      }
      close(value)
    } else close(true)
  }

  return (
    <div className="dialog-backdrop" onClick={() => close(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id="dialog-title">{req.title}</h2>
        {req.message && <p className="muted">{req.message}</p>}
        {req.input && (
          <label className="field">
            <span>{req.input.label}</span>
            <input
              ref={inputRef}
              value={value}
              placeholder={req.input.placeholder}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
              autoComplete="off"
              enterKeyHint="done"
            />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={() => close(null)}>
            {req.cancelLabel ?? 'Cancel'}
          </button>
          <button type="submit" className={`btn ${req.danger ? 'danger' : 'primary'}`} disabled={busy}>
            {req.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------- Toasts ----------

let toastMsg: { text: string; id: number } | null = null
const toastListeners = new Set<() => void>()
let toastTimer: ReturnType<typeof setTimeout> | undefined

export function toast(text: string) {
  toastMsg = { text, id: Date.now() }
  toastListeners.forEach((l) => l())
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMsg = null
    toastListeners.forEach((l) => l())
  }, 2600)
}

export function ToastHost() {
  const msg = useSyncExternalStore(
    (fn) => {
      toastListeners.add(fn)
      return () => toastListeners.delete(fn)
    },
    () => toastMsg,
  )
  return (
    <div className="toast-wrap" aria-live="polite">
      {msg && (
        <div key={msg.id} className="toast">
          {msg.text}
        </div>
      )}
    </div>
  )
}
