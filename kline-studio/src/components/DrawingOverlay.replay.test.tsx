import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DrawingOverlay } from './DrawingOverlay'
import { createDefaultFibSettings, type Drawing, type DrawingHistory } from '../lib/drawings'
import type { IntervalId } from '../lib/market'

const structure = (times = [60, 180]): Drawing => ({
  id: 'historical', tool: 'trend', behavior: 'line', label: '历史结构',
  points: times.map((time, index) => ({ x: .2 + index * .2, y: .2 + index * .1, time, price: 100 - index })),
  color: '#2962ff', width: 2,
})

const renderReplay = (
  drawing: Drawing,
  lastTime: number | null,
  ids: ReadonlySet<string> | null = new Set(['historical']),
  interval: IntervalId = '1m',
) => {
  const history: DrawingHistory = {
    past: [], present: [drawing], future: [], selectedId: drawing.id, selectedIds: [drawing.id],
  }
  return renderToStaticMarkup(<DrawingOverlay
    activeTool="cursor"
    history={history}
    dispatch={vi.fn()}
    color="#2962ff"
    magnetMode="off"
    drawingsLocked={false}
    hidden={false}
    candles={lastTime === null ? [] : [lastTime - 60, lastTime].map(time => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 100 }))}
    symbol="XAUUSD"
    interval={interval}
    revealClipIds={ids}
    quickMeasurement={null}
    onMeasurePoint={() => null}
    onProjectPoint={({ time, price }) => ({ x: time * 2, y: (110 - price) * 20 })}
    onQuickMeasurementChange={vi.fn()}
    onToolComplete={vi.fn()}
    onZoomSelection={vi.fn()}
    onOpenProperties={vi.fn()}
  />)
}

const expectNoStructure = (markup: string) => {
  expect(markup).not.toContain('data-testid="drawing-object"')
  expect(markup).not.toContain('data-testid="drawing-line-hit-target"')
  expect(markup).not.toContain('drawing-anchor-points')
  expect(markup).not.toContain('data-drawing-anchor=')
  expect(markup).not.toContain('data-position-handle=')
}

describe('historical drawing replay reveal', () => {
  it('omits all shape/hit target/selected handles before completion, reveals them together and removes them on rewind', () => {
    const drawing = structure()
    expectNoStructure(renderReplay(drawing, 60))
    expectNoStructure(renderReplay(drawing, 120))
    const complete = renderReplay(drawing, 180)
    expect(complete).toContain('data-testid="drawing-object"')
    expect(complete).toContain('data-testid="drawing-line-hit-target"')
    expect(complete).toContain('data-drawing-anchor="start"')
    expect(complete).toContain('data-drawing-anchor="end"')
    expect(complete).toContain('<g clip-path="url(#replay-reveal-clip)"><g')
    expectNoStructure(renderReplay(drawing, 120))
  })

  it('does not reveal reversed anchors merely because the last array point is in the past', () => {
    expectNoStructure(renderReplay(structure([180, 60]), 120))
    expect(renderReplay(structure([180, 60]), 180)).toContain('data-testid="drawing-object"')
  })

  it('waits for every freehand anchor including future middle points', () => {
    const drawing: Drawing = { ...structure([60, 240, 120]), tool: 'brush', behavior: 'brush' }
    expectNoStructure(renderReplay(drawing, 180))
    expect(renderReplay(drawing, 240)).toContain('data-testid="drawing-object"')
  })

  it('uses the selected chart interval and excludes its exact next-candle boundary', () => {
    expectNoStructure(renderReplay(structure([60, 360]), 60, new Set(['historical']), '5m'))
    expect(renderReplay(structure([60, 359]), 60, new Set(['historical']), '5m')).toContain('data-testid="drawing-object"')
    expect(renderReplay(structure([60, 360]), 360, new Set(['historical']), '5m')).toContain('data-testid="drawing-object"')
  })

  it('does not leak Fibonacci levels/labels or position zones/controls while incomplete', () => {
    const fib: Drawing = { ...structure(), tool: 'fib', behavior: 'fib', fib: createDefaultFibSettings() }
    const position: Drawing = { ...structure(), tool: 'short-position', behavior: 'short-position' }
    const fibMarkup = renderReplay(fib, 120)
    const positionMarkup = renderReplay(position, 120)
    expectNoStructure(fibMarkup)
    expectNoStructure(positionMarkup)
    expect(fibMarkup).not.toContain('data-fib-level=')
    expect(fibMarkup).not.toContain('data-fib-label=')
    expect(positionMarkup).not.toContain('data-testid="position-upper-zone"')
    expect(positionMarkup).not.toContain('data-testid="position-control-points"')
    expect(renderReplay(fib, 180)).toContain('data-fib-level=')
    expect(renderReplay(position, 180)).toContain('data-position-handle=')
  })

  it('fails closed while legacy anchor times are missing and before any candle exists', () => {
    const drawing = structure()
    const legacy = { ...drawing, points: drawing.points.map(({ x, y, price }) => ({ x, y, price })) }
    expectNoStructure(renderReplay(legacy, 180))
    expectNoStructure(renderReplay(drawing, null))
    expect(renderReplay(drawing, 180)).toContain('data-testid="drawing-object"')
  })

  it('keeps ordinary and newly created replay drawings visible even with future anchors', () => {
    const ordinary = renderReplay(structure(), 60, null)
    expect(ordinary).toContain('data-testid="drawing-object"')
    expect(ordinary).not.toContain('replay-reveal-clip')
    const newlyCreated = renderReplay({ ...structure(), id: 'new-during-replay' }, 60)
    expect(newlyCreated).toContain('data-testid="drawing-object"')
    expect(newlyCreated).toContain('data-drawing-anchor="end"')
    expect(newlyCreated).toContain('<g clip-path="url(#replay-reveal-clip)"></g><g')
  })
})
