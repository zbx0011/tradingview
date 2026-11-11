import { expect, it } from 'vitest'
import type { IChartApi } from 'lightweight-charts'
import type { Candle } from './market'
import { attachSmartMoneyOverlay } from './smartMoneyOverlay'

it('merges an unfilled 15m gap into the 5m marker it overlaps, deepening the shared layers', () => {
  const paints: { x: number; y: number; width: number; color: string }[] = []
  const context = new Proxy({ fillStyle: '' } as Record<string, any>, {
    get: (target, key: string) => key === 'fillRect' ? (x: number, y: number, width: number) => paints.push({ x, y, width, color: target.fillStyle }) : key in target ? target[key] : () => {},
  })
  // The overlay is a series primitive: capture it and paint it the way the chart would.
  let primitive: any
  const frame = () => primitive.paneViews()[0].renderer().draw({ useMediaCoordinateSpace: (paint: (scope: unknown) => void) => paint({ context, mediaSize: { width: 400, height: 400 } }) })
  const chart = {
    timeScale: () => ({ logicalToCoordinate: (index: number) => index * 10, getVisibleLogicalRange: () => ({ from: 0, to: 30 }) }),
    paneSize: () => ({ width: 400, height: 400 }),
  } as unknown as IChartApi
  const overlay = attachSmartMoneyOverlay({ clientWidth: 400, clientHeight: 400, appendChild() {} } as unknown as HTMLElement, chart, { priceToCoordinate: (price: number) => (120 - price) * 10, attachPrimitive: (value: any) => { primitive = value; value.attached?.({ requestUpdate() {} }) } })
  const start = 1_700_000_100 - (1_700_000_100 % 3600)
  const bar = (index: number, open: number, high: number, low: number, close: number): Candle => ({ time: start + index * 300, open, high, low, close, volume: 1 } as Candle)
  const candles = [
    bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100.5), bar(2, 100.5, 101, 99.5, 101),
    bar(3, 101, 104, 101, 104), bar(4, 104, 108, 104, 108), bar(5, 108, 110, 107, 110),
    bar(6, 110, 112, 106, 111), bar(7, 111, 112, 105, 106), bar(8, 106, 109, 105.5, 108),
    bar(9, 108, 108.5, 103, 104), bar(10, 104, 104.5, 100, 101),
  ]
  const render = (length: number) => { overlay.setData(candles.slice(0, length)); paints.length = 0; frame() }
  // The 15m gap (101–105) shares its price area with the 5m gaps at candle 3, so it joins their marker and the
  // shared layers are drawn deeper (a dark wash over the base colour).
  const marker = () => paints.some((p) => p.x === 30 && p.width === 10 && p.color.startsWith('rgba(0, 0, 0'))
  render(8)
  expect(marker()).toBe(false)
  render(9)
  expect(marker()).toBe(true)
  render(11)
  expect(paints.some((p) => p.x === 30 && p.color.endsWith(', 0.8)'))).toBe(false)
})
