import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DrawingOverlay } from './DrawingOverlay'
import type { Drawing, DrawingHistory, DrawingPoint } from '../lib/drawings'
import type { Candle } from '../lib/market'
import { atrValues } from '../lib/abcd'

const abcdDrawing = (prices = [100, 120, 110]): Drawing => ({
  id: 'abcd-projection-test',
  tool: 'ab-equals-cd',
  behavior: 'abc-projection',
  label: 'AB=CD',
  points: prices.map((price, index) => ({
    x: .12 + index * .12, y: (400 - price * 2) / 1000, time: 60 + index * 60, price,
  })),
  color: '#2962ff',
  width: 2,
})

type Projection = (point: { time: number; price: number }) => { x: number; y: number } | null
const linearProjection: Projection = ({ time, price }) => ({ x: time * 2, y: 400 - price * 2 })

const renderAbcd = (
  drawing: Drawing,
  { project = linearProjection, lastTime, selected = true, candles, plotSize }: {
    project?: Projection; lastTime?: number; selected?: boolean; candles?: Candle[]; plotSize?: { width: number; height: number }
  } = {},
) => {
  const history: DrawingHistory = {
    past: [], present: [drawing], future: [],
    selectedId: selected ? drawing.id : null, selectedIds: selected ? [drawing.id] : [],
  }
  return renderToStaticMarkup(<DrawingOverlay
    activeTool="cursor"
    history={history}
    dispatch={vi.fn()}
    color="#2962ff"
    magnetMode="off"
    drawingsLocked={false}
    hidden={false}
    candles={candles ?? (lastTime === undefined ? [] : [lastTime - 60, lastTime].map(time => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 100 })))}
    symbol="XAUUSD"
    interval="1m"
    revealClipIds={lastTime === undefined && candles === undefined ? null : new Set([drawing.id])}
    onPlotSize={plotSize ? () => plotSize : undefined}
    quickMeasurement={null}
    onMeasurePoint={() => null}
    onProjectPoint={project}
    onQuickMeasurementChange={vi.fn()}
    onToolComplete={vi.fn()}
    onZoomSelection={vi.fn()}
    onOpenProperties={vi.fn()}
  />)
}

const openingTag = (markup: string, attribute: string, value: string) => {
  const tag = markup.match(new RegExp(`<[^>]*\\b${attribute}="${value}"[^>]*>`))?.[0]
  expect(tag, `${attribute}="${value}" must be rendered`).toBeDefined()
  return tag!
}

const coordinate = (tag: string, name: string) => Number(tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1])

describe('AB=CD three-anchor projection rendering', () => {
  it.each([
    { direction: 'up', prices: [100, 120, 110], target: 130, targetY: 140 },
    { direction: 'down', prices: [120, 100, 110], target: 90, targetY: 220 },
  ])('renders the $direction projection with labeled legs and three editable anchors only', ({ prices, target, targetY }) => {
    const drawing = abcdDrawing(prices)
    const markup = renderAbcd(drawing)
    const projectionGroup = openingTag(markup, 'data-testid', 'abcd-projection')
    expect(projectionGroup).toMatch(/^<g\b/)
    expect(projectionGroup).toContain(`data-abcd-target-price="${target}"`)
    for (const leg of ['AB', 'BC', 'CD']) openingTag(markup, 'data-abcd-leg', leg)
    for (const label of ['A', 'B', 'C', 'D']) {
      expect(markup).toMatch(new RegExp(`data-abcd-label="${label}"[^>]*>${label}\\b[^<]*</text>`))
    }
    const forecast = openingTag(markup, 'data-abcd-leg', 'CD')
    expect(coordinate(forecast, 'x1')).toBe(360)
    expect(coordinate(forecast, 'x2')).toBe(480)
    expect(coordinate(forecast, 'y2')).toBe(targetY)
    expect(forecast).toMatch(/stroke-dasharray="[^"]+"/)
    const targetMarker = (markup.match(/<circle\b[^>]*>/g) ?? []).find(tag => (
      coordinate(tag, 'cx') === 480 && coordinate(tag, 'cy') === targetY
    ))
    expect(targetMarker).toContain('pointer-events="none"')
    expect((markup.match(/data-drawing-anchor=/g) ?? [])).toHaveLength(3)
    for (const anchor of ['A', 'B', 'C']) openingTag(markup, 'data-drawing-anchor', anchor)
    expect(markup).not.toContain('data-drawing-anchor="D"')
    expect(drawing.points).toHaveLength(3)
  })

  it('recomputes D from changed C without persisting a fourth point', () => {
    const drawing = abcdDrawing()
    const originalPoints = structuredClone(drawing.points)
    const original = openingTag(renderAbcd(drawing), 'data-abcd-leg', 'CD')
    const changed: Drawing = {
      ...drawing,
      points: drawing.points.map((point, index) => index === 2
        ? { ...point, time: 240, price: 115, x: .48, y: .17 }
        : point),
    }
    const markup = renderAbcd(changed)
    const forecast = openingTag(markup, 'data-abcd-leg', 'CD')
    expect(coordinate(original, 'x2')).toBe(480)
    expect(coordinate(forecast, 'x2')).toBe(600)
    expect(coordinate(forecast, 'y2')).toBe(130)
    expect(markup).toContain('data-abcd-target-price="135"')
    expect(changed.points).toHaveLength(3)
    expect(drawing.points).toEqual(originalPoints)
  })

  it('projects the raw arithmetic target price through a logarithmic price scale', () => {
    const drawing = abcdDrawing([100, 200, 150])
    const project = vi.fn(({ time, price }: { time: number; price: number }) => ({ x: time * 2, y: 1000 - 100 * Math.log(price) }))
    const markup = renderAbcd(drawing, { project })
    const forecast = openingTag(markup, 'data-abcd-leg', 'CD')
    expect(markup).toContain('data-abcd-target-price="250"')
    expect(project).toHaveBeenCalledWith({ time: 180, price: 250 })
    expect(coordinate(forecast, 'x2')).toBe(480)
    expect(coordinate(forecast, 'y2')).toBeCloseTo(1000 - 100 * Math.log(250), 8)
    const incorrectPixelVector = 1000 - 100 * Math.log(150) - 100 * Math.log(200) + 100 * Math.log(100)
    expect(Math.abs(coordinate(forecast, 'y2') - incorrectPixelVector)).toBeGreaterThan(1)
  })

  it('falls back to screen-space projection when raw anchor prices are unavailable', () => {
    const drawing = abcdDrawing()
    drawing.points = [
      { x: .1, y: .5 }, { x: .25, y: .3 }, { x: .4, y: .45 },
    ]
    const markup = renderAbcd(drawing, { project: () => null })
    const forecast = openingTag(markup, 'data-abcd-leg', 'CD')
    expect(coordinate(forecast, 'x2')).toBeCloseTo(550)
    expect(coordinate(forecast, 'y2')).toBeCloseTo(250)
    expect(markup).not.toContain('data-abcd-target-price=')
    expect(markup).not.toContain('NaN')
  })

  it.each([1, 2])('supports an incomplete %i-anchor preview without inventing C or D', count => {
    const drawing = abcdDrawing()
    drawing.points = drawing.points.slice(0, count)
    const markup = renderAbcd(drawing)
    expect(markup).not.toContain('data-abcd-label="C"')
    expect(markup).not.toContain('data-abcd-label="D"')
    expect(markup).not.toContain('data-abcd-leg="CD"')
    expect(markup).not.toContain('data-abcd-target-price=')
    expect(markup).not.toContain('NaN')
    if (count === 2) openingTag(markup, 'data-abcd-leg', 'AB')
  })

  it('keeps historical projections hidden until all A/B/C candles are known, not until future D', () => {
    const drawing = abcdDrawing()
    for (const lastTime of [60, 120]) {
      const markup = renderAbcd(drawing, { lastTime })
      expect(markup).not.toContain('data-testid="abcd-projection"')
      expect(markup).not.toContain('data-abcd-label=')
      expect(markup).not.toContain('data-drawing-anchor=')
    }
    const revealed = renderAbcd(drawing, { lastTime: 180 })
    expect(revealed).toContain('data-testid="abcd-projection"')
    expect(revealed).toContain('data-abcd-label="D"')
    expect(coordinate(openingTag(revealed, 'data-abcd-leg', 'CD'), 'x2')).toBe(480)
    expect(drawing.points.map((point: DrawingPoint) => point.time)).toEqual([60, 120, 180])
    expect(renderAbcd(drawing, { lastTime: 120 })).not.toContain('data-testid="abcd-projection"')
  })
})

const candle = (time: number, close: number, low = close - 1, high = close + 1): Candle => ({
  time, open: close, high, low, close, volume: 100,
})
const targetDrawing: Drawing = {
  ...abcdDrawing(),
  points: abcdDrawing().points.map((point, index) => ({ ...point, time: [60, 1260, 1320][index] })),
}
const targetProjection: Projection = ({ time, price }) => ({ x: 80 + (time - 60) / 6, y: 500 - price * 2 })
const anchorCandles = [
  ...Array.from({ length: 21 }, (_, index) => candle(index * 60, 100, 98, 102)),
  candle(1260, 120), candle(1320, 110),
]
const touchingCandles = [...anchorCandles, candle(1380, 129, 109, 131)]
const nearbyCandles = [...touchingCandles, candle(1440, 129, 128.5, 129.5)]
const farCandles = [...nearbyCandles, candle(1500, 100)]
const targetOptions = { project: targetProjection, plotSize: { width: 800, height: 400 } }
const renderTarget = (candles: Candle[], drawing = targetDrawing) => renderAbcd(drawing, { ...targetOptions, candles })

const nearTargetGroup = (markup: string) => {
  const tag = openingTag(markup, 'data-testid', 'abcd-near-target')
  const start = markup.indexOf(tag)
  const ancestors: string[] = []
  for (const match of markup.slice(0, start).matchAll(/<\/?g\b[^>]*>/g)) {
    if (match[0].startsWith('</')) ancestors.pop()
    else if (!match[0].endsWith('/>')) ancestors.push(match[0])
  }
  expect([...ancestors, tag].join(' ')).not.toContain('clip-path="url(#replay-reveal-clip)"')
  return markup.slice(start, markup.indexOf('</g>', start) + 4)
}
const replayClipRight = (markup: string) => {
  const clipping = markup.match(/<clipPath\b[^>]*id="replay-reveal-clip"[^>]*>([\s\S]*?)<\/clipPath>/)?.[1] ?? ''
  const rectangle = clipping.match(/<rect\b[^>]*>/)?.[0]
  expect(rectangle).toBeDefined()
  return coordinate(rectangle!, 'x') + coordinate(rectangle!, 'width')
}

describe('hand-drawn AB=CD nearby target guide', () => {
  it('moves the sole D text outside replay clipping on an early touch while retaining every original leg', () => {
    const baseline = renderTarget(anchorCandles)
    const markup = renderTarget(touchingCandles)
    const forecast = openingTag(markup, 'data-abcd-leg', 'CD')
    const clipRight = replayClipRight(markup)
    expect(clipRight).toBe(305)
    expect(coordinate(forecast, 'x2')).toBe(490)
    expect(coordinate(forecast, 'x2')).toBeGreaterThan(clipRight)
    const guide = nearTargetGroup(markup)
    const line = guide.match(/<line\b[^>]*>/)?.[0]
    expect(line).toBeDefined()
    expect(coordinate(line!, 'y1')).toBe(240)
    expect(coordinate(line!, 'y2')).toBe(240)
    expect(coordinate(line!, 'x2')).toBeGreaterThan(clipRight)
    expect(coordinate(line!, 'x2')).toBeLessThanOrEqual(targetOptions.plotSize.width)
    expect(coordinate(line!, 'x2') - coordinate(line!, 'x1')).toBeGreaterThan(0)
    expect(coordinate(line!, 'x2') - coordinate(line!, 'x1')).toBeLessThanOrEqual(100)
    expect(line).toContain('stroke="#2962ff"')
    const label = openingTag(guide, 'data-abcd-label', 'D')
    expect(label).toContain('text-anchor="end"')
    expect(coordinate(label, 'x')).toBeGreaterThanOrEqual(targetOptions.plotSize.width - 100)
    expect(coordinate(label, 'x')).toBeLessThanOrEqual(targetOptions.plotSize.width)
    expect(guide).toMatch(/data-abcd-label="D"[^>]*>D 130(?:\.0+)? · AB=CD<\/text>/)
    expect(markup.match(/data-abcd-label="D"/g)).toHaveLength(1)
    expect(markup).toContain('data-abcd-target-price="130"')
    for (const leg of ['AB', 'BC', 'CD']) {
      expect(openingTag(markup, 'data-abcd-leg', leg)).toBe(openingTag(baseline, 'data-abcd-leg', leg))
    }
  })

  it('keeps the D guide on the next nearby candle even without another target touch', () => {
    const latest = nearbyCandles.at(-1)!
    expect(latest.high).toBeLessThan(130)
    expect(Math.abs(latest.close - 130)).toBeLessThanOrEqual(0.5 * atrValues(nearbyCandles, 20).at(-1)!)
    const markup = renderTarget(nearbyCandles)
    const guide = nearTargetGroup(markup)
    expect(coordinate(guide.match(/<line\b[^>]*>/)![0], 'y1')).toBe(240)
    expect(markup.match(/data-abcd-label="D"/g)).toHaveLength(1)
    expect(coordinate(openingTag(markup, 'data-abcd-leg', 'CD'), 'x2')).toBeGreaterThan(replayClipRight(markup))
  })

  it('removes the temporary guide and restores the original D text when the latest candle moves far away', () => {
    const latest = farCandles.at(-1)!
    expect(latest.high).toBeLessThan(130)
    expect(Math.abs(latest.close - 130)).toBeGreaterThan(0.5 * atrValues(farCandles, 20).at(-1)!)
    const markup = renderTarget(farCandles)
    expect(markup).not.toContain('data-testid="abcd-near-target"')
    expect(markup.match(/data-abcd-label="D"/g)).toHaveLength(1)
    expect(openingTag(markup, 'data-abcd-label', 'D')).toBe(openingTag(renderTarget(anchorCandles), 'data-abcd-label', 'D'))
    for (const leg of ['AB', 'BC', 'CD']) openingTag(markup, 'data-abcd-leg', leg)
  })

  it('keeps a drawing with a future C entirely hidden even when the latest candle touches its target price', () => {
    const futureC: Drawing = {
      ...targetDrawing,
      points: targetDrawing.points.map((point, index) => index === 2 ? { ...point, time: 1560 } : point),
    }
    const markup = renderTarget(touchingCandles, futureC)
    expect(markup).not.toContain('data-testid="abcd-near-target"')
    expect(markup).not.toContain('data-testid="abcd-projection"')
    expect(markup).not.toContain('data-abcd-label=')
    expect(markup).not.toContain('data-abcd-leg=')
    expect(markup).not.toContain('data-drawing-anchor=')
  })
})
