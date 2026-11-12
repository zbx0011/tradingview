import { describe, expect, it } from 'vitest'
import {
  advanceManualSession, cancelManualPendingOrder, manualItemReasonTimes, manualTimeline,
  mergeManualPracticeStores, parseManualPracticeStore, recordManualReasonTimes,
  saveCandleBiasNotes, saveManualInitialRisk, upsertBarNote,
  type ManualPendingOrder, type ManualPracticeSession, type ManualPracticeStore,
} from './manualPractice'

const paper = (): ManualPracticeSession => ({
  id: 'paper', symbol: 'NQ1!', dayKey: 'day', dayLabel: 'day', startTime: 0, endTime: 1200,
  cursorTime: 60, status: 'active', createdAt: 1, updatedAt: 2, completedAt: null, trades: [], notes: [],
})
const pending = (): ManualPendingOrder => ({
  id: 'order', side: 'long', orderKind: 'stop', entryPrice: 100, stopLoss: 95, takeProfit: 110,
  quantity: 1, background: '背景', reasons: ['突破'], unsupportedReasons: '反证', createdTime: 0, interval: '1m',
  reasonTimes: { createdAt: 100, updatedAt: 200 },
})
const store = (session: ManualPracticeSession): ManualPracticeStore => ({ version: 1, activeSessionId: session.id, sessions: [session] })
const roundTrip = (session: ManualPracticeSession) => parseManualPracticeStore(JSON.stringify(store(session))).sessions[0]
const bothMerges = (a: ManualPracticeSession, b: ManualPracticeSession) => [mergeManualPracticeStores(store(a), store(b)), mergeManualPracticeStores(store(b), store(a))].map((result) => result.sessions[0])
const withoutReasonTimes = <T extends { reasonTimes?: unknown }>(value: T): T => {
  const result = { ...value }
  delete result.reasonTimes
  return result
}

describe('original decision reason save times', () => {
  it('creates new timestamps, preserves creation during edits, and does not invent legacy creation', () => {
    expect(recordManualReasonTimes(undefined, 100, true)).toEqual({ createdAt: 100, updatedAt: 100 })
    expect(recordManualReasonTimes({ createdAt: 100, updatedAt: 150 }, 200)).toEqual({ createdAt: 100, updatedAt: 200 })
    expect(recordManualReasonTimes(undefined, 200)).toEqual({ updatedAt: 200 })
    expect(recordManualReasonTimes({ updatedAt: 150 }, 200)).toEqual({ updatedAt: 200 })
    expect(recordManualReasonTimes({ createdAt: 100, updatedAt: 200 }, 50)).toEqual({ createdAt: 100, updatedAt: 200 })
  })

  it('records note edits but leaves unchanged reason saves at their original times', () => {
    const created = upsertBarNote(paper(), 0, '1m', ['理由'], '背景', 'should-trade', 'long', 100)
    const unchanged = upsertBarNote(created, 0, '1m', [' 理由 '], ' 背景 ', 'should-trade', 'long', 200)
    expect(unchanged.notes[0].reasonTimes).toBe(created.notes[0].reasonTimes)
    expect(unchanged.notes[0].updatedAt).toBe(100)
    const edited = upsertBarNote(unchanged, 0, '1m', ['新理由'], '背景', 'should-trade', 'long', 300)
    expect(edited.notes[0].reasonTimes).toEqual({ createdAt: 100, updatedAt: 300 })
    expect(roundTrip(edited).notes[0].reasonTimes).toEqual(edited.notes[0].reasonTimes)
    const legacy = { ...created, notes: created.notes.map(withoutReasonTimes) }
    expect(upsertBarNote(legacy, 0, '1m', ['编辑旧理由'], '背景', 'should-trade', 'long', 400).notes[0].reasonTimes).toEqual({ updatedAt: 400 })
  })

  it('does not retime reasons when directional rank or risk changes', () => {
    const created = saveCandleBiasNotes(paper(), 0, '1m', '背景', [{ bias: 'long', reasons: ['多'] }, { bias: 'short', reasons: ['空'] }], 100)
    const reordered = saveCandleBiasNotes(created, 0, '1m', '背景', [
      { bias: 'short', reasons: ['空'], initialRisk: { entryPrice: 100, stopLoss: 110, takeProfit: 90 } },
      { bias: 'long', reasons: ['多'] },
    ], 200)
    for (const note of reordered.notes) expect(note.reasonTimes).toEqual({ createdAt: 100, updatedAt: 100 })
    expect(reordered.notes.find((note) => note.side === 'short')?.biasRank).toBe(0)
    const changed = saveCandleBiasNotes(reordered, 0, '1m', '新背景', [{ bias: 'short', reasons: ['空'] }, { bias: 'long', reasons: ['多'] }], 300)
    for (const note of changed.notes) expect(note.reasonTimes).toEqual({ createdAt: 100, updatedAt: 300 })
  })

  it('keeps a legacy note last-save evidence when only its initial risk is backfilled', () => {
    const original = paper()
    original.notes = [{ barTime: 0, interval: '1m', kind: 'should-trade', side: 'long', background: '旧背景', reasons: ['旧理由'], updatedAt: 50 }]
    const item = manualTimeline(original)[0]
    expect(manualItemReasonTimes(item)).toEqual({ updatedAt: 50 })
    const changed = saveManualInitialRisk(original, item, { entryPrice: 100, stopLoss: 95, takeProfit: 110 }, 300)
    expect(changed.notes[0].updatedAt).toBe(300)
    expect(manualItemReasonTimes(manualTimeline(changed)[0])).toEqual({ updatedAt: 50 })
  })

  it('retains submission times through a fill or cancellation, with independent manual exit reasons', () => {
    const original = { ...paper(), pendingOrder: pending() }
    const filled = advanceManualSession(original, [{ time: 60, open: 100, high: 102, low: 99, close: 101, volume: 1 }], 60, 300).session
    expect(filled.trades[0].reasonTimes).toEqual(pending().reasonTimes)
    const closed = { ...filled, trades: [{ ...filled.trades[0], exitKind: 'manual' as const, exitTime: 120, exitPrice: 101, exitReasons: ['平仓'], exitReasonTimes: recordManualReasonTimes(undefined, 400, true) }] }
    const restored = roundTrip(closed)
    expect(manualItemReasonTimes(manualTimeline(restored).find((item) => item.kind === 'entry')!)).toEqual({ createdAt: 100, updatedAt: 200 })
    expect(manualItemReasonTimes(manualTimeline(restored).find((item) => item.kind === 'exit')!)).toEqual({ createdAt: 400, updatedAt: 400 })
    const cancelled = roundTrip(cancelManualPendingOrder(original, '1m', 60, 'manual', 500))
    expect(manualItemReasonTimes(manualTimeline(cancelled)[0])).toEqual(pending().reasonTimes)
  })

  it('filters malformed imported reason metadata and does not infer save times from chart timestamps', () => {
    const original = { ...paper(), pendingOrder: pending() }
    for (const invalid of [{ updatedAt: 8.64e15 + 1 }, { updatedAt: -1 }, { updatedAt: '100' }, null]) {
      expect(roundTrip({ ...original, pendingOrder: { ...pending(), reasonTimes: invalid } } as unknown as ManualPracticeSession).pendingOrder?.reasonTimes).toBeUndefined()
    }
    const withBadCreation = roundTrip({ ...original, pendingOrder: { ...pending(), reasonTimes: { createdAt: 300, updatedAt: 200 } } })
    expect(withBadCreation.pendingOrder?.reasonTimes).toEqual({ updatedAt: 200 })
    const legacy = { ...original, pendingOrder: { ...pending(), reasonTimes: undefined } }
    const filled = advanceManualSession(legacy, [{ time: 60, open: 100, high: 102, low: 99, close: 101, volume: 1 }], 60, 300).session
    expect(manualItemReasonTimes(manualTimeline(roundTrip(filled))[0])).toBeUndefined()
  })

  it('borrows missing metadata only for matching winning reason content during cross-computer merges', () => {
    const recorded = upsertBarNote(paper(), 0, '1m', ['理由'], '背景', 'no-trade', undefined, 100)
    const legacy = { ...recorded, updatedAt: 300, cursorTime: 900, notes: recorded.notes.map((note) => ({ ...withoutReasonTimes(note), biasRank: 2 })) }
    for (const result of bothMerges(recorded, legacy)) {
      expect(result.cursorTime).toBe(900)
      expect(result.notes[0].reasonTimes).toEqual({ createdAt: 100, updatedAt: 100 })
      expect(result.notes[0].biasRank).toBe(2)
    }
    const different = { ...legacy, notes: legacy.notes.map((note) => ({ ...note, reasons: ['另一理由'] })) }
    for (const result of bothMerges(recorded, different)) expect(result.notes[0].reasonTimes).toBeUndefined()
  })

  it('preserves matching trade, pending and cancelled metadata without attaching times to different reasons', () => {
    const original = { ...paper(), pendingOrder: pending() }
    const legacyPending = { ...original, updatedAt: 400, pendingOrder: { ...pending(), reasonTimes: undefined } }
    for (const result of bothMerges(original, legacyPending)) expect(result.pendingOrder?.reasonTimes).toEqual(pending().reasonTimes)
    const filled = advanceManualSession(original, [{ time: 60, open: 100, high: 102, low: 99, close: 101, volume: 1 }], 60, 300).session
    const legacyTrade = { ...filled, updatedAt: 400, trades: filled.trades.map(withoutReasonTimes) }
    for (const result of bothMerges(filled, legacyTrade)) expect(result.trades[0].reasonTimes).toEqual(pending().reasonTimes)
    const different = { ...legacyTrade, trades: legacyTrade.trades.map((trade) => ({ ...trade, unsupportedReasons: '不同反证' })) }
    for (const result of bothMerges(filled, different)) expect(result.trades[0].reasonTimes).toBeUndefined()
    const archived = cancelManualPendingOrder(original, '1m', 60, 'manual', 300)
    const legacyArchive = { ...archived, updatedAt: 500, cancelledOrders: archived.cancelledOrders?.map((order) => ({ ...withoutReasonTimes(order), updatedAt: 400 })) }
    for (const result of bothMerges(archived, legacyArchive)) expect(result.cancelledOrders?.[0].reasonTimes).toEqual(pending().reasonTimes)
  })
})
