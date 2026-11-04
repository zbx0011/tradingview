import { describe, expect, it } from 'vitest'
import {
  advanceManualSession, manualTimeline, parseManualPracticeStore,
  type ManualPendingOrder, type ManualPracticeSession, type ManualTrade,
} from './manualPractice'

const trade = (): ManualTrade => ({
  id: 'trade', side: 'long', entryTime: 0, entryPrice: 100, stopLoss: 95, takeProfit: 110,
  exitTime: 60, exitPrice: 102, exitKind: 'manual', background: '区间', reasons: ['突破'], exitReasons: [],
})

const order = (): ManualPendingOrder => ({
  id: 'pending', side: 'long', orderKind: 'stop', entryPrice: 100, stopLoss: 95, takeProfit: 110,
  quantity: 1, background: '区间', reasons: ['突破'], createdTime: 0,
})

const session = (): ManualPracticeSession => ({
  id: 'paper', symbol: 'NQ1!', dayKey: 'NQ1!:2025-04-14', dayLabel: '2025-04-14',
  startTime: 0, endTime: 600, cursorTime: 60, status: 'active', createdAt: 1, updatedAt: 1,
  completedAt: null, trades: [], notes: [], pendingOrder: null,
})

function roundTrip(paper: ManualPracticeSession) {
  return parseManualPracticeStore(JSON.stringify({ version: 1, activeSessionId: paper.id, sessions: [paper] })).sessions[0]
}

describe('manual entry counter-evidence', () => {
  it('keeps legacy trades and orders valid and retains trimmed multiline text through storage', () => {
    const paper = session()
    paper.trades = [trade()]
    paper.pendingOrder = order()
    expect(roundTrip(paper).trades[0].unsupportedReasons).toBe('')
    expect(roundTrip(paper).pendingOrder?.unsupportedReasons).toBe('')

    paper.trades[0].unsupportedReasons = '  前方阻力较近\n突破力度不足  '
    paper.pendingOrder.unsupportedReasons = '  没有回测确认  '
    const parsed = roundTrip(paper)
    expect(parsed.trades[0].unsupportedReasons).toBe('前方阻力较近\n突破力度不足')
    expect(parsed.pendingOrder?.unsupportedReasons).toBe('没有回测确认')
    expect(roundTrip(parsed)).toEqual(parsed)
  })

  it('carries pending-order counter-evidence into the fill and only the entry timeline item', () => {
    const paper = session()
    paper.pendingOrder = { ...order(), unsupportedReasons: '  顺势空间不足\n对手方仍强  ' }
    const outcome = advanceManualSession(paper, [{ time: 60, open: 99, high: 102, low: 98, close: 101, volume: 1 }], 60, 2)
    expect(outcome.session.pendingOrder).toBeNull()
    expect(outcome.filledTrade?.unsupportedReasons).toBe('顺势空间不足\n对手方仍强')
    const filled = outcome.session.trades[0]
    const completed = roundTrip({ ...outcome.session, trades: [{ ...filled, exitTime: 120, exitPrice: 102, exitKind: 'manual' }] })
    const timeline = manualTimeline(completed)
    expect(timeline.find((item) => item.kind === 'entry')?.unsupportedReasons).toBe('顺势空间不足\n对手方仍强')
    expect(timeline.find((item) => item.kind === 'exit')?.unsupportedReasons).toBeUndefined()
  })
})
