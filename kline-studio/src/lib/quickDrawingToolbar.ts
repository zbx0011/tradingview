export interface QuickDrawingToolbarPosition {
  left: number
  top: number
}

export interface QuickDrawingToolbarSize {
  width: number
  height: number
}

export const QUICK_DRAWING_TOOLBAR_POSITION_KEY = 'kline-studio-quick-drawing-toolbar-position-v1'

export function clampQuickDrawingToolbarPosition(
  position: QuickDrawingToolbarPosition,
  container: QuickDrawingToolbarSize,
  toolbar: QuickDrawingToolbarSize,
  padding = 8,
): QuickDrawingToolbarPosition {
  const maxLeft = Math.max(padding, container.width - toolbar.width - padding)
  const maxTop = Math.max(padding, container.height - toolbar.height - padding)
  return {
    left: Math.min(Math.max(position.left, padding), maxLeft),
    top: Math.min(Math.max(position.top, padding), maxTop),
  }
}

export function parseQuickDrawingToolbarPosition(raw: string | null): QuickDrawingToolbarPosition | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<QuickDrawingToolbarPosition>
    return Number.isFinite(value.left) && Number.isFinite(value.top)
      ? { left: value.left!, top: value.top! }
      : null
  } catch {
    return null
  }
}

export function loadQuickDrawingToolbarPosition() {
  if (typeof localStorage === 'undefined') return null
  return parseQuickDrawingToolbarPosition(localStorage.getItem(QUICK_DRAWING_TOOLBAR_POSITION_KEY))
}

export function saveQuickDrawingToolbarPosition(position: QuickDrawingToolbarPosition) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(QUICK_DRAWING_TOOLBAR_POSITION_KEY, JSON.stringify(position))
  }
}
