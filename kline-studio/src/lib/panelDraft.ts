import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const PREFIX = 'kline-panel-state-v1:'

export function loadPanelState<T>(id: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFIX + id) ?? 'null')
    return valid(value) ? value : fallback
  } catch { return fallback }
}

export function savePanelState(id: string, value: unknown) {
  try { localStorage.setItem(PREFIX + id, JSON.stringify(value)) } catch { /* Storage may be unavailable. */ }
}

export function clearPanelState(id: string) {
  try { localStorage.removeItem(PREFIX + id) } catch { /* Storage may be unavailable. */ }
}

/** Drafts survive an interrupted page, but explicit save/cancel discards the draft. */
export function usePanelDraft<T>(id: string, initial: () => T, valid: (value: unknown) => value is T) {
  const [value, setValue] = useState(() => loadPanelState(id, initial(), valid))
  const latest = useRef(value)
  const discarded = useRef(false)
  useLayoutEffect(() => {
    latest.current = value
    if (!discarded.current) savePanelState(id, value)
  }, [id, value])
  useEffect(() => {
    const flush = () => { if (!discarded.current) savePanelState(id, latest.current) }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [id])
  const discard = () => { discarded.current = true; clearPanelState(id) }
  return [value, setValue, discard] as const
}
