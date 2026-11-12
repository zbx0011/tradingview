import { describe, expect, it } from 'vitest'
import { contextStartTime, createManualTopicSession, parseManualPracticeStore, type ManualPracticeSession } from './manualPractice'
import { buildTopicQueue, doneTopicIds, parseTopicProgress, summarizeTopic, topicSessionLabel, validateTopicCases, type TopicCase } from './topicPractice'

const BREAK = 1_715_067_000 // 2024-05-07 15:30 Beijing
const item: TopicCase = { id: 'counter-1', kind: 'counter', dir: 'down', follow: 1, breakTime: BREAK, rangeHigh: 120, rangeLow: 110, result: 'fail', maxExcursion: 0.5 }

function finished(caseId: string, kind: 'counter' | 'with', points: number[], updatedAt = 1): ManualPracticeSession {
  const session = createManualTopicSession({ caseId, kind }, BREAK, 'x', 0)
  return {
    ...session, status: 'completed', updatedAt,
    trades: points.map((value, index) => ({
      id: `${caseId}-${index}`, side: 'long', entryTime: BREAK, entryPrice: 100, stopLoss: null, takeProfit: null,
      exitTime: BREAK + 300, exitPrice: 100 + value, exitKind: 'manual', background: '', reasons: [], exitReasons: [],
    })),
  }
}

describe('topic practice', () => {
  it('starts a paper with the breakout candle revealed and one trading day after it', () => {
    const session = createManualTopicSession({ caseId: item.id, kind: item.kind }, BREAK, topicSessionLabel(item), 5)
    expect(session.startTime).toBe(BREAK)
    expect(session.cursorTime).toBe(BREAK + 300)
    expect(session.endTime).toBe(BREAK + 300 + 288 * 300)
    expect(session.dayKey).toBe('topic:counter-1')
    expect(session.dayLabel).toBe('逆势突破 · 2024-05-07 15:30')
    // The topic link survives the storage round trip.
    const store = parseManualPracticeStore(JSON.stringify({ version: 1, activeSessionId: session.id, sessions: [session] }))
    expect(store.sessions[0].topic).toEqual({ caseId: 'counter-1', kind: 'counter' })
    expect(store.activeSessionId).toBe(session.id)
  })

  it('shows five full trading sessions before the session of the breakout', () => {
    const days = Array.from({ length: 8 }, (_, i) => ({ key: `d${i}`, label: `d${i}`, startTime: BREAK - (7 - i) * 86_400 - 3600, endTime: BREAK - (6 - i) * 86_400 - 7200, minutes: 1380 }))
    const session = createManualTopicSession({ caseId: item.id, kind: item.kind }, BREAK, 'x', 0)
    expect(contextStartTime(days, session)).toBe(days[2].startTime)
  })

  it('queues only the selected kinds, questions not done yet first', () => {
    const cases: TopicCase[] = [{ ...item, id: 'a' }, { ...item, id: 'b', kind: 'with' }, { ...item, id: 'c' }, { ...item, id: 'd' }]
    const done = doneTopicIds([finished('a', 'counter', [])])
    const queue = buildTopicQueue(cases, ['counter'], done, () => 0)
    expect(queue).toHaveLength(3)
    expect(queue[2]).toBe('a')
    expect(queue.includes('b')).toBe(false)
    expect(buildTopicQueue(cases, ['counter', 'with'], done, () => 0)).toHaveLength(4)
  })

  it('counts an unfinished paper as not done and sums the latest finished paper per question', () => {
    const active = createManualTopicSession({ caseId: 'b', kind: 'with' }, BREAK, 'x', 0)
    const sessions = [finished('a', 'counter', [2, -1], 1), finished('a', 'counter', [5], 2), active]
    expect([...doneTopicIds(sessions)]).toEqual(['a'])
    const summary = summarizeTopic([{ ...item, id: 'a' }, { ...item, id: 'b', kind: 'with' }], sessions)
    expect(summary.counter).toEqual({ total: 1, done: 1, trades: 1, wins: 1, points: 5 })
    expect(summary.with).toEqual({ total: 1, done: 0, trades: 0, wins: 0, points: 0 })
  })

  it('validates the bank and the stored order', () => {
    expect(validateTopicCases({ version: 1, cases: [item, { id: 3 }] })).toHaveLength(1)
    expect(validateTopicCases({ version: 2, cases: [] })).toBe(null)
    expect(parseTopicProgress(JSON.stringify({ kinds: ['with', 'x'], queue: ['a', 1] }))).toEqual({ kinds: ['with'], queue: ['a'], excluded: [] })
    expect(parseTopicProgress(JSON.stringify({ kinds: [], queue: [], excluded: ['b', null] })).excluded).toEqual(['b'])
    expect(parseTopicProgress('oops').kinds).toEqual(['counter', 'with'])
  })
})
