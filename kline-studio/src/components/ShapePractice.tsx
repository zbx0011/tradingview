import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, BarChart3, Check, ChevronDown, CircleAlert, CircleCheck, Eye, Flag, Play, RotateCcw,
} from 'lucide-react'
import {
  SHAPE_PRACTICE_RISK_USD, advanceShapePractice, cancelShapePracticePendingOrder,
  finishShapePracticeQuestion, formatShapePracticeTime, getShapePracticeVisibleSlice, loadShapePracticeStore,
  queueShapePracticeOrder, requestShapePracticeManualClose, saveShapePracticeStore, shapePracticeMark,
  summarizeShapePracticeScore, validateShapePracticeDataset,
} from '../lib/shapePractice'
import type {
  ShapePracticeBar, ShapePracticeDataset, ShapePracticePosition, ShapePracticeProgress, ShapePracticeQuestion,
  ShapePracticeSide, ShapePracticeStore,
} from '../lib/shapePractice'
import './ShapePractice.css'

const SHAPE_PRACTICE_DATA_URL = `${import.meta.env.BASE_URL}data/shape-practice/xauusd-5m-strong22.json`

function price(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
}

function quantity(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function money(value: number) {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function rText(value: number) {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}R`
}

function exitReasonLabel(reason: string) {
  if (reason === 'stop-loss') return '止损'
  if (reason === 'take-profit') return '止盈'
  if (reason === 'manual-close') return '手动平仓'
  return '结束题目结算'
}

function sideLabel(side: ShapePracticeSide) {
  return side === 'long' ? '多' : '空'
}

function yLabel(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}

interface ShapePracticeChartProps {
  question: ShapePracticeQuestion
  progress: ShapePracticeProgress
}

function ShapePracticeChart({ question, progress }: ShapePracticeChartProps) {
  const visible = useMemo(() => getShapePracticeVisibleSlice(question, progress.cursor), [question, progress.cursor])
  const width = 1000
  const height = 470
  const padding = { top: 24, right: 74, bottom: 42, left: 16 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const values = visible.bars.flatMap((bar) => [bar.high, bar.low]).concat(visible.ema20.filter(Number.isFinite))
  const rawMax = Math.max(...values, 1)
  const rawMin = Math.min(...values, rawMax - 1)
  const margin = Math.max((rawMax - rawMin) * 0.06, 0.00001)
  const max = rawMax + margin
  const min = rawMin - margin
  const range = Math.max(max - min, 0.00001)
  const step = visible.bars.length > 0 ? plotWidth / visible.bars.length : plotWidth
  const candleWidth = Math.max(2, Math.min(13, step * 0.66))
  const xFor = (index: number) => padding.left + step * (index + 0.5)
  const yFor = (value: number) => padding.top + (max - value) / range * plotHeight
  const emaPath = visible.ema20.map((value, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index).toFixed(2)} ${yFor(value).toFixed(2)}`).join(' ')
  const grid = [0, 1, 2, 3, 4].map((index) => {
    const value = max - range * index / 4
    return { value, y: yFor(value) }
  })
  const labels = visible.bars.length === 0 ? [] : [0, Math.floor((visible.bars.length - 1) / 2), visible.bars.length - 1]
    .filter((index, position, list) => list.indexOf(index) === position)

  return <div className="shape-practice-chart-wrap" data-testid="shape-practice-known-chart">
    {visible.bars.length === 0 ? <div className="shape-practice-chart-empty">当前没有可显示的 K 线</div> : <svg className="shape-practice-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`已知 ${visible.bars.length} 根 K 线和 EMA20`}>
      <defs>
        <linearGradient id="shape-practice-chart-fade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#202a3e" stopOpacity=".72" />
          <stop offset="1" stopColor="#111722" stopOpacity=".24" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={width} height={height} fill="url(#shape-practice-chart-fade)" />
      {grid.map((line) => <g key={line.value} className="shape-practice-grid-line"><line x1={padding.left} x2={width - padding.right + 8} y1={line.y} y2={line.y} /><text x={width - padding.right + 14} y={line.y + 4}>{yLabel(line.value)}</text></g>)}
      <line className="shape-practice-axis-line" x1={padding.left} x2={width - padding.right + 8} y1={height - padding.bottom} y2={height - padding.bottom} />
      {visible.bars.map((bar: ShapePracticeBar, index) => {
        const isUp = bar.close >= bar.open
        const candleX = xFor(index)
        const bodyTop = yFor(Math.max(bar.open, bar.close))
        const bodyBottom = yFor(Math.min(bar.open, bar.close))
        const bodyHeight = Math.max(1.5, bodyBottom - bodyTop)
        return <g key={`${bar.time}-${index}`} data-testid={`shape-practice-candle-${visible.startIndex + index}`} className={`shape-practice-candle ${isUp ? 'is-up' : 'is-down'}${index === visible.bars.length - 1 ? ' is-current' : ''}`}>
          <line x1={candleX} x2={candleX} y1={yFor(bar.high)} y2={yFor(bar.low)} />
          <rect x={candleX - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight} />
        </g>
      })}
      {emaPath && <path className="shape-practice-ema" d={emaPath} fill="none" />}
      {labels.map((index) => <text key={index} className="shape-practice-time-label" x={xFor(index)} y={height - 14} textAnchor={index === 0 ? 'start' : index === visible.bars.length - 1 ? 'end' : 'middle'}>{formatShapePracticeTime(visible.bars[index].time)}</text>)}
    </svg>}
    <span className="shape-practice-ema-legend"><i /> EMA20（只用已知 K 线）</span>
  </div>
}

function PositionCard({ position, current }: { position: ShapePracticePosition; current: ShapePracticeBar }) {
  const mark = shapePracticeMark(position, current.close)
  return <div className="shape-practice-position-card is-open">
    <div className="shape-practice-card-heading"><span><span className={`shape-practice-side-dot ${position.side}`} />持仓中 · 开{sideLabel(position.side)}</span><span className={mark.pnlUsd >= 0 ? 'is-positive' : 'is-negative'}>{money(mark.pnlUsd)} · {rText(mark.rMultiple)}</span></div>
    <dl className="shape-practice-mini-grid">
      <div><dt>入场</dt><dd>{price(position.entryPrice)}</dd></div>
      <div><dt>数量</dt><dd>{quantity(position.quantity)}</dd></div>
      <div><dt>止损</dt><dd>{price(position.stopLoss)}</dd></div>
      <div><dt>止盈</dt><dd>{position.takeProfit === undefined ? '无' : price(position.takeProfit)}</dd></div>
    </dl>
    {position.manualCloseRequestedAtIndex !== undefined && <p className="shape-practice-inline-note">手动平仓已排队，将在下一根 K 线开盘执行。</p>}
  </div>
}

function ResultCard({ progress }: { progress: ShapePracticeProgress }) {
  if (!progress.result) return null
  const result = progress.result
  return <div className={`shape-practice-position-card shape-practice-result-card ${result.pnlUsd >= 0 ? 'is-profit' : 'is-loss'}`}>
    <div className="shape-practice-card-heading"><span><CircleCheck size={16} />本题交易结果</span><span className={result.pnlUsd >= 0 ? 'is-positive' : 'is-negative'}>{money(result.pnlUsd)} · {rText(result.rMultiple)}</span></div>
    <p>{sideLabel(result.side)}向 · {exitReasonLabel(result.exitReason)}{result.forcedAtFinish ? ' · 结束题目强制结算' : ''}</p>
    <div className="shape-practice-result-line">入场 {price(result.entryPrice)} → 出场 {price(result.exitPrice)} · 固定风险 ${result.riskUsd.toFixed(0)}</div>
  </div>
}

function CompletedScore({ dataset, store }: { dataset: ShapePracticeDataset; store: ShapePracticeStore }) {
  const states = dataset.questions.map((question) => store.questions[question.id]).filter((state): state is ShapePracticeProgress => Boolean(state))
  const score = summarizeShapePracticeScore(states, dataset.questions.length)
  const completed = dataset.questions.filter((question) => store.questions[question.id]?.status === 'completed')
  return <div className="shape-practice-score-panel" role="region" aria-label="已完题成绩">
    <div className="shape-practice-score-heading"><div><b>已完题成绩</b><small>进度会持续保存在本地</small></div><span>{score.completed}/{score.total} 题</span></div>
    <div className="shape-practice-score-grid">
      <div><small>已交易</small><b>{score.traded}</b></div>
      <div><small>胜率</small><b>{score.winRate === null ? '—' : `${score.winRate.toFixed(1)}%`}</b></div>
      <div><small>净盈亏</small><b className={score.netPnlUsd >= 0 ? 'is-positive' : 'is-negative'}>{money(score.netPnlUsd)}</b></div>
      <div><small>净 R</small><b className={score.netR >= 0 ? 'is-positive' : 'is-negative'}>{rText(score.netR)}</b></div>
    </div>
    <div className="shape-practice-score-list">
      {completed.length === 0 ? <p className="shape-practice-empty-copy">还没有结束的题目。</p> : completed.map((question) => {
        const result = store.questions[question.id].result
        return <div className="shape-practice-score-row" key={question.id}><strong>{question.id}</strong>{result ? <><span>{exitReasonLabel(result.exitReason)}</span><b className={result.pnlUsd >= 0 ? 'is-positive' : 'is-negative'}>{money(result.pnlUsd)} · {rText(result.rMultiple)}</b></> : <span>只观察 · 无交易</span>}</div>
      })}
    </div>
  </div>
}

export function ShapePractice({ onClose }: { onClose: () => void }) {
  const [dataset, setDataset] = useState<ShapePracticeDataset | null>(null)
  const [store, setStore] = useState<ShapePracticeStore | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  const [persistenceEnabled, setPersistenceEnabled] = useState(true)
  const [uiMessage, setUiMessage] = useState<string | null>(null)
  const [slInput, setSlInput] = useState('')
  const [tpInput, setTpInput] = useState('')
  const [scoreOpen, setScoreOpen] = useState(false)

  useEffect(() => {
    let disposed = false
    fetch(SHAPE_PRACTICE_DATA_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<unknown>
      })
      .then((raw) => {
        if (disposed) return
        const validated = validateShapePracticeDataset(raw)
        if (!validated.ok) throw new Error(validated.error)
        const restored = loadShapePracticeStore(validated.data)
        if (disposed) return
        setDataset(validated.data)
        setStore(restored.state)
        setSelectedId((restored.state.selectedQuestionId || validated.data.questions[0]?.id) ?? null)
        setStorageWarning(restored.warning ?? null)
        setPersistenceEnabled(restored.canPersist)
      })
      .catch((error: unknown) => {
        if (disposed) return
        setLoadError(error instanceof Error ? error.message : '题库加载失败。')
      })
    return () => { disposed = true }
  }, [])

  const question = dataset?.questions.find((item) => item.id === selectedId) ?? null
  const progress = question && store ? store.questions[question.id] : null
  const questionNumber = question && dataset ? dataset.questions.findIndex((item) => item.id === question.id) + 1 : 0
  const score = useMemo(() => {
    if (!dataset || !store) return null
    return summarizeShapePracticeScore(dataset.questions.map((item) => store.questions[item.id]), dataset.questions.length)
  }, [dataset, store])

  function persist(next: ShapePracticeStore) {
    if (!persistenceEnabled) return
    const saved = saveShapePracticeStore(next)
    if (!saved.ok) {
      if (saved.warning) setStorageWarning(saved.warning)
      setPersistenceEnabled(false)
    }
  }

  function commitProgress(next: ShapePracticeProgress) {
    if (!store || !question) return store
    const nextStore = { ...store, questions: { ...store.questions, [question.id]: next } }
    setStore(nextStore)
    persist(nextStore)
    return nextStore
  }

  function selectQuestion(id: string, baseStore: ShapePracticeStore | null = store) {
    if (!dataset || !dataset.questions.some((item) => item.id === id)) return
    setSelectedId(id)
    setSlInput('')
    setTpInput('')
    setUiMessage(null)
    if (baseStore) {
      const nextStore = { ...baseStore, selectedQuestionId: id }
      setStore(nextStore)
      persist(nextStore)
    }
  }

  function handleAdvance() {
    if (!question || !progress) return
    const result = advanceShapePractice(question, progress)
    if (!result.ok) {
      setUiMessage(result.message ?? '无法前进。')
      return
    }
    commitProgress(result.state)
    setUiMessage(null)
  }

  function handleEntry(side: ShapePracticeSide) {
    if (!question || !progress) return
    const stopLoss = Number(slInput)
    const takeProfit = tpInput.trim() === '' ? undefined : Number(tpInput)
    const result = queueShapePracticeOrder(question, progress, side, stopLoss, takeProfit)
    if (!result.ok) {
      setUiMessage(result.message ?? '订单参数无效。')
      return
    }
    commitProgress(result.state)
    setUiMessage(null)
  }

  function handleManualClose() {
    if (!question || !progress) return
    const result = requestShapePracticeManualClose(question, progress)
    if (!result.ok) {
      setUiMessage(result.message ?? '无法手动平仓。')
      return
    }
    commitProgress(result.state)
    setUiMessage(null)
  }

  function selectNextQuestion() {
    if (!dataset || !question) return
    const current = dataset.questions.findIndex((item) => item.id === question.id)
    const next = dataset.questions[(current + 1) % dataset.questions.length]
    selectQuestion(next.id)
  }

  function handleFinish() {
    if (!question || !progress) return
    if (progress.status === 'completed') {
      selectNextQuestion()
      return
    }
    const result = finishShapePracticeQuestion(question, progress)
    if (!result.ok) {
      setUiMessage(result.message ?? '无法结束本题。')
      return
    }
    const nextStore = commitProgress(result.state)
    setUiMessage(null)
    if (dataset && questionNumber < dataset.questions.length && nextStore) selectQuestion(dataset.questions[questionNumber].id, nextStore)
  }

  const currentBar = question && progress ? question.bars[Math.max(0, Math.min(question.bars.length - 1, progress.cursor))] : null
  const isAtEnd = question && progress ? progress.cursor >= question.bars.length - 1 : false
  const isFinished = progress?.status === 'completed'

  return <div className="shape-practice-backdrop">
    <section className="shape-practice-dialog" role="dialog" aria-modal="true" aria-label="按K线形态练习">
      <header className="shape-practice-header">
        <div className="shape-practice-title-block"><span className="shape-practice-logo"><BarChart3 size={19} /></span><div><h1>按 K 线形态练习</h1><p>逐根观察 · 模拟订单 · 独立保存进度</p></div></div>
        {dataset && <div className="shape-practice-header-controls">
          <span className="shape-practice-question-count">题目 {questionNumber || '—'} / {dataset.questions.length}</span>
          <label className="shape-practice-selector">选择题目 <select aria-label="选择题目" value={selectedId ?? ''} onChange={(event) => selectQuestion(event.target.value)}><option value="" disabled>—</option>{dataset.questions.map((item) => <option value={item.id} key={item.id}>{item.id}{store?.questions[item.id]?.status === 'completed' ? ' · 已完成' : ''}</option>)}</select><ChevronDown size={15} /></label>
          <button type="button" className="shape-practice-close-button" onClick={onClose}><ArrowLeft size={16} />返回</button>
        </div>}
        {!dataset && <button type="button" className="shape-practice-close-button" onClick={onClose}><ArrowLeft size={16} />返回</button>}
      </header>

      {loadError ? <div className="shape-practice-state-panel is-error" role="alert"><CircleAlert size={22} /><div><strong>题库无法加载</strong><p>{loadError}</p><small>请确认本地静态数据路径可访问后重试。</small></div><button type="button" onClick={() => window.location.reload()}><RotateCcw size={16} />重试</button></div>
        : !dataset || !store || !question || !progress ? <div className="shape-practice-state-panel"><span className="shape-practice-spinner" /><div><strong>正在加载练习题库</strong><p>验证 22 道题目与因果 EMA20…</p></div></div>
        : <>
          {(storageWarning || uiMessage) && <div className={`shape-practice-notice ${storageWarning ? 'is-warning' : ''}`} role={storageWarning ? 'alert' : 'status'}><span>{storageWarning ? <CircleAlert size={16} /> : <Check size={16} />}</span><span>{storageWarning ?? uiMessage}</span></div>}
          <main className="shape-practice-main">
            <section className="shape-practice-chart-card">
              <div className="shape-practice-chart-toolbar">
                <div><strong>{dataset.symbol}</strong><span>{dataset.timeframeMinutes} 分钟 · 题目 {question.id}</span></div>
                <div className="shape-practice-known-progress"><span data-testid="shape-practice-cursor">已知第 {progress.cursor + 1} / {question.bars.length} 根</span><span className={isFinished ? 'is-complete' : ''}>{isFinished ? '本题已完成' : '练习中'}</span></div>
              </div>
              <div className="shape-practice-ohlc" data-testid="shape-practice-current-ohlc">
                <div><small>时间（北京时间）</small><b>{currentBar ? formatShapePracticeTime(currentBar.time) : '—'}</b></div>
                <div><small>开</small><b>{currentBar ? price(currentBar.open) : '—'}</b></div><div><small>高</small><b>{currentBar ? price(currentBar.high) : '—'}</b></div><div><small>低</small><b>{currentBar ? price(currentBar.low) : '—'}</b></div><div><small>收</small><b>{currentBar ? price(currentBar.close) : '—'}</b></div>
              </div>
              <ShapePracticeChart question={question} progress={progress} />
              <div className="shape-practice-chart-footer"><span>图表只显示当前游标之前的已知 K 线；未来 K 线不会进入图表或价轴。</span><span>蓝线 EMA20</span></div>
            </section>

            <aside className="shape-practice-control-card">
              <div className="shape-practice-control-heading"><div><b>当前练习</b><small>{isFinished ? '已保存，可以查看走势和成绩' : '每次只允许一笔模拟交易'}</small></div><span className={`shape-practice-status-pill ${isFinished ? 'is-complete' : ''}`}>{isFinished ? <><CircleCheck size={14} />已完成</> : <><Eye size={14} />观察中</>}</span></div>

              <div className="shape-practice-action-box">
                <div className="shape-practice-box-title"><span>逐根推进</span><small>只推进一根已知 K 线</small></div>
                <button type="button" className="shape-practice-step-button" disabled={isAtEnd} onClick={handleAdvance}><Play size={17} fill="currentColor" />下一根 K 线</button>
                <p className="shape-practice-help">订单会在下一根 K 线的开盘成交；当前 K 线收盘不会直接成交。</p>
              </div>

              {!isFinished && !progress.position && !progress.pendingOrder && !progress.result && <div className="shape-practice-action-box">
                <div className="shape-practice-box-title"><span>模拟开仓</span><small>固定止损风险 ${SHAPE_PRACTICE_RISK_USD}</small></div>
                <label className="shape-practice-field">止损价格<input aria-label="止损价格" type="number" inputMode="decimal" step="0.001" value={slInput} onChange={(event) => setSlInput(event.target.value)} placeholder="先输入止损" /></label>
                <label className="shape-practice-field">止盈价格 <span className="shape-practice-optional">可选</span><input aria-label="止盈价格" type="number" inputMode="decimal" step="0.001" value={tpInput} onChange={(event) => setTpInput(event.target.value)} placeholder="留空则不设" /></label>
                <div className="shape-practice-entry-buttons"><button type="button" className="is-long" disabled={!slInput || isAtEnd} onClick={() => handleEntry('long')}>开多</button><button type="button" className="is-short" disabled={!slInput || isAtEnd} onClick={() => handleEntry('short')}>开空</button></div>
                <p className="shape-practice-help">下单前会检查止损方向；若下一根开盘跳空使止损失效，挂单会撤销并说明原因。</p>
              </div>}

              {progress.pendingOrder && <div className="shape-practice-action-box is-pending"><div className="shape-practice-box-title"><span>等待开盘成交</span><small>{sideLabel(progress.pendingOrder.side)}向 · 下一根开盘</small></div><div className="shape-practice-pending-lines"><span>止损 {price(progress.pendingOrder.stopLoss)}</span><span>止盈 {progress.pendingOrder.takeProfit === undefined ? '无' : price(progress.pendingOrder.takeProfit)}</span></div><button type="button" className="shape-practice-secondary-button" onClick={() => { const result = cancelShapePracticePendingOrder(question, progress); if (result.ok) { commitProgress(result.state); setUiMessage(null) } else setUiMessage(result.message ?? '无法取消挂单。') }}>取消等待成交</button></div>}
              {progress.position && currentBar && <><PositionCard position={progress.position} current={currentBar} /><button type="button" className="shape-practice-manual-close" disabled={progress.position.manualCloseRequestedAtIndex !== undefined || isAtEnd} onClick={handleManualClose}>{progress.position.manualCloseRequestedAtIndex !== undefined ? '已排队，下一根开盘平仓' : '手动平仓（下一根开盘）'}</button></>}
              {!progress.position && !progress.pendingOrder && !progress.result && <div className="shape-practice-observe-copy"><Eye size={17} /><span>可以只观察走势，随时结束本题并记录为无交易。</span></div>}
              <ResultCard progress={progress} />
              <div className="shape-practice-control-footer"><button type="button" className="shape-practice-finish-button" onClick={handleFinish}>{isFinished ? '下一题' : questionNumber < dataset.questions.length ? '跳过 / 完成本题并下一题' : '完成本题'}</button><button type="button" className="shape-practice-score-button" onClick={() => setScoreOpen((value) => !value)}><Flag size={15} />查看已完题成绩 {score?.completed ?? 0}/{dataset.questions.length}</button></div>
            </aside>
          </main>
          {scoreOpen && <CompletedScore dataset={dataset} store={store} />}
        </>}
    </section>
  </div>
}
