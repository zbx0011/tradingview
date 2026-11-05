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
})
