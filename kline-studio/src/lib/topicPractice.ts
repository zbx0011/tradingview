import type { ManualPracticeSession, ManualTopicRef } from './manualPractice'
import { sessionSummary } from './manualPractice'

/**
 * 专题练习: NQ 5m range breakouts at the end of a big trend. Each case is one 自主复盘 paper that
 * starts on the breakout candle; this module holds the question bank and the question order.
 */
export const TOPIC_PROGRESS_STORAGE_KEY = 'kline-studio-topic-practice-v2'
export const TOPIC_DATA_PATH = 'data/topic-practice/nq-range-breakouts.json'

export type TopicKind = ManualTopicRef['kind']
export const TOPIC_KINDS: readonly TopicKind[] = ['counter', 'with']
export const TOPIC_KIND_LABEL: Record<TopicKind, string> = { counter: '逆势突破', with: '顺势突破' }

export interface TopicCase {
  id: string
  kind: TopicKind
  /** Direction of the breakout. */
  dir: 'up' | 'down'
  /** The follow-through came on the 1st, 2nd or 3rd candle after the breakout candle. */
  follow: number
  /** Open time (UTC seconds) of the 5m breakout candle. */
  breakTime: number
  rangeHigh: number
  rangeLow: number
  /** Statistic outcome: 1x range height reached before closing back at the range middle. */
  result: 'success' | 'fail' | 'open'
  /** Furthest excursion beyond the range edge before the outcome, in range heights. */
  maxExcursion: number
}

/** Which kinds are selected, the questions still waiting in the current round and the questions deleted from the bank (key 5). */
export interface TopicProgress { kinds: TopicKind[]; queue: string[]; excluded: string[] }

const isKind = (value: unknown): value is TopicKind => value === 'counter' || value === 'with'
const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function validateTopicCases(value: unknown): TopicCase[] | null {
  const data = value as { version?: number; cases?: unknown[] } | null
  if (!data || data.version !== 1 || !Array.isArray(data.cases)) return null
  return data.cases.filter((item): item is TopicCase => {
    const row = item as Partial<TopicCase> | null
    return Boolean(row && typeof row.id === 'string' && isKind(row.kind) && (row.dir === 'up' || row.dir === 'down')
      && isNum(row.breakTime) && isNum(row.rangeHigh) && isNum(row.rangeLow))
  })
}

export function parseTopicProgress(raw: string | null): TopicProgress {
  const fallback: TopicProgress = { kinds: [...TOPIC_KINDS], queue: [], excluded: [] }
  if (!raw) return fallback
  try {
    const data = JSON.parse(raw)
    return {
      kinds: Array.isArray(data?.kinds) ? data.kinds.filter(isKind) : fallback.kinds,
      queue: Array.isArray(data?.queue) ? data.queue.filter((id: unknown): id is string => typeof id === 'string') : [],
      excluded: Array.isArray(data?.excluded) ? data.excluded.filter((id: unknown): id is string => typeof id === 'string') : [],
    }
  } catch {
    return fallback
  }
}

export function loadTopicProgress(): TopicProgress {
  try { return parseTopicProgress(localStorage.getItem(TOPIC_PROGRESS_STORAGE_KEY)) } catch { return parseTopicProgress(null) }
}

export function saveTopicProgress(progress: TopicProgress) {
  try { localStorage.setItem(TOPIC_PROGRESS_STORAGE_KEY, JSON.stringify(progress)) } catch { /* storage blocked: the order is only kept for this visit */ }
}

/** Fisher–Yates with an injectable random source (tests). */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const result = items.slice()
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** Case ids that already have a finished paper. */
export function doneTopicIds(sessions: readonly ManualPracticeSession[]): Set<string> {
  return new Set(sessions.filter((session) => session.topic && session.status === 'completed').map((session) => session.topic!.caseId))
}

/** A fresh random order of the selected kinds; cases not done yet come first. */
export function buildTopicQueue(cases: readonly TopicCase[], kinds: readonly TopicKind[], done: ReadonlySet<string>, random: () => number = Math.random): string[] {
  const selected = cases.filter((item) => kinds.includes(item.kind))
  return [
    ...shuffled(selected.filter((item) => !done.has(item.id)).map((item) => item.id), random),
    ...shuffled(selected.filter((item) => done.has(item.id)).map((item) => item.id), random),
  ]
}

export function topicSessionLabel(item: TopicCase) {
  const date = new Date((item.breakTime + 8 * 3600) * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${TOPIC_KIND_LABEL[item.kind]} · ${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

export function topicOutcomeLabel(item: TopicCase) {
  const reach = `最远 ${item.maxExcursion.toFixed(2)} 倍区间`
  if (item.result === 'success') return `成功（走出 1 倍区间，${reach}）`
  if (item.result === 'fail') return `失败（收回区间中线，${reach}）`
  return `一天内未分胜负（${reach}）`
}

export interface TopicKindSummary { total: number; done: number; trades: number; wins: number; points: number }

/** Per kind: questions done and the closed trades of the finished papers. */
export function summarizeTopic(cases: readonly TopicCase[], sessions: readonly ManualPracticeSession[]): Record<TopicKind, TopicKindSummary> {
  const summary: Record<TopicKind, TopicKindSummary> = {
    counter: { total: 0, done: 0, trades: 0, wins: 0, points: 0 },
    with: { total: 0, done: 0, trades: 0, wins: 0, points: 0 },
  }
  for (const item of cases) summary[item.kind].total++
  const latest = new Map<string, ManualPracticeSession>()
  for (const session of sessions) {
    if (!session.topic || session.status !== 'completed') continue
    const previous = latest.get(session.topic.caseId)
    if (!previous || session.updatedAt > previous.updatedAt) latest.set(session.topic.caseId, session)
  }
  for (const session of latest.values()) {
    const row = summary[session.topic!.kind]
    const stats = sessionSummary(session)
    row.done++
    row.trades += stats.closed
    row.wins += stats.wins
    row.points += stats.totalPoints
  }
  return summary
}
