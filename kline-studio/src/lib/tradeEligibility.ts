import type { SymbolId } from './market'

/** Exit code used when a replay tape ends while the position is still open. */
export const UNFINISHED_POSITION_EXIT_REASON = 'END_OF_DATA_MARK_TO_MARKET'

interface TradeTiming {
  entry: { time: number }
  exit: { time: number; reasonCode?: string }
}

function beijingTradingDay(time: number) {
  // Replay timestamps are Unix seconds. Beijing has a fixed UTC+8 offset, so
  // this avoids locale-dependent date parsing and daylight-saving surprises.
  return Math.floor((time + 8 * 60 * 60) / (24 * 60 * 60))
}

/**
 * Gold and silver exercises are intraday-only. A position that crosses the
 * Beijing calendar date, or is only marked to market because the source tape
 * ended, is not a completed trade for the chart, replay, or statistics.
 */
export function isExcludedCommodityTrade(symbol: SymbolId, trade: TradeTiming) {
  if (symbol !== 'XAUUSD' && symbol !== 'XAGUSD') return false
  if (trade.exit.reasonCode === UNFINISHED_POSITION_EXIT_REASON) return true
  return beijingTradingDay(trade.entry.time) !== beijingTradingDay(trade.exit.time)
}

