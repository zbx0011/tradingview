import { describe, expect, it } from 'vitest'
import {
  manualReviewCommentKey, manualTimeline, mergeManualPracticeStores, parseManualPracticeStore,
  recordManualReview, saveManualReviewComment, sessionSummary,
  type ManualPracticeSession, type ManualPracticeStore,
} from './manualPractice'

const paper = (status: ManualPracticeSession['status'] = 'completed'): ManualPracticeSession => ({
  id: 'paper', symbol: 'NQ1!', dayKey: 'day', dayLabel: 'day', startTime: 0, endTime: 1200,
  cursorTime: 1200, status, createdAt: 1, updatedAt: 2, completedAt: status === 'completed' ? 2 : null,
  trades: [{
    id: 'trade', side: 'long', entryTime: 600, entryPrice: 100, stopLoss: 95, takeProfit: 110,
    exitTime: 900, exitPrice: 102, exitKind: 'manual', quantity: 2,
    background: '原始背景', reasons: ['原始开仓理由'], unsupportedReasons: '原始不支持理由', exitReasons: ['原始平仓理由'],
  }],
  notes: [
    { barTime: 300, interval: '5m', kind: 'no-trade', background: '背景', reasons: ['不做'], updatedAt: 1 },
    { barTime: 300, interval: '5m', kind: 'should-trade', side: 'long', background: '背景', reasons: ['多'], updatedAt: 1 },
    { barTime: 300, interval: '5m', kind: 'should-trade', side: 'short', background: '背景', reasons: ['空'], updatedAt: 1 },
  ],
})

const store = (session: ManualPracticeSession): ManualPracticeStore => ({
  version: 1, activeSessionId: session.status === 'active' ? session.id : null, sessions: [session],
})
const roundTrip = (session: ManualPracticeSession) => parseManualPracticeStore(JSON.stringify(store(session))).sessions[0]

describe('independent manual review comments', () => {
  it('round-trips multiline comments in the existing v1 format and remains compatible with old papers', () => {
    const original = paper()
    expect(roundTrip(original).reviewComments).toBeUndefined()
    const item = manualTimeline(original).find(item => item.kind === 'entry')!
    const updated = saveManualReviewComment(original, item, '  确认不足\n  下次等待回踩  ', 100)
    const restored = roundTrip(updated)
    expect(restored.reviewComments?.[manualReviewCommentKey(item)]).toEqual({ text: '确认不足\n  下次等待回踩', updatedAt: 100, createdAt: 100 })
    expect(roundTrip(restored)).toEqual(restored)
    expect(parseManualPracticeStore(JSON.stringify(store(updated))).version).toBe(1)
  })

  it.each(['active', 'completed'] as const)('keeps %s decision records, progress and PnL unchanged', (status) => {
    const original = paper(status)
    const before = JSON.stringify(original)
    const originalSummary = sessionSummary(original)
    const item = manualTimeline(original).find(item => item.kind === 'entry')!
    const saved = saveManualReviewComment(original, item, '复盘意见', 100)
    const { reviewComments, reviewStartedAt, lastReviewedAt, ...unchanged } = saved
    expect(unchanged).toEqual(original)
    expect(reviewComments).toBeDefined()
    expect(reviewStartedAt).toBe(100)
    expect(lastReviewedAt).toBe(100)
    expect(saved.trades).toBe(original.trades)
    expect(saved.notes).toBe(original.notes)
    expect(saved.updatedAt).toBe(original.updatedAt)
    expect(saved.cursorTime).toBe(original.cursorTime)
    expect(saved.status).toBe(original.status)
    expect(saved.completedAt).toBe(original.completedAt)
    expect(sessionSummary(saved)).toEqual(originalSummary)
    expect(JSON.stringify(original)).toBe(before)
  })

  it('separates entry from exit, even for the same trade and timestamp', () => {
    const original = paper()
    original.trades[0].exitTime = original.trades[0].entryTime
    const items = manualTimeline(original)
    const entry = items.find(item => item.kind === 'entry')!
    const exit = items.find(item => item.kind === 'exit')!
    const updated = saveManualReviewComment(saveManualReviewComment(original, entry, '开仓复盘', 3), exit, '平仓复盘', 4)
    expect(manualReviewCommentKey(entry)).not.toBe(manualReviewCommentKey(exit))
    expect(updated.reviewComments?.[manualReviewCommentKey(entry)]?.text).toBe('开仓复盘')
    expect(updated.reviewComments?.[manualReviewCommentKey(exit)]?.text).toBe('平仓复盘')
    const movedEntry = { ...entry, time: 12345, trade: { ...entry.trade!, entryTime: 12345 } }
    expect(manualReviewCommentKey(movedEntry)).toBe(manualReviewCommentKey(entry))
  })

  it('isolates note directions, kinds, candles and timeframes without depending on ranks or indexes', () => {
    const original = paper()
    const items = manualTimeline(original).filter(item => item.note)
    const additional = [
      { ...items[0], note: { ...items[0].note!, interval: '15m' as const } },
      { ...items[0], note: { ...items[0].note!, barTime: 600 } },
    ]
    expect(new Set([...items, ...additional].map(manualReviewCommentKey)).size).toBe(5)
    const saved = items.reduce((session, item, index) => saveManualReviewComment(session, item, `意见${index}`, index + 3), original)
    const reordered = { ...saved, notes: [...saved.notes].reverse().map((note, index) => ({ ...note, biasRank: index })) }
    for (const item of manualTimeline(reordered).filter(item => item.note)) {
      const index = items.findIndex(source => manualReviewCommentKey(source) === manualReviewCommentKey(item))
      expect(saved.reviewComments?.[manualReviewCommentKey(item)]?.text).toBe(`意见${index}`)
    }
    const legacyLong = { ...items[1], note: { ...items[1].note!, side: undefined } }
    expect(manualReviewCommentKey(legacyLong)).toBe(manualReviewCommentKey(items[1]))
  })

  it('validates imported comments and retains valid empty deletion tombstones', () => {
    const original = paper()
    const malformed = {
      ...original,
      reviewComments: {
        valid: { text: '正常', updatedAt: 5 }, clear: { text: '', updatedAt: 6 },
        missingTime: { text: '缺少时间' }, badTime: { text: '错误时间', updatedAt: '7' },
        badText: { text: 123, updatedAt: 8 }, invalid: null, array: [], infinite: { text: '错误', updatedAt: null },
      },
    }
    const parsed = parseManualPracticeStore(JSON.stringify({ ...store(original), sessions: [malformed] })).sessions[0]
    expect(parsed.reviewComments).toEqual({ valid: { text: '正常', updatedAt: 5 }, clear: { text: '', updatedAt: 6 } })
    for (const reviewComments of [null, [], 'invalid']) {
      const restored = parseManualPracticeStore(JSON.stringify({ ...store(original), sessions: [{ ...original, reviewComments }] })).sessions[0]
      expect(restored.reviewComments).toEqual({})
      expect(restored.trades).toEqual(roundTrip(original).trades)
    }
  })

  it('merges each comment independently of the winning original session snapshot', () => {
    const original = paper('active')
    const entry = manualTimeline(original).find(item => item.kind === 'entry')!
    const exit = manualTimeline(original).find(item => item.kind === 'exit')!
    const oldCopy = saveManualReviewComment(original, entry, '来自较旧交易快照的新复盘', 200)
    const newerProgress = { ...original, status: 'completed' as const, updatedAt: 100, completedAt: 100, cursorTime: 1300 }
    const current = saveManualReviewComment(saveManualReviewComment(newerProgress, exit, '另一条复盘', 120), entry, '旧复盘', 110)
    for (const merged of [mergeManualPracticeStores(store(current), store(oldCopy)), mergeManualPracticeStores(store(oldCopy), store(current))]) {
      const result = merged.sessions[0]
      expect(result.status).toBe('completed')
      expect(result.cursorTime).toBe(1300)
      expect(result.completedAt).toBe(100)
      expect(result.updatedAt).toBe(100)
      expect(result.trades).toBe(current.trades)
      expect(result.notes).toBe(current.notes)
      expect(result.reviewComments?.[manualReviewCommentKey(entry)]).toEqual({ text: '来自较旧交易快照的新复盘', updatedAt: 200, createdAt: 110 })
      expect(result.reviewComments?.[manualReviewCommentKey(exit)]).toEqual({ text: '另一条复盘', updatedAt: 120, createdAt: 120 })
      expect(result.reviewStartedAt).toBe(120)
      expect(result.lastReviewedAt).toBe(200)
    }
  })

  it('persists clears as newer tombstones so old computers cannot resurrect text', () => {
    const original = paper()
    const item = manualTimeline(original)[0]
    const saved = saveManualReviewComment(original, item, '过期意见', 100)
    const cleared = roundTrip(saveManualReviewComment(saved, item, ' \n  ', 200))
    const key = manualReviewCommentKey(item)
    expect(cleared.reviewComments?.[key]).toEqual({ text: '', updatedAt: 200 })
    for (const merged of [mergeManualPracticeStores(store(saved), store(cleared)), mergeManualPracticeStores(store(cleared), store(saved))]) {
      expect(merged.sessions[0].reviewComments?.[key]).toEqual({ text: '', updatedAt: 200 })
    }
  })

  it('resolves equal-timestamp conflicts deterministically, preferring deletion on ties', () => {
    const original = paper()
    const item = manualTimeline(original)[0]
    const key = manualReviewCommentKey(item)
    const left = saveManualReviewComment(original, item, 'a', 100)
    const right = saveManualReviewComment(original, item, 'z', 100)
    const merge = (a: ManualPracticeSession, b: ManualPracticeSession) => mergeManualPracticeStores(store(a), store(b)).sessions[0].reviewComments
    expect(merge(left, right)).toEqual(merge(right, left))
    expect(merge(left, right)?.[key].text).toBe('z')
    const cleared = saveManualReviewComment(original, item, '', 100)
    expect(merge(left, cleared)).toEqual(merge(cleared, left))
    expect(merge(left, cleared)?.[key].text).toBe('')
    expect(mergeManualPracticeStores(store(original), store(original)).sessions[0].reviewComments).toBeUndefined()
  })

  it('preserves comment creation when edited and gives a deleted comment a new creation time when rewritten', () => {
    const original = paper()
    const item = manualTimeline(original)[0]
    const key = manualReviewCommentKey(item)
    const created = saveManualReviewComment(original, item, '首次评论', 100)
    const edited = saveManualReviewComment(created, item, '修改评论', 200)
    expect(roundTrip(edited).reviewComments?.[key]).toEqual({ text: '修改评论', createdAt: 100, updatedAt: 200 })
    expect(edited).toMatchObject({ reviewStartedAt: 100, lastReviewedAt: 200, updatedAt: original.updatedAt })
    const deleted = saveManualReviewComment(edited, item, '', 300)
    expect(roundTrip(deleted).reviewComments?.[key]).toEqual({ text: '', updatedAt: 300 })
    const recreated = saveManualReviewComment(roundTrip(deleted), item, '重写评论', 400)
    expect(recreated.reviewComments?.[key]).toEqual({ text: '重写评论', createdAt: 400, updatedAt: 400 })
    for (const merged of [mergeManualPracticeStores(store(deleted), store(recreated)), mergeManualPracticeStores(store(recreated), store(deleted))]) {
      expect(merged.sessions[0].reviewComments?.[key]).toEqual(recreated.reviewComments?.[key])
    }
  })

  it('does not invent creation or review timestamps for legacy records', () => {
    const original = paper()
    const item = manualTimeline(original)[0]
    const key = manualReviewCommentKey(item)
    const legacy = { ...original, reviewComments: { [key]: { text: '旧版评论', updatedAt: 50 } } }
    const restored = roundTrip(legacy)
    expect(restored.reviewStartedAt).toBeUndefined()
    expect(restored.lastReviewedAt).toBeUndefined()
    expect(restored.reviewComments?.[key].createdAt).toBeUndefined()
    const edited = saveManualReviewComment(restored, item, '旧版评论已编辑', 200)
    expect(edited.reviewComments?.[key]).toEqual({ text: '旧版评论已编辑', updatedAt: 200 })
    expect(edited).toMatchObject({ reviewStartedAt: 200, lastReviewedAt: 200 })
  })

  it('records first and latest review visits without changing practice progress or ranking', () => {
    const original = paper('active')
    const first = recordManualReview(original, 100)
    const second = recordManualReview(first, 300)
    const skewedClock = recordManualReview(second, 200)
    expect(skewedClock).toBe(second)
    expect(second).toMatchObject({ reviewStartedAt: 100, lastReviewedAt: 300 })
    const { reviewStartedAt, lastReviewedAt, ...rest } = second
    expect([reviewStartedAt, lastReviewedAt]).toEqual([100, 300])
    expect(rest).toEqual(original)
    expect(second.trades).toBe(original.trades)
    expect(second.notes).toBe(original.notes)
    expect(roundTrip(second)).toMatchObject({ reviewStartedAt: 100, lastReviewedAt: 300 })
    expect(recordManualReview(original, NaN)).toBe(original)
  })

  it('parses only valid optional wall-clock timestamps and leaves missing legacy values absent', () => {
    const original = paper()
    const imported = {
      ...original, reviewStartedAt: 100, lastReviewedAt: 300,
      reviewComments: {
        valid: { text: '有时间', createdAt: 100, updatedAt: 200 },
        future: { text: '不可信创建时间', createdAt: 300, updatedAt: 200 },
        negative: { text: '错误时间', createdAt: -1, updatedAt: 200 },
        text: { text: '字符串时间', createdAt: '100', updatedAt: 200 },
      },
    }
    const restored = roundTrip(imported as unknown as ManualPracticeSession)
    expect(restored).toMatchObject({ reviewStartedAt: 100, lastReviewedAt: 300 })
    expect(restored.reviewComments?.valid.createdAt).toBe(100)
    for (const key of ['future', 'negative', 'text']) expect(restored.reviewComments?.[key].createdAt).toBeUndefined()
    for (const invalid of [-1, 0, 8.64e15 + 1, null, '100']) {
      const parsed = roundTrip({ ...original, reviewStartedAt: invalid, lastReviewedAt: invalid } as unknown as ManualPracticeSession)
      expect(parsed.reviewStartedAt).toBeUndefined()
      expect(parsed.lastReviewedAt).toBeUndefined()
    }
  })

  it('merges review visits independently and retains trustworthy creation evidence through old-client edits', () => {
    const original = paper('active')
    const item = manualTimeline(original)[0]
    const key = manualReviewCommentKey(item)
    const earlier = saveManualReviewComment(recordManualReview(original, 80), item, '首次评论', 100)
    const progress = { ...original, updatedAt: 500, cursorTime: 1500, reviewComments: { [key]: { text: '旧客户端较新编辑', updatedAt: 300 } } }
    const later = recordManualReview(progress, 400)
    for (const merged of [mergeManualPracticeStores(store(earlier), store(later)), mergeManualPracticeStores(store(later), store(earlier))]) {
      const result = merged.sessions[0]
      expect(result).toMatchObject({ updatedAt: 500, cursorTime: 1500, reviewStartedAt: 80, lastReviewedAt: 400 })
      expect(result.reviewComments?.[key]).toEqual({ text: '旧客户端较新编辑', updatedAt: 300, createdAt: 100 })
      expect(result.trades).toBe(progress.trades)
      expect(result.notes).toBe(progress.notes)
    }
    const legacyMerge = mergeManualPracticeStores(store(original), store({ ...original, updatedAt: 600 })).sessions[0]
    expect(legacyMerge.reviewStartedAt).toBeUndefined()
    expect(legacyMerge.lastReviewedAt).toBeUndefined()
  })
})
