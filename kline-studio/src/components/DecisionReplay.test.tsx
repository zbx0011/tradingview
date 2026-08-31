import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ReplayDecisionCandidate } from '../lib/replayTradeRegistry'
import {
  buildDecisionResult, createDecisionAttempt, createDecisionSession, formatDecisionDate, toggleDecisionHistoryIntervalSelection, toggleDecisionHistorySymbolSelection,
} from '../lib/decisionReplay'
import type { DecisionReplaySession } from '../lib/decisionReplay'
import { decisionReplayFavoriteKey } from '../lib/decisionReplayFavorites'
import {
  DecisionChartAnnotations, DecisionChartPnlBreakdown, DecisionChartStatus, DecisionHistoryDialog, DecisionReplayCenter, DecisionReplayPanel, DecisionResultsDialog, DecisionReviewPanel, DecisionRiskOverlay,
} from './DecisionReplay'

function candidate(): ReplayDecisionCandidate {
  return {
    key: 'XAUUSD:5m:long:3000:3300', sourceId: 'v5', sourceName: 'V5 回测', symbol: 'XAUUSD', interval: '5m', scenario: 'test', backtestSha256: 'abc',
    trade: {
      tradeNumber: 12, side: 'long',
      entry: {
        signalIdx: 10, signalTime: 3000, time: 3300, beijingTime: '2026-01-01 00:00', price: 101,
        setup: '震荡区间向上真突破', reason: '这是用户必须在决策前直接看到的严格因果开仓理由，参考 K8 与 K10。', ruleVersion: 'V5',
        triggerReference: 'signal high', triggerCondition: '下一根 K 线突破入场规则', stopLoss: 95, takeProfit: null,
        noFixedTakeProfitAtEntry: true, stopMethod: '最近确认的枢轴低点', trailingActivationUsd: null, trailingDistanceUsd: null,
      },
      exit: {
        idx: 14, time: 4200, beijingTime: '2026-01-01 00:15', price: 103, reasonCode: 'TRAILING_STOP',
        reason: '不可提前显示的系统平仓理由 K14', setup: '系统平仓', ambiguous: false, finalActiveStop: 103,
        trailingActivated: true, trailingActivationIdx: 13,
      },
      result: { barsHeld: 3, rMultiple: .4, pnlUsd: 40 },
    },
  }
}

const noop = () => undefined

type AnnotationPoint = { time: number; price: number }

function annotationCandidate(entry: AnnotationPoint, exit: AnnotationPoint): ReplayDecisionCandidate {
  const item = candidate()
  return {
    ...item,
    key: `${item.key}:${entry.time}:${exit.time}`,
    trade: {
      ...item.trade,
      entry: {
        ...item.trade.entry,
        signalIdx: 1,
        signalTime: entry.time,
        time: entry.time,
        price: entry.price,
        reason: 'entry reason',
      },
      exit: {
        ...item.trade.exit,
        idx: 2,
        time: exit.time,
        price: exit.price,
        reason: 'exit reason',
      },
    },
  }
}

function annotationTag(markup: string, testId: string) {
  const tag = markup.match(new RegExp(`<[^>]*\\bdata-testid="${testId}"[^>]*>`))?.[0]
  if (!tag) throw new Error(`Missing data-testid="${testId}"`)
  return tag
}

function numericAttribute(markup: string, testId: string, attribute: string) {
  const tag = annotationTag(markup, testId)
  const value = tag.match(new RegExp(`\\b${attribute}="([^"]+)"`))?.[1]
  if (value === undefined) throw new Error(`Missing ${attribute} on ${testId}`)
  return Number(value)
}

function stringAttribute(markup: string, testId: string, attribute: string) {
  const tag = annotationTag(markup, testId)
  const value = tag.match(new RegExp(`\\b${attribute}="([^"]*)"`))?.[1]
  if (value === undefined) throw new Error(`Missing ${attribute} on ${testId}`)
  return value
}

function elementText(markup: string, testId: string) {
  const match = markup.match(new RegExp(`<[^>]*\\bdata-testid="${testId}"[^>]*>([^<]*)</[^>]+>`))
  if (!match) throw new Error(`Missing text for data-testid="${testId}"`)
  return match[1]
}

function styleNumber(markup: string, testId: string, property: string) {
  const tag = annotationTag(markup, testId)
  const style = tag.match(/style="([^"]*)"/)?.[1]
  const value = style?.match(new RegExp(`(?:^|;)${property}:\\s*([^;]+)`))?.[1]
  if (value === undefined) throw new Error(`Missing ${property} style on ${testId}`)
  return Number(value.trim().replace(/px$/, ''))
}

function assertDecisionPoint(markup: string, id: string, anchorX: number, anchorY: number, expectedProjectTime?: number) {
  const labelId = `decision-point-label-${id}`
  const anchorId = `decision-point-anchor-${id}`
  const connectorId = `decision-point-connector-${id}`
  const labelLeft = styleNumber(markup, labelId, 'left')
  const labelTop = styleNumber(markup, labelId, 'top')
  const labelWidth = styleNumber(markup, labelId, 'width')
  const labelHeight = styleNumber(markup, labelId, 'height')

  expect(labelLeft + labelWidth / 2).toBeCloseTo(anchorX)
  expect(labelWidth).toBe(200)
  expect(labelHeight).toBe(44)
  expect(numericAttribute(markup, anchorId, 'cx')).toBeCloseTo(anchorX)
  expect(numericAttribute(markup, anchorId, 'cy')).toBeCloseTo(anchorY)
  const connectorPoints = stringAttribute(markup, connectorId, 'points')
    .trim()
    .split(/\s+/)
    .map((point) => point.split(',').map(Number))
  expect(connectorPoints).toHaveLength(2)
  const [anchorPoint, labelPoint] = connectorPoints
  expect(anchorPoint[0]).toBeCloseTo(anchorX)
  expect(anchorPoint[1]).toBeCloseTo(anchorY)
  expect(labelPoint[0]).toBeCloseTo(anchorX)
  expect(labelPoint[1]).toBeCloseTo(id.startsWith('system') ? labelTop + labelHeight : labelTop)

  const radius = numericAttribute(markup, anchorId, 'r')
  expect(radius).toBe(id.startsWith('system') ? 4 : 7)
  if (expectedProjectTime !== undefined) expect(elementText(markup, `decision-point-time-${id}`)).toBe(`K线 ${formatDecisionDate(expectedProjectTime)}`)

  return { left: labelLeft, top: labelTop, right: labelLeft + labelWidth, bottom: labelTop + labelHeight }
}

function markerBlock(markup: string, testId: string) {
  const openingTag = annotationTag(markup, testId)
  const start = markup.indexOf(openingTag)
  const end = markup.indexOf('</g>', start)
  if (start < 0 || end < 0) throw new Error(`Missing marker group for ${testId}`)
  return markup.slice(start, end + 4)
}

function assertSystemCandleMarker(markup: string, id: string, anchorX: number, candleTime: number, highY: number, label: string) {
  const markerId = `decision-candle-marker-${id}`
  const columnId = `decision-candle-column-${id}`
  expect(Number(stringAttribute(markup, markerId, 'data-candle-time'))).toBe(candleTime)
  const transformValues = stringAttribute(markup, markerId, 'transform').match(/[-+]?(?:\d+\.?\d*|\.\d+)/g)?.map(Number) ?? []
  expect(transformValues).toHaveLength(2)
  expect(transformValues[0]).toBeCloseTo(anchorX)
  expect(transformValues[1]).toBeLessThan(highY)
  const columnX = numericAttribute(markup, columnId, 'x')
  const columnWidth = numericAttribute(markup, columnId, 'width')
  expect(columnX + columnWidth / 2).toBeCloseTo(anchorX)
  expect(numericAttribute(markup, columnId, 'y')).toBeLessThanOrEqual(highY)
  expect(markerBlock(markup, markerId)).toContain(`>${label}</text>`)
  return transformValues[1]
}

function annotationData(times: readonly number[], price = 100, high = price + 1, low = price - 1) {
  return times.map((time) => ({ time, open: price, high, low, close: price, volume: 10 }))
}

describe('decision replay components', () => {
  it('shows the causal entry reason and all four initial choices without revealing the system exit', () => {
    const item = candidate()
    const markup = renderToStaticMarkup(<DecisionReplayPanel
      candidate={item} attempt={createDecisionAttempt(item)} ordinal={1} total={30}
      onAdvance={noop} onSignalExtreme={noop} onFreePrice={noop} onSkip={noop}
      onManualClose={noop} onCancelPending={noop} onNextTrade={noop} onStop={noop}
    />)
    expect(markup).toContain('震荡区间向上真突破')
    expect(markup).toContain('这是用户必须在决策前直接看到的严格因果开仓理由')
    expect(markup).toContain('class="trade-marker-k-index"')
    expect(markup).toContain('>K8</span>')
    expect(markup).toContain('>K10</span>')
    expect(markup).not.toContain('当前 K 线')
    expect(markup).not.toContain('信号规则')
    expect(markup).not.toContain('计划止损依据')
    expect(markup).toContain('先观察')
    expect(markup).toContain('本 K 突破价挂单')
    expect(markup).toContain('自由选择挂单价')
    expect(markup).toContain('不参与')
    expect(markup).toContain('拖动移动决策详情框')
    expect(markup).toContain('调整决策详情框大小')
    expect(markup).toContain('data-testid="decision-action-menu"')
    expect(markup).toContain('data-testid="decision-action-drag-handle"')
    expect(markup).toContain('拖动移动决策操作框')
    expect(markup).not.toContain('不可提前显示的系统平仓理由')
  })

  it('shows next-candle, open-long and open-short choices before the first signal of a day sequence', () => {
    const item = candidate()
    const markup = renderToStaticMarkup(<DecisionReplayPanel
      candidate={item} attempt={createDecisionAttempt(item, 600)} ordinal={1} total={3}
      preSignal daySequenceMode
      onAdvance={noop} onSignalExtreme={noop} onFreePrice={noop} onSkip={noop}
      onManualClose={noop} onCancelPending={noop} onNextTrade={noop} onStop={noop}
    />)

    expect(markup).toContain('从当天第一根 K 线开始')
    expect(markup).toContain('播放下一根 K 线')
    expect(markup).toContain('<kbd>2</kbd><span><b>开多</b>')
    expect(markup).toContain('<kbd>3</kbd><span><b>开空</b>')
    expect(markup).toContain('按当前 K 线收盘价')
    expect(markup).toContain('未来信息保持隐藏')
    expect(markup).not.toContain('开多信号')
    expect(markup).not.toContain('震荡区间向上真突破')
    expect(markup).not.toContain('本 K 突破价挂单')
    expect(markup).not.toContain('自由选择挂单价')
    expect(markup).not.toContain('不参与')
  })

  it('shows the per-trade favorite control while the exercise is in progress', () => {
    const item = candidate()
    const markup = renderToStaticMarkup(<DecisionReplayPanel
      candidate={item} attempt={createDecisionAttempt(item)} ordinal={1} total={30}
      favorite onToggleFavorite={noop}
      onAdvance={noop} onSignalExtreme={noop} onFreePrice={noop} onSkip={noop}
      onManualClose={noop} onCancelPending={noop} onNextTrade={noop} onStop={noop}
    />)
    expect(markup).toContain('aria-label="取消收藏本笔交易"')
    expect(markup).toContain('aria-pressed="true"')
  })

  it('offers key 2 to cancel a pending order and continue the same exercise', () => {
    const item = candidate()
    const attempt = {
      ...createDecisionAttempt(item),
      stage: 'order-pending' as const,
      entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const,
      pendingEntryPrice: 101,
      initialStopLoss: 95,
      stopLoss: 95,
      takeProfit: 107,
    }
    const markup = renderToStaticMarkup(<DecisionReplayPanel
      candidate={item} attempt={attempt} ordinal={1} total={30}
      onAdvance={noop} onSignalExtreme={noop} onFreePrice={noop} onSkip={noop}
      onManualClose={noop} onCancelPending={noop} onNextTrade={noop} onStop={noop}
    />)
    expect(markup).toContain('<kbd>2</kbd>撤单并进入下一根 K 线')
    expect(markup).not.toContain('撤销挂单并跳过')
  })

  it('marks causal references and reveals system open/close only after their candles arrive', () => {
    const item = candidate()
    const data = [2400, 2700, 3000, 3300, 3600, 3900, 4200].map((time, index) => ({
      time, open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, volume: 10,
    }))
    const markup = renderToStaticMarkup(<DecisionChartAnnotations
      candidate={item}
      attempt={createDecisionAttempt(item)}
      result={null}
      data={data}
      toX={(time) => time / 100}
      toY={(price) => price}
    />)
    expect((markup.match(/decision-reason-candle-marker/g) ?? []).length).toBe(2)
    expect((markup.match(/class="decision-reason-anchor-line/g) ?? []).length).toBe(2)
    expect(markup).toContain('x1="24" y1="101"')
    expect(markup).toContain('x1="30" y1="103"')
    expect(markup).toContain('>K8</span>')
    expect(markup).toContain('>K10</span>')
    expect(markup).toContain('系统开 101.000')
    expect(markup).toContain('系统平 103.000')
    expect(markup).not.toContain('K14')

    const hiddenMarkup = renderToStaticMarkup(<DecisionChartAnnotations
      candidate={item}
      attempt={createDecisionAttempt(item)}
      result={null}
      data={data}
      toX={(time) => time / 100}
      toY={(price) => price}
      hidden
    />)
    expect(hiddenMarkup).toContain('class="decision-chart-annotations is-hidden"')

    const beforeSystemExit = renderToStaticMarkup(<DecisionChartAnnotations
      candidate={item}
      attempt={createDecisionAttempt(item)}
      result={null}
      data={data.slice(0, -1)}
      toX={(time) => time / 100}
      toY={(price) => price}
    />)
    expect(beforeSystemExit).toContain('系统开 101.000')
    expect(beforeSystemExit).not.toContain('系统平 103.000')
  })

  it('centers nearby system entry and exit labels on their candles in time order', () => {
    const entry = { time: 1_785_723_900, price: 4054.755 }
    const exit = { time: 1_785_725_100, price: 4061.040 }
    const firstTime = entry.time - 600
    const item = annotationCandidate(entry, exit)
    const markup = renderToStaticMarkup(<DecisionChartAnnotations
      candidate={item}
      attempt={createDecisionAttempt(item)}
      result={null}
      data={annotationData([firstTime, entry.time, entry.time + 300, exit.time], 4058, 4063, 4050)}
      toX={(time) => (time - firstTime) / 300}
      toY={(price) => 200 - (price - 4050) * 5}
    />)

    const entryRect = assertDecisionPoint(markup, 'system-entry', 2, 200 - (entry.price - 4050) * 5)
    const exitRect = assertDecisionPoint(markup, 'system-exit', 6, 200 - (exit.price - 4050) * 5)
    expect(entryRect.left).toBeLessThan(exitRect.left)
  })

  it('centers all same-bar system and user labels on their anchors without overlap', () => {
    const candleTime = 1_785_723_900
    const systemEntry = { time: candleTime, price: 4048.530 }
    const systemExit = { time: candleTime, price: 4048.920 }
    const userEntry = { time: candleTime + 60, price: 4048.530 }
    const userExit = { time: candleTime + 60, price: 4048.732 }
    const item = annotationCandidate(systemEntry, systemExit)
    const attempt = {
      ...createDecisionAttempt(item),
      stage: 'post-exit' as const,
      entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const,
      pendingEntryPrice: userEntry.price,
      initialStopLoss: userEntry.price - 10,
      stopLoss: userEntry.price - 10,
      takeProfit: userEntry.price + 10,
      fill: userEntry,
    }
    const result = buildDecisionResult(item, attempt, { ...userExit, reason: 'manual-close' }, [])
    const toY = (price: number) => 180 - (price - 4048) * 20
    const candleHighY = toY(4049.5)
    const candleLowY = toY(4047.0)
    const markup = renderToStaticMarkup(<DecisionChartAnnotations
      candidate={item}
      attempt={attempt}
      result={result}
      data={annotationData([candleTime], 4048, 4049.5, 4047.0)}
      toX={() => 64}
      toY={toY}
    />)

    const rects = [
      assertDecisionPoint(markup, 'system-entry', 64, toY(systemEntry.price), candleTime),
      assertDecisionPoint(markup, 'system-exit', 64, toY(systemExit.price), candleTime),
      assertDecisionPoint(markup, 'user-entry', 64, toY(userEntry.price), candleTime),
      assertDecisionPoint(markup, 'user-exit', 64, toY(userExit.price), candleTime),
    ]
    expect(rects[0].bottom).toBeLessThanOrEqual(candleHighY)
    expect(rects[1].bottom).toBeLessThanOrEqual(candleHighY)
    expect(rects[2].top).toBeGreaterThanOrEqual(candleLowY)
    expect(rects[3].top).toBeGreaterThanOrEqual(candleLowY)
    const entryBadgeY = assertSystemCandleMarker(markup, 'system-entry', 64, candleTime, candleHighY, '开')
    const exitBadgeY = assertSystemCandleMarker(markup, 'system-exit', 64, candleTime, candleHighY, '平')
    expect(Math.abs(entryBadgeY - exitBadgeY)).toBeGreaterThanOrEqual(20)
    for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < rects.length; rightIndex += 1) {
        const left = rects[leftIndex]
        const right = rects[rightIndex]
        const separated = left.right <= right.left || right.right <= left.left || left.bottom <= right.top || right.bottom <= left.top
        expect(separated).toBe(true)
      }
    }
  })

  it('does not render future system exit label geometry before its candle is revealed', () => {
    const entry = { time: 1_785_723_900, price: 4054.755 }
    const exit = { time: entry.time + 600, price: 4061.040 }
    const item = annotationCandidate(entry, exit)
    const markup = renderToStaticMarkup(<DecisionChartAnnotations
      candidate={item}
      attempt={createDecisionAttempt(item)}
      result={null}
      data={annotationData([entry.time - 300, entry.time], 4058, 4063, 4050)}
      toX={(time) => time - entry.time + 10}
      toY={(price) => 200 - (price - 4050) * 5}
    />)

    expect(markup).toContain('data-testid="decision-point-label-system-entry"')
    expect(markup).not.toContain('data-testid="decision-point-label-system-exit"')
    expect(markup).not.toContain('data-testid="decision-point-anchor-system-exit"')
    expect(markup).not.toContain('data-testid="decision-point-connector-system-exit"')
    expect(markup).not.toContain('data-testid="decision-candle-marker-system-exit"')
    expect(markup).not.toContain('data-testid="decision-candle-column-system-exit"')
  })

  it('retains the hidden annotation class while rendering point geometry', () => {
    const point = { time: 1_785_723_900, price: 4054.755 }
    const item = annotationCandidate(point, point)
    const markup = renderToStaticMarkup(<DecisionChartAnnotations
      candidate={item}
      attempt={createDecisionAttempt(item)}
      result={null}
      data={annotationData([point.time], 4058, 4063, 4050)}
      toX={() => 50}
      toY={(price) => 200 - (price - 4050) * 5}
      hidden
    />)

    expect(markup).toContain('class="decision-chart-annotations is-hidden"')
  })

  it('keeps the user open/close visible when reviewing a completed trade', () => {
    const item = candidate()
    const attempt = {
      ...createDecisionAttempt(item),
      stage: 'position-open' as const,
      entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const,
      pendingEntryPrice: 101,
      initialStopLoss: 95,
      stopLoss: 95,
      takeProfit: 107,
      fill: { time: 3300, price: 101 },
    }
    const result = buildDecisionResult(item, attempt, { time: 3900, price: 102, reason: 'manual-close' }, [])
    const data = [2400, 2700, 3000, 3300, 3600, 3900, 4200].map((time, index) => ({
      time, open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, volume: 10,
    }))
    const markup = renderToStaticMarkup(<DecisionChartAnnotations
      candidate={item}
      attempt={attempt}
      result={result}
      data={data}
      toX={(time) => time / 100}
      toY={(price) => price}
    />)
    expect(markup).toContain('你的开仓 101.000')
    expect(markup).toContain('你的平仓 102.000')
    expect(markup).toContain('class="user-path"')
  })

  it('renders three price levels, a draggable setup hint and the one-R default', () => {
    const markup = renderToStaticMarkup(<DecisionRiskOverlay
      candidate={candidate()} entryPrice={100} stopLoss={95} takeProfit={105}
      currentCandleX={42}
      toPrice={(y) => y} toY={(price) => price} onStopLoss={noop} onTakeProfit={noop}
      onConfirm={noop} onCancel={noop}
    />)
    expect(markup).toContain('止盈 105.000')
    expect(markup).toContain('data-testid="decision-take-profit-amount"')
    expect(markup).toContain('class="decision-risk-amount is-anchored"')
    expect(markup).toContain('style="left:42px;right:auto"')
    expect(markup).toContain('止盈金额')
    expect(markup).toContain('+$100.00')
    expect(markup).toContain('挂单 100.000 · 盈亏比 1 : 1.00')
    expect(markup).toContain('仓位 1×')
    expect(markup).toContain('止损 95.000')
    expect(markup).toContain('data-testid="decision-stop-loss-amount"')
    expect(markup).toContain('止损线参考盈亏（非最大亏损）')
    expect(markup).toContain('-$100.00')
    expect(markup).toContain('data-testid="decision-take-profit-line"')
    expect(markup).toContain('data-testid="decision-stop-loss-line"')
    expect(markup.match(/decision-risk-hit-area/g)).toHaveLength(2)
    expect(markup).toContain('title="拖动调整止盈"')
    expect(markup).toContain('title="拖动调整止损；按钮只切换本笔模式，不移动价格"')
    expect(markup).toContain('拖动上下两个控制点')
  })

  it('renders position decrease and increase controls and scales setup amounts', () => {
    const markup = renderToStaticMarkup(<DecisionRiskOverlay
      candidate={candidate()} entryPrice={100} stopLoss={95} takeProfit={105}
      positionMultiplier={2} onPositionMultiplierChange={noop}
      toPrice={(y) => y} toY={(price) => price} onStopLoss={noop} onTakeProfit={noop}
      onConfirm={noop} onCancel={noop}
    />)
    expect(markup).toContain('aria-label="减小仓位"')
    expect(markup).toContain('aria-label="增加仓位"')
    expect(markup).toContain('仓位 2×')
    expect(markup).toContain('+$200.00')
    expect(markup).toContain('-$200.00')
  })

  it('defaults the red-line selector to close mode and identifies touch as per-trade only', () => {
    const props = {
      candidate: candidate(), entryPrice: 100, stopLoss: 95, takeProfit: 105,
      toPrice: (y: number) => y, toY: (price: number) => price,
      onStopLoss: noop, onTakeProfit: noop, onStopLossMode: noop,
    }
    const close = renderToStaticMarkup(<DecisionRiskOverlay {...props} />)
    expect(close).toMatch(/<button[^>]*aria-pressed="true"[^>]*>收盘止损<\/button>/)
    expect(close).toMatch(/<button[^>]*aria-pressed="false"[^>]*>触碰止损<\/button>/)
    expect(close).toContain('止损线参考盈亏（非最大亏损）')
    const touch = renderToStaticMarkup(<DecisionRiskOverlay {...props} stopLossMode="touch" />)
    expect(touch).toMatch(/<button[^>]*aria-pressed="true"[^>]*>触碰止损<\/button>/)
    expect(touch).toContain('触碰止损仅本笔生效，下笔默认收盘止损')
    expect(touch).not.toContain('止损线参考盈亏（非最大亏损）')
    expect(styleNumber(close, 'decision-stop-loss-line', 'top')).toBe(95)
    expect(styleNumber(touch, 'decision-stop-loss-line', 'top')).toBe(95)
  })

  it('keeps risk lines editable while a position is open without setup controls', () => {
    const markup = renderToStaticMarkup(<DecisionRiskOverlay
      candidate={candidate()} entryPrice={100} stopLoss={95} takeProfit={105}
      toPrice={(y) => y} toY={(price) => price} onStopLoss={noop} onTakeProfit={noop}
      editable showConfirmControls={false}
    />)
    expect(markup).toContain('decision-risk-overlay editable')
    expect(markup).not.toContain('decision-risk-confirm')
    expect(markup).toContain('止盈 105.000')
    expect(markup).toContain('止损 95.000')
  })

  it('reverses amount label placement for short positions', () => {
    const item = candidate()
    const shortCandidate = { ...item, trade: { ...item.trade, side: 'short' as const } }
    const markup = renderToStaticMarkup(<DecisionRiskOverlay
      candidate={shortCandidate} entryPrice={100} stopLoss={105} takeProfit={95}
      currentCandleX={42}
      toPrice={(y) => y} toY={(price) => price} onStopLoss={noop} onTakeProfit={noop}
      editable showConfirmControls={false}
    />)
    expect(markup).toContain('decision-risk-overlay editable short')
    expect(markup).toContain('止盈 95.000')
    expect(markup).toContain('止损 105.000')
  })

  it('shows the filled entry line and live close-to-close PnL while holding', () => {
    const markup = renderToStaticMarkup(<DecisionRiskOverlay
      candidate={candidate()} entryPrice={101} entryLabel="开仓" stopLoss={95} takeProfit={107}
      currentClose={103} currentPnlUsd={40}
      toPrice={(y) => y} toY={(price) => price} onStopLoss={noop} onTakeProfit={noop}
      editable showConfirmControls={false}
    />)
    expect(markup).toContain('decision-risk-line entry filled')
    expect(markup).toContain('开仓 101.000 · 盈亏比 1 : 1.00')
    expect(markup).toContain('data-testid="decision-position-pnl-line"')
    expect(markup).toContain('收盘 103.000 · 浮盈 +$40.00')
  })

  it('uses the selected fixed-notional mode for live PnL and does not show fixed-risk labels', () => {
    const markup = renderToStaticMarkup(<DecisionRiskOverlay
      candidate={candidate()} entryPrice={101} entryLabel="开仓" stopLoss={95} takeProfit={107}
      currentClose={103} currentPnlByMode={{ 'fixed-risk': 40, 'fixed-notional': 198.019801980198 }} positionSizingModes={['fixed-notional']}
      toPrice={(y) => y} toY={(price) => price} onStopLoss={noop} onTakeProfit={noop}
      editable showConfirmControls={false}
    />)
    expect(markup).toContain('固定仓位 10,000U')
    expect(markup).toContain('浮盈 +$198.02')
    expect(markup).not.toContain('固定风险 100U')
    expect(markup).not.toContain('+$40.00')
  })

  it('shows current live PnL and the exercise total directly on the chart status', () => {
    const item = candidate()
    const attempt = {
      ...createDecisionAttempt(item), stage: 'position-open' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, stopLoss: 95, takeProfit: 107, fill: { time: 3300, price: 101 },
    }
    const session = { ...createDecisionSession([item], 1, 1, ['fixed-notional']), attempts: [attempt] }
    const markup = renderToStaticMarkup(<DecisionChartStatus
      session={session}
      attempt={attempt}
      currentPnlByMode={{ 'fixed-notional': 198.019801980198 }}
      positionSizingModes={['fixed-notional']}
    />)
    expect(markup).toContain('当前笔实时盈亏')
    expect(markup).toContain('本场累计净盈亏')
    expect(markup).toContain('参与胜率 <strong>—</strong>')
    expect(markup).toContain('本场 AI 累计净盈亏')
    expect(markup).toContain('data-testid="decision-chart-user-total"')
    expect(markup).toContain('data-testid="decision-chart-ai-total"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toMatch(/data-testid="decision-chart-ai-total"[\s\S]*\$0\.00/)
    expect(markup).toContain('+$198.02')
    expect(markup).toContain('仓位 10,000U')
    expect(markup).not.toContain('风险 100U')
    expect(markup).toContain('data-testid="decision-chart-status-drag-handle"')
    expect(markup).toContain('拖动移动本场练习盈亏')
  })

  it('renders every settled trade in the expandable chart PnL breakdown', () => {
    const first = candidate()
    const second = {
      ...candidate(),
      key: 'XAUUSD:5m:long:6000:6300',
      manualContinuation: true,
      trade: { ...candidate().trade, tradeNumber: 13 },
    }
    const firstAttempt = {
      ...createDecisionAttempt(first), stage: 'complete' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, initialStopLoss: 95, stopLoss: 95,
      fill: { time: 3300, price: 101 },
    }
    const secondAttempt = {
      ...createDecisionAttempt(second), stage: 'complete' as const, entryMode: 'market-close' as const,
      orderKind: null, pendingEntryPrice: 101, initialStopLoss: 95, stopLoss: 95,
      fill: { time: 6300, price: 101 },
    }
    const firstResult = buildDecisionResult(first, firstAttempt, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const secondResult = buildDecisionResult(second, secondAttempt, { time: 6600, price: 99, reason: 'manual-close' }, [])
    const session = {
      ...createDecisionSession([first, second], 2, 1, ['fixed-notional']),
      attempts: [{ ...firstAttempt, result: firstResult }, { ...secondAttempt, result: secondResult }],
    }
    const markup = renderToStaticMarkup(<DecisionChartPnlBreakdown
      session={session}
      results={[firstResult, secondResult]}
      focusActor="user"
      positionSizingModes={['fixed-notional']}
    />)

    expect(markup).toContain('data-testid="decision-chart-pnl-breakdown"')
    expect(markup).toContain('共 2 笔已结算交易')
    expect(markup).toContain('第 1 笔 · 多头')
    expect(markup).toContain('第 2 笔 · 多头')
    expect(markup).toContain('你的盈亏')
    expect(markup).toContain('AI 盈亏')
    expect(markup).toContain('差额')
    expect(markup).toContain('手动续单')
    expect(markup).toContain('无对应交易')
  })

  it('keeps the current system result floating until the next question is entered', () => {
    const item = candidate()
    const attempt = {
      ...createDecisionAttempt(item), stage: 'post-exit' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, stopLoss: 95, takeProfit: 107,
      fill: { time: 3300, price: 101 },
    }
    const result = buildDecisionResult(item, attempt, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const session = {
      ...createDecisionSession([item], 1, 1, ['fixed-notional']),
      attempts: [{ ...attempt, result }],
    }
    const markup = renderToStaticMarkup(<DecisionChartStatus
      session={session}
      attempt={session.attempts[0]}
      systemCurrentPnlByMode={{ 'fixed-notional': 99.009900990099 }}
      positionSizingModes={['fixed-notional']}
    />)
    const aiSection = markup.match(/<button[^>]*class="ai-total[\s\S]*?<\/button>/)?.[0] ?? ''
    expect(aiSection).toContain('已结算 0 笔 + 当前浮动')
    expect(aiSection).toContain('+$99.01')
    expect(aiSection).not.toContain('+$198.02')
  })

  it('locks the current system result once the system exit candle is visible', () => {
    const item = candidate()
    const attempt = {
      ...createDecisionAttempt(item), stage: 'post-exit' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, stopLoss: 95, takeProfit: 107,
      fill: { time: 3300, price: 101 },
    }
    const result = buildDecisionResult(item, attempt, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const session = {
      ...createDecisionSession([item], 1, 1, ['fixed-notional']),
      attempts: [{ ...attempt, result }],
    }
    const markup = renderToStaticMarkup(<DecisionChartStatus
      session={session}
      attempt={session.attempts[0]}
      systemCurrentPnlByMode={{ 'fixed-notional': 198.019801980198 }}
      systemCurrentPnlLocked
      positionSizingModes={['fixed-notional']}
    />)
    const aiSection = markup.match(/<button[^>]*class="ai-total[\s\S]*?<\/button>/)?.[0] ?? ''
    expect(aiSection).toContain('全部已结算 1 笔题目')
    expect(aiSection).toContain('+$198.02')
    expect(aiSection).not.toContain('当前浮动')
  })

  it('shows user win rate from settled participated trades and excludes skipped exercises', () => {
    const tradedCandidate = candidate()
    const skippedCandidate = { ...candidate(), key: 'XAUUSD:5m:long:6000:6300', trade: { ...candidate().trade, tradeNumber: 13 } }
    const tradedAttempt = {
      ...createDecisionAttempt(tradedCandidate), stage: 'complete' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, initialStopLoss: 95, stopLoss: 95, takeProfit: 107,
      fill: { time: 3300, price: 101 },
    }
    const skippedAttempt = { ...createDecisionAttempt(skippedCandidate), stage: 'complete' as const }
    const tradedResult = buildDecisionResult(tradedCandidate, tradedAttempt, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const skippedResult = buildDecisionResult(skippedCandidate, skippedAttempt, { time: 6300, price: 101, reason: 'skipped' }, [])
    const session = {
      ...createDecisionSession([tradedCandidate, skippedCandidate], 2, 1, ['fixed-notional']),
      currentIndex: 1,
      attempts: [{ ...tradedAttempt, result: tradedResult }, { ...skippedAttempt, result: skippedResult }],
    }
    const markup = renderToStaticMarkup(<DecisionChartStatus
      session={session}
      attempt={session.attempts[1]}
      positionSizingModes={['fixed-notional']}
    />)

    expect(markup).toContain('参与胜率 <strong>100.0%</strong>')
    expect(markup).toContain('参与 1 / 未参与 1 / 已结算 2 笔')
  })

  it('labels a pending order that reached the data boundary as unfilled', () => {
    const item = candidate()
    const pending = {
      ...createDecisionAttempt(item), stage: 'complete' as const, entryMode: 'free-price' as const,
      orderKind: 'limit' as const, pendingEntryPrice: 90, stopLoss: 85, takeProfit: 95,
    }
    const result = buildDecisionResult(item, pending, { time: 4500, price: 103, reason: 'end-of-data' }, [])
    const session = {
      ...createDecisionSession([item], 1, 1), status: 'completed' as const, activeSessionId: null,
      attempts: [{ ...pending, result }], finishedAt: 2,
    }
    const markup = renderToStaticMarkup(<DecisionResultsDialog session={session} onClose={noop} onReview={noop} onNew={noop} />)
    expect(markup).toContain('挂单未成交')
    expect(markup).not.toContain('未参与</span>')
  })

  it('uses fixed-notional values throughout results and review when that is the only selected mode', () => {
    const item = candidate()
    const filled = {
      ...createDecisionAttempt(item), stage: 'position-open' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, stopLoss: 95, takeProfit: 107, fill: { time: 3300, price: 101 },
    }
    const result = buildDecisionResult(item, filled, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const session = {
      ...createDecisionSession([item], 1, 1, ['fixed-notional']), status: 'completed' as const,
      attempts: [{ ...filled, stage: 'post-exit' as const, result }], finishedAt: 2,
    }
    const resultsMarkup = renderToStaticMarkup(<DecisionResultsDialog session={session} onClose={noop} onReview={noop} onNew={noop} />)
    const reviewMarkup = renderToStaticMarkup(<DecisionReviewPanel result={result} positionSizingModes={['fixed-notional']} onBack={noop} />)
    for (const markup of [resultsMarkup, reviewMarkup]) {
      expect(markup).toContain('固定仓位 10,000U')
      expect(markup).toContain('+$198.02')
      expect(markup).not.toContain('固定风险 100U')
      expect(markup).not.toContain('固定计划风险：每笔 $100')
      expect(markup).not.toContain('+$33.33')
    }
  })

  it('shows both labeled sizing modes in the results table and summary', () => {
    const item = candidate()
    const filled = {
      ...createDecisionAttempt(item), stage: 'position-open' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, stopLoss: 95, takeProfit: 107, fill: { time: 3300, price: 101 },
    }
    const result = buildDecisionResult(item, filled, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const session = {
      ...createDecisionSession([item], 1, 1, ['fixed-risk', 'fixed-notional']), status: 'completed' as const,
      attempts: [{ ...filled, stage: 'post-exit' as const, result }], finishedAt: 2,
    }
    const markup = renderToStaticMarkup(<DecisionResultsDialog session={session} onClose={noop} onReview={noop} onNew={noop} />)
    expect(markup).toContain('固定风险 100U')
    expect(markup).toContain('固定仓位 10,000U')
    expect(markup).toContain('+$33.33')
    expect(markup).toContain('+$198.02')
  })

  it('shows current-symbol history with user and system earnings comparison', () => {
    const item = candidate()
    const filled = {
      ...createDecisionAttempt(item),
      stage: 'position-open' as const,
      entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const,
      pendingEntryPrice: 101,
      stopLoss: 95,
      takeProfit: 107,
      fill: { time: 3300, price: 101 },
    }
    const result = buildDecisionResult(item, filled, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const session = {
      ...createDecisionSession([item], 1, 1),
      status: 'completed' as const,
      attempts: [{ ...filled, stage: 'post-exit' as const, result }],
      finishedAt: 2,
    }
    const markup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={[session]} onClose={noop} onOpenSession={noop}
      favoriteKeys={[decisionReplayFavoriteKey('trade', item.key)]}
    />)
    expect(markup).toContain('历史记录')
    expect(markup).toContain('<span>自定义模式笔数</span><b>1</b>')
    expect(markup).not.toContain('练习场次')
    expect(markup).toContain('你的自定义模式净盈亏')
    expect(markup).toContain('自定义模式系统参与净盈亏')
    expect(markup).toContain('自定义模式系统总净盈亏')
    expect(markup).not.toContain('日内逐根回放模式收益')
    expect(markup).toContain('aria-label="历史记录展示方式"')
    expect(markup).toContain('aria-pressed="true">逐笔交易</button>')
    expect(markup).toContain('aria-pressed="false">按卷子</button>')
    expect(markup).toContain('XAUUSD · 5分 · 多头 · 第 12 笔')
    expect(markup).toContain('查看已收藏记录')
    expect(markup).toContain('1 笔')
    expect(markup).toContain('点击直接打开这一笔的 K 线复盘与独立画图')
  })

  it('shows day-sequence earnings in a separate history module without mixing ordinary practice', () => {
    const item = candidate()
    const completedAttempt = (exitPrice: number) => {
      const filled = {
        ...createDecisionAttempt(item),
        stage: 'position-open' as const,
        entryMode: 'signal-extreme' as const,
        orderKind: 'stop' as const,
        pendingEntryPrice: 101,
        stopLoss: 95,
        takeProfit: 107,
        fill: { time: 3300, price: 101 },
      }
      const result = buildDecisionResult(item, filled, { time: 3600, price: exitPrice, reason: 'manual-close' }, [])
      return { ...filled, stage: 'post-exit' as const, result }
    }
    const daySession = {
      ...createDecisionSession([item], 1, 100, ['fixed-notional'], {
        practiceMode: 'day-sequence',
        daySequence: { key: 'XAUUSD:5m:2026-01-01', symbol: 'XAUUSD' as const, interval: '5m' as const, startTime: 1, endTime: 86_401 },
      }),
      id: 'day-sequence-history',
      status: 'completed' as const,
      attempts: [completedAttempt(103)],
      finishedAt: 101,
    }
    const ordinarySession = {
      ...createDecisionSession([item], 1, 200, ['fixed-notional']),
      id: 'ordinary-history',
      status: 'completed' as const,
      attempts: [completedAttempt(99)],
      finishedAt: 201,
    }
    const customMarkup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={[daySession, ordinarySession]} onClose={noop} onOpenSession={noop}
    />)
    const dayMarkup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={[daySession, ordinarySession]} onClose={noop} onOpenSession={noop}
      defaultStatsMode="day-sequence"
    />)
    const daySessionMarkup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={[daySession, ordinarySession]} onClose={noop} onOpenSession={noop}
      defaultStatsMode="day-sequence" defaultHistoryView="sessions"
    />)
    const customModuleStart = customMarkup.indexOf('data-testid="decision-custom-mode-history-summary"')
    const customModuleEnd = customMarkup.indexOf('class="decision-history-body"', customModuleStart)
    const customModeModule = customMarkup.slice(customModuleStart, customModuleEnd)
    const moduleStart = dayMarkup.indexOf('data-testid="decision-day-sequence-history-summary"')
    const moduleEnd = dayMarkup.indexOf('class="decision-history-body"', moduleStart)
    const daySequenceModule = dayMarkup.slice(moduleStart, moduleEnd)

    expect(customMarkup).toContain('aria-label="历史统计模式"')
    expect(customMarkup).toContain('aria-pressed="true">自定义模式 <b>1</b> 笔</button>')
    expect(customMarkup).toContain('aria-pressed="false">日内逐根回放 <b>1</b> 笔</button>')
    expect(customModuleStart).toBeGreaterThan(-1)
    expect(customModeModule).toContain('<span>自定义模式笔数</span><b>1</b>')
    expect(customModeModule).toContain('你的自定义模式净盈亏')
    expect(customModeModule).toContain('-$198.02')
    expect(moduleStart).toBeGreaterThan(-1)
    expect(dayMarkup).toContain('aria-label="日内逐根回放模式收益"')
    expect(daySequenceModule).toContain('<span>逐根回放笔数</span><b>1</b>')
    expect(daySequenceModule).toContain('1 场有记录 · 参与 1 笔 · 未参与 0 笔')
    expect(daySequenceModule).toContain('你的逐根回放净盈亏')
    expect(daySequenceModule).toContain('+$198.02')
    expect(daySequenceModule).not.toContain('-$198.02')
    expect(customMarkup).not.toContain('日内逐根回放 · 练习')
    expect(dayMarkup).toContain('日内逐根回放 · 练习')
    expect(daySessionMarkup).toContain('全部标的 · 日内逐根回放 · 按卷子汇总')
    expect(daySessionMarkup).toContain('XAUUSD · 日内逐根回放')
    expect(daySessionMarkup).not.toContain('XAUUSD · 决策练习')
  })

  it('renders every favorite trade as its own history card instead of grouping by session', () => {
    const first = candidate()
    const second: ReplayDecisionCandidate = {
      ...first,
      key: 'XAUUSD:5m:short:3600:3900',
      trade: {
        ...first.trade,
        tradeNumber: 13,
        side: 'short',
        entry: { ...first.trade.entry, signalTime: 3600, time: 3900 },
        exit: { ...first.trade.exit, time: 4800 },
      },
    }
    const completedAttempt = (item: ReplayDecisionCandidate) => {
      const filled = {
        ...createDecisionAttempt(item),
        stage: 'position-open' as const,
        entryMode: 'signal-extreme' as const,
        orderKind: 'stop' as const,
        pendingEntryPrice: 101,
        stopLoss: 95,
        takeProfit: 107,
        fill: { time: item.trade.entry.time, price: 101 },
      }
      const result = buildDecisionResult(item, filled, { time: item.trade.exit.time, price: 103, reason: 'manual-close' }, [])
      return { ...filled, stage: 'post-exit' as const, result }
    }
    const session = {
      ...createDecisionSession([first, second], 2, 1),
      status: 'completed' as const,
      attempts: [completedAttempt(first), completedAttempt(second)],
      finishedAt: 2,
    }
    const markup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={[session]} onClose={noop} onOpenSession={noop}
      defaultView="favorites"
      favoriteKeys={[
        decisionReplayFavoriteKey('trade', first.key),
        decisionReplayFavoriteKey('trade', second.key),
      ]}
    />)

    expect(markup).toContain('收藏笔数')
    expect(markup).toContain('逐笔收藏交易')
    expect(markup).toContain('XAUUSD · 5分 · 多头 · 第 12 笔')
    expect(markup).toContain('XAUUSD · 5分 · 空头 · 第 13 笔')
    expect(markup).toContain('本场第 1 / 2 笔')
    expect(markup).toContain('本场第 2 / 2 笔')
    expect(markup).toContain('点击直接打开这一笔的 K 线复盘与独立画图')
    expect(markup).not.toContain('XAUUSD · 决策练习')
  })

  it('shows round total R and average R based on the average initial stop distance', () => {
    const item = candidate()
    const filled = {
      ...createDecisionAttempt(item), stage: 'position-open' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, initialStopLoss: 95, stopLoss: 100, takeProfit: 107,
      fill: { time: 3300, price: 103 },
    }
    const result = buildDecisionResult(item, filled, { time: 3600, price: 105, reason: 'manual-close' }, [])
    const session = {
      ...createDecisionSession([item], 1, 1), status: 'completed' as const,
      attempts: [{ ...filled, stage: 'post-exit' as const, result }], finishedAt: 2,
    }
    const markup = renderToStaticMarkup(<DecisionResultsDialog session={session} onClose={noop} onReview={noop} onNew={noop} />)

    expect(markup).toContain('你的总盈亏（R）')
    expect(markup).toContain('每笔订单平均盈亏（R）')
    expect(markup).toContain('data-testid="decision-result-total-r"')
    expect(markup).toContain('data-testid="decision-result-average-r"')
    expect(markup).toContain('+0.25R')
    expect(markup).toContain('R 基准：参与订单初始止损距离平均 8')
  })

  it('can show one scorecard per practice session and open its trade details', () => {
    const item = candidate()
    const filled = {
      ...createDecisionAttempt(item),
      stage: 'position-open' as const,
      entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const,
      pendingEntryPrice: 101,
      stopLoss: 95,
      takeProfit: 107,
      fill: { time: 3300, price: 101 },
    }
    const result = buildDecisionResult(item, filled, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const session = {
      ...createDecisionSession([item], 1, 1),
      status: 'completed' as const,
      attempts: [{ ...filled, stage: 'post-exit' as const, result }],
      finishedAt: 2,
    }
    const markup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={[session]} onClose={noop} onOpenSession={noop}
      defaultHistoryView="sessions"
    />)

    expect(markup).toContain('全部标的 · 自定义模式 · 按卷子汇总')
    expect(markup).toContain('<span>自定义模式卷子数</span><b>1</b>')
    expect(markup).toContain('aria-pressed="true">按卷子</button>')
    expect(markup).toContain('aria-pressed="false">逐笔交易</button>')
    expect(markup).toContain('XAUUSD · 决策练习')
    expect(markup).toContain('本场进度')
    expect(markup).toContain('你的考分 · 净盈亏')
    expect(markup).toContain('系统考分 · 净盈亏')
    expect(markup).toContain('相对系统')
    expect(markup).toContain('点击查看本场每笔交易详情、收益对比和独立画图')
    expect(markup).toContain('开始：')
    expect(markup).toContain('完成：')
    expect(markup).not.toContain('XAUUSD · 5分 · 多头 · 第 12 笔')
  })

  it('does not render two identical scorecards from duplicated historical copies', () => {
    const item = candidate()
    const filled = {
      ...createDecisionAttempt(item),
      stage: 'position-open' as const,
      entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const,
      pendingEntryPrice: 101,
      stopLoss: 95,
      takeProfit: 107,
      fill: { time: 3300, price: 101 },
    }
    const result = buildDecisionResult(item, filled, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const session = {
      ...createDecisionSession([item], 1, 1),
      status: 'completed' as const,
      attempts: [{ ...filled, stage: 'post-exit' as const, result }],
      finishedAt: 2,
    }
    const duplicate = { ...session, id: `${session.id}-copy` }
    const markup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={[session, duplicate]} onClose={noop} onOpenSession={noop}
      defaultHistoryView="sessions"
    />)

    expect(markup).toContain('<span>自定义模式卷子数</span><b>1</b>')
    expect((markup.match(/XAUUSD · 决策练习/g) ?? []).length).toBe(1)
  })

  it('shows the last answer time instead of a completion time for an active session card', () => {
    const item = candidate()
    const session = {
      ...createDecisionSession([item], 1, 1000),
      status: 'active' as const,
      updatedAt: 3000,
      finishedAt: null,
    }
    const markup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={[session]} onClose={noop} onOpenSession={noop}
      defaultHistoryView="sessions"
    />)

    expect(markup).toContain('开始：')
    expect(markup).toContain('最后作答：')
    expect(markup).not.toContain('完成：')
  })

  it('shows per-symbol total and remaining counts in the new exercise selector', () => {
    const markup = renderToStaticMarkup(<DecisionReplayCenter
      open availableCount={5} totalCount={8}
      symbolStats={[
        { symbol: 'XAUUSD', total: 4, remaining: 3, intervals: [{ interval: '5m', total: 4, remaining: 3 }, { interval: '15m', total: 0, remaining: 0 }, { interval: '1h', total: 0, remaining: 0 }] },
        { symbol: 'BTCUSDT.P', total: 4, remaining: 2, intervals: [{ interval: '5m', total: 4, remaining: 2 }, { interval: '15m', total: 0, remaining: 0 }, { interval: '1h', total: 0, remaining: 0 }] },
        { symbol: 'US500', total: 2, remaining: 0, intervals: [{ interval: '5m', total: 2, remaining: 0 }, { interval: '15m', total: 0, remaining: 0 }, { interval: '1h', total: 0, remaining: 0 }] },
      ]}
      sessions={[]} activeSessionId={null} onClose={noop} onStart={noop} onContinue={noop} onResults={noop}
    />)
    expect(markup).toContain('选择标的')
    expect(markup).toContain('aria-label="选择决策回放模式"')
    expect(markup).toContain('自定义题目数量')
    expect(markup).toContain('随机交易日顺序回放')
    expect(markup).toContain('跨日期随机抽题，题量由你设置')
    expect(markup).toContain('随机一天，按信号时间从早到晚逐笔练习')
    expect(markup).toContain('XAUUSD')
    expect(markup).toContain('共 4 笔 · 剩余 3 笔')
    expect(markup).toContain('BTCUSDT.P')
    expect(markup).toContain('共 4 笔 · 剩余 2 笔')
    expect(markup).toContain('共 2 笔 · 剩余 0 笔')
    expect(markup).toContain('aria-label="选择练习时间级别"')
    expect(markup).toContain('<label class="decision-interval-option active"><input type="checkbox" checked=""/><span><b>5min</b>')
    expect(markup).toContain('<label class="decision-interval-option"><input type="checkbox"/><span><b>15min</b>')
    expect(markup).toContain('<label class="decision-interval-option"><input type="checkbox"/><span><b>1h</b>')
    expect(markup).toContain('disabled=""')
  })

  it('labels chronological day sessions with their Beijing date', () => {
    const item = candidate()
    const dayStart = Date.UTC(2025, 11, 31, 16) / 1000
    const session = createDecisionSession([item], 1, 1, ['fixed-risk'], {
      practiceMode: 'day-sequence',
      daySequence: { key: 'XAUUSD:5m:test-day', symbol: 'XAUUSD', interval: '5m', startTime: dayStart, endTime: dayStart + 86_400 },
    })
    const markup = renderToStaticMarkup(<DecisionChartStatus session={session} attempt={session.attempts[0]} />)

    expect(markup).toContain('2026/01/01 · 按日顺序 · 第 1 / 1 笔')
  })

  it('shows the independent anomaly redo entry with its verified count and safe disabled states', () => {
    const props = {
      open: true, availableCount: 5, totalCount: 8, symbolStats: [], sessions: [], activeSessionId: null,
      onClose: noop, onStart: noop, onContinue: noop, onResults: noop, onRedoAnomalies: noop,
    }
    const ready = renderToStaticMarkup(<DecisionReplayCenter {...props} anomalyCount={21} />)
    expect(ready).toContain('重做异常订单（21题）')
    expect(ready).toContain('独立重做 · 原记录保留')
    expect(annotationTag(ready, 'decision-anomaly-redo')).not.toContain('disabled')
    const empty = renderToStaticMarkup(<DecisionReplayCenter {...props} anomalyCount={0} />)
    expect(annotationTag(empty, 'decision-anomaly-redo')).toContain('disabled')
    const loading = renderToStaticMarkup(<DecisionReplayCenter {...props} anomalyCount={21} anomalyLoading />)
    expect(annotationTag(loading, 'decision-anomaly-redo')).toContain('disabled')
    expect(loading).toContain('正在核对异常订单…')
  })

  it('opens history on all symbols instead of silently filtering to the active symbol', () => {
    const item = candidate()
    const filled = {
      ...createDecisionAttempt(item), stage: 'position-open' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, stopLoss: 95, takeProfit: 107, fill: { time: 3300, price: 101 },
    }
    const result = buildDecisionResult(item, filled, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const session = { ...createDecisionSession([item], 1, 1), status: 'completed' as const, attempts: [{ ...filled, stage: 'post-exit' as const, result }], finishedAt: 2 }
    const markup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="BTCUSDT.P" sessions={[session]} onClose={noop} onOpenSession={noop}
    />)
    expect(markup).toContain('全部标的 · 自定义模式 · 逐笔交易记录')
    expect(markup).toContain('<span>自定义模式笔数</span><b>1</b><small>全部标的 · 不含逐根回放</small>')
    expect(markup).toContain('aria-label="历史记录标的筛选"')
    expect(markup).toContain('<input type="checkbox" checked=""/>全部标的')
    expect(markup).toContain('<input type="checkbox"/>XAUUSD')
    expect(markup).toContain('<input type="checkbox"/>BTCUSDT.P')
    expect(markup).toContain('aria-label="历史记录时间级别筛选"')
    expect(markup).toContain('<input type="checkbox" checked=""/>全部周期')
    expect(markup).toContain('<input type="checkbox"/>5分')
    expect(markup).toContain('<input type="checkbox"/>15分')
    expect(markup).toContain('<input type="checkbox"/>1小时')
    expect(markup).not.toContain('aria-label="历史记录范围"')
    expect(markup).toContain('aria-label="历史记录仓位显示方式"')
    expect(markup).toContain('class="active" aria-pressed="true">固定仓位 10,000U</button>')
    expect(markup).toContain('aria-pressed="false">固定风险 100U</button>')
    expect(markup).toContain('参与胜率 <strong>100.0%</strong> · 盈利 1 / 1 笔')
    expect(markup).toContain('自定义模式系统参与净盈亏')
    expect(markup).toContain('参与部分胜率 <strong>100.0%</strong> · 盈利 1 / 1 笔')
    expect(markup).toContain('自定义模式系统总净盈亏')
    expect(markup).toContain('总胜率 <strong>100.0%</strong> · 盈利 1 / 1 笔')
    expect(markup).toContain('aria-label="历史记录排序"')
    expect(markup).toContain('时间降序（最新优先）')
    expect(markup).toContain('时间升序（最早优先）')
    expect(markup).toContain('盈利降序（最高优先）')
    expect(markup).toContain('盈利升序（最低优先）')
    expect(markup).toContain('XAUUSD · 5分 · 多头 · 第 12 笔')
  })

  it('supports switching from all symbols to one or multiple checked symbols', () => {
    expect(toggleDecisionHistorySymbolSelection([], 'XAUUSD')).toEqual(['XAUUSD'])
    expect(toggleDecisionHistorySymbolSelection(['XAUUSD'], 'BTCUSDT.P')).toEqual(['XAUUSD', 'BTCUSDT.P'])
    expect(toggleDecisionHistorySymbolSelection(['XAUUSD', 'BTCUSDT.P'], 'XAUUSD')).toEqual(['BTCUSDT.P'])
    expect(toggleDecisionHistorySymbolSelection(['BTCUSDT.P'], 'BTCUSDT.P')).toEqual([])
  })

  it('supports switching from all intervals to one or multiple checked intervals', () => {
    expect(toggleDecisionHistoryIntervalSelection([], '5m')).toEqual(['5m'])
    expect(toggleDecisionHistoryIntervalSelection(['5m'], '15m')).toEqual(['5m', '15m'])
    expect(toggleDecisionHistoryIntervalSelection(['5m', '15m'], '5m')).toEqual(['15m'])
    expect(toggleDecisionHistoryIntervalSelection(['15m'], '15m')).toEqual([])
  })

  it('keeps skipped questions out of the user rate while including them in the system rate', () => {
    const first = candidate()
    const second = {
      ...candidate(),
      key: 'XAUUSD:5m:long:6000:6300',
      trade: { ...candidate().trade, tradeNumber: 13 },
    }
    const filled = {
      ...createDecisionAttempt(first), stage: 'position-open' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, stopLoss: 95, takeProfit: 107, fill: { time: 3300, price: 101 },
    }
    const won = buildDecisionResult(first, filled, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const skippedAttempt = createDecisionAttempt(second)
    const skipped = buildDecisionResult(second, skippedAttempt, { time: 6300, price: 0, reason: 'skipped' }, [])
    const session = {
      ...createDecisionSession([first, second], 2, 1),
      status: 'completed' as const,
      attempts: [
        { ...filled, stage: 'post-exit' as const, result: won },
        { ...skippedAttempt, stage: 'complete' as const, result: skipped },
      ],
      finishedAt: 2,
    }
    const markup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={[session]} onClose={noop} onOpenSession={noop}
    />)

    expect(markup).toContain('参与胜率 <strong>100.0%</strong> · 盈利 1 / 1 笔 · 未参与 1 笔交易')
    expect(markup).toContain('自定义模式系统参与净盈亏')
    expect(markup).toContain('参与部分胜率 <strong>100.0%</strong> · 盈利 1 / 1 笔')
    expect(markup).toContain('自定义模式系统总净盈亏')
    expect(markup).toContain('总胜率 <strong>100.0%</strong> · 盈利 2 / 2 笔')
    expect(markup).not.toContain('盈利 1 / 2 笔')
    expect(markup).toContain('未参与')
    expect(markup).toContain('未参与不计入你的胜率')
    expect(markup).toContain('全部 2 笔')
  })

  it('keeps an active session visible after partial progress', () => {
    const item = candidate()
    const session = {
      ...createDecisionSession([item], 1, 1),
      attempts: [{ ...createDecisionAttempt(item), stage: 'entry-price' as const, entryMode: 'free-price' as const }],
    }
    const markup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={[session]} onClose={noop} onOpenSession={noop}
    />)
    expect(markup).toContain('进行中')
    expect(markup).toContain('尚未结算')
    expect(markup).toContain('本场第 1 / 1 笔')
    expect(markup).toContain('XAUUSD · 5分 · 多头 · 第 12 笔')
  })

  it('keeps an observe-only step visible after the cursor advances', () => {
    const item = candidate()
    const session = {
      ...createDecisionSession([item], 1, 1),
      attempts: [{ ...createDecisionAttempt(item), cursorTime: 3600 }],
    }
    const markup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={[session]} onClose={noop} onOpenSession={noop}
    />)
    expect(markup).toContain('进行中')
    expect(markup).toContain('本场第 1 / 1 笔')
  })

  it('renders large histories in batches instead of mounting every trade card at once', () => {
    const sessions = Array.from({ length: 65 }, (_, index) => {
      const item = candidate()
      const attempt = { ...createDecisionAttempt(item), cursorTime: 3600 }
      return {
        ...createDecisionSession([item], 1, 1000 + index),
        id: `history-batch-${index}`,
        startedAt: 1000 + index,
        attempts: [attempt],
      }
    })
    const markup = renderToStaticMarkup(<DecisionHistoryDialog
      open currentSymbol="XAUUSD" sessions={sessions} onClose={noop} onOpenSession={noop}
    />)

    expect(markup.match(/class="decision-history-card decision-history-trade-card"/g)).toHaveLength(60)
    expect(markup).toContain('继续向下滚动加载')
    expect(markup).toContain('已显示 60 / 65')
  })

  it('does not scan decision sessions while the history dialog is closed', () => {
    const unreadableSessions = new Proxy([] as DecisionReplaySession[], {
      get: () => { throw new Error('closed history must not inspect sessions') },
    })

    expect(renderToStaticMarkup(<DecisionHistoryDialog
      open={false} currentSymbol="XAUUSD" sessions={unreadableSessions} onClose={noop} onOpenSession={noop}
    />)).toBe('')
  })

  it('keeps a closed trade on screen until the user explicitly chooses the next trade', () => {
    const item = candidate()
    const filled = {
      ...createDecisionAttempt(item),
      stage: 'position-open' as const,
      entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const,
      pendingEntryPrice: 101,
      stopLoss: 95,
      takeProfit: 107,
      fill: { time: 3300, price: 101 },
    }
    const result = buildDecisionResult(item, filled, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const attempt = { ...filled, stage: 'post-exit' as const, result }
    const markup = renderToStaticMarkup(<DecisionReplayPanel
      candidate={item} attempt={attempt} ordinal={1} total={30}
      onAdvance={noop} onSignalExtreme={noop} onFreePrice={noop} onSkip={noop}
      onManualClose={noop} onCancelPending={noop} onNextTrade={noop} onStop={noop}
    />)
    expect(markup).toContain('本笔已经平仓')
    expect(markup).toContain('本笔盈亏已锁定，可继续观看后续 K 线')
    expect(markup).toContain('继续观看下一根 K 线')
    expect(markup).toContain('进入下一笔交易')
    expect(markup).toContain('<kbd>5</kbd>重新开始这笔交易')
  })

  it('keeps day-sequence post-exit controls on keys 1, 2 and 3', () => {
    const item = candidate()
    const filled = {
      ...createDecisionAttempt(item),
      stage: 'position-open' as const,
      userSide: 'long' as const,
      entryMode: 'market-close' as const,
      pendingEntryPrice: 101,
      initialStopLoss: 95,
      stopLoss: 95,
      takeProfit: 107,
      fill: { time: 3300, price: 101 },
    }
    const result = buildDecisionResult(item, filled, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const markup = renderToStaticMarkup(<DecisionReplayPanel
      candidate={item} attempt={{ ...filled, stage: 'post-exit' as const, result }} ordinal={1} total={4}
      daySequenceMode canAdvanceTrade={false}
      onAdvance={noop} onSignalExtreme={noop} onFreePrice={noop} onSkip={noop}
      onOpenLong={noop} onOpenShort={noop}
      onManualClose={noop} onCancelPending={noop} onNextTrade={noop} onStop={noop}
    />)
    expect(markup).toContain('<kbd>1</kbd><span><b>播放下一根 K 线</b>')
    expect(markup).toContain('<kbd>2</kbd><span><b>开多</b>')
    expect(markup).toContain('<kbd>3</kbd><span><b>开空</b>')
    expect(markup).not.toContain('当天已无下一笔系统交易')
    expect(markup).not.toContain('disabled=""')
    expect(markup).not.toContain('进入下一笔交易')
    expect(markup).not.toContain('重新开始这笔交易')
  })

  it('shows the latest causally revealed signal in the day-sequence detail panel', () => {
    const activeBase = candidate()
    const active = { ...activeBase, key: 'active-signal:1', trade: { ...activeBase.trade, side: 'short' as const } }
    const latestTrade = candidate().trade
    const latestSignal = {
      id: 'decision-signal-test-4200-long',
      sourceId: 'test',
      kind: 'entry' as const,
      tradeMarkerId: 'replay-trade-test-2-entry',
      signalSide: 'long' as const,
      signalTime: 4200,
      trade: {
        ...latestTrade,
        entry: { ...latestTrade.entry, signalTime: 4200, setup: '最新多头反转', reason: '这是最新已经揭示的多头信号' },
      },
    }
    const markup = renderToStaticMarkup(<DecisionReplayPanel
      candidate={active} latestSignal={latestSignal} attempt={createDecisionAttempt(active, 4500)} ordinal={2} total={4}
      daySequenceMode
      onAdvance={noop} onSignalExtreme={noop} onFreePrice={noop} onSkip={noop}
      onOpenLong={noop} onOpenShort={noop}
      onManualClose={noop} onCancelPending={noop} onNextTrade={noop} onStop={noop}
    />)

    expect(markup).toContain('最新信号 K')
    expect(markup).toContain('当前 K：')
    expect(markup).toContain('开多信号')
    expect(markup).toContain('最新多头反转')
    expect(markup).toContain('这是最新已经揭示的多头信号')
    expect(markup).not.toContain(active.trade.entry.setup)
    expect(markup).not.toContain(active.trade.entry.reason)
  })
})
