import { describe, expect, it } from 'vitest'
import {
  exitReasonDetail, exitReasonLabel, getXauTradeMarkers, parseXauTradeMarkerId,
  resolveXauTradeMarker, toXauTradeConnectionSpecs, toXauTradeSeriesMarkers, toggleXauTradeMarkerSelection, tradeLevelMethodLabel,
  tradeMarkerTitle, tradeRuleLabel, triggerConditionLabel,
  xauTradeMarkerSummary,
} from './tradeMarkers'

describe('XAUUSD conservative trade markers', () => {
  it('contains 94 no-fixed-target trades with complete entry, exit and result details', () => {
    const trades = getXauTradeMarkers('XAUUSD', '5m')
    expect(trades).toHaveLength(94)
    expect(trades.filter((trade) => trade.side === 'long')).toHaveLength(44)
    expect(trades.filter((trade) => trade.side === 'short')).toHaveLength(50)
    expect(new Set(trades.map((trade) => trade.entry.time)).size).toBe(94)
    expect(new Set(trades.map((trade) => trade.exit.time)).size).toBe(94)
    expect(trades.every((trade) => Number.isInteger(trade.entry.time) && Number.isInteger(trade.exit.time))).toBe(true)
    expect(trades.every((trade) => trade.entry.time % 300 === 0 && trade.exit.time % 300 === 0)).toBe(true)
    expect(trades.every((trade) => trade.exit.time >= trade.entry.time)).toBe(true)
    expect(trades.every((trade) => trade.entry.reason.trim() && trade.entry.setup.trim() && trade.exit.beijingTime.trim())).toBe(true)
    expect(trades.map((trade) => trade.tradeNumber)).toEqual(Array.from({ length: 94 }, (_, index) => index + 1))
    expect(trades.filter((trade) => trade.entry.time === trade.exit.time)).toHaveLength(6)
    expect(new Set(trades.flatMap((trade) => [trade.entry.time, trade.exit.time])).size).toBe(182)
    expect(trades.every((trade) => trade.entry.takeProfit === null && trade.entry.noFixedTakeProfitAtEntry)).toBe(true)
    expect(trades.filter((trade) => trade.exit.reasonCode === 'INITIAL_STOP_LOSS')).toHaveLength(26)
    expect(trades.filter((trade) => trade.exit.reasonCode === 'TRAILING_STOP')).toHaveLength(20)
    expect(trades.filter((trade) => trade.exit.reasonCode === 'TRAILING_STOP_GAP')).toHaveLength(1)
    expect(trades.filter((trade) => trade.exit.reasonCode === 'OPPOSITE_SIGNAL_CLOSE')).toHaveLength(47)
    expect(trades.filter((trade) => trade.exit.reasonCode === 'OPPOSITE_SIGNAL_CLOSE').every((trade) => trade.exit.setup && trade.exit.reason)).toBe(true)
    expect(xauTradeMarkerSummary()).toMatchObject({
      trades: 94,
      long: 44,
      short: 50,
      entryMarkers: 94,
      exitMarkers: 94,
      uniqueTimes: 182,
      sameBarOpenClose: 6,
      exitReasonCounts: { INITIAL_STOP_LOSS: 26, INITIAL_STOP_LOSS_GAP: 0, TRAILING_STOP: 20, TRAILING_STOP_GAP: 1, OPPOSITE_SIGNAL_CLOSE: 47, END_OF_DATA_MARK_TO_MARKET: 0 },
    })
  })

  it('filters markers to the XAUUSD 5m context', () => {
    expect(getXauTradeMarkers('XAUUSD', '1m')).toEqual([])
    expect(getXauTradeMarkers('BTCUSDT.P', '5m')).toEqual([])
    expect(getXauTradeMarkers('ETHUSD', '15m')).toEqual([])
    expect(toXauTradeSeriesMarkers('XAUUSD', '1m')).toEqual([])
  })

  it('emits 94 entry and 94 exit native markers with stable IDs and styles', () => {
    const trades = getXauTradeMarkers('XAUUSD', '5m')
    const markers = toXauTradeSeriesMarkers('XAUUSD', '5m')
    expect(markers).toHaveLength(188)
    expect(markers.filter((marker) => marker.text?.startsWith('开'))).toHaveLength(94)
    expect(markers.filter((marker) => marker.text?.startsWith('平'))).toHaveLength(94)
    expect(new Set(markers.map((marker) => marker.id)).size).toBe(188)
    expect(markers.map((marker) => Number(marker.time))).toEqual([...markers.map((marker) => Number(marker.time))].sort((a, b) => a - b))
    expect(markers[0]).toMatchObject({ id: 'xau-trade-1-entry', time: 1785709200, position: 'aboveBar', shape: 'arrowDown', text: '开空', color: '#f7525f' })
    expect(markers.find((marker) => marker.text === '开多')).toMatchObject({ position: 'belowBar', shape: 'arrowUp', color: '#22ab94' })
    expect(markers.find((marker) => marker.text === '开空')).toMatchObject({ position: 'aboveBar', shape: 'arrowDown', color: '#f7525f' })
    expect(markers.find((marker) => marker.text === '平多')).toMatchObject({ position: 'aboveBar', shape: 'circle', color: '#f59e0b' })
    expect(markers.find((marker) => marker.text === '平空')).toMatchObject({ position: 'belowBar', shape: 'circle', color: '#f59e0b' })
    expect(markers.every((marker) => ['开多', '开空', '平多', '平空'].includes(marker.text ?? ''))).toBe(true)
    expect(markers.every((marker) => Object.keys(marker).every((key) => ['time', 'position', 'shape', 'color', 'text', 'size', 'id'].includes(key)))).toBe(true)

    const sameBarTrade = trades.find((trade) => trade.entry.time === trade.exit.time)!
    const sameBarMarkers = markers.filter((marker) => Number(marker.time) === sameBarTrade.entry.time)
    expect(sameBarMarkers).toHaveLength(2)
    expect(sameBarMarkers[0].text?.startsWith('开')).toBe(true)
    expect(sameBarMarkers[1].text?.startsWith('平')).toBe(true)
  })

  it('only reveals markers at or before the replay cursor', () => {
    const allMarkers = toXauTradeSeriesMarkers('XAUUSD', '5m')
    const cutoff = Number(allMarkers[80].time)
    const revealed = toXauTradeSeriesMarkers('XAUUSD', '5m', cutoff)
    expect(revealed).toEqual(allMarkers.filter((marker) => Number(marker.time) <= cutoff))
    expect(revealed.length).toBeGreaterThan(0)
    expect(revealed.length).toBeLessThan(allMarkers.length)
    expect(revealed.every((marker) => Number(marker.time) <= cutoff)).toBe(true)
  })

  it('highlights both markers for the active trade without changing replay filtering', () => {
    const normal = toXauTradeSeriesMarkers('XAUUSD', '5m')
    expect(toXauTradeSeriesMarkers('XAUUSD', '5m', undefined, null)).toEqual(normal)
    const active = toXauTradeSeriesMarkers('XAUUSD', '5m', undefined, 1)
    const activeMarkers = active.filter((marker) => marker.id === 'xau-trade-1-entry' || marker.id === 'xau-trade-1-exit')
    expect(activeMarkers).toHaveLength(2)
    expect(activeMarkers.every((marker) => marker.color === '#facc15' && marker.size === 2)).toBe(true)
    expect(active.filter((marker) => marker.id !== 'xau-trade-1-entry' && marker.id !== 'xau-trade-1-exit')).toEqual(normal.filter((marker) => marker.id !== 'xau-trade-1-entry' && marker.id !== 'xau-trade-1-exit'))

    const cutoff = Number(normal[80].time)
    const normalRevealed = toXauTradeSeriesMarkers('XAUUSD', '5m', cutoff)
    const activeRevealed = toXauTradeSeriesMarkers('XAUUSD', '5m', cutoff, 1)
    expect(activeRevealed.map((marker) => marker.id)).toEqual(normalRevealed.map((marker) => marker.id))
    expect(activeRevealed.every((marker) => Number(marker.time) <= cutoff)).toBe(true)
  })

  it('emits one independently colored connection per completed trade', () => {
    const connections = toXauTradeConnectionSpecs('XAUUSD', '5m')
    expect(connections).toHaveLength(94)
    expect(new Set(connections.map((connection) => connection.id)).size).toBe(94)
    expect(connections.filter((connection) => connection.outcome === 'profit')).toHaveLength(39)
    expect(connections.filter((connection) => connection.outcome === 'loss')).toHaveLength(55)
    expect(connections.filter((connection) => connection.outcome === 'breakeven')).toHaveLength(0)
    expect(connections.filter((connection) => connection.color === '#22ab94')).toHaveLength(39)
    expect(connections.filter((connection) => connection.color === '#f7525f')).toHaveLength(55)
    expect(connections.filter((connection) => connection.color === '#f59e0b')).toHaveLength(0)
    expect(connections.every((connection) => connection.entryTime <= connection.exitTime)).toBe(true)
    const sameBarTrade = connections.find((connection) => connection.entryTime === connection.exitTime)!
    expect(sameBarTrade.entryTime).toBe(sameBarTrade.exitTime)
    expect(sameBarTrade.entryPrice).not.toBe(sameBarTrade.exitPrice)
  })

  it('filters connections by completed exit time and context', () => {
    const allConnections = toXauTradeConnectionSpecs('XAUUSD', '5m')
    const cutoff = allConnections[40].exitTime
    const revealed = toXauTradeConnectionSpecs('XAUUSD', '5m', cutoff)
    expect(revealed).toEqual(allConnections.filter((connection) => connection.exitTime <= cutoff))
    expect(revealed.every((connection) => connection.exitTime <= cutoff)).toBe(true)
    expect(toXauTradeConnectionSpecs('XAUUSD', '1m')).toEqual([])
    expect(toXauTradeConnectionSpecs('BTCUSDT.P', '5m')).toEqual([])
  })

  it('resolves IDs and toggles the same marker without side effects', () => {
    expect(parseXauTradeMarkerId('xau-trade-1-entry')).toEqual({ tradeNumber: 1, kind: 'entry' })
    expect(parseXauTradeMarkerId('xau-trade-94-exit')).toEqual({ tradeNumber: 94, kind: 'exit' })
    expect(parseXauTradeMarkerId('xau-trade-95-exit')).toBeNull()
    expect(parseXauTradeMarkerId('xau-trade-0-entry')).toBeNull()
    expect(parseXauTradeMarkerId('not-a-marker')).toBeNull()
    const selection = resolveXauTradeMarker('XAUUSD', '5m', 'xau-trade-1-entry')!
    expect(selection.kind).toBe('entry')
    expect(selection.trade.tradeNumber).toBe(1)
    expect(resolveXauTradeMarker('XAUUSD', '1m', 'xau-trade-1-entry')).toBeNull()
    expect(toggleXauTradeMarkerSelection(null, selection.id)).toBe(selection.id)
    expect(toggleXauTradeMarkerSelection(selection.id, selection.id)).toBeNull()
    expect(toggleXauTradeMarkerSelection(selection.id, 'xau-trade-1-exit')).toBe('xau-trade-1-exit')
  })

  it('provides non-empty public exit explanations and titles', () => {
    const trade = getXauTradeMarkers('XAUUSD', '5m')[0]
    expect(exitReasonLabel('OPPOSITE_SIGNAL_CLOSE')).toBe('反向信号平仓')
    expect(exitReasonLabel('INITIAL_STOP_LOSS')).toBe('固定止损')
    expect(exitReasonLabel('TRAILING_STOP')).toBe('移动止盈')
    expect(exitReasonLabel('COURSE_TARGET')).toBe('动态课程目标')
    expect(exitReasonLabel('COURSE_TARGET_GAP')).toBe('动态课程目标跳空')
    expect(exitReasonLabel('UNKNOWN_REASON' as never)).toBe('未知退出原因')
    for (const code of ['OPPOSITE_SIGNAL_CLOSE', 'INITIAL_STOP_LOSS', 'INITIAL_STOP_LOSS_GAP', 'TRAILING_STOP', 'TRAILING_STOP_GAP', 'END_OF_DATA_MARK_TO_MARKET', 'COURSE_TARGET', 'COURSE_TARGET_GAP'] as const) expect(exitReasonDetail(code, trade.side).trim()).not.toBe('')
    expect(exitReasonDetail('COURSE_TARGET', trade.side)).toContain('动态课程目标')
    expect(exitReasonDetail('UNKNOWN_REASON' as never, trade.side)).toContain('未被界面映射')
    expect(tradeRuleLabel('next_bar_breakout_initial_stop_no_fixed_target_v2_20260809')).toContain('无固定止盈')
    expect(tradeRuleLabel('next_bar_breakout_initial_stop_course_target_v1_20260813')).toBe('下一根K线突破入场规则')
    expect(tradeRuleLabel('unrecognised_rule_code')).toBe('按回放规则触发')
    expect(triggerConditionLabel('next_bar_high > signal_bar_high')).toContain('突破')
    expect(triggerConditionLabel('unrecognised_condition')).toBe('按信号K线确认后触发')
    expect(tradeLevelMethodLabel('latest_confirmed_pivot_low_below_entry')).toContain('枢轴低点')
    expect(tradeMarkerTitle(trade, 'entry')).toContain('开空')
    expect(tradeMarkerTitle(trade, 'exit')).toContain('平空')
  })
})
