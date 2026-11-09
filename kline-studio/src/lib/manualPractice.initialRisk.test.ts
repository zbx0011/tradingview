import { describe, expect, it } from 'vitest'
import {
  advanceManualSession, cancelManualPendingOrder, manualItemRisk, manualReasonRows,
  manualRiskRatio, manualTimeline, mergeManualPracticeStores, parseManualPracticeStore,
  parseManualRiskPlan, saveCandleBiasNotes, saveManualInitialRisk,
  type ManualPendingOrder, type ManualPracticeSession, type ManualPracticeStore, type ManualRiskPlan,
} from './manualPractice'

const long: ManualRiskPlan = { entryPrice: 100, stopLoss: 95, takeProfit: 115 }
const short: ManualRiskPlan = { entryPrice: 100, stopLoss: 110, takeProfit: 80 }
const pending = (): ManualPendingOrder => ({
  id: 'order', side: 'long', orderKind: 'stop', ...long, initialRisk: { ...long },
  quantity: 1, background: '背景', reasons: ['突破'], createdTime: 0, interval: '1m',
})
const paper = (): ManualPracticeSession => ({
  id: 'paper', symbol: 'NQ1!', dayKey: 'day', dayLabel: 'day', startTime: 0, endTime: 1200,
  cursorTime: 60, status: 'active', createdAt: 1, updatedAt: 1, completedAt: null,
  trades: [], notes: [], pendingOrder: pending(),
})
const store = (session: ManualPracticeSession): ManualPracticeStore => ({ version: 1, activeSessionId: session.id, sessions: [session] })
const roundTrip = (session: ManualPracticeSession) => parseManualPracticeStore(JSON.stringify(store(session))).sessions[0]

describe('initial decision risk snapshots', () => {
  it('persists independent long and short candle plans through parsing and either merge direction', () => {
    const old = paper()
    const saved = saveCandleBiasNotes(old, 300, '5m', '背景', [
      { bias: 'long', reasons: ['支撑'], initialRisk: long },
      { bias: 'short', reasons: ['阻力'], initialRisk: short },
      { bias: 'no-trade', reasons: ['等待'], initialRisk: long },
    ], 20)
    const restored = roundTrip(saved)
    for (const result of [restored, ...[
      mergeManualPracticeStores(store(old), store(restored)),
      mergeManualPracticeStores(store(restored), store(old)),
    ].map(merged => merged.sessions[0])]) {
      expect(result.notes.find(note => note.side === 'long')?.initialRisk).toEqual(long)
      expect(result.notes.find(note => note.side === 'short')?.initialRisk).toEqual(short)
      expect(result.notes.find(note => note.kind === 'no-trade')?.initialRisk).toBeUndefined()
      expect(result.pendingOrder?.initialRisk).toEqual(long)
    }
    expect(old.notes).toEqual([])
  })

  it('attaches one plan to a five-reason decision rather than making five plans', () => {
    const reasons = ['一', '二', '三', '四', '五']
    const saved = saveCandleBiasNotes({ ...paper(), pendingOrder: null }, 300, '5m', '背景', [
      { bias: 'long', reasons, initialRisk: long },
    ], 20)
    const rows = manualReasonRows(roundTrip(saved))
    expect(rows).toHaveLength(1)
    const planned = rows[0].biasItems!.filter(item => manualItemRisk(item))
    expect(planned).toHaveLength(1)
    expect(planned[0].reasons).toEqual(reasons)
    expect(manualItemRisk(planned[0])).toEqual(long)
  })

  it('retains a price-only plan even when the candle has no background or reasons', () => {
    const saved = saveCandleBiasNotes(paper(), 300, '5m', '', [{ bias: 'short', reasons: [], initialRisk: short }], 20)
    expect(roundTrip(saved).notes.find(note => note.side === 'short')?.initialRisk).toEqual(short)
  })

  it('preserves submission prices when a pending order fills at a gap and its stop is later changed', () => {
    const original = paper()
    const outcome = advanceManualSession(original, [
      { time: 60, open: 103, high: 105, low: 102, close: 104, volume: 1 },
    ], 60, 20)
    expect(outcome.filledTrade?.entryPrice).toBe(103)
    expect(outcome.filledTrade?.initialRisk).toEqual(long)
    expect(outcome.session.pendingOrder).toBeNull()
    const adjusted = {
      ...outcome.session, updatedAt: 30,
      trades: outcome.session.trades.map(trade => ({ ...trade, stopLoss: 102 })),
    }
    const restored = roundTrip(adjusted)
    expect(restored.trades[0].stopLoss).toBe(102)
    expect(restored.trades[0].initialRisk).toEqual(long)
    expect(manualRiskRatio(restored.trades[0].initialRisk!)).toBe(3)
    expect(manualItemRisk(manualTimeline(restored)[0])).toEqual(long)
    for (const merged of [
      mergeManualPracticeStores(store(outcome.session), store(restored)),
      mergeManualPracticeStores(store(restored), store(outcome.session)),
    ]) expect(merged.sessions[0].trades[0]).toMatchObject({ stopLoss: 102, initialRisk: long })
    expect(original.pendingOrder?.initialRisk).toEqual(long)
  })

  it('retains the submitted plan when a pending order is cancelled', () => {
    const cancelled = roundTrip(cancelManualPendingOrder(paper(), '1m', 60, 'manual', 20))
    expect(cancelled.cancelledOrders?.[0].initialRisk).toEqual(long)
    expect(manualItemRisk(manualTimeline(cancelled)[0])).toEqual(long)
  })

  it('does not invent initial plans for legacy notes, pending orders or filled trades', () => {
    const legacy = paper()
    delete legacy.pendingOrder!.initialRisk
    legacy.notes = [{ barTime: 0, interval: '1m', kind: 'should-trade', side: 'long', background: '', reasons: ['旧理由'], updatedAt: 1 }]
    const restored = roundTrip(legacy)
    expect(restored.pendingOrder?.initialRisk).toBeUndefined()
    expect(restored.notes[0].initialRisk).toBeUndefined()
    const filled = advanceManualSession(restored, [
      { time: 60, open: 100, high: 102, low: 99, close: 101, volume: 1 },
    ], 60, 20).session
    const merged = mergeManualPracticeStores(store(legacy), store(roundTrip(filled))).sessions[0]
    expect(merged.trades[0].initialRisk).toBeUndefined()
    expect(manualTimeline(merged).every(item => manualItemRisk(item) === undefined)).toBe(true)
  })

  it.each([
    null, {}, { ...long, entryPrice: '100' }, { ...long, entryPrice: 0 },
    { ...long, stopLoss: -1 }, { ...long, takeProfit: Infinity },
    { ...long, stopLoss: 100 }, { ...long, takeProfit: 100 },
    { ...long, stopLoss: 110 }, { ...short, takeProfit: 120 },
  ])('rejects malformed or unordered imported plans: %j', invalid => {
    expect(parseManualRiskPlan(invalid)).toBeUndefined()
    const source = paper()
    const raw = {
      ...source, pendingOrder: { ...source.pendingOrder, initialRisk: invalid },
      notes: [{ barTime: 0, interval: '1m', kind: 'should-trade', side: 'long', background: '', reasons: ['有效记录'], updatedAt: 1, initialRisk: invalid }],
      trades: [{ id: 'trade', side: 'long', entryTime: 0, ...long, exitTime: null, exitPrice: null, exitKind: null, background: '', reasons: [], exitReasons: [], initialRisk: invalid }],
    }
    const restored = parseManualPracticeStore(JSON.stringify({ version: 1, sessions: [raw] })).sessions[0]
    expect(restored.pendingOrder?.initialRisk).toBeUndefined()
    expect(restored.notes).toHaveLength(1)
    expect(restored.notes[0].initialRisk).toBeUndefined()
    expect(restored.trades).toHaveLength(1)
    expect(restored.trades[0].initialRisk).toBeUndefined()
  })

  it('calculates reward divided by risk for either side', () => {
    expect(manualRiskRatio(long)).toBe(3)
    expect(manualRiskRatio(short)).toBe(2)
    expect(parseManualRiskPlan(long)).toEqual(long)
    expect(parseManualRiskPlan(short)).toEqual(short)
    expect(parseManualRiskPlan(long)).not.toBe(long)
  })
})

describe('explicit missing-plan backfill', () => {
  it('adds the plan to the selected note only and preserves all trade outcomes', () => {
    const original = saveCandleBiasNotes(paper(), 0, '5m', 'context', [{ bias: 'long', reasons: ['a'] }, { bias: 'short', reasons: ['b'] }])
    const item = manualTimeline(original).find(item => item.note?.side === 'long')!
    const saved = saveManualInitialRisk(original, item, long, 100)
    expect(saved.notes.find(note => note.side === 'long')?.initialRisk).toEqual(long)
    expect(saved.notes.find(note => note.side === 'short')?.initialRisk).toBeUndefined()
    expect(saved.trades).toEqual(original.trades)
    expect(saved.pendingOrder).toEqual(original.pendingOrder)
    expect(saved.cursorTime).toBe(original.cursorTime)
    expect(roundTrip(saved).notes.find(note => note.side === 'long')?.initialRisk).toEqual(long)
    expect(saveManualInitialRisk(saved, item, { ...long, takeProfit: 200 }, 101)).toBe(saved)
  })
  it('rejects a plan for the wrong side', () => {
    const original = saveCandleBiasNotes(paper(), 0, '5m', 'context', [{ bias: 'short', reasons: ['b'] }])
    const item = manualTimeline(original).find(item => item.note?.side === 'short')!
    expect(saveManualInitialRisk(original, item, long)).toBe(original)
  })
})
