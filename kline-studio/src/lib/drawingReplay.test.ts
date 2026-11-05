import { describe, expect, it } from 'vitest'
import { drawingIsRevealed } from './drawingReplay'
import type { Drawing } from './drawings'

const drawingAt = (times: (number | undefined)[]): Drawing => ({
  id: 'historical', tool: 'trend', behavior: 'line', label: '历史结构',
  points: times.map((time, index) => ({ x: index / 10, y: .5, time, price: 100 })),
  color: '#2962ff', width: 2,
})
const historicalIds = new Set(['historical'])

describe('drawingIsRevealed', () => {
  it('withholds the entire historical structure until its final anchor candle, then hides it on rewind', () => {
    const drawing = drawingAt([60, 180])
    expect(drawingIsRevealed(drawing, historicalIds, 60, 60)).toBe(false)
    expect(drawingIsRevealed(drawing, historicalIds, 120, 60)).toBe(false)
    expect(drawingIsRevealed(drawing, historicalIds, 180, 60)).toBe(true)
    expect(drawingIsRevealed(drawing, historicalIds, 120, 60)).toBe(false)
  })

  it('includes intrabar anchors but excludes the exact next-bar boundary', () => {
    expect(drawingIsRevealed(drawingAt([60, 179.999]), historicalIds, 120, 60)).toBe(true)
    expect(drawingIsRevealed(drawingAt([60, 180]), historicalIds, 120, 60)).toBe(false)
  })

  it('handles reversed anchors by checking every time, not the final array element', () => {
    const drawing = drawingAt([180, 60])
    expect(drawingIsRevealed(drawing, historicalIds, 120, 60)).toBe(false)
    expect(drawingIsRevealed(drawing, historicalIds, 180, 60)).toBe(true)
  })

  it('does not reveal freehand structures with an unseen middle anchor', () => {
    const drawing = { ...drawingAt([60, 240, 120]), tool: 'brush', behavior: 'brush' as const }
    expect(drawingIsRevealed(drawing, historicalIds, 180, 60)).toBe(false)
    expect(drawingIsRevealed(drawing, historicalIds, 240, 60)).toBe(true)
  })

  it.each([undefined, NaN, Infinity, -Infinity])('fails closed for an unanchored/nonfinite point (%s)', time => {
    expect(drawingIsRevealed(drawingAt([60, time, 120]), historicalIds, 180, 60)).toBe(false)
  })

  it('fails closed for empty points until a legacy structure has real anchors', () => {
    expect(drawingIsRevealed(drawingAt([]), historicalIds, 180, 60)).toBe(false)
    expect(drawingIsRevealed(drawingAt([undefined, undefined]), historicalIds, 180, 60)).toBe(false)
    expect(drawingIsRevealed(drawingAt([60, 120]), historicalIds, 180, 60)).toBe(true)
  })

  it.each([null, NaN, Infinity, -Infinity])('fails closed without a finite last candle (%s)', lastTime => {
    expect(drawingIsRevealed(drawingAt([60]), historicalIds, lastTime, 60)).toBe(false)
  })

  it.each([0, -60, NaN, Infinity])('fails closed without a valid interval (%s)', seconds => {
    expect(drawingIsRevealed(drawingAt([60]), historicalIds, 180, seconds)).toBe(false)
  })

  it.each([null, undefined])('does not limit ordinary non-replay drawings (%s)', ids => {
    expect(drawingIsRevealed(drawingAt([60, 1000]), ids, 120, 60)).toBe(true)
    expect(drawingIsRevealed(drawingAt([undefined]), ids, null, 60)).toBe(true)
  })

  it('does not limit drawings created during replay or an empty replay ID set', () => {
    const drawing = drawingAt([60, 1000])
    expect(drawingIsRevealed({ ...drawing, id: 'new-during-replay' }, historicalIds, 120, 60)).toBe(true)
    expect(drawingIsRevealed(drawing, new Set(), 120, 60)).toBe(true)
  })
})
