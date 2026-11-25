import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ManualPracticeAnnotations } from './ManualPractice'
import type { ManualPracticeSession } from '../lib/manualPractice'

const session: ManualPracticeSession = {
  id: 'replay-annotations', symbol: 'NQ1!', dayKey: 'NQ1!:2025-04-14', dayLabel: '2025-04-14',
  startTime: 0, endTime: 7200, cursorTime: 7200, status: 'completed', createdAt: 1, updatedAt: 2, completedAt: 2,
  trades: [{ id: 'future-exit', side: 'long', entryTime: 600, entryPrice: 100, stopLoss: 90, takeProfit: 130,
    exitTime: 3600, exitPrice: 120, exitKind: 'manual', background: '', reasons: ['entry reason'], exitReasons: ['exit reason'], quantity: 1 }],
  notes: [],
}
const renderAt = (last: number | null, value = session) => renderToStaticMarkup(<ManualPracticeAnnotations
  session={value} interval="5m" hidden={false}
  toX={time => time / 10} toY={price => price}
  clipAfterBar={last === null ? null : { last, previous: last - 300 }}
/>)

type Rectangle = { left: number; right: number; top: number; bottom: number }
const denseCandleBand: Rectangle = { left: 100, right: 420, top: 170, bottom: 300 }
const labelViewport = { width: 800, height: 600, candleObstacles: [denseCandleBand] }
const renderWithLabels = (last: number | null, viewport = labelViewport) => renderToStaticMarkup(<ManualPracticeAnnotations
  session={session} interval="5m" hidden={false}
  toX={time => 180 + (time - 600) / 150} toY={price => 350 - price}
  barRange={() => ({ high: 104, low: 96 })}
  tradeLabelViewport={viewport}
  clipAfterBar={last === null ? null : { last, previous: last - 300 }}
/>)
const labelBounds = (markup: string, testId: 'manual-entry-label' | 'manual-exit-label'): Rectangle => {
  const tag = (markup.match(/<[a-z][^>]*>/g) ?? []).find(element => element.includes(`data-testid="${testId}"`))
  expect(tag, testId).toBeDefined()
  const style = tag!.match(/\bstyle="([^"]*)"/)?.[1] ?? ''
  const properties = Object.fromEntries(style.split(';').map(property => property.split(':')))
  const [left, top, width, height] = ['left', 'top', 'width', 'height'].map(property => Number.parseFloat(properties[property] ?? ''))
  for (const coordinate of [left, top, width, height]) expect(Number.isFinite(coordinate)).toBe(true)
  expect(width).toBeGreaterThan(0)
  expect(height).toBeGreaterThan(0)
  return { left, right: left + width, top, bottom: top + height }
}
const intersects = (first: Rectangle, second: Rectangle) => Math.min(first.right, second.right) > Math.max(first.left, second.left)
  && Math.min(first.bottom, second.bottom) > Math.max(first.top, second.top)

describe('manual replay trade annotations', () => {
  it('keeps the known entry but hides the entire dashed path and future exit', () => {
    const markup = renderAt(1800)
    expect(markup).toContain('mp-marker entry side-long')
    expect(markup).not.toContain('mp-trade-path')
    expect(markup).not.toContain('mp-marker exit')
    expect(markup).not.toContain('exit reason')
  })
  it('shows the connection only when the exit candle is revealed, and hides it again on rewind', () => {
    expect(renderAt(3300)).not.toContain('mp-trade-path')
    expect(renderAt(3600)).toContain('mp-trade-path')
    expect(renderAt(3600)).toContain('mp-marker exit')
    expect(renderAt(1800)).not.toContain('mp-trade-path')
    expect(renderAt(null)).toContain('mp-trade-path')
  })
  it('does not expose future entry arrows, reason badges, or open-trade levels', () => {
    const markup = renderAt(300)
    expect(markup).not.toContain('mp-marker entry')
    expect(markup).not.toContain('mp-note-badge')
    const openSession = { ...session, trades: [{ ...session.trades[0], exitTime: null, exitPrice: null, exitKind: null }] }
    expect(renderAt(300, openSession)).not.toContain('mp-level')
    expect(renderAt(600, openSession)).toContain('mp-level')
  })

  it('positions entry and exit labels independently outside a dense candle band and away from each other', () => {
    const markup = renderWithLabels(null)
    expect(markup).toContain('mp-marker entry side-long')
    expect(markup).toContain('mp-marker exit')
    expect(markup.match(/data-testid="manual-entry-label"/g)).toHaveLength(1)
    expect(markup.match(/data-testid="manual-exit-label"/g)).toHaveLength(1)
    const entry = labelBounds(markup, 'manual-entry-label')
    const exit = labelBounds(markup, 'manual-exit-label')
    for (const rectangle of [entry, exit]) {
      expect(intersects(rectangle, denseCandleBand)).toBe(false)
      expect(rectangle.left).toBeGreaterThanOrEqual(0)
      expect(rectangle.right).toBeLessThanOrEqual(labelViewport.width)
      expect(rectangle.top).toBeGreaterThanOrEqual(0)
      expect(rectangle.bottom).toBeLessThanOrEqual(labelViewport.height)
    }
    expect(intersects(entry, exit)).toBe(false)
  })

  it('does not leak the future exit through the independently positioned label on replay or rewind', () => {
    const beforeExit = renderWithLabels(1800)
    expect(beforeExit).toContain('mp-marker entry side-long')
    expect(beforeExit).toContain('data-testid="manual-entry-label"')
    expect(beforeExit).not.toContain('mp-marker exit')
    expect(beforeExit).not.toContain('data-testid="manual-exit-label"')
    expect(beforeExit).not.toContain('mp-trade-path')
    expect(renderWithLabels(3600)).toContain('data-testid="manual-exit-label"')
    expect(renderWithLabels(1800)).not.toContain('data-testid="manual-exit-label"')
    expect(renderWithLabels(300)).not.toMatch(/data-testid="manual-(?:entry|exit)-label"/)
  })

  it('keeps execution markers but hides large labels when every available position intersects candles', () => {
    const markup = renderWithLabels(null, {
      width: 800, height: 600,
      candleObstacles: [{ left: 0, right: 800, top: 0, bottom: 600 }],
    })
    expect(markup).toContain('mp-marker entry side-long')
    expect(markup).toContain('mp-marker exit')
    expect(markup).toContain('mp-trade-path')
    expect(markup).not.toContain('data-testid="manual-entry-label"')
    expect(markup).not.toContain('data-testid="manual-exit-label"')
  })
})
