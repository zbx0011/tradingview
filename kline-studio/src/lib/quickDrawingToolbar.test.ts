import { describe, expect, it } from 'vitest'
import { clampQuickDrawingToolbarPosition, parseQuickDrawingToolbarPosition } from './quickDrawingToolbar'

describe('quick drawing toolbar position', () => {
  it('keeps a dragged toolbar inside every chart edge', () => {
    expect(clampQuickDrawingToolbarPosition(
      { left: -100, top: 900 },
      { width: 1000, height: 600 },
      { width: 400, height: 48 },
    )).toEqual({ left: 8, top: 544 })
  })

  it('handles a toolbar wider than its chart without producing a negative position', () => {
    expect(clampQuickDrawingToolbarPosition(
      { left: 400, top: 40 },
      { width: 300, height: 200 },
      { width: 500, height: 48 },
    )).toEqual({ left: 8, top: 40 })
  })

  it('rejects malformed saved positions', () => {
    expect(parseQuickDrawingToolbarPosition('{"left":120,"top":40}')).toEqual({ left: 120, top: 40 })
    expect(parseQuickDrawingToolbarPosition('{"left":"120","top":40}')).toBeNull()
    expect(parseQuickDrawingToolbarPosition('bad json')).toBeNull()
  })
})
