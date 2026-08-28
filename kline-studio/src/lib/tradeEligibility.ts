import type { IntervalId, SymbolId } from './market'

/** Exit code used when a replay tape ends while the position is still open. */
export const UNFINISHED_POSITION_EXIT_REASON = 'END_OF_DATA_MARK_TO_MARKET'

/**
 * These instruments have a daily maintenance break in the bundled market
 * snapshots. Crypto symbols are continuous and deliberately do not use these
 * session-edge rules.
 */
export const CLOSED_SESSION_SYMBOLS: readonly SymbolId[] = ['XAUUSD', 'XAGUSD', 'US500']
export const SESSION_EDGE_BAR_COUNT = 10
export const SESSION_OPEN_BEIJING_SECONDS = 6 * 60 * 60
export const SESSION_CLOSE_BEIJING_SECONDS = 5 * 60 * 60

interface TradeTiming {
  entry: { time: number }
  exit: { time: number; reasonCode?: string }
}

function beijingTradingDay(time: number) {
  // Replay timestamps are Unix seconds. Beijing has a fixed UTC+8 offset, so
  // this avoids locale-dependent date parsing and daylight-saving surprises.
  return Math.floor((time + 8 * 60 * 60) / (24 * 60 * 60))
}

function beijingSecondsSinceMidnight(time: number) {
  const day = 24 * 60 * 60
  return ((time + 8 * 60 * 60) % day + day) % day
}

function intervalSeconds(interval: IntervalId | undefined) {
  if (!interval) return null
  const seconds: Record<IntervalId, number> = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '2h': 7200,
    '4h': 14400,
    '1d': 86400,
    '1w': 604800,
  }
  return seconds[interval]
}

function isSessionEdgeEntry(time: number, interval: IntervalId | undefined) {
  const step = intervalSeconds(interval)
  if (step === null) return false
  const seconds = beijingSecondsSinceMidnight(time)
  const firstTenEnd = SESSION_OPEN_BEIJING_SECONDS + SESSION_EDGE_BAR_COUNT * step
  const lastTenStart = SESSION_CLOSE_BEIJING_SECONDS - SESSION_EDGE_BAR_COUNT * step
  return (
    seconds >= SESSION_OPEN_BEIJING_SECONDS && seconds < firstTenEnd
  ) || (
    seconds >= lastTenStart && seconds < SESSION_CLOSE_BEIJING_SECONDS
  )
}

/**
 * Closed-session exercises are intraday-only. A position that crosses the
 * Beijing calendar date, starts in the first ten candles after the 06:00
 * session open, starts in the final ten candles before the 05:00 close, or is
 * only marked to market because the source tape ended, is not a completed
 * trade for the chart, replay, or statistics.
 *
 * `interval` is optional for compatibility with old callers. Without it, the
 * cross-date and unfinished-position checks still apply, while the
 * candle-count edge check is skipped because its bar width is unknown.
 */
export function isExcludedCommodityTrade(symbol: SymbolId, trade: TradeTiming, interval?: IntervalId) {
  if (!CLOSED_SESSION_SYMBOLS.includes(symbol)) return false
  if (trade.exit.reasonCode === UNFINISHED_POSITION_EXIT_REASON) return true
  if (beijingTradingDay(trade.entry.time) !== beijingTradingDay(trade.exit.time)) return true
  return isSessionEdgeEntry(trade.entry.time, interval)
}

