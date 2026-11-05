// 自主逐K复盘（无AI信号）
//
// A self-directed practice mode: pick a random NQ1! trading day, reveal it one
// candle at a time, and record *why* you traded or why you stayed out. Unlike
// decision replay there are no system signals and no AI answers to compare with;
// the point is to be able to review your own reasoning afterwards.
import type { Candle, IntervalId, SymbolId } from './market'
import { INTERVALS } from './market'

export const MANUAL_PRACTICE_STORAGE_KEY = 'kline-studio-manual-practice-v1'
export const MANUAL_PRACTICE_SYMBOL: SymbolId = 'NQ1!'
/** CME E-mini Nasdaq-100: USD per index point for one contract. */
export const NQ_POINT_VALUE_USD = 20
/** Trading sessions shown before the practice day so the chart has context. */
const CONTEXT_SESSIONS = 3
/** CME halts NQ for an hour each day; any gap this long separates two sessions. */
const SESSION_GAP_SECONDS = 30 * 60
/** Ignore holiday / early-close fragments; a full NQ session has ~1380 minutes. */
const MIN_SESSION_MINUTES = 600

export type ManualSide = 'long' | 'short'
export type ManualExitKind = 'manual' | 'stop' | 'target' | 'session-end'
export type ManualNoteKind = 'no-trade' | 'should-trade' | 'entry' | 'exit'

export interface ManualTrade {
  id: string
  side: ManualSide
  /** Time of the minute whose close filled the order. */
  entryTime: number
  entryPrice: number
  stopLoss: number | null
  takeProfit: number | null
  exitTime: number | null
  exitPrice: number | null
  exitKind: ManualExitKind | null
  /** 背景 — market context at entry; mandatory. */
  background: string
  /** 做单理由 — mandatory, at least one. */
  reasons: string[]
  /** 不支持理由 — optional multiline counter-evidence recorded at entry. */
  unsupportedReasons?: string
  /** 平仓理由 — optional. */
  exitReasons: string[]
  /** 手数 (contracts); trades saved before this existed are 1 lot. */
  quantity?: number
}

export type ManualCandleBias = 'no-trade' | 'long' | 'short'

export interface ManualBarNote {
  /** Chart bar the note belongs to (bar open time). */
  barTime: number
  interval: IntervalId
  /** no-trade = 未开单理由; should-trade = 应该开单理由 (looking back at a candle you should have traded). */
  kind: 'no-trade' | 'should-trade'
  /** Direction of the trade that should have been taken (should-trade only). */
  side?: ManualSide
  /** 背景 — market context for this candle; mandatory when a note is saved. */
  background: string
  reasons: string[]
  /** Preference order for this candle: 0 is the strongest inclination. */
  biasRank?: number
  updatedAt: number
}

export type ManualOrderKind = 'stop' | 'limit'

/** A later review of a reason record, stored separately from the original decision. */
export interface ManualReviewComment {
  text: string
  updatedAt: number
}

/** A resting order waiting for price: 追单 (stop, beyond price) or 挂单 (limit, back at price). */
export interface ManualPendingOrder {
  id: string
  side: ManualSide
  orderKind: ManualOrderKind
  entryPrice: number
  stopLoss: number
  takeProfit: number
  quantity: number
  background: string
  reasons: string[]
  unsupportedReasons?: string
  /** Minute the order was placed. */
  createdTime: number
}

export interface ManualPracticeSession {
  id: string
  symbol: SymbolId
  /** Trading day key, e.g. `NQ1!:2025-03-12`. */
  dayKey: string
  /** Trading date label (America/New_York session date). */
  dayLabel: string
  startTime: number
  endTime: number
  /** Minutes strictly before this time are revealed. */
  cursorTime: number
  status: 'active' | 'completed'
  createdAt: number
  updatedAt: number
  completedAt: number | null
  trades: ManualTrade[]
  notes: ManualBarNote[]
  /** Empty text is a deletion tombstone, retained for cross-computer synchronization. */
  reviewComments?: Record<string, ManualReviewComment>
  /** At most one resting order, filled by a later minute that trades through its price. */
  pendingOrder?: ManualPendingOrder | null
}

export interface ManualPracticeStore {
  version: 1
  activeSessionId: string | null
  sessions: ManualPracticeSession[]
}

export interface ManualTradingDay {
  key: string
  label: string
  startTime: number
  /** Exclusive: one minute after the session's last bar. */
  endTime: number
  minutes: number
}

export function emptyManualPracticeStore(): ManualPracticeStore {
  return { version: 1, activeSessionId: null, sessions: [] }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const stringList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function parseTrade(value: unknown): ManualTrade | null {
  const trade = value as Partial<ManualTrade> | null
  if (!trade || typeof trade.id !== 'string' || (trade.side !== 'long' && trade.side !== 'short')) return null
  if (!isFiniteNumber(trade.entryTime) || !isFiniteNumber(trade.entryPrice)) return null
  return {
    id: trade.id,
    side: trade.side,
    entryTime: trade.entryTime,
    entryPrice: trade.entryPrice,
    stopLoss: isFiniteNumber(trade.stopLoss) ? trade.stopLoss : null,
    takeProfit: isFiniteNumber(trade.takeProfit) ? trade.takeProfit : null,
    exitTime: isFiniteNumber(trade.exitTime) ? trade.exitTime : null,
    exitPrice: isFiniteNumber(trade.exitPrice) ? trade.exitPrice : null,
    exitKind: ['manual', 'stop', 'target', 'session-end'].includes(trade.exitKind as string) ? trade.exitKind as ManualExitKind : null,
    background: typeof trade.background === 'string' ? trade.background : '',
    reasons: stringList(trade.reasons),
    unsupportedReasons: typeof trade.unsupportedReasons === 'string' ? trade.unsupportedReasons.trim() : '',
    exitReasons: stringList(trade.exitReasons),
    quantity: isFiniteNumber(trade.quantity) && trade.quantity >= 1 ? Math.floor(trade.quantity) : undefined,
  }
}

function parsePendingOrder(value: unknown): ManualPendingOrder | null {
  const order = value as Partial<ManualPendingOrder> | null
  if (!order || typeof order.id !== 'string' || (order.side !== 'long' && order.side !== 'short')) return null
  if (order.orderKind !== 'stop' && order.orderKind !== 'limit') return null
  if (!isFiniteNumber(order.entryPrice) || !isFiniteNumber(order.stopLoss) || !isFiniteNumber(order.takeProfit) || !isFiniteNumber(order.createdTime)) return null
  return {
    id: order.id,
    side: order.side,
    orderKind: order.orderKind,
    entryPrice: order.entryPrice,
    stopLoss: order.stopLoss,
    takeProfit: order.takeProfit,
    quantity: isFiniteNumber(order.quantity) && order.quantity >= 1 ? Math.floor(order.quantity) : 1,
    background: typeof order.background === 'string' ? order.background : '',
    reasons: stringList(order.reasons),
    unsupportedReasons: typeof order.unsupportedReasons === 'string' ? order.unsupportedReasons.trim() : '',
    createdTime: order.createdTime,
  }
}

function parseNote(value: unknown): ManualBarNote | null {
  const note = value as Partial<ManualBarNote> | null
  if (!note || !isFiniteNumber(note.barTime) || typeof note.interval !== 'string' || !(note.interval in INTERVALS)) return null
  const kind = note.kind === 'should-trade' ? 'should-trade' : 'no-trade'
  const biasRank = Number.isInteger(note.biasRank) && note.biasRank! >= 0 && note.biasRank! <= 2 ? note.biasRank : undefined
  return { barTime: note.barTime, interval: note.interval as IntervalId, kind, ...(kind === 'should-trade' ? { side: note.side === 'short' ? 'short' as const : 'long' as const } : {}), ...(biasRank === undefined ? {} : { biasRank }), background: typeof note.background === 'string' ? note.background : '', reasons: stringList(note.reasons), updatedAt: isFiniteNumber(note.updatedAt) ? note.updatedAt : 0 }
}

function parseSession(value: unknown): ManualPracticeSession | null {
  const session = value as Partial<ManualPracticeSession> | null
  if (!session || typeof session.id !== 'string' || typeof session.dayKey !== 'string') return null
  if (!isFiniteNumber(session.startTime) || !isFiniteNumber(session.endTime) || !isFiniteNumber(session.cursorTime)) return null
  return {
    id: session.id,
    symbol: (session.symbol ?? MANUAL_PRACTICE_SYMBOL) as SymbolId,
    dayKey: session.dayKey,
    dayLabel: typeof session.dayLabel === 'string' ? session.dayLabel : session.dayKey,
    startTime: session.startTime,
    endTime: session.endTime,
    cursorTime: session.cursorTime,
    status: session.status === 'completed' ? 'completed' : 'active',
    createdAt: isFiniteNumber(session.createdAt) ? session.createdAt : 0,
    updatedAt: isFiniteNumber(session.updatedAt) ? session.updatedAt : 0,
    completedAt: isFiniteNumber(session.completedAt) ? session.completedAt : null,
    trades: (Array.isArray(session.trades) ? session.trades : []).map(parseTrade).filter((item): item is ManualTrade => item !== null),
    notes: (Array.isArray(session.notes) ? session.notes : []).map(parseNote).filter((item): item is ManualBarNote => item !== null),
    ...(session.reviewComments === undefined ? {} : { reviewComments: parseReviewComments(session.reviewComments) }),
    pendingOrder: parsePendingOrder(session.pendingOrder),
  }
}

function parseReviewComments(value: unknown): Record<string, ManualReviewComment> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const comment = entry as Partial<ManualReviewComment>
    return typeof comment.text === 'string' && isFiniteNumber(comment.updatedAt)
      ? [[key, { text: comment.text, updatedAt: comment.updatedAt }]]
      : []
  }))
}

function mergeReviewComments(left: Record<string, ManualReviewComment> = {}, right: Record<string, ManualReviewComment> = {}) {
  return Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])].sort().map((key) => {
    const a = Object.hasOwn(left, key) ? left[key] : undefined
    const b = Object.hasOwn(right, key) ? right[key] : undefined
    // Equal-clock conflicts converge in either merge order. A deletion wins a tie.
    const winner = !a ? b! : !b ? a : a.updatedAt !== b.updatedAt
      ? (a.updatedAt > b.updatedAt ? a : b)
      : a.text === '' ? a : b.text === '' ? b : a.text >= b.text ? a : b
    return [key, winner]
  }))
}

export function parseManualPracticeStore(raw: string | null): ManualPracticeStore {
  if (!raw) return emptyManualPracticeStore()
  try {
    const value = JSON.parse(raw) as Partial<ManualPracticeStore>
    const sessions = (Array.isArray(value.sessions) ? value.sessions : []).map(parseSession).filter((item): item is ManualPracticeSession => item !== null)
    const activeSessionId = typeof value.activeSessionId === 'string' && sessions.some((session) => session.id === value.activeSessionId && session.status === 'active')
      ? value.activeSessionId
      : null
    return { version: 1, activeSessionId, sessions }
  } catch {
    return emptyManualPracticeStore()
  }
}

const sessionRank = (session: ManualPracticeSession) => [session.updatedAt, session.status === 'completed' ? 1 : 0, session.cursorTime, session.trades.length + session.notes.length]

function isNewerSession(candidate: ManualPracticeSession, current: ManualPracticeSession) {
  const a = sessionRank(candidate)
  const b = sessionRank(current)
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] > b[index]
  return false
}

/**
 * Merge two computers' self-review papers. Papers are matched by id and the most recently
 * updated copy wins, so a half-finished paper continues from wherever it got furthest.
 * Later review comments merge independently by their own timestamps, without rewriting decisions.
 * The base store keeps its open paper; otherwise the incoming one's open paper is adopted.
 */
export function mergeManualPracticeStores(base: ManualPracticeStore, incoming: ManualPracticeStore): ManualPracticeStore {
  const byId = new Map(base.sessions.map((session) => [session.id, session]))
  for (const session of incoming.sessions) {
    const current = byId.get(session.id)
    if (!current) byId.set(session.id, session)
    else {
      const winner = isNewerSession(session, current) ? session : current
      byId.set(session.id, current.reviewComments === undefined && session.reviewComments === undefined ? winner : {
        ...winner, reviewComments: mergeReviewComments(current.reviewComments, session.reviewComments),
      })
    }
  }
  const sessions = [...byId.values()].sort((left, right) => right.createdAt - left.createdAt)
  const stillActive = (id: string | null) => id !== null && sessions.some((session) => session.id === id && session.status === 'active') ? id : null
  return { version: 1, activeSessionId: stillActive(base.activeSessionId) ?? stillActive(incoming.activeSessionId), sessions }
}

export function loadManualPracticeStore(): ManualPracticeStore {
  try {
    return parseManualPracticeStore(localStorage.getItem(MANUAL_PRACTICE_STORAGE_KEY))
  } catch {
    return emptyManualPracticeStore()
  }
}

export function saveManualPracticeStore(store: ManualPracticeStore) {
  try {
    localStorage.setItem(MANUAL_PRACTICE_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Storage can be full or unavailable; the in-memory session keeps working.
  }
}

const sessionDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const weekdayFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'America/New_York', weekday: 'short' })

/** First index whose time is >= target (minutes are sorted by time). */
export function lowerBound(candles: readonly Candle[], target: number) {
  let low = 0
  let high = candles.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (candles[middle].time < target) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * Split 1-minute NQ history into CME trading sessions. NQ trades almost 24h
 * with a daily one-hour halt, so sessions are the runs between gaps. The
 * session is labelled with its New York trading date (the date it closes on).
 */
export function findManualTradingDays(minutes: readonly Candle[], symbol: SymbolId = MANUAL_PRACTICE_SYMBOL): ManualTradingDay[] {
  const days: ManualTradingDay[] = []
  let start = 0
  const flush = (endIndex: number) => {
    const count = endIndex - start
    if (count < MIN_SESSION_MINUTES) return
    const first = minutes[start]
    const last = minutes[endIndex - 1]
    const date = sessionDateFormatter.format(new Date(last.time * 1000))
    days.push({
      key: `${symbol}:${date}`,
      label: `${date}（${weekdayFormatter.format(new Date(last.time * 1000))}）`,
      startTime: first.time,
      endTime: last.time + 60,
      minutes: count,
    })
  }
  for (let index = 1; index < minutes.length; index += 1) {
    if (minutes[index].time - minutes[index - 1].time >= SESSION_GAP_SECONDS) {
      flush(index)
      start = index
    }
  }
  // The newest session may still be in progress in the snapshot; skip it.
  return days
}

function randomInt(upperExclusive: number) {
  if (upperExclusive <= 1) return 0
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const value = new Uint32Array(1)
    crypto.getRandomValues(value)
    return value[0] % upperExclusive
  }
  return Math.floor(Math.random() * upperExclusive)
}

export function pickRandomTradingDay(days: readonly ManualTradingDay[], usedDayKeys: ReadonlySet<string>) {
  const fresh = days.filter((day) => !usedDayKeys.has(day.key))
  const pool = fresh.length > 0 ? fresh : days
  return pool.length > 0 ? pool[randomInt(pool.length)] : null
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

export function createManualSession(day: ManualTradingDay, now = Date.now()): ManualPracticeSession {
  return {
    id: newId(),
    symbol: MANUAL_PRACTICE_SYMBOL,
    dayKey: day.key,
    dayLabel: day.label,
    startTime: day.startTime,
    endTime: day.endTime,
    cursorTime: day.startTime,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    trades: [],
    notes: [],
  }
}

/** Start of the context window: CONTEXT_SESSIONS sessions before the practice day. */
export function contextStartTime(days: readonly ManualTradingDay[], session: Pick<ManualPracticeSession, 'startTime'>) {
  const index = days.findIndex((day) => day.startTime === session.startTime)
  if (index <= 0) return session.startTime - 3 * 86_400
  return days[Math.max(0, index - CONTEXT_SESSIONS)].startTime
}

export function aggregateMinutes(minutes: readonly Candle[], seconds: number): Candle[] {
  if (seconds <= 60) return minutes.slice()
  const result: Candle[] = []
  let current: Candle | null = null
  for (const minute of minutes) {
    const time = Math.floor(minute.time / seconds) * seconds
    if (!current || current.time !== time) {
      current = { ...minute, time }
      result.push(current)
    } else {
      current.high = Math.max(current.high, minute.high)
      current.low = Math.min(current.low, minute.low)
      current.close = minute.close
      current.volume += minute.volume
    }
  }
  return result
}

export function openTrade(session: ManualPracticeSession) {
  return session.trades.find((trade) => trade.exitTime === null) ?? null
}

export function lastRevealedMinute(minutes: readonly Candle[], cursorTime: number) {
  const index = lowerBound(minutes, cursorTime) - 1
  return index >= 0 ? minutes[index] : null
}

/** Next cursor: the end of the next chart bar that contains at least one minute. */
export function nextCursorTime(minutes: readonly Candle[], session: ManualPracticeSession, stepSeconds: number) {
  const nextIndex = lowerBound(minutes, session.cursorTime)
  const next = minutes[nextIndex]
  if (!next || next.time >= session.endTime) return session.endTime
  const bucketEnd = Math.floor(next.time / stepSeconds) * stepSeconds + stepSeconds
  return Math.min(session.endTime, bucketEnd)
}

function exitAgainstMinute(trade: ManualTrade, minute: Candle): { price: number; kind: ManualExitKind } | null {
  const long = trade.side === 'long'
  // Conservative: if the stop and the target are both inside one minute, assume the stop hit first.
  if (trade.stopLoss !== null) {
    const hit = long ? minute.low <= trade.stopLoss : minute.high >= trade.stopLoss
    if (hit) {
      const gapped = long ? minute.open < trade.stopLoss : minute.open > trade.stopLoss
      return { price: gapped ? minute.open : trade.stopLoss, kind: 'stop' }
    }
  }
  if (trade.takeProfit !== null) {
    const hit = long ? minute.high >= trade.takeProfit : minute.low <= trade.takeProfit
    if (hit) {
      const gapped = long ? minute.open > trade.takeProfit : minute.open < trade.takeProfit
      return { price: gapped ? minute.open : trade.takeProfit, kind: 'target' }
    }
  }
  return null
}

export interface AdvanceOutcome {
  session: ManualPracticeSession
  /** Set when the open position was closed by its stop / target during this step. */
  closedTrade: ManualTrade | null
  /** Set when a resting order filled during this step. */
  filledTrade?: ManualTrade | null
  finished: boolean
}

/** Order type for an entry price relative to the last close: long above price = stop (追单), below = limit (挂单). */
export function manualOrderKind(side: ManualSide, entryPrice: number, referencePrice: number): ManualOrderKind {
  return side === 'long'
    ? (entryPrice >= referencePrice ? 'stop' : 'limit')
    : (entryPrice <= referencePrice ? 'stop' : 'limit')
}

/** Fill price when a minute trades through a resting order (gaps fill at the open), otherwise null. */
export function fillManualOrder(order: Pick<ManualPendingOrder, 'side' | 'orderKind' | 'entryPrice'>, candle: Candle): number | null {
  const { side, orderKind, entryPrice } = order
  if (orderKind === 'stop' && side === 'long' && candle.high > entryPrice) return candle.open > entryPrice ? candle.open : entryPrice
  if (orderKind === 'stop' && side === 'short' && candle.low < entryPrice) return candle.open < entryPrice ? candle.open : entryPrice
  if (orderKind === 'limit' && side === 'long' && candle.low <= entryPrice) return candle.open < entryPrice ? candle.open : entryPrice
  if (orderKind === 'limit' && side === 'short' && candle.high >= entryPrice) return candle.open > entryPrice ? candle.open : entryPrice
  return null
}

/** Reveal the next chart bar, filling a resting order and settling stop/target on the newly revealed minutes. */
export function advanceManualSession(session: ManualPracticeSession, minutes: readonly Candle[], stepSeconds: number, now = Date.now()): AdvanceOutcome {
  if (session.status !== 'active') return { session, closedTrade: null, finished: true }
  const nextCursor = nextCursorTime(minutes, session, stepSeconds)
  let trades = session.trades
  let closedTrade: ManualTrade | null = null
  let filledTrade: ManualTrade | null = null
  let pending = session.pendingOrder ?? null
  let position = openTrade(session)
  for (let index = lowerBound(minutes, session.cursorTime); index < minutes.length && minutes[index].time < nextCursor; index += 1) {
    const minute = minutes[index]
    if (!position && pending) {
      const price = fillManualOrder(pending, minute)
      if (price !== null) {
        // Stop / target are judged from the next minute on, so a fill bar never exits on its own wick.
        filledTrade = {
          id: pending.id, side: pending.side, entryTime: minute.time, entryPrice: price,
          stopLoss: pending.stopLoss, takeProfit: pending.takeProfit, quantity: pending.quantity,
          exitTime: null, exitPrice: null, exitKind: null,
          background: pending.background, reasons: pending.reasons, exitReasons: [],
          unsupportedReasons: pending.unsupportedReasons?.trim() ?? '',
        }
        trades = [...trades, filledTrade]
        position = filledTrade
        pending = null
      }
      continue
    }
    if (position && (position.stopLoss !== null || position.takeProfit !== null)) {
      const exit = exitAgainstMinute(position, minute)
      if (exit) {
        const closing: ManualTrade = { ...position, exitTime: minute.time, exitPrice: exit.price, exitKind: exit.kind }
        closedTrade = closing
        trades = trades.map((trade) => trade.id === closing.id ? closing : trade)
        break
      }
    }
  }
  const finished = nextCursor >= session.endTime
  let next: ManualPracticeSession = { ...session, trades, pendingOrder: pending, cursorTime: nextCursor, updatedAt: now }
  if (finished) next = finishManualSession(next, minutes, now)
  return { session: next, closedTrade, filledTrade, finished }
}

/** Close any open position at the last revealed price and mark the day complete. */
export function finishManualSession(session: ManualPracticeSession, minutes: readonly Candle[], now = Date.now()): ManualPracticeSession {
  const last = lastRevealedMinute(minutes, session.cursorTime)
  const trades = session.trades.map((trade) => trade.exitTime === null && last
    ? { ...trade, exitTime: last.time, exitPrice: last.close, exitKind: 'session-end' as const }
    : trade)
  return { ...session, trades, pendingOrder: null, status: 'completed', completedAt: now, updatedAt: now }
}

export function tradePoints(trade: ManualTrade, markPrice?: number | null) {
  const exit = trade.exitPrice ?? markPrice
  if (exit === null || exit === undefined) return null
  return (exit - trade.entryPrice) * (trade.side === 'long' ? 1 : -1)
}

export const MANUAL_MAX_QUANTITY = 10

export function tradeQuantity(trade: Pick<ManualTrade, 'quantity'>) {
  const quantity = trade.quantity
  return typeof quantity === 'number' && Number.isFinite(quantity) && quantity >= 1 ? Math.floor(quantity) : 1
}

/** Profit in dollars for the whole position (points x $20 x contracts). */
export function tradeUsd(trade: ManualTrade, markPrice?: number | null) {
  const points = tradePoints(trade, markPrice)
  return points === null ? null : points * NQ_POINT_VALUE_USD * tradeQuantity(trade)
}

export function sessionSummary(session: ManualPracticeSession) {
  const closed = session.trades.filter((trade) => trade.exitPrice !== null)
  const points = closed.map((trade) => tradePoints(trade) ?? 0)
  const totalPoints = points.reduce((sum, value) => sum + value, 0)
  const wins = points.filter((value) => value > 0).length
  return {
    trades: session.trades.length,
    closed: closed.length,
    wins,
    losses: points.filter((value) => value < 0).length,
    winRate: closed.length ? wins / closed.length : null,
    totalPoints,
    totalUsd: closed.reduce((sum, trade) => sum + (tradeUsd(trade) ?? 0), 0),
    noTradeNotes: new Set(session.notes.filter((note) => note.kind !== 'should-trade').map(note => `${note.barTime}:${note.interval}`)).size,
    shouldTradeNotes: new Set(session.notes.filter((note) => note.kind === 'should-trade').map(note => `${note.barTime}:${note.interval}`)).size,
    reasonCount: session.trades.reduce((sum, trade) => sum + trade.reasons.length + trade.exitReasons.length, 0)
      + session.notes.reduce((sum, note) => sum + note.reasons.length, 0),
  }
}

export function cleanReasons(reasons: readonly string[]) {
  return reasons.map((reason) => reason.trim()).filter(Boolean)
}

/** Save a candle's note; an empty background and no reasons removes it. */
export function upsertBarNote(session: ManualPracticeSession, barTime: number, interval: IntervalId, reasons: readonly string[], background: string, kind: ManualBarNote['kind'] = 'no-trade', side?: ManualSide, now = Date.now()): ManualPracticeSession {
  const cleaned = cleanReasons(reasons)
  const context = background.trim()
  // Each candle can retain all three alternatives independently.
  const matches = (note: ManualBarNote) => note.barTime === barTime && note.interval === interval && note.kind === kind && (kind !== 'should-trade' || (note.side ?? 'long') === (side ?? 'long'))
  const previous = session.notes.find(matches)
  const others = session.notes.filter((note) => !matches(note))
  const notes = cleaned.length > 0 || context
    ? [...others, { barTime, interval, kind, ...(kind === 'should-trade' ? { side: side ?? 'long' } : {}), ...(previous?.biasRank === undefined ? {} : { biasRank: previous.biasRank }), background: context, reasons: cleaned, updatedAt: now } as ManualBarNote].sort((a, b) => a.barTime - b.barTime)
    : others
  return { ...session, notes, updatedAt: now }
}

/** Atomically save the three alternatives for one candle in strongest-first order. */
export function saveCandleBiasNotes(session: ManualPracticeSession, barTime: number, interval: IntervalId, background: string, entries: readonly { bias: ManualCandleBias; reasons: readonly string[] }[], now = Date.now()): ManualPracticeSession {
  const alternatives: { bias: ManualCandleBias; reasons: string[] }[] = []
  for (const entry of entries) {
    if (!['no-trade', 'long', 'short'].includes(entry.bias) || alternatives.some((item) => item.bias === entry.bias)) continue
    alternatives.push({ bias: entry.bias, reasons: cleanReasons(entry.reasons) })
  }
  for (const bias of ['no-trade', 'long', 'short'] as const) {
    if (!alternatives.some((item) => item.bias === bias)) alternatives.push({ bias, reasons: [] })
  }
  const context = background.trim()
  const others = session.notes.filter((note) => note.barTime !== barTime || note.interval !== interval)
  const notes: ManualBarNote[] = !context && alternatives.every((entry) => entry.reasons.length === 0) ? [] : alternatives.map((entry, biasRank) => ({
    barTime, interval, kind: entry.bias === 'no-trade' ? 'no-trade' : 'should-trade',
    ...(entry.bias === 'no-trade' ? {} : { side: entry.bias }),
    background: context, reasons: entry.reasons, biasRank, updatedAt: now,
  }))
  return { ...session, notes: [...others, ...notes].sort((a, b) => a.barTime - b.barTime), updatedAt: now }
}

/** The most recent background written in this paper, used to pre-fill the next one. */
export function latestBackground(session: ManualPracticeSession) {
  const entries = [
    ...session.notes.map((note) => ({ time: note.updatedAt, background: note.background })),
    ...session.trades.map((trade) => ({ time: trade.entryTime * 1000, background: trade.background })),
  ].filter((entry) => entry.background.trim())
  entries.sort((a, b) => b.time - a.time)
  return entries[0]?.background ?? ''
}

export function barTimeFor(time: number, interval: IntervalId) {
  const seconds = INTERVALS[interval].seconds
  return Math.floor(time / seconds) * seconds
}

export interface ManualTimelineItem {
  time: number
  kind: ManualNoteKind
  title: string
  /** 背景 (entries and no-trade notes only). */
  background: string | null
  reasons: string[]
  /** Entry counter-evidence; not used for exits or no-trade notes. */
  unsupportedReasons?: string
  trade?: ManualTrade
  note?: ManualBarNote
  /** A stop / target / end-of-day exit is triggered by the market, not decided by the user, so it has no 平仓理由. */
  passive?: boolean
}

/** Stable identities survive timeline filtering, ranking and insertion of other records. */
export function manualReviewCommentKey(item: ManualTimelineItem): string {
  if (item.trade && (item.kind === 'entry' || item.kind === 'exit')) return JSON.stringify(['trade', item.trade.id, item.kind])
  if (item.note) {
    const note = item.note
    return JSON.stringify(['note', note.kind, note.barTime, note.interval, note.kind === 'should-trade' ? note.side ?? 'long' : null])
  }
  return JSON.stringify(['timeline', item.kind, item.time])
}

/** Save hindsight only; never mutate the original decision or advance/reopen its session. */
export function saveManualReviewComment(session: ManualPracticeSession, item: ManualTimelineItem, text: string, now = Date.now()): ManualPracticeSession {
  return {
    ...session,
    reviewComments: { ...session.reviewComments, [manualReviewCommentKey(item)]: { text: text.trim(), updatedAt: now } },
  }
}

/** Every reason in time order, for the review screen. */
export function manualTimeline(session: ManualPracticeSession): ManualTimelineItem[] {
  const items: ManualTimelineItem[] = []
  for (const note of session.notes) {
    items.push(note.kind === 'should-trade'
      ? { time: note.barTime, kind: 'should-trade', title: `应该${note.side === 'short' ? '开空' : '开多'}（${INTERVALS[note.interval].label} K线）`, background: note.background, reasons: note.reasons, note }
      : { time: note.barTime, kind: 'no-trade', title: `不做单（${INTERVALS[note.interval].label} K线）`, background: note.background, reasons: note.reasons, note })
  }
  for (const trade of session.trades) {
    items.push({ time: trade.entryTime, kind: 'entry', title: `${trade.side === 'long' ? '开多' : '开空'} @ ${trade.entryPrice.toFixed(2)}`, background: trade.background, reasons: trade.reasons, unsupportedReasons: trade.unsupportedReasons ?? '', trade })
    if (trade.exitTime !== null) {
      const label = trade.exitKind === 'stop' ? '止损' : trade.exitKind === 'target' ? '止盈' : trade.exitKind === 'session-end' ? '收盘平仓' : '手动平仓'
      items.push({ time: trade.exitTime, kind: 'exit', title: `${label} @ ${trade.exitPrice?.toFixed(2)}`, background: null, reasons: trade.exitReasons, trade, passive: trade.exitKind !== 'manual' })
    }
  }
  const timeline = items.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time
    if (a.kind === 'exit' && b.kind !== 'exit') return -1
    if (b.kind === 'exit' && a.kind !== 'exit') return 1
    return 0
  })
  // Rank within a candle/period without moving unrelated timeframes or trades.
  const alternatives = new Map<string, ManualTimelineItem[]>()
  for (const item of timeline) {
    if (!item.note) continue
    const key = `${item.note.barTime}:${item.note.interval}`
    const group = alternatives.get(key) ?? []
    group.push(item)
    alternatives.set(key, group)
  }
  for (const group of alternatives.values()) group.sort((a, b) => (a.note!.biasRank ?? 3) - (b.note!.biasRank ?? 3))
  const consumed = new Map<string, number>()
  return timeline.map((item) => {
    if (!item.note) return item
    const key = `${item.note.barTime}:${item.note.interval}`
    const index = consumed.get(key) ?? 0
    consumed.set(key, index + 1)
    return alternatives.get(key)![index]
  })
}

/**
 * One numbered row per reason card, in time order. A trade's exit belongs to the card of its entry.
 * The number is shown on the card and on the chart, so both always agree (and stay stable when filtering).
 */
export function manualReasonRows(session: ManualPracticeSession) {
  const timeline = manualTimeline(session)
  const rows: { item: ManualTimelineItem; exit: ManualTimelineItem | undefined; biasItems?: ManualTimelineItem[] }[] = []
  const grouped = new Set<string>()
  for (const item of timeline) {
    if (item.kind === 'exit') continue
    if (item.note) {
      const key = `${item.note.barTime}:${item.note.interval}`
      if (grouped.has(key)) continue
      grouped.add(key)
      const biasItems = timeline.filter((other) => other.note?.barTime === item.note!.barTime && other.note.interval === item.note!.interval)
      rows.push({ item, exit: undefined, biasItems })
      continue
    }
    const exit = item.kind === 'entry' && item.trade ? timeline.find((other) => other.kind === 'exit' && other.trade?.id === item.trade!.id) : undefined
    rows.push({ item, exit })
  }
  return rows.map((row, index) => ({ ...row, seq: index + 1 }))
}
