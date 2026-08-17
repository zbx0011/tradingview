import { describe, expect, it } from 'vitest'
import { makeDrawing } from './drawings'
import { ACTION_TOOLS, ALL_DRAWING_TOOLS, getTool, shouldExitDrawingMode, TOOL_GROUPS } from './toolCatalog'

describe('TradingView-style drawing catalog', () => {
  it('contains all eight expandable groups and action tools', () => {
    expect(TOOL_GROUPS.map((group) => group.id)).toEqual([
      'cursors', 'trend', 'fib-gann', 'patterns', 'forecast', 'shapes', 'annotations', 'icons',
    ])
    expect(TOOL_GROUPS.every((group) => group.tools.length >= 6)).toBe(true)
    expect(ALL_DRAWING_TOOLS.length).toBeGreaterThanOrEqual(110)
    expect(ACTION_TOOLS.map((item) => item.id)).toEqual(['measure', 'zoom'])
  })

  it('has unique ids, labels and executable behavior for every item', () => {
    const ids = ALL_DRAWING_TOOLS.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of ALL_DRAWING_TOOLS) {
      expect(item.label.length).toBeGreaterThan(0)
      expect(item.description.length).toBeGreaterThan(0)
      expect(getTool(item.id)).toBe(item)
      const drawing = makeDrawing(item, { x: .25, y: .4 })
      expect(drawing.tool).toBe(item.id)
      expect(drawing.behavior).toBe(item.behavior)
      expect(drawing.points).toEqual([{ x: .25, y: .4 }])
    }
  })

  it('makes the rectangle tool one-shot even when continuous drawing is enabled', () => {
    expect(shouldExitDrawingMode('rectangle', true)).toBe(true)
    expect(shouldExitDrawingMode('trend', true)).toBe(false)
    expect(shouldExitDrawingMode('trend', false)).toBe(true)
  })
})
