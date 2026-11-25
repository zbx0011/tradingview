import { useEffect, useLayoutEffect, useRef } from 'react'
import { isEditableShortcutTarget } from '../lib/shortcuts'

/** Keyboard shortcuts for the active practice, registered ahead of the app's own shortcuts. */
export function useManualPracticeKeys(enabled: boolean, handlers: {
  advance: () => void
  /** Key 2: open long, or close the open position. */
  key2: () => void
  /** Key 3: open short. */
  key3: () => void
  note?: () => void
  /** Tab: hide / show the trade markers, orders and drawings on the chart (the backquote key is taken by `note`). */
  toggleHidden?: () => void
  /** Key 4 (亏损单复盘: mark as not understood). */
  key4?: () => void
  /** Key 5 (亏损单复盘: favourite the trade). */
  key5?: () => void
  /** Ignore repeats in contexts where key 1 is a one-time action. */
  noRepeat?: boolean
  /** Esc, only when no input or dialog has it (review replay: leave the replay). */
  escape?: () => void
  /** While a reason editor is open the practice keys are swallowed but do nothing. */
  blocked?: boolean
}) {
  const handlersRef = useRef(handlers)
  // Refresh right after each commit (before paint) so rapid or held key presses never run a stale handler.
  useLayoutEffect(() => { handlersRef.current = handlers })
  useEffect(() => {
    if (!enabled) return
    let advanceStartedHere = false
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return
      if (isEditableShortcutTarget(event.target)) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (event.key === 'Escape') {
        if (!handlersRef.current.blocked) handlersRef.current.escape?.()
        return
      }
      let action: (() => void) | null = null
      if (event.code === 'Backquote' || event.key === '`' || event.key === '·') action = handlersRef.current.note ?? null
      else if (!event.shiftKey && event.key === 'Tab' && handlersRef.current.toggleHidden) action = handlersRef.current.toggleHidden
      else if (!event.shiftKey && (event.code === 'Digit1' || event.code === 'Numpad1')) action = handlersRef.current.advance
      else if (!event.shiftKey && (event.code === 'Digit2' || event.code === 'Numpad2')) action = handlersRef.current.key2
      else if (!event.shiftKey && (event.code === 'Digit3' || event.code === 'Numpad3')) action = handlersRef.current.key3
      else if (!event.shiftKey && (event.code === 'Digit4' || event.code === 'Numpad4') && handlersRef.current.key4) action = handlersRef.current.key4
      else if (!event.shiftKey && (event.code === 'Digit5' || event.code === 'Numpad5') && handlersRef.current.key5) action = handlersRef.current.key5
      if (!action) return
      // Keep the number keys away from the timeframe dialog while practising (and Tab from moving focus).
      event.preventDefault()
      event.stopImmediatePropagation()
      if (handlersRef.current.blocked) return
      const advancing = action === handlersRef.current.advance
      // A key held through an order confirmation belongs to that dialog until released.
      if (event.repeat && (!advancing || handlersRef.current.noRepeat || !advanceStartedHere)) return
      if (advancing) advanceStartedHere = true
      action()
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Digit1' || event.code === 'Numpad1') advanceStartedHere = false
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [enabled])
}
