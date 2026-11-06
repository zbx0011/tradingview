import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DrawingOverlay } from './DrawingOverlay'
import type { Drawing, DrawingHistory, DrawingPoint } from '../lib/drawings'

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
  { project = linearProjection, lastTime, selected = true }: {
    project?: Projection; lastTime?: number; selected?: boolean
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
    candles={lastTime === undefined ? [] : [lastTime - 60, lastTime].map(time => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 100 }))}
    symbol="XAUUSD"
    interval="1m"
    revealClipIds={lastTime === undefined ? null : new Set([drawing.id])}
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
