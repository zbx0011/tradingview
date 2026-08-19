import { describe, expect, it } from 'vitest'
import { calculateFibLevelGeometry, fibLevelProgress, layoutFibLabels } from './fibLayout'

describe('TradingView-style Fibonacci geometry', () => {
  it('pins 0 and 1 to the two anchors and reverses them without moving the trend line', () => {
    expect(fibLevelProgress(0, false)).toBe(0)
    expect(fibLevelProgress(1, false)).toBe(1)
    expect(fibLevelProgress(0, true)).toBe(1)
    expect(fibLevelProgress(1, true)).toBe(0)

    const levels = calculateFibLevelGeometry([
      { id: '0', value: 0 },
      { id: '0618', value: .618 },
      { id: '1', value: 1 },
    ], 100, 300, 500, 400, false)
    expect(levels[0]).toMatchObject({ y: 100, price: 500 })
    expect(levels[1].y).toBeCloseTo(223.6)
    expect(levels[1].price).toBeCloseTo(438.2)
    expect(levels[2]).toMatchObject({ y: 300, price: 400 })
  })

  it('fans out labels in a shallow retracement while leaving level coordinates intact', () => {
    const compact = calculateFibLevelGeometry([
      { id: '0', value: 0 },
      { id: '0236', value: .236 },
      { id: '0382', value: .382 },
      { id: '05', value: .5 },
      { id: '0618', value: .618 },
      { id: '0786', value: .786 },
      { id: '1', value: 1 },
    ], 100, 108, null, null, false)
    const laidOut = layoutFibLabels(compact, 300, 12)
    expect(laidOut.map((level) => level.y)).toEqual(compact.map((level) => level.y))
    const sortedLabels = laidOut.map((level) => level.labelY).sort((a, b) => a - b)
    expect(sortedLabels.every((value, index) => index === 0 || value - sortedLabels[index - 1] >= 15)).toBe(true)
    expect(sortedLabels[0]).toBeGreaterThanOrEqual(8)
    expect(sortedLabels.at(-1)).toBeLessThanOrEqual(292)
  })

  it('supports TradingView logarithmic Fibonacci prices for positive anchors', () => {
    const [middle] = calculateFibLevelGeometry([{ id: '05', value: .5 }], 0, 100, 100, 400, false, true)
    expect(middle.price).toBeCloseTo(200)
  })
})
