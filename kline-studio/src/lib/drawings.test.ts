import { describe, expect, it } from 'vitest'
import { constrainDrawingPoint, drawingReducer, duplicateDrawing, hitTestDrawing, initialDrawingHistory, makeDrawing, moveDrawing, normalizeFibSettings, partiallyEraseDrawing, withoutTransientMeasurements } from './drawings'
import { parseWorkspace } from './persistence'

describe('drawing history and persistence', () => {
  it('adds, deletes, undoes and redoes drawings', () => {
    const drawing = { ...makeDrawing('trend', { x: 0.1, y: 0.2 }), id: 'test' }
    let state = drawingReducer(initialDrawingHistory, { type: 'add', drawing })
    expect(state.present).toHaveLength(1)
    state = drawingReducer(state, { type: 'delete', id: 'test' })
    expect(state.present).toHaveLength(0)
    state = drawingReducer(state, { type: 'undo' })
    expect(state.present).toHaveLength(1)
    state = drawingReducer(state, { type: 'redo' })
    expect(state.present).toHaveLength(0)
  })

  it('accepts a valid saved workspace and rejects malformed input', () => {
    const valid = JSON.stringify({
      symbol: 'XAUUSD', interval: '5m', chartType: 'candles', theme: 'dark', drawings: [],
      indicators: { ma: true, ema: false, boll: false, volume: true, maPeriod: 20, emaPeriod: 9, bollPeriod: 20, bollDeviation: 2 },
    })
    expect(parseWorkspace(valid)?.symbol).toBe('XAUUSD')
    expect(parseWorkspace('{broken')).toBeNull()
    expect(parseWorkspace(JSON.stringify({ symbol: 'NOPE', interval: '5m', indicators: {}, drawings: [] }))).toBeNull()
  })

  it('duplicates and nudges drawings without mutating the source', () => {
    const source = { ...makeDrawing('trend', { x: 0.1, y: 0.2 }), id: 'source', points: [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.8 }] }
    const copy = duplicateDrawing(source)
    expect(copy.id).not.toBe(source.id)
    expect(copy.points[0].x).toBeCloseTo(0.12)
    expect(copy.points[0].y).toBeCloseTo(0.22)
    expect(source.points[0]).toEqual({ x: 0.1, y: 0.2 })
    const moved = moveDrawing(source, 0.2, -0.3)
    expect(moved[0].x).toBeCloseTo(0.3)
    expect(moved[0].y).toBe(0)
    expect(moved[1]).toEqual({ x: 1, y: 0.5 })
  })

  it('supports TradingView-style Ctrl+click additive selection', () => {
    const first = { ...makeDrawing('trend', { x: 0.1, y: 0.2 }), id: 'first' }
    const second = { ...makeDrawing('horizontal', { x: 0.3, y: 0.4 }), id: 'second' }
    let state = drawingReducer(initialDrawingHistory, { type: 'add', drawing: first })
    state = drawingReducer(state, { type: 'add', drawing: second })
    state = drawingReducer(state, { type: 'select', id: 'first', additive: true })
    expect(state.selectedIds).toEqual(['second', 'first'])
    state = drawingReducer(state, { type: 'select', id: 'second', additive: true })
    expect(state.selectedIds).toEqual(['first'])
    expect(state.selectedId).toBe('first')
    state = drawingReducer(state, { type: 'delete-many', ids: state.selectedIds })
    expect(state.present.map((drawing) => drawing.id)).toEqual(['second'])
  })

  it('uses a forgiving screen-space hit area for thin trend lines', () => {
    const drawing = { ...makeDrawing('trend', { x: .2, y: .2 }), points: [{ x: .2, y: .2 }, { x: .8, y: .8 }] }
    expect(hitTestDrawing(drawing, { x: .5, y: .51 }, 1000, 500)).toBe(true)
    expect(hitTestDrawing(drawing, { x: .5, y: .56 }, 1000, 500)).toBe(false)
  })

  it('applies TradingView Shift constraints to shapes and angled lines', () => {
    const square = constrainDrawingPoint({ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.4 }, 'rectangle', 1000, 500)
    expect((square.x - 0.1) * 1000).toBeCloseTo((square.y - 0.1) * 500)
    const angled = constrainDrawingPoint({ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.32 }, 'line', 1000, 500)
    expect((angled.x - 0.1) * 1000).toBeCloseTo((angled.y - 0.1) * 500)
  })

  it('partially erases freehand drawings without deleting the whole object', () => {
    const brush = { ...makeDrawing('brush', { x: 0, y: 0 }), points: Array.from({ length: 20 }, (_, index) => ({ x: index / 20, y: index / 20 })) }
    const points = partiallyEraseDrawing(brush, { x: 0.5, y: 0.5 })
    expect(points).not.toBeNull()
    expect(points!.length).toBeLessThan(brush.points.length)
    expect(points!.length).toBeGreaterThan(2)
  })

  it('adds and restores complete Fibonacci settings', () => {
    const fib = makeDrawing('fib', { x: .2, y: .3 })
    expect(fib.fib?.levels.filter((level) => level.visible).map((level) => level.value)).toEqual([0, .5, .618, 1])
    const restored = normalizeFibSettings({ levels: [{ id: '0618', value: .65, visible: true, color: '#123456' }] })
    expect(restored.levels.find((level) => level.id === '0618')).toMatchObject({ value: .65, color: '#123456' })
    expect(restored.levels).toHaveLength(12)
  })

  it('does not persist the quick Measure action but keeps measurement drawings', () => {
    const quickMeasure = { ...makeDrawing('measure', { x: .1, y: .2 }), points: [{ x: .1, y: .2 }, { x: .4, y: .5 }] }
    const datePriceRange = { ...makeDrawing('date-price-range', { x: .2, y: .3 }), points: [{ x: .2, y: .3 }, { x: .6, y: .7 }] }
    expect(withoutTransientMeasurements([quickMeasure, datePriceRange])).toEqual([datePriceRange])
  })
})
