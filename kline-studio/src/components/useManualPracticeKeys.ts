import { useEffect, useLayoutEffect, useRef } from 'react'

/** Keyboard shortcuts for the active practice, registered ahead of the app's own shortcuts. */
export function useManualPracticeKeys(enabled: boolean, handlers: {
  advance: () => void
  /** Key 2: open long, or close the open position. */
  key2: () => void
  /** Key 3: open short. */
  key3: () => void
  note: () => void
  /** Esc: leave the replay (not called while a candle is being picked or a dialog is open). */
  escape?: () => void
  /** While a reason editor is open the practice keys are swallowed but do nothing. */
  blocked?: boolean
}) {
  const handlersRef = useRef(handlers)
  // Refresh right after each commit (before paint) so rapid or held key presses never run a stale handler.
  useLayoutEffect(() => { handlersRef.current = handlers })
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (event.key === 'Escape') {
        if (!handlersRef.current.blocked) handlersRef.current.escape?.()
        return
      }
      let action: (() => void) | null = null
      if (event.code === 'Backquote' || event.key === '`' || event.key === '·') action = handlersRef.current.note
      else if (!event.shiftKey && (event.code === 'Digit1' || event.code === 'Numpad1')) action = handlersRef.current.advance
      else if (!event.shiftKey && (event.code === 'Digit2' || event.code === 'Numpad2')) action = handlersRef.current.key2
      else if (!event.shiftKey && (event.code === 'Digit3' || event.code === 'Numpad3')) action = handlersRef.current.key3
      if (!action) return
      // Keep the number keys away from the timeframe dialog while practising.
      event.preventDefault()
      event.stopImmediatePropagation()
      if (handlersRef.current.blocked) return
      if (event.repeat && action !== handlersRef.current.advance) return
      action()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [enabled])
}
