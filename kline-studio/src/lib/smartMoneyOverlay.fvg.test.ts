import { afterEach, expect, it, vi } from 'vitest'
import type { IChartApi } from 'lightweight-charts'
import type { Candle } from './market'
import { attachSmartMoneyOverlay } from './smartMoneyOverlay'

afterEach(() => vi.unstubAllGlobals())

it.each([false, true])('renders causal stepped refill slices at 20% opacity, including open gaps (bearish=%s)', bearish => {
  const paints: { x: number; y: number; width: number; height: number; color: string }[] = []
  const labels: string[] = []
  const context = new Proxy({ fillStyle: '' } as Record<string, any>, {
    get: (target, key: string) => key === 'fillRect'
      ? (x: number, y: number, width: number, height: number) => paints.push({ x, y, width, height, color: target.fillStyle })
      : key === 'fillText' ? (label: string) => labels.push(label)
        : key in target ? target[key] : () => {},
  })
  const canvas = { style: {}, width: 0, height: 0, setAttribute() {}, getContext: () => context, remove() {} }
  let frame: (() => void) | undefined
  vi.stubGlobal('document', { createElement: () => canvas })
  vi.stubGlobal('window', { devicePixelRatio: 1, requestAnimationFrame: (callback: () => void) => { frame = callback; return 1 }, cancelAnimationFrame() {} })
  const chart = {
    timeScale: () => ({ logicalToCoordinate: (index: number) => index * 10, getVisibleLogicalRange: () => ({ from: 0, to: 30 }) }),
    paneSize: () => ({ width: 400, height: 400 }),
  } as unknown as IChartApi
  const priceToCoordinate = (price: number) => (120 - price) * 10
  const overlay = attachSmartMoneyOverlay({ clientWidth: 400, clientHeight: 400, appendChild() {} } as unknown as HTMLElement, chart, { priceToCoordinate })
  const bar = (index: number, open: number, high: number, low: number, close: number): Candle => ({ time: 1_700_000_000 + index * 60, open, high, low, close, volume: 1 })
  let candles = [
    ...Array.from({ length: 20 }, (_, index) => bar(index, 100, 100.5, 99.5, 100)),
    bar(20, 100, 101, 99, 100), bar(21, 100, 110, 100, 109),
    bar(22, 109, 112, 107, 111), bar(23, 111, 112, 107, 109),
    bar(24, 109, 110, 105, 106), bar(25, 106, 110, 106, 109),
    bar(26, 109, 110, 103, 104), bar(27, 104, 108, 103, 107),
    bar(28, 107, 108, 101, 102), bar(29, 102, 103, 99, 100),
  ]
  if (bearish) candles = candles.map(c => ({ ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high }))
  const render = (length: number) => {
    overlay.setData(candles.slice(0, length))
    paints.length = 0
    labels.length = 0
    frame!()
  }
  render(23)
  const originalColor = paints.find(p => p.x === 210 && p.color.endsWith(', 0.8)'))!.color
  const slices = () => paints.filter(p => p.x === 210 && p.color === originalColor.replace(', 0.8)', ', 0.2)'))
  const markers = () => paints.filter(p => p.x === 210 && p.color === originalColor)
  const expectedSlice = (index: number, top: number, bottom: number) => {
    const prices = bearish ? [200 - bottom, 200 - top] : [top, bottom]
    return { x: 210, y: Math.min(...prices.map(priceToCoordinate)), width: index * 10 - 210, height: (top - bottom) * 10, color: originalColor.replace(', 0.8)', ', 0.2)') }
  }
  const first = expectedSlice(24, 107, 105)
  const second = expectedSlice(26, 105, 103)
  const third = expectedSlice(28, 103, 101)
  // The default is still off, even after a partial refill.
  render(25)
  expect(slices()).toEqual([])
  overlay.setShowFilledGaps(true)
  render(25)
  expect(slices()).toEqual([first])
  expect(markers()).toHaveLength(2)
  expect(markers().reduce((sum, marker) => sum + marker.height, 0)).toBe(40)
  expect(Math.min(...markers().map(marker => marker.y))).toBe(bearish ? 210 : 150)
  render(26) // a shallower retest must not add or widen the first layer
  expect(slices()).toEqual([first])
  render(27)
  expect(slices()).toEqual([first, second])
  expect(markers().reduce((sum, marker) => sum + marker.height, 0)).toBe(20)
  render(28) // equal-depth retest also leaves slice geometry untouched
  expect(slices()).toEqual([first, second])
  render(29) // exact touch closes the gap; no full-height box or marker remains
  expect(slices()).toEqual([first, second, third])
  expect(markers()).toEqual([])
  expect(paints.some(p => p.x === 210 && p.width === 70 && p.height === 60)).toBe(false)
  expect(labels.some(label => label.startsWith('回补 '))).toBe(false)
  render(30)
  expect(slices()).toEqual([first, second, third])
  overlay.setShowFilledGaps(false)
  render(27)
  expect(slices()).toEqual([])
  expect(markers()).toHaveLength(2)
  expect(markers().reduce((sum, marker) => sum + marker.height, 0)).toBe(20)
  // Rewind removes only layers that had not been reached at that candle prefix.
  overlay.setShowFilledGaps(true)
  render(25)
  expect(slices()).toEqual([first])
  expect(markers().reduce((sum, marker) => sum + marker.height, 0)).toBe(40)
  render(24)
  expect(slices()).toEqual([])
  expect(markers().reduce((sum, marker) => sum + marker.height, 0)).toBe(60)
  expect(labels.some(label => label.startsWith('回补 '))).toBe(false)
  overlay.destroy()
})
