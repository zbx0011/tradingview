import { describe, expect, it } from 'vitest'
import type { Drawing } from './drawings'
import {
  manualLossQueue, manualLossStats, manualLossTrades, mergeManualPracticeStores, parseManualPracticeStore, setManualLossMark, syncManualSessionDrawings, tradePoints,
  type ManualPracticeSession, type ManualPracticeStore, type ManualTrade,
} from './manualPractice'

const trade = (id: string, entryTime: number, entryPrice: number, exitPrice: number | null, side: ManualTrade['side'] = 'long'): ManualTrade => ({
  id, side, entryTime, entryPrice, stopLoss: null, takeProfit: null, exitTime: exitPrice === null ? null : entryTime + 300, exitPrice,
  exitKind: exitPrice === null ? null : 'manual', background: '', reasons: ['理由'], exitReasons: [],
})

const paper = (id: string, trades: ManualTrade[], status: ManualPracticeSession['status'] = 'completed'): ManualPracticeSession => ({
  id, symbol: 'NQ1!', dayKey: `day-${id}`, dayLabel: `day-${id}`, startTime: 0, endTime: 100_000, cursorTime: 100_000, status,
  createdAt: 1, updatedAt: 2, completedAt: status === 'completed' ? 2 : null, trades, notes: [],
})

describe('losing trade review', () => {
  const sessions = [
    paper('b', [trade('b1', 2000, 100, 90), trade('b2', 2600, 100, 110)]),
    paper('a', [trade('a1', 1000, 100, 95, 'short'), trade('a2', 1500, 100, 98, 'long'), trade('open', 1800, 100, null)], 'active'),
  ]

  it('lists closed losing trades of every paper, oldest first, and ignores winners and open positions', () => {
    const losses = manualLossTrades(sessions)
    // a1 is a short that exits lower (a win) and "open" has no exit yet; b2 is a winning long.
    expect(losses.map((entry) => entry.tradeId)).toEqual(['a2', 'b1'])
    expect(losses.every((entry) => (tradePoints(entry.trade) ?? 0) < 0)).toBe(true)
    expect(losses[0].points).toBe(-2)
    expect(losses[1].usd).toBe(-200)
  })

  it('marks understanding and favourites per trade without touching the decision records', () => {
    const original = sessions[0]
    const before = JSON.stringify(original)
    const marked = setManualLossMark(original, 'b1', { understanding: 'confused' }, 50)
    const favourite = setManualLossMark(marked, 'b1', { favorite: true }, 60)
    expect(favourite.lossMarks?.b1).toEqual({ understanding: 'confused', favorite: true, updatedAt: 60 })
    expect(favourite.trades).toBe(original.trades)
    expect(favourite.updatedAt).toBe(original.updatedAt)
    expect(JSON.stringify(original)).toBe(before)
  })

  it('filters the queue by status and counts each state', () => {
    const marked = [setManualLossMark(sessions[0], 'b1', { understanding: 'confused', favorite: true }, 10), sessions[1]]
    expect(manualLossQueue(marked, 'all').map((ref) => ref.tradeId)).toEqual(['a2', 'b1'])
    expect(manualLossQueue(marked, 'unseen').map((ref) => ref.tradeId)).toEqual(['a2'])
    expect(manualLossQueue(marked, 'confused').map((ref) => ref.tradeId)).toEqual(['b1'])
    expect(manualLossQueue(marked, 'favorite').map((ref) => ref.tradeId)).toEqual(['b1'])
    expect(manualLossStats(marked)).toMatchObject({ total: 2, confused: 1, understood: 0, favorite: 1, unseen: 1, totalPoints: -12 })
  })

  it('round-trips marks in the v1 format and keeps old papers unchanged', () => {
    const store = (list: ManualPracticeSession[]): ManualPracticeStore => ({ version: 1, activeSessionId: null, sessions: list })
    const parse = (value: ManualPracticeStore) => parseManualPracticeStore(JSON.stringify(value))
    expect(parse(store([sessions[0]])).sessions[0].lossMarks).toBeUndefined()
    const marked = setManualLossMark(sessions[0], 'b1', { understanding: 'understood' }, 10)
    const restored = parse(store([marked])).sessions[0]
    expect(restored.lossMarks).toEqual({ b1: { understanding: 'understood', favorite: false, updatedAt: 10 } })
    // Malformed entries are dropped rather than corrupting the paper.
    const broken = { ...marked, lossMarks: { b1: { understanding: 'maybe', favorite: 'yes', updatedAt: 5 }, bad: 'x', worse: { updatedAt: 'now' } } }
    expect(parse(store([broken as unknown as ManualPracticeSession])).sessions[0].lossMarks).toEqual({ b1: { understanding: null, favorite: false, updatedAt: 5 } })
  })

  it('merges two computers\' marks by the latest change, in either direction', () => {
    const left = setManualLossMark(sessions[0], 'b1', { understanding: 'confused' }, 10)
    const right = setManualLossMark(setManualLossMark(sessions[0], 'b1', { understanding: 'understood' }, 20), 'b2', { favorite: true }, 15)
    const store = (session: ManualPracticeSession): ManualPracticeStore => ({ version: 1, activeSessionId: null, sessions: [session] })
    const a = mergeManualPracticeStores(store(left), store(right)).sessions[0].lossMarks
    const b = mergeManualPracticeStores(store(right), store(left)).sessions[0].lossMarks
    expect(a).toEqual(b)
    expect(a?.b1.understanding).toBe('understood')
    expect(a?.b2.favorite).toBe(true)
  })
})

describe('practice-time drawings', () => {
  const line = (id: string, y = 1): Drawing => ({ id, tool: 'trend-line', behavior: 'line', label: 'line', points: [{ x: 0, y, time: 10, price: 100 }, { x: 1, y, time: 20, price: 101 }], color: '#fff', width: 1 } as Drawing)
  const base = paper('p', [], 'active')

  it('adopts only lines drawn after practice began, and ignores those that were already on the chart', () => {
    const before = new Set(['old'])
    const session = syncManualSessionDrawings(base, [line('old'), line('mine')], before, 5)
    expect(session.drawings?.map((drawing) => drawing.id)).toEqual(['mine'])
    expect(session.updatedAt).toBe(5)
  })

  it('follows edits and deletions made during practice, but keeps lines this chart never had', () => {
    const first = syncManualSessionDrawings(base, [line('a'), line('b')], new Set(), 5)
    const edited = syncManualSessionDrawings(first, [line('a', 9)], new Set(['a', 'b']), 6)
    expect(edited.drawings?.map((drawing) => drawing.id)).toEqual(['a'])
    expect(edited.drawings?.[0].points[0].y).toBe(9)
    const other = syncManualSessionDrawings(first, [], new Set(), 7)
    expect(other.drawings?.map((drawing) => drawing.id)).toEqual(['a', 'b'])
  })

  it('does not rewrite the paper when nothing changed', () => {
    const first = syncManualSessionDrawings(base, [line('a')], new Set(), 5)
    expect(syncManualSessionDrawings(first, [line('a')], new Set(['a']), 6)).toBe(first)
    expect(syncManualSessionDrawings(base, [], new Set(), 6)).toBe(base)
  })

  it('round-trips and merges between computers', () => {
    const withLines = syncManualSessionDrawings(base, [line('a')], new Set(), 5)
    const store = (session: ManualPracticeSession): ManualPracticeStore => ({ version: 1, activeSessionId: null, sessions: [session] })
    expect(parseManualPracticeStore(JSON.stringify(store(withLines))).sessions[0].drawings?.map((drawing) => drawing.id)).toEqual(['a'])
    const broken = { ...withLines, drawings: [{ id: 'x' }, 'nope', line('ok')] }
    expect(parseManualPracticeStore(JSON.stringify(store(broken as unknown as ManualPracticeSession))).sessions[0].drawings?.map((drawing) => drawing.id)).toEqual(['ok'])
    // A newer copy without recorded lines borrows them from the older copy.
    const newerBare = { ...base, updatedAt: 50 }
    expect(mergeManualPracticeStores(store(withLines), store(newerBare)).sessions[0].drawings?.map((drawing) => drawing.id)).toEqual(['a'])
    expect(mergeManualPracticeStores(store(newerBare), store(withLines)).sessions[0].drawings?.map((drawing) => drawing.id)).toEqual(['a'])
  })
})
