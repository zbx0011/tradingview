import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, NotebookPen, Plus, Trash2 } from 'lucide-react'
import { FloatingCard } from './ManualPractice'
import { DecisionRiskOverlay } from './DecisionReplay'
import { manualRiskRatio, NQ_POINT_VALUE_USD } from '../lib/manualPractice'
import type { ManualBarNote, ManualCandleBias, ManualRiskPlan } from '../lib/manualPractice'
import { usePanelDraft } from '../lib/panelDraft'

const labels = { 'no-trade': '不开单', long: '做多', short: '做空' }
const biasOf = (note: ManualBarNote): ManualCandleBias => note.kind === 'no-trade' ? 'no-trade' : note.side ?? 'long'

function BiasReasonRows({ label, rows, onChange }: { label: string; rows: string[]; onChange: (rows: string[]) => void }) {
  const inputs = useRef<Array<HTMLInputElement | null>>([])
  const add = () => {
    onChange([...rows, ''])
    requestAnimationFrame(() => inputs.current[rows.length]?.focus())
  }
  return <>
    <ol className="mp-reason-rows">{rows.map((row, index) => <li key={index}>
      <span className="mp-reason-index">{index + 1}</span>
      <input ref={element => { inputs.current[index] = element }} aria-label={`${label}理由 ${index + 1}`} value={row} placeholder="每条填写一个理由" onChange={e => onChange(rows.map((value, i) => i === index ? e.target.value : value))} onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey) return
        if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey && index === rows.length - 1 && row.trim())) {
          e.preventDefault()
          if (index < rows.length - 1) inputs.current[index + 1]?.focus()
          else if (row.trim()) add()
        }
      }} />
      {rows.length > 1 && <button type="button" aria-label={`删除${label}理由 ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2 size={14} /></button>}
    </li>)}</ol>
    <button type="button" className="mp-add-row" onClick={add} aria-label={`添加${label}理由`}><Plus size={14} />添加一条</button>
  </>
}

type Direction = 'long' | 'short'
interface RiskDraft { enabled: boolean; entryPrice: string; stopLoss: string; takeProfit: string }
const emptyRisk = (): RiskDraft => ({ enabled: false, entryPrice: '', stopLoss: '', takeProfit: '' })
const riskFromNotes = (notes: readonly ManualBarNote[], side: Direction): RiskDraft => {
  const plan = notes.find(note => biasOf(note) === side && note.initialRisk)?.initialRisk
  return plan ? { enabled: true, entryPrice: String(plan.entryPrice), stopLoss: String(plan.stopLoss), takeProfit: String(plan.takeProfit) } : emptyRisk()
}
const riskNumbers = (draft: RiskDraft): ManualRiskPlan | undefined => {
  if (![draft.entryPrice, draft.stopLoss, draft.takeProfit].every(value => value.trim())) return undefined
  const entryPrice = Number(draft.entryPrice), stopLoss = Number(draft.stopLoss), takeProfit = Number(draft.takeProfit)
  if (![entryPrice, stopLoss, takeProfit].every(value => Number.isFinite(value) && value > 0)) return undefined
  return { entryPrice, stopLoss, takeProfit }
}
const readRisk = (draft: RiskDraft, side: Direction): ManualRiskPlan | undefined => {
  const plan = riskNumbers(draft)
  if (!plan) return undefined
  const { entryPrice, stopLoss, takeProfit } = plan
  if (side === 'long' ? !(stopLoss < entryPrice && entryPrice < takeProfit) : !(takeProfit < entryPrice && entryPrice < stopLoss)) return undefined
  return { entryPrice, stopLoss, takeProfit }
}
const TICK = 0.25
const priceFields = ['entryPrice', 'stopLoss', 'takeProfit'] as const
const clampRiskPrice = (plan: ManualRiskPlan, side: Direction, field: keyof ManualRiskPlan, price: number): number => {
  const snapped = Math.max(TICK, Math.round(price / TICK) * TICK)
  if (field === 'entryPrice') {
    const lower = side === 'long' ? plan.stopLoss : plan.takeProfit
    const upper = side === 'long' ? plan.takeProfit : plan.stopLoss
    return Math.max(lower + TICK, Math.min(upper - TICK, snapped))
  }
  return (field === 'stopLoss') === (side === 'long')
    ? Math.min(plan.entryPrice - TICK, snapped)
    : Math.max(plan.entryPrice + TICK, snapped)
}
const draftWithPlan = (plan: ManualRiskPlan, enabled = true): RiskDraft => ({ enabled, entryPrice: String(plan.entryPrice), stopLoss: String(plan.stopLoss), takeProfit: String(plan.takeProfit) })
const seedRisk = (plan: RiskDraft, suggestion: ManualRiskPlan | undefined): RiskDraft => suggestion && !plan.enabled ? {
  ...plan,
  entryPrice: plan.entryPrice || String(suggestion.entryPrice),
  stopLoss: plan.stopLoss || String(suggestion.stopLoss),
  takeProfit: plan.takeProfit || String(suggestion.takeProfit),
} : plan
interface BiasDraft { background: string; order: ManualCandleBias[]; reasons: Record<ManualCandleBias, string[]>; riskPlans?: Record<Direction, RiskDraft> }
const validBiasDraft = (value: unknown): value is BiasDraft => {
  const draft = value as BiasDraft | null
  return Boolean(draft && typeof draft.background === 'string' && Array.isArray(draft.order) && draft.order.length === 3 && new Set(draft.order).size === 3
    && draft.order.every(bias => ['no-trade', 'long', 'short'].includes(bias)) && draft.reasons
    && ['no-trade', 'long', 'short'].every(bias => Array.isArray(draft.reasons[bias as ManualCandleBias]) && draft.reasons[bias as ManualCandleBias].every(row => typeof row === 'string'))
    && (draft.riskPlans === undefined || (['long', 'short'] as const).every(side => {
      const plan = draft.riskPlans?.[side]
      return plan && typeof plan.enabled === 'boolean' && [plan.entryPrice, plan.stopLoss, plan.takeProfit].every(value => typeof value === 'string')
    })))
}

export function ManualCandleBiasEditor({ subtitle, notes, initialBias, initialBackground, defaultRiskPlans, currentCandleX = null, toPrice, toY, persistenceId, onSave, onCancel }: {
  subtitle: string
  notes: readonly ManualBarNote[]
  initialBias: ManualCandleBias
  initialBackground: string
  referencePrice?: number
  defaultRiskPlans?: Record<Direction, ManualRiskPlan>
  currentCandleX?: number | null
  toPrice: (y: number) => number | null
  toY: (price: number) => number | null
  persistenceId?: string
  onSave: (background: string, entries: { bias: ManualCandleBias; reasons: string[]; initialRisk?: ManualRiskPlan }[]) => void
  onCancel: () => void
}) {
  const [draft, setDraft, discardDraft] = usePanelDraft<BiasDraft>(`bias:${persistenceId ?? JSON.stringify([subtitle, notes])}`, () => {
    const ranked = [...notes].sort((a, b) => (a.biasRank ?? 99) - (b.biasRank ?? 99)).map(biasOf)
    return {
      background: notes.find(n => n.background.trim())?.background ?? initialBackground,
      order: [...new Set([...ranked, initialBias, 'no-trade', 'long', 'short'])] as ManualCandleBias[],
      reasons: Object.fromEntries((['no-trade', 'long', 'short'] as const).map(bias => {
        const rows = notes.filter(n => biasOf(n) === bias).flatMap(n => n.reasons)
        return [bias, rows.length ? rows : ['']]
      })) as Record<ManualCandleBias, string[]>,
      riskPlans: { long: seedRisk(riskFromNotes(notes, 'long'), defaultRiskPlans?.long), short: seedRisk(riskFromNotes(notes, 'short'), defaultRiskPlans?.short) },
    }
  }, validBiasDraft)
  const { background, order, reasons } = draft
  const [error, setError] = useState('')
  const riskPlans = useMemo(() => ({
    long: seedRisk(draft.riskPlans?.long ?? riskFromNotes(notes, 'long'), defaultRiskPlans?.long),
    short: seedRisk(draft.riskPlans?.short ?? riskFromNotes(notes, 'short'), defaultRiskPlans?.short),
  }), [draft.riskPlans, notes, defaultRiskPlans])
  const [activeSide, setActiveSide] = useState<Direction | null>(() => initialBias !== 'no-trade' ? initialBias : order.find((bias): bias is Direction => bias !== 'no-trade') ?? 'long')
  const setRisk = useCallback((side: Direction, update: Partial<RiskDraft>) => {
    setDraft(current => {
      const plans = current.riskPlans ? {
        long: seedRisk(current.riskPlans.long, defaultRiskPlans?.long),
        short: seedRisk(current.riskPlans.short, defaultRiskPlans?.short),
      } : riskPlans
      return { ...current, riskPlans: { ...plans, [side]: { ...plans[side], ...update } } }
    })
    setError('')
  }, [defaultRiskPlans, riskPlans, setDraft])
  const activateSide = (side: Direction) => { setActiveSide(side); setRisk(side, { enabled: true }) }
  const updatePrice = (side: Direction, field: keyof ManualRiskPlan, price: number) => {
    const plan = readRisk(riskPlans[side], side)
    if (!plan || !Number.isFinite(price) || price <= 0) return
    setRisk(side, { enabled: true, [field]: String(clampRiskPrice(plan, side, field, price)) })
  }
  const confirmPricePlan = useCallback((input?: HTMLInputElement | null) => {
    if (!activeSide) return
    let values = riskPlans[activeSide]
    if (input && input.dataset.riskSide === activeSide) {
      const field = input.dataset.riskField as keyof ManualRiskPlan
      if (priceFields.includes(field)) {
        const price = input.value.trim() ? Number(input.value) : NaN
        if (!Number.isFinite(price) || price <= 0) { setError('请输入有效的正数价格'); return }
        const plan = riskNumbers(values)
        values = { ...values, [field]: String(plan ? clampRiskPrice(plan, activeSide, field, price) : Math.max(TICK, Math.round(price / TICK) * TICK)) }
      }
    }
    if (!readRisk(values, activeSide)) { setError(`${labels[activeSide]}初始计划：${activeSide === 'long' ? '止损 < 入场 < 止盈' : '止盈 < 入场 < 止损'}`); return }
    setRisk(activeSide, { ...values, enabled: true })
    setActiveSide(null)
  }, [activeSide, riskPlans, setRisk])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!activeSide || event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const focused = document.activeElement
      const input = focused instanceof HTMLInputElement && focused.closest('[data-testid="candle-bias-editor"]') && focused.dataset.riskField ? focused : null
      if (focused instanceof HTMLElement && (focused.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName)) && !input) return
      if (input && input.dataset.riskSide !== activeSide) return
      event.preventDefault()
      event.stopImmediatePropagation()
      confirmPricePlan(input)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [activeSide, confirmPricePlan])
  const setBackground = (value: string) => setDraft(current => ({ ...current, background: value }))
  const setOrder = (update: (value: ManualCandleBias[]) => ManualCandleBias[]) => setDraft(current => ({ ...current, order: update(current.order) }))
  const setReasons = (update: (value: Record<ManualCandleBias, string[]>) => Record<ManualCandleBias, string[]>) => setDraft(current => ({ ...current, reasons: update(current.reasons) }))
  const cancel = () => { discardDraft(); onCancel() }
  const move = (index: number, offset: number) => setOrder(current => {
    const next = [...current]
    ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
    return next
  })
  const save = () => {
    const entries: { bias: ManualCandleBias; reasons: string[]; initialRisk?: ManualRiskPlan }[] = []
    for (const bias of order) {
      const rows = reasons[bias].map(s => s.trim()).filter(Boolean)
      const plan = bias === 'no-trade' || !riskPlans[bias].enabled ? undefined : readRisk(riskPlans[bias], bias)
      if (bias !== 'no-trade' && riskPlans[bias].enabled) {
        if (!plan) { setError(`${labels[bias]}初始计划：请输入正数价格，${bias === 'long' ? '止损 < 入场 < 止盈' : '止盈 < 入场 < 止损'}`); return }
      }
      entries.push({ bias, reasons: rows, ...(plan ? { initialRisk: plan } : {}) })
    }
    if (!background.trim() && entries.some(e => e.reasons.length || e.initialRisk)) { setError('请填写背景'); return }
    discardDraft()
    onSave(background.trim(), entries)
  }
  const activePlan = activeSide ? readRisk(riskPlans[activeSide], activeSide) : undefined
  return <>
    {activeSide && activePlan && <DecisionRiskOverlay
      symbol="NQ1!" precision={2} side={activeSide} entryPrice={activePlan.entryPrice} entryLabel="开仓价" stopLoss={activePlan.stopLoss} takeProfit={activePlan.takeProfit}
      ratioLabel={`盈亏比 ${manualRiskRatio(activePlan).toFixed(2)} : 1`} stopLossMode="touch" hideStopMode showConfirmControls={false}
      currentCandleX={currentCandleX} lineStartX={currentCandleX} amountForExit={price => (price - activePlan.entryPrice) * (activeSide === 'long' ? 1 : -1) * NQ_POINT_VALUE_USD}
      toPrice={toPrice} toY={toY} onEntryPrice={price => updatePrice(activeSide, 'entryPrice', price)} onStopLoss={price => updatePrice(activeSide, 'stopLoss', price)} onTakeProfit={price => updatePrice(activeSide, 'takeProfit', price)}
    />}
    <FloatingCard id="candle-bias-editor" title="未开单 K 线 · 偏向与理由" ariaLabel="K线偏向与理由" testId="candle-bias-editor" icon={<NotebookPen size={14} />} className="mp-editor mp-bias-editor" defaultStyle={{ left: 64, top: 12, width: 400, height: 520 }} minWidth={320} minHeight={300} onClose={cancel}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save() }
    }}>
    <p className="mp-editor-subtitle">{subtitle}</p>
    <label className="mp-bias-background">背景<input aria-label="背景（必填）" value={background} onChange={e => { setBackground(e.target.value); setError('') }} /></label>
    <p className="mp-bias-hint">越靠上越偏向；每条理由独立编号，Enter / Tab 添加下一条。</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {(['long', 'short'] as const).map(side => <button key={side} type="button" className={activeSide === side ? 'mp-primary' : 'mp-secondary'} onClick={() => activateSide(side)}>{labels[side]}价格线</button>)}
      {activeSide && <button type="button" className="mp-primary" onClick={() => confirmPricePlan()}>确认价格线 · Enter</button>}
    </div>
    <p className="mp-bias-hint">拖动三条价格线或输入价格，Enter 仅确认价格线；默认价格供调整，保存理由后才写入记录。</p>
    <div className="mp-bias-options">{order.map((bias, index) => <div key={bias} className={`mp-bias-option bias-${bias}`}>
      <div className="mp-bias-heading"><b>{index + 1}. {labels[bias]} <span className="mp-bias-count">{reasons[bias].filter(row => row.trim()).length} 条理由</span></b>{index === 0 && <small>最偏向</small>}
        <button type="button" aria-label={`${labels[bias]}上移`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></button>
        <button type="button" aria-label={`${labels[bias]}下移`} disabled={index === order.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></button>
      </div>
      <div onFocus={() => bias === 'no-trade' ? setActiveSide(null) : activateSide(bias)}><BiasReasonRows label={labels[bias]} rows={reasons[bias]} onChange={rows => setReasons(current => ({ ...current, [bias]: rows }))} /></div>
      {bias !== 'no-trade' && <div className="mp-initial-risk-plan" style={{ marginTop: 10 }}>
        <button type="button" className="mp-secondary" aria-label={`调整${labels[bias]}价格线`} onClick={() => activateSide(bias)}>调整价格线</button>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginTop: 8 }}>
            {([['entryPrice', '入场'], ['stopLoss', '止损'], ['takeProfit', '止盈']] as const).map(([field, label]) => <label key={field} style={{ minWidth: 0 }}>{label}<input data-risk-field={field} data-risk-side={bias} type="number" min="0.25" step="0.25" inputMode="decimal" aria-label={`${labels[bias]}初始${label}价格`} value={riskPlans[bias][field]} style={{ width: '100%', boxSizing: 'border-box', marginTop: 4, padding: 8, color: '#eef1f6', background: '#151a23', border: '1px solid #3a4558', borderRadius: 6 }} onChange={event => setRisk(bias, { enabled: true, [field]: event.target.value })} onBlur={event => {
              const price = event.target.value.trim() ? Number(event.target.value) : NaN
              const current = riskNumbers(riskPlans[bias])
              if (current && Number.isFinite(price) && price > 0) setRisk(bias, draftWithPlan({ ...current, [field]: clampRiskPrice(current, bias, field, price) }, riskPlans[bias].enabled))
            }} /></label>)}
          </div>
          <p className="mp-bias-hint">{(() => {
            const plan = readRisk(riskPlans[bias], bias)
            return plan ? `盈亏比 ${(Math.abs(plan.takeProfit - plan.entryPrice) / Math.abs(plan.entryPrice - plan.stopLoss)).toFixed(2)} : 1` : bias === 'long' ? '做多：止损 < 入场 < 止盈' : '做空：止盈 < 入场 < 止损'
          })()}</p>
      </div>}
    </div>)}</div>
    {error && <p className="mp-editor-error" role="alert">{error}</p>}
    <footer><span className="mp-editor-hint">Ctrl+Enter 保存 · Esc 取消</span><button type="button" className="mp-secondary" onClick={cancel}>取消</button><button type="button" className="mp-primary" onClick={save}>保存</button></footer>
  </FloatingCard>
  </>
}
