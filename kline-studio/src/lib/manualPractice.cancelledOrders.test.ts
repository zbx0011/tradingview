import { describe, expect, it } from 'vitest'
import {
  advanceManualSession, cancelManualPendingOrder, finishManualSession, manualReasonRows,
  manualReviewCommentKey, manualTimeline, mergeManualPracticeStores, parseManualPracticeStore,
  saveManualReviewComment, sessionSummary,
  type ManualPendingOrder, type ManualPracticeSession, type ManualPracticeStore,
} from './manualPractice'
import type { Candle } from './market'

const pending = (id = 'order'): ManualPendingOrder => ({
  id, side: 'short', orderKind: 'limit', entryPrice: 120, stopLoss: 125, takeProfit: 110,
  quantity: 3, background: '提交时背景\n保留原文', reasons: ['理由 A', '理由 B'],
  unsupportedReasons: '反对证据\n不要丢失', createdTime: 300, interval: '5m',
})
const paper = (): ManualPracticeSession => ({
  id: 'paper', symbol: 'NQ1!', dayKey: 'day', dayLabel: 'day', startTime: 0, endTime: 600,
  cursorTime: 420, status: 'active', createdAt: 1, updatedAt: 2, completedAt: null,
  trades: [], notes: [], pendingOrder: pending(),
})
const store = (session: ManualPracticeSession): ManualPracticeStore => ({ version: 1, activeSessionId: session.status === 'active' ? session.id : null, sessions: [session] })
const roundTrip = (session: ManualPracticeSession) => parseManualPracticeStore(JSON.stringify(store(session))).sessions[0]
const candle = (time: number): Candle => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 1 })

describe('retained cancelled manual orders', () => {
  it('archives the complete submitted decision, copies reasons, and clears only the pending slot', () => {
    const original = paper()
    const before = JSON.stringify(original)
    const result = cancelManualPendingOrder(original, '15m', undefined, 'manual', 1234)
    expect(result.pendingOrder).toBeNull()
    expect(result.cancelledOrders).toEqual([{ ...original.pendingOrder!, interval: '5m', cancelledTime: 360, cancellationReason: 'manual', updatedAt: 1234 }])
    expect(result.cancelledOrders![0].reasons).not.toBe(original.pendingOrder!.reasons)
    expect(result.trades).toBe(original.trades)
    expect(result.notes).toBe(original.notes)
    expect(result.cursorTime).toBe(original.cursorTime)
    expect(result.updatedAt).toBe(1234)
    expect(JSON.stringify(original)).toBe(before)
  })

  it('is an exact no-op without a pending order, including repeated cancellation', () => {
    const original = paper()
    const cancelled = cancelManualPendingOrder(original, '5m', 360, 'manual', 10)
    expect(cancelManualPendingOrder(cancelled, '5m', 400, 'manual', 20)).toBe(cancelled)
    const withoutPending = { ...original, pendingOrder: undefined }
    expect(cancelManualPendingOrder(withoutPending, '1m')).toBe(withoutPending)
    const resurrected = { ...cancelled, pendingOrder: original.pendingOrder }
    expect(cancelManualPendingOrder(resurrected, '5m', 400, 'manual', 30).cancelledOrders).toHaveLength(1)
  })

  it('uses the cancellation timeframe for legacy pending orders and never dates cancellation before submission', () => {
    const original = paper()
    delete original.pendingOrder!.interval
    original.cursorTime = 300
    const result = cancelManualPendingOrder(original, '15m', undefined, 'manual', 10)
    expect(result.cancelledOrders![0].interval).toBe('15m')
    expect(result.cancelledOrders![0].cancelledTime).toBe(300)
  })

  it('round-trips v1 papers with archives and accepts legacy papers without them', () => {
    const legacy = paper()
    delete legacy.pendingOrder!.interval
    expect(roundTrip(legacy).cancelledOrders).toBeUndefined()
    expect(roundTrip(legacy).pendingOrder?.interval).toBeUndefined()
    const archived = cancelManualPendingOrder(legacy, '15m', 360, 'manual', 10)
    expect(roundTrip(archived)).toEqual(archived)
    expect(parseManualPracticeStore(JSON.stringify(store(archived))).version).toBe(1)
  })

  it('validates imported archive records and suppresses an archived stale pending order', () => {
    const valid = cancelManualPendingOrder(paper(), '5m', 360, 'manual', 10).cancelledOrders![0]
    const source = { ...paper(), cancelledOrders: [valid, null, { ...valid, id: 'bad-time', cancelledTime: '360' }, { ...valid, id: 'bad-interval', interval: 'bogus' }, { ...valid, id: 'bad-clock', updatedAt: null }, { ...valid, id: 'bad-reason', cancellationReason: 'filled' }, { ...valid, id: 'too-early', cancelledTime: 0 }] }
    const restored = parseManualPracticeStore(JSON.stringify({ version: 1, sessions: [source] })).sessions[0]
    expect(restored.cancelledOrders).toEqual([valid])
    expect(restored.pendingOrder).toBeNull()
  })

  it('keeps multiple cancellations on the same bar as separate numbered cards and review identities', () => {
    const first = cancelManualPendingOrder(paper(), '5m', 360, 'manual', 10)
    const second = cancelManualPendingOrder({ ...first, pendingOrder: pending('second') }, '5m', 360, 'manual', 11)
    const rows = manualReasonRows(second)
    expect(rows.map(row => row.seq)).toEqual([1, 2])
    expect(rows.every(row => row.item.kind === 'cancelled-order' && row.exit === undefined && row.biasItems === undefined)).toBe(true)
    const [a, b] = rows.map(row => row.item)
    expect(a.time).toBe(300)
    expect(a.title).toContain('已取消挂单')
    expect(a.title).toContain('开空 @ 120.00')
    expect(a.background).toBe(pending().background)
    expect(a.reasons).toEqual(pending().reasons)
    expect(a.unsupportedReasons).toBe(pending().unsupportedReasons)
    expect(manualReviewCommentKey(a)).not.toBe(manualReviewCommentKey(b))
    expect(manualReviewCommentKey({ ...a, time: 900, cancelledOrder: { ...a.cancelledOrder!, createdTime: 900 } })).toBe(manualReviewCommentKey(a))
    const reviewed = saveManualReviewComment(saveManualReviewComment(second, a, '第一条', 20), b, '第二条', 21)
    expect(roundTrip(reviewed).reviewComments?.[manualReviewCommentKey(a)].text).toBe('第一条')
    expect(roundTrip(reviewed).reviewComments?.[manualReviewCommentKey(b)].text).toBe('第二条')
  })

  it('archives session-end expiry from both finish and normal advancement without filling an order', () => {
    const original = { ...paper(), cursorTime: 600 }
    const finished = finishManualSession(original, [candle(540)], 50)
    expect(finished.status).toBe('completed')
    expect(finished.pendingOrder).toBeNull()
    expect(finished.trades).toEqual([])
    expect(finished.cancelledOrders![0]).toMatchObject({ cancelledTime: 540, cancellationReason: 'session-end', updatedAt: 50 })
    expect(manualTimeline(finished)[0].title).toContain('到期未成交')
    const advanced = advanceManualSession({ ...paper(), cursorTime: 540 }, [candle(540)], 60, 50)
    expect(advanced.finished).toBe(true)
    expect(advanced.filledTrade).toBeNull()
    expect(advanced.session.cancelledOrders).toEqual(finished.cancelledOrders)
  })

  it('changes only retained reason counts, never trades, PnL, wins/losses or genuine no-trade notes', () => {
    const original = paper()
    original.notes = [{ barTime: 0, interval: '5m', kind: 'no-trade', background: '背景', reasons: ['真实未做单'], updatedAt: 1 }]
    original.trades = [{ id: 'trade', side: 'long', entryTime: 0, entryPrice: 100, stopLoss: 95, takeProfit: 110, exitTime: 60, exitPrice: 102, exitKind: 'manual', background: '背景', reasons: ['成交理由'], exitReasons: ['平仓理由'], quantity: 2 }]
    const before = sessionSummary(original)
    expect(before.reasonCount).toBe(2)
    original.notes[0].reasons = ['一', '二', '三', '四', '五']
    expect(sessionSummary(original).reasonCount).toBe(2)
    const after = sessionSummary(cancelManualPendingOrder(original, '5m', 360, 'manual', 10))
    expect(after).toEqual({ ...before, reasonCount: before.reasonCount + 1 })
    expect(after.noTradeNotes).toBe(1)
    expect(after.totalUsd).toBe(80)
  })

  it('merges independent archives by order identity and own clock even when another snapshot wins', () => {
    const archived = cancelManualPendingOrder(paper(), '5m', 360, 'manual', 100)
    const other = cancelManualPendingOrder({ ...paper(), pendingOrder: pending('second') }, '5m', 360, 'manual', 200)
    const newerProgress = { ...other, updatedAt: 1000, cursorTime: 500, pendingOrder: pending() }
    for (const merged of [mergeManualPracticeStores(store(archived), store(newerProgress)), mergeManualPracticeStores(store(newerProgress), store(archived))]) {
      expect(merged.sessions[0].cursorTime).toBe(500)
      expect(merged.sessions[0].updatedAt).toBe(1000)
      expect(merged.sessions[0].cancelledOrders?.map(order => order.id)).toEqual(['order', 'second'])
      expect(merged.sessions[0].pendingOrder).toBeNull()
    }
    const changed = { ...archived, updatedAt: 1, cancelledOrders: [{ ...archived.cancelledOrders![0], background: '较新记录', updatedAt: 300 }] }
    const merge = (a: ManualPracticeSession, b: ManualPracticeSession) => mergeManualPracticeStores(store(a), store(b)).sessions[0].cancelledOrders
    expect(merge(archived, changed)).toEqual(merge(changed, archived))
    expect(merge(archived, changed)?.[0].background).toBe('较新记录')
    const tied = { ...changed, cancelledOrders: [{ ...changed.cancelledOrders[0], background: 'z' }] }
    expect(merge(tied, changed)).toEqual(merge(changed, tied))
  })
})
