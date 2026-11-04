import { describe, expect, it } from 'vitest'
import {
  advanceShapePractice, createInitialShapePracticeProgress, createInitialShapePracticeStore, getShapePracticeVisibleSlice,
  loadShapePracticeStore, queueShapePracticeOrder, requestShapePracticeManualClose, saveShapePracticeStore,
} from './shapePractice'
import type { ShapePracticeBar, ShapePracticeDataset, ShapePracticeQuestion } from './shapePractice'

function bar(time: number, open: number, high: number, low: number, close: number): ShapePracticeBar {
  return { time, open, high, low, close, volume: 1 }
}

function question(bars: ShapePracticeBar[], startIndex = 0): ShapePracticeQuestion {
  return { id: 'M01', startIndex, bars, ema20: bars.map((item) => item.close), signalTime: bars[startIndex].time }
}

function dataset(item: ShapePracticeQuestion): ShapePracticeDataset {
  return { version: 1, id: 'test-dataset', symbol: 'OANDA:XAUUSD', timeframeMinutes: 5, sourceSha256: 'test', questions: [item] }
}

function memoryStorage(initial?: string): Storage {
  let value = initial ?? null
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next },
    removeItem: () => { value = null },
    clear: () => { value = null },
    key: () => null,
    get length() { return value === null ? 0 : 1 },
  }
}

describe('shape practice causal viewport and order lifecycle', () => {
  it('slices only candles at or before the cursor, including the EMA window', () => {
    const bars = Array.from({ length: 8 }, (_, index) => bar(index, 100 + index, 101 + index, 99 + index, 100.5 + index))
    const visible = getShapePracticeVisibleSlice(question(bars, 2), 4, 3)
    expect(visible.startIndex).toBe(2)
    expect(visible.endIndex).toBe(4)
    expect(visible.bars.map((item) => item.time)).toEqual([2, 3, 4])
    expect(visible.ema20).toEqual([102.5, 103.5, 104.5])
    expect(visible.bars.some((item) => item.time > 4)).toBe(false)
  })

  it('executes an entry at the next candle open and sizes fixed $100 stop risk', () => {
    const item = question([bar(0, 99, 101, 98, 100), bar(1, 103, 104, 102, 103), bar(2, 104, 105, 103, 104)])
    const queued = queueShapePracticeOrder(item, createInitialShapePracticeProgress(item), 'long', 98)
    expect(queued.ok).toBe(true)
    const advanced = advanceShapePractice(item, queued.state)
    expect(advanced.ok).toBe(true)
    expect(advanced.state.cursor).toBe(1)
    expect(advanced.state.position?.entryPrice).toBe(103)
    expect(advanced.state.position?.quantity).toBeCloseTo(100 / 5)
  })

  it('settles a same-candle stop and target conservatively at the stop first', () => {
    const item = question([bar(0, 99, 101, 98, 100), bar(1, 100, 110, 90, 105)])
    const queued = queueShapePracticeOrder(item, createInitialShapePracticeProgress(item), 'long', 95, 105)
    const result = advanceShapePractice(item, queued.state)
    expect(result.state.result?.exitReason).toBe('stop-loss')
    expect(result.state.result?.exitPrice).toBe(95)
    expect(result.state.result?.rMultiple).toBeCloseTo(-1)
    expect(result.state.status).toBe('completed')
  })

  it('uses a worse opening gap for a live stop and does not fill at the stop level', () => {
    const item = question([
      bar(0, 99, 101, 98, 100),
      bar(1, 100, 101, 99, 100),
      bar(2, 90, 95, 88, 92),
    ])
    const first = queueShapePracticeOrder(item, createInitialShapePracticeProgress(item), 'long', 95)
    const opened = advanceShapePractice(item, first.state)
    const closed = advanceShapePractice(item, opened.state)
    expect(closed.state.result?.exitReason).toBe('stop-loss')
    expect(closed.state.result?.exitPrice).toBe(90)
    expect(closed.state.result?.pnlUsd).toBeCloseTo(-200)
  })

  it('executes a queued manual close at next open before later candle extremes', () => {
    const item = question([
      bar(0, 99, 101, 98, 100),
      bar(1, 100, 101, 99, 100),
      bar(2, 101, 120, 80, 105),
    ])
    const first = queueShapePracticeOrder(item, createInitialShapePracticeProgress(item), 'long', 95, 110)
    const opened = advanceShapePractice(item, first.state)
    const requested = requestShapePracticeManualClose(item, opened.state)
    const closed = advanceShapePractice(item, requested.state)
    expect(closed.state.result?.exitReason).toBe('manual-close')
    expect(closed.state.result?.exitPrice).toBe(101)
  })

  it('restores cursor, pending order, result and selected question from the dedicated key', () => {
    const item = question([bar(0, 99, 101, 98, 100), bar(1, 101, 102, 100, 101)])
    const current = createInitialShapePracticeStore(dataset(item))
    const queued = queueShapePracticeOrder(item, current.questions[item.id], 'long', 95)
    const savedState = { ...current, questions: { ...current.questions, [item.id]: queued.state }, selectedQuestionId: item.id }
    const storage = memoryStorage()
    expect(saveShapePracticeStore(savedState, storage).ok).toBe(true)
    const restored = loadShapePracticeStore(dataset(item), storage)
    expect(restored.canPersist).toBe(true)
    expect(restored.state.selectedQuestionId).toBe(item.id)
    expect(restored.state.questions[item.id].cursor).toBe(0)
    expect(restored.state.questions[item.id].pendingOrder?.stopLoss).toBe(95)
  })

  it('does not overwrite an incompatible saved key while persistence is paused', () => {
    const original = JSON.stringify({ version: 1, datasetId: 'old-dataset', selectedQuestionId: 'M01', questions: {} })
    const storage = memoryStorage(original)
    const item = question([bar(0, 99, 101, 98, 100), bar(1, 101, 102, 100, 101)])
    const restored = loadShapePracticeStore(dataset(item), storage)
    expect(restored.canPersist).toBe(false)
    expect(storage.getItem('kline-shape-practice-v1')).toBe(original)
  })
})
