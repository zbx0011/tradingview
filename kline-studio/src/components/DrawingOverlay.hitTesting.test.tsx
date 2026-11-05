import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DrawingOverlay } from './DrawingOverlay'
import type { Drawing, DrawingHistory } from '../lib/drawings'

const line: Drawing = {
  id: 'underlying-trend', tool: 'trend-line', behavior: 'line', label: '趋势线',
  points: [{ x: .3, y: .3 }, { x: .7, y: .4 }], color: '#2962ff', width: 2,
}

const renderPosition = (side: 'long' | 'short', selected: boolean, fillOpacity = .2) => {
  const position: Drawing = {
    id: 'overlapping-position', tool: `${side}-position`, behavior: `${side}-position`, label: '仓位',
    points: [{ x: .2, y: .5 }, { x: .8, y: .5 }, { x: .2, y: side === 'long' ? .2 : .8 }, { x: .2, y: side === 'long' ? .8 : .2 }],
    color: '#2962ff', width: 2, fillOpacity,
  }
  const history: DrawingHistory = {
    past: [], present: [line, position], future: [],
    selectedId: selected ? position.id : null, selectedIds: selected ? [position.id] : [],
  }
  return renderToStaticMarkup(<DrawingOverlay
    activeTool="cursor" history={history} dispatch={vi.fn()} color="#2962ff"
    magnetMode="off" drawingsLocked={false} hidden={false} candles={[]}
    symbol="XAUUSD" interval="1m" quickMeasurement={null}
    onMeasurePoint={() => null} onProjectPoint={() => null}
    onQuickMeasurementChange={vi.fn()} onToolComplete={vi.fn()}
    onZoomSelection={vi.fn()} onOpenProperties={vi.fn()}
  />)
}

const element = (markup: string, testId: string) => {
  const match = markup.match(new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`))
  expect(match, `missing ${testId}`).not.toBeNull()
  return match![0]
}

describe('overlapping position hit testing', () => {
  it.each(['long', 'short'] as const)('makes %s position interiors click-through even above an earlier trend line', side => {
    for (const selected of [false, true]) {
      for (const opacity of [0, .2, 1]) {
        const markup = renderPosition(side, selected, opacity)
        expect(markup.indexOf('data-behavior="line"')).toBeLessThan(markup.indexOf(`data-behavior="${side}-position"`))
        expect(element(markup, 'drawing-line-hit-target')).toContain('pointer-events="stroke"')
        for (const zone of ['position-upper-zone', 'position-lower-zone']) {
          expect(element(markup, zone)).toContain('pointer-events="none"')
          expect(element(markup, zone)).toContain('width="600"')
          expect(element(markup, zone)).toContain('height="300"')
        }
        expect(element(markup, 'position-entry-line')).toContain('pointer-events="none"')
        const hitTarget = element(markup, 'position-move-hit-target')
        expect(hitTarget).toContain('d="M200,200 H800 V800 H200 Z M200,500 H800"')
        expect(hitTarget).toContain('fill="none"')
        expect(hitTarget).toContain('stroke="transparent"')
        expect(hitTarget).toContain('stroke-width="14"')
        expect(hitTarget).toContain('pointer-events="stroke"')
        expect(hitTarget).toContain('vector-effect="non-scaling-stroke"')
      }
    }
  })

  it.each(['long', 'short'] as const)('preserves %s position labels and all four selected resize controls', side => {
    const selected = renderPosition(side, true)
    for (const name of ['stop', 'target', 'entry']) {
      expect(element(selected, `position-${name}-label`)).not.toContain('pointer-events="none"')
    }
    expect(element(selected, 'position-control-points')).toContain('pointer-events="all"')
    for (const handle of ['target', 'entry', 'width', 'stop']) {
      expect(selected).toMatch(new RegExp(`<[^>]+data-position-handle="${handle}"[^>]+pointer-events="all"`))
    }
    expect(renderPosition(side, false)).not.toContain('data-position-handle=')
  })
})
