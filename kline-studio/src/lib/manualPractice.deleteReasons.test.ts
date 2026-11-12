import { describe, expect, it } from 'vitest'
import {
  deleteManualCandleReasons, manualReviewCommentKey, manualTimeline, mergeManualPracticeStores,
  parseManualPracticeStore, saveCandleBiasNotes, upsertBarNote,
  type ManualPracticeSession, type ManualPracticeStore,
} from './manualPractice'

const paper = (): ManualPracticeSession => ({
  id: 'paper', symbol: 'NQ1!', dayKey: 'day', dayLabel: 'day', startTime: 0, endTime: 1200,
  cursorTime: 600, status: 'active', createdAt: 1, updatedAt: 2, completedAt: null,
  trades: [{ id: 'trade', side: 'long', entryTime: 60, entryPrice: 100, stopLoss: 95, takeProfit: 110, exitTime: null, exitPrice: null, exitKind: null, background: '交易背景', reasons: ['交易理由'], exitReasons: [] }],
  pendingOrder: { id: 'pending', side: 'short', orderKind: 'limit', entryPrice: 120, stopLoss: 125, takeProfit: 110, quantity: 1, background: '挂单背景', reasons: ['挂单理由'], createdTime: 300 },
  notes: [],
})
const store = (session: ManualPracticeSession): ManualPracticeStore => ({ version: 1, activeSessionId: session.id, sessions: [session] })
const roundTrip = (session: ManualPracticeSession) => parseManualPracticeStore(JSON.stringify(store(session))).sessions[0]
const bothMerges = (a: ManualPracticeSession, b: ManualPracticeSession) => [mergeManualPracticeStores(store(a), store(b)), mergeManualPracticeStores(store(b), store(a))].map((result) => result.sessions[0])
const seeded = () => {
  let session = saveCandleBiasNotes(paper(), 300, '5m', '待删除背景', [
    { bias: 'long', reasons: ['多方理由'], initialRisk: { entryPrice: 100, stopLoss: 95, takeProfit: 110 } },
    { bias: 'short', reasons: ['空方理由'] }, { bias: 'no-trade', reasons: ['等待理由'] },
  ], 100)
  session = upsertBarNote(session, 600, '5m', ['其他K线'], '保留', 'no-trade', undefined, 110)
  session = upsertBarNote(session, 300, '15m', ['其他周期'], '保留', 'no-trade', undefined, 120)
  return {
    ...session,
    reviewComments: Object.fromEntries(manualTimeline(session).map((item) => [manualReviewCommentKey(item), { text: `评论 ${item.time} ${item.kind}`, createdAt: 140, updatedAt: 150 }])),
  }
}

describe('deleting one candle original reasons', () => {
  it('removes all directions, background, risk and reason times for only the selected candle and interval', () => {
    const original = seeded()
    const deleted = deleteManualCandleReasons(original, 300, '5m', 200)
    expect(deleted.notes).toEqual(original.notes.filter((note) => note.barTime !== 300 || note.interval !== '5m'))
    expect(deleted.notes).toHaveLength(2)
    expect(deleted.notes.every((note) => !note.initialRisk)).toBe(true)
    expect(deleted.trades).toBe(original.trades)
    expect(deleted.pendingOrder).toBe(original.pendingOrder)
    expect(deleted.cursorTime).toBe(original.cursorTime)
    expect(deleted.status).toBe(original.status)
    expect(deleted.updatedAt).toBe(200)
    expect(Object.values(deleted.deletedNotes!)).toEqual([200, 200, 200])
    for (const item of manualTimeline(original)) {
      const key = manualReviewCommentKey(item)
      const targeted = item.note?.barTime === 300 && item.note.interval === '5m'
      expect(deleted.reviewComments?.[key]).toEqual(targeted ? { text: '', updatedAt: 200 } : original.reviewComments[key])
    }
    expect(original.notes).toHaveLength(5)
    expect(original.deletedNotes).toBeUndefined()
  })

  it('is an exact no-op when there are no notes at the target', () => {
    const original = seeded()
    expect(deleteManualCandleReasons(original, 900, '5m', 200)).toBe(original)
    expect(deleteManualCandleReasons(original, 300, '1m', 200)).toBe(original)
    const deleted = deleteManualCandleReasons(original, 300, '5m', 200)
    expect(deleteManualCandleReasons(deleted, 300, '5m', 300)).toBe(deleted)
  })

  it('round-trips valid deletion clocks and filters older or equal-clock notes during parsing', () => {
    const original = seeded()
    const deleted = deleteManualCandleReasons(original, 300, '5m', 200)
    const restored = roundTrip({ ...deleted, notes: original.notes })
    expect(restored.notes).toEqual(roundTrip(deleted).notes)
    expect(restored.deletedNotes).toEqual(deleted.deletedNotes)
    const invalid = { ...deleted, deletedNotes: { ...deleted.deletedNotes, bad: -1, tooLarge: 8.64e15 + 1, wrongType: '200' } }
    expect(roundTrip(invalid as unknown as ManualPracticeSession).deletedNotes).toEqual(deleted.deletedNotes)
    const equalClock = { ...deleted, notes: original.notes.map((note) => ({ ...note, updatedAt: 200 })) }
    expect(roundTrip(equalClock).notes).toHaveLength(2)
  })

  it('does not restore deleted reasons or their old comments from a newer-progress computer in either merge direction', () => {
    const original = seeded()
    const deleted = deleteManualCandleReasons(original, 300, '5m', 200)
    const stale = { ...original, updatedAt: 999, cursorTime: 1000 }
    for (const result of bothMerges(deleted, stale)) {
      expect(result.notes).toEqual(deleted.notes)
      expect(result.cursorTime).toBe(1000)
      expect(result.trades).toBe(stale.trades)
      expect(result.deletedNotes).toEqual(deleted.deletedNotes)
      for (const key of Object.keys(deleted.deletedNotes!)) expect(result.reviewComments?.[key]).toEqual({ text: '', updatedAt: 200 })
    }
  })

  it('deletes stale directions that were absent on the deleting computer', () => {
    const original = upsertBarNote(paper(), 300, '5m', ['等待'], '背景', 'no-trade', undefined, 100)
    const stale = upsertBarNote(original, 300, '5m', ['别处的做空'], '背景', 'should-trade', 'short', 150)
    const deleted = deleteManualCandleReasons(original, 300, '5m', 200)
    for (const result of bothMerges(deleted, { ...stale, updatedAt: 999 })) expect(result.notes).toEqual([])
  })

  it('allows freshly saved alternatives after deletion without restoring old plans or comments', () => {
    const deleted = deleteManualCandleReasons(seeded(), 300, '5m', 200)
    const recreated = saveCandleBiasNotes(deleted, 300, '5m', '新背景', [{ bias: 'long', reasons: ['新理由'] }], 300)
    for (const result of [roundTrip(recreated), ...bothMerges(deleted, recreated)]) {
      const notes = result.notes.filter((note) => note.barTime === 300 && note.interval === '5m')
      expect(notes).toHaveLength(3)
      for (const note of notes) {
        expect(note.updatedAt).toBe(300)
        expect(note.reasonTimes).toEqual({ createdAt: 300, updatedAt: 300 })
        expect(note.initialRisk).toBeUndefined()
      }
      for (const key of Object.keys(deleted.deletedNotes!)) expect(result.reviewComments?.[key]).toEqual({ text: '', updatedAt: 200 })
    }
  })
})
