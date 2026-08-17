import { describe, expect, it } from 'vitest'
import { labelLayoutObstacle, tradeEndpointLabelLayout, type TradeLabelObstacle } from './tradeEndpointLabelLayout'

describe('trade endpoint label layout', () => {
  it('moves the card outside a dense local candle band', () => {
    const candles: TradeLabelObstacle[] = [
      { left: 100, right: 420, top: 170, bottom: 300 },
    ]
    const layout = tradeEndpointLabelLayout(140, 250, 'entry', 800, 600, candles)
    expect(layout.obstacleOverlapArea).toBe(0)
    expect(layout.boxY + layout.boxHeight <= 162 || layout.boxY >= 308).toBe(true)
  })

  it('switches below the candles when there is no room above', () => {
    const candles: TradeLabelObstacle[] = [
      { left: 10, right: 390, top: 4, bottom: 92 },
    ]
    const layout = tradeEndpointLabelLayout(80, 50, 'entry', 520, 360, candles)
    expect(layout.obstacleOverlapArea).toBe(0)
    expect(layout.boxY).toBeGreaterThanOrEqual(96)
    expect(layout.boxY).toBeGreaterThanOrEqual(candles[0].bottom)
  })

  it('keeps the exit card away from an already placed entry card', () => {
    const entry = tradeEndpointLabelLayout(180, 220, 'entry', 700, 500)
    const exit = tradeEndpointLabelLayout(200, 230, 'exit', 700, 500, [], [labelLayoutObstacle(entry)])
    expect(exit.reservedOverlapArea).toBe(0)
  })

  it('always keeps the card inside the viewport', () => {
    const layout = tradeEndpointLabelLayout(3, 2, 'exit', 240, 120)
    expect(layout.boxX).toBeGreaterThanOrEqual(8)
    expect(layout.boxY).toBeGreaterThanOrEqual(8)
    expect(layout.boxX + layout.boxWidth).toBeLessThanOrEqual(232)
    expect(layout.boxY + layout.boxHeight).toBeLessThanOrEqual(112)
  })

  it('keeps labels out of the chart header and bottom time controls', () => {
    const topLayout = tradeEndpointLabelLayout(300, 20, 'entry', 900, 620)
    const bottomLayout = tradeEndpointLabelLayout(300, 610, 'exit', 900, 620)
    expect(topLayout.boxY).toBeGreaterThanOrEqual(96)
    expect(bottomLayout.boxY + bottomLayout.boxHeight).toBeLessThanOrEqual(576)
  })

  it('uses an empty band between price candles and volume bars', () => {
    const obstacles: TradeLabelObstacle[] = [
      { left: 100, right: 500, top: 100, bottom: 260 },
      { left: 100, right: 500, top: 470, bottom: 570 },
    ]
    const layout = tradeEndpointLabelLayout(300, 180, 'exit', 800, 620, obstacles)
    expect(layout.obstacleOverlapArea).toBe(0)
    expect(layout.boxY).toBeGreaterThanOrEqual(268)
    expect(layout.boxY + layout.boxHeight).toBeLessThanOrEqual(462)
  })
})
