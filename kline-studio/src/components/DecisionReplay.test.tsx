import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ReplayDecisionCandidate } from '../lib/replayTradeRegistry'
import {
  buildDecisionResult, createDecisionAttempt, createDecisionSession, toggleDecisionHistorySymbolSelection,
} from '../lib/decisionReplay'
import { decisionReplayFavoriteKey } from '../lib/decisionReplayFavorites'
import {
  DecisionChartAnnotations, DecisionChartStatus, DecisionHistoryDialog, DecisionReplayCenter, DecisionReplayPanel, DecisionResultsDialog, DecisionReviewPanel, DecisionRiskOverlay,
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
      toPrice={(y) => y} toY={(price) => price} onStopLoss={noop} onTakeProfit={noop}
      onConfirm={noop} onCancel={noop}
    />)
    expect(markup).toContain('止盈 105.000')
    expect(markup).toContain('挂单 100.000 · 盈亏比 1 : 1.00')
    expect(markup).toContain('止损 95.000')
    expect(markup).toContain('data-testid="decision-take-profit-line"')
    expect(markup).toContain('data-testid="decision-stop-loss-line"')
    expect(markup.match(/decision-risk-hit-area/g)).toHaveLength(2)
    expect(markup).toContain('title="拖动调整止盈"')
    expect(markup).toContain('title="拖动调整止损"')
    expect(markup).toContain('拖动上下两个控制点')
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
    expect(markup).toContain('data-testid="decision-chart-ai-total"')
    expect(markup).toMatch(/data-testid="decision-chart-ai-total"[\s\S]*\$0\.00/)
    expect(markup).toContain('+$198.02')
    expect(markup).toContain('仓位 10,000U')
    expect(markup).not.toContain('风险 100U')
    expect(markup).toContain('data-testid="decision-chart-status-drag-handle"')
    expect(markup).toContain('拖动移动本场练习盈亏')
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
    expect(markup).toContain('<span>总笔数</span><b>1</b>')
    expect(markup).not.toContain('练习场次')
    expect(markup).toContain('你的累计净盈亏')
    expect(markup).toContain('系统参与部分净盈亏')
    expect(markup).toContain('系统总净盈亏')
    expect(markup).toContain('XAUUSD · 5分 · 多头 · 第 12 笔')
    expect(markup).toContain('查看已收藏记录')
    expect(markup).toContain('1 笔')
    expect(markup).toContain('点击直接打开这一笔的 K 线复盘与独立画图')
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

  it('shows per-symbol total and remaining counts in the new exercise selector', () => {
    const markup = renderToStaticMarkup(<DecisionReplayCenter
      open availableCount={5} totalCount={8}
      symbolStats={[
        { symbol: 'XAUUSD', total: 4, remaining: 3 },
        { symbol: 'BTCUSDT.P', total: 4, remaining: 2 },
        { symbol: 'US500', total: 2, remaining: 0 },
      ]}
      sessions={[]} activeSessionId={null} onClose={noop} onStart={noop} onContinue={noop} onResults={noop}
    />)
    expect(markup).toContain('选择标的')
    expect(markup).toContain('XAUUSD')
    expect(markup).toContain('共 4 笔 · 剩余 3 笔')
    expect(markup).toContain('BTCUSDT.P')
    expect(markup).toContain('共 4 笔 · 剩余 2 笔')
    expect(markup).toContain('共 2 笔 · 剩余 0 笔')
    expect(markup).toContain('disabled=""')
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
    expect(markup).toContain('全部标的 · 逐笔交易记录')
    expect(markup).toContain('<span>总笔数</span><b>1</b><small>全部标的</small>')
    expect(markup).toContain('aria-label="历史记录标的筛选"')
    expect(markup).toContain('<input type="checkbox" checked=""/>全部标的')
    expect(markup).toContain('<input type="checkbox"/>XAUUSD')
    expect(markup).toContain('<input type="checkbox"/>BTCUSDT.P')
    expect(markup).not.toContain('aria-label="历史记录范围"')
    expect(markup).toContain('aria-label="历史记录仓位显示方式"')
    expect(markup).toContain('class="active" aria-pressed="true">固定仓位 10,000U</button>')
    expect(markup).toContain('aria-pressed="false">固定风险 100U</button>')
    expect(markup).toContain('参与胜率 <strong>100.0%</strong> · 盈利 1 / 1 笔')
    expect(markup).toContain('系统参与部分净盈亏')
    expect(markup).toContain('参与部分胜率 <strong>100.0%</strong> · 盈利 1 / 1 笔')
    expect(markup).toContain('系统总净盈亏')
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
    expect(markup).toContain('系统参与部分净盈亏')
    expect(markup).toContain('参与部分胜率 <strong>100.0%</strong> · 盈利 1 / 1 笔')
    expect(markup).toContain('系统总净盈亏')
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
  })
})
