import { describe, expect, it } from 'vitest'
import {
  calculatePositionMetrics, calculatePositionMetricsFromLevels, createDefaultPositionPoints,
  formatPositionNumber, resolvePositionGeometry, updatePositionPoints,
} from './positionDrawing'

describe('TradingView-style long/short position metrics', () => {
  it('places the stop above and the target below for a short position', () => {
    const metrics = calculatePositionMetrics({
      side: 'short', topPrice: 105, bottomPrice: 95, currentPrice: 102, tickSize: .01,
    })
    expect(metrics).toMatchObject({
      entryPrice: 100,
      stopPrice: 105,
      targetPrice: 95,
      distance: 5,
      percent: 5,
      ticks: 500,
      quantity: 5,
      pnl: -10,
      riskReward: 1,
      stopAmount: 750,
      targetAmount: 1250,
    })
  })

  it('places the target above and the stop below for a long position', () => {
    const metrics = calculatePositionMetrics({
      side: 'long', topPrice: 105, bottomPrice: 95, currentPrice: 102, tickSize: .01,
    })
    expect(metrics.stopPrice).toBe(95)
    expect(metrics.targetPrice).toBe(105)
    expect(metrics.pnl).toBe(10)
  })

  it('calculates asymmetric levels without moving the entry price', () => {
    const metrics = calculatePositionMetricsFromLevels({
      side: 'long', entryPrice: 100, stopPrice: 96, targetPrice: 110, currentPrice: 103, tickSize: .5,
    })
    expect(metrics).toMatchObject({ entryPrice: 100, distance: 4, ticks: 8, riskReward: 2.5, pnl: 15 })
  })

  it('formats labels with grouped decimals', () => {
    expect(formatPositionNumber(4739.1, 1)).toBe('4,739.1')
    expect(formatPositionNumber(-132.373)).toBe('-132.373')
  })

  it('updates each independent TradingView position control without losing point metadata', () => {
    const points = [
      { x: .2, y: .5, time: 10, price: 100 },
      { x: .6, y: .5, time: 20, price: 100 },
      { x: .2, y: .3, time: 10, price: 105 },
      { x: .2, y: .7, time: 10, price: 95 },
    ]

    const movedTarget = updatePositionPoints(points, 'target', { x: .2, y: .1 })
    expect(movedTarget[0]).toMatchObject({ x: .2, y: .5, time: 10, price: 100 })
    expect(movedTarget[2]).toMatchObject({ x: .2, y: .1, time: 10, price: 105 })
    expect(movedTarget[3].y).toBe(.7)

    const movedStop = updatePositionPoints(points, 'stop', { x: .2, y: .9 })
    expect(movedStop[0].y).toBe(.5)
    expect(movedStop[2].y).toBe(.3)
    expect(movedStop[3].y).toBe(.9)

    expect(updatePositionPoints(points, 'width', { x: .8, y: .5 })[1].x).toBe(.8)

    const movedEntry = updatePositionPoints(points, 'entry', { x: .3, y: .6 })
    expect(movedEntry[0]).toMatchObject({ x: .3, y: .6, time: 10, price: 100 })
    expect(movedEntry[1]).toMatchObject({ x: .7, y: .6, time: 20, price: 100 })
    expect(movedEntry[2].y).toBeCloseTo(.4)
    expect(movedEntry[3].y).toBeCloseTo(.8)
  })

  it('creates a compact four-anchor 1:1 rectangle from one click', () => {
    const points = createDefaultPositionPoints({ x: .5, y: .5 })
    const geometry = resolvePositionGeometry(points, 'long')!
    expect(points).toHaveLength(4)
    expect(geometry.right - geometry.left).toBeCloseTo(.24)
    expect(geometry.entryY).toBeCloseTo(.5)
    expect(geometry.entryY - geometry.targetY).toBeCloseTo(.08)
    expect(geometry.stopY - geometry.entryY).toBeCloseTo(.08)
  })

  it('keeps short target and stop on their TradingView sides', () => {
    const points = createDefaultPositionPoints({ x: .5, y: .5 }, 'short')
    const movedTarget = updatePositionPoints(points, 'target', { x: .5, y: .8 }, 'short')
    const movedStop = updatePositionPoints(movedTarget, 'stop', { x: .5, y: .2 }, 'short')
    const geometry = resolvePositionGeometry(movedStop, 'short')!
    expect(geometry.targetY).toBe(.8)
    expect(geometry.stopY).toBe(.2)
    expect(geometry.entryY).toBe(.5)
  })

  it('upgrades a legacy diagonal pair without shifting its entry when the target moves', () => {
    const legacy = [
      { x: .2, y: .3, time: 10, price: 105 },
      { x: .6, y: .7, time: 20, price: 95 },
    ]
    const upgraded = updatePositionPoints(legacy, 'target', { x: .2, y: .8 }, 'short')
    expect(upgraded).toHaveLength(4)
    expect(upgraded[0].y).toBe(.5)
    expect(upgraded[2].y).toBe(.8)
    expect(upgraded[3].y).toBe(.3)
  })
})
