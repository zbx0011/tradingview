import { describe, expect, it } from 'vitest'
import { manualReasonRows, manualTimeline, parseManualPracticeStore, saveCandleBiasNotes, upsertBarNote, type ManualPracticeSession } from './manualPractice'

const paper = (): ManualPracticeSession => ({
  id: 'paper', symbol: 'NQ1!', dayKey: 'day', dayLabel: 'day', startTime: 0, endTime: 1200,
  cursorTime: 1200, status: 'completed', createdAt: 1, updatedAt: 1, completedAt: 1,
  notes: [], trades: [{ id: 'trade', side: 'long', entryTime: 600, entryPrice: 100, stopLoss: 95, takeProfit: 110, exitTime: 900, exitPrice: 102, exitKind: 'manual', background: '背景', reasons: ['实际成交'], exitReasons: [] }],
})

describe('one-candle ranked alternatives', () => {
  it('saves all directions atomically and restores rank and both sides from storage', () => {
    const original = upsertBarNote(paper(), 300, '5m', ['旧理由'], '旧背景', 'no-trade', undefined, 2)
    const updated = saveCandleBiasNotes(original, 300, '5m', '  震荡  ', [
      { bias: 'short', reasons: ['  跌破  '] }, { bias: 'no-trade', reasons: ['位置一般'] }, { bias: 'long', reasons: ['支撑'] },
    ], 3)
    const restored = parseManualPracticeStore(JSON.stringify({ version: 1, activeSessionId: null, sessions: [updated] })).sessions[0]
    expect(restored.notes.map(note => [note.kind, note.side, note.biasRank, note.reasons])).toEqual([
      ['should-trade', 'short', 0, ['跌破']], ['no-trade', undefined, 1, ['位置一般']], ['should-trade', 'long', 2, ['支撑']],
    ])
    expect(restored.notes.every(note => note.background === '震荡')).toBe(true)
    expect(updated.trades).toEqual(original.trades)
    expect(restored.trades).toMatchObject(original.trades)
    expect(restored.status).toBe('completed')
    expect(restored.cursorTime).toBe(original.cursorTime)
    expect(original.notes[0].reasons).toEqual(['旧理由'])
  })

  it('reorders a candle into one numbered row while keeping other timeframes and trades separate', () => {
    let state = upsertBarNote(paper(), 300, '15m', ['大周期'], '背景', 'no-trade', undefined, 2)
    state = saveCandleBiasNotes(state, 300, '5m', '背景', [{ bias: 'long', reasons: ['支撑'] }, { bias: 'short', reasons: ['阻力'] }, { bias: 'no-trade', reasons: [] }], 3)
    // Even if the backing array arrives in another order, rank governs display.
    state = { ...state, notes: [...state.notes].reverse() }
    const rows = manualReasonRows(state)
    const ranked = rows.find(row => row.item.note?.interval === '5m')!
    expect(ranked.biasItems?.map(item => item.note?.biasRank)).toEqual([0, 1, 2])
    expect(ranked.item.note?.side).toBe('long')
    expect(rows).toHaveLength(3)
    expect(rows.map(row => row.seq)).toEqual([1, 2, 3])
    expect(rows.find(row => row.item.kind === 'entry')?.exit?.kind).toBe('exit')
    expect(manualTimeline(state).filter(item => item.note?.interval === '5m')).toHaveLength(3)
  })

  it('updates one side without erasing the opposite side and retains its saved rank', () => {
    let state = saveCandleBiasNotes(paper(), 300, '5m', '背景', [{ bias: 'short', reasons: ['空'] }, { bias: 'long', reasons: ['多'] }, { bias: 'no-trade', reasons: [] }], 2)
    state = upsertBarNote(state, 300, '5m', ['新多'], '新背景', 'should-trade', 'long', 3)
    expect(state.notes.find(note => note.side === 'short')?.reasons).toEqual(['空'])
    expect(state.notes.find(note => note.side === 'long')).toMatchObject({ reasons: ['新多'], biasRank: 1 })
  })

  it('clears only the selected candle and period when the unified editor is empty', () => {
    let state = upsertBarNote(paper(), 600, '5m', ['别的K线'], '背景', 'no-trade', undefined, 2)
    state = upsertBarNote(state, 300, '15m', ['别的周期'], '背景', 'no-trade', undefined, 2)
    state = saveCandleBiasNotes(state, 300, '5m', '背景', [{ bias: 'short', reasons: [] }], 3)
    expect(state.notes.filter(note => note.interval === '5m' && note.barTime === 300)).toHaveLength(3)
    const cleared = saveCandleBiasNotes(state, 300, '5m', '  ', [], 4)
    expect(cleared.notes).toHaveLength(2)
    expect(cleared.trades).toEqual(state.trades)
  })

  it('keeps the ordering of legacy alternatives without ranks', () => {
    const state = paper()
    state.notes = [
      { barTime: 300, interval: '5m', kind: 'should-trade', side: 'short', background: '', reasons: ['空'], updatedAt: 1 },
      { barTime: 300, interval: '5m', kind: 'no-trade', background: '', reasons: ['不做'], updatedAt: 1 },
    ]
    const restored = parseManualPracticeStore(JSON.stringify({ version: 1, activeSessionId: null, sessions: [state] })).sessions[0]
    expect(manualReasonRows(restored)[0].biasItems?.map(item => item.reasons[0])).toEqual(['空', '不做'])
  })
})
