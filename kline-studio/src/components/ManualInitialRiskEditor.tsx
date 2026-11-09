import { useEffect, useRef, useState } from 'react'
import { DecisionRiskOverlay } from './DecisionReplay'
import { FloatingCard } from './ManualPractice'
import { manualRiskRatio, NQ_POINT_VALUE_USD, type ManualRiskPlan, type ManualSide } from '../lib/manualPractice'

const TICK = 0.25
const snapPrice = (price: number) => Math.max(TICK, Math.round(price / TICK) * TICK)

function initialPlan(initial: ManualRiskPlan, side: ManualSide): ManualRiskPlan {
  const entryPrice = Math.max(TICK * 2, snapPrice(initial.entryPrice))
  return side === 'long'
    ? { entryPrice, stopLoss: Math.min(entryPrice - TICK, snapPrice(initial.stopLoss)), takeProfit: Math.max(entryPrice + TICK, snapPrice(initial.takeProfit)) }
    : { entryPrice, stopLoss: Math.max(entryPrice + TICK, snapPrice(initial.stopLoss)), takeProfit: Math.min(entryPrice - TICK, snapPrice(initial.takeProfit)) }
}

function PriceInput({ field, label, value, onCommit }: { field: keyof ManualRiskPlan; label: string; value: number; onCommit: (value: number) => number }) {
  const [text, setText] = useState(value.toFixed(2))
  const [seenValue, setSeenValue] = useState(value)
  if (seenValue !== value) {
    setSeenValue(value)
    setText(value.toFixed(2))
  }
  const commit = () => {
    const parsed = text.trim() ? Number(text) : NaN
    setText((Number.isFinite(parsed) && parsed > 0 ? onCommit(parsed) : value).toFixed(2))
  }
  return <label className="mp-risk-input"><span>{label}</span><input
    data-initial-risk-field={field}
    aria-label={`补录初始${label}`}
    inputMode="decimal"
    value={text}
    onChange={(event) => setText(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setText(value.toFixed(2)) }
    }}
  /></label>
}

/** A local reason-record draft. Saving does not modify orders or positions. */
export function ManualInitialRiskEditor({ side, initial, currentCandleX, toPrice, toY, onSave, onCancel }: {
  side: ManualSide
  initial: ManualRiskPlan
  currentCandleX: number | null
  toPrice: (y: number) => number | null
  toY: (price: number) => number | null
  onSave: (plan: ManualRiskPlan) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(() => initialPlan(initial, side))
  const confirmed = useRef(false)
  const clampPrice = (field: keyof ManualRiskPlan, price: number) => {
    if (!Number.isFinite(price)) return draft[field]
    const snapped = snapPrice(price)
    let value: number
    if (field === 'entryPrice') {
      const lower = side === 'long' ? draft.stopLoss : draft.takeProfit
      const upper = side === 'long' ? draft.takeProfit : draft.stopLoss
      value = Math.max(lower + TICK, Math.min(upper - TICK, snapped))
    } else if ((field === 'stopLoss') === (side === 'long')) {
      value = Math.min(draft.entryPrice - TICK, snapped)
    } else {
      value = Math.max(draft.entryPrice + TICK, snapped)
    }
    return value
  }
  const updatePrice = (field: keyof ManualRiskPlan, price: number) => {
    const value = clampPrice(field, price)
    setDraft(current => ({ ...current, [field]: value }))
    return value
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'Enter') return
      const active = document.activeElement
      const input = active instanceof HTMLInputElement && active.closest('[data-testid="manual-initial-risk-editor"]') ? active : null
      if (active instanceof HTMLElement && (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) && !input) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (confirmed.current) return
      let plan = draft
      if (input) {
        const field = input.dataset.initialRiskField as keyof ManualRiskPlan | undefined
        const price = input.value.trim() ? Number(input.value) : NaN
        if (!field || !Number.isFinite(price) || price <= 0) return
        const snapped = snapPrice(price)
        const lower = side === 'long' ? draft.stopLoss : draft.takeProfit
        const upper = side === 'long' ? draft.takeProfit : draft.stopLoss
        const value = field === 'entryPrice' ? Math.max(lower + TICK, Math.min(upper - TICK, snapped))
          : (field === 'stopLoss') === (side === 'long') ? Math.min(draft.entryPrice - TICK, snapped) : Math.max(draft.entryPrice + TICK, snapped)
        plan = { ...draft, [field]: value }
      }
      confirmed.current = true
      onSave({ ...plan })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [draft, onSave, side])
  return <>
    <DecisionRiskOverlay
      symbol="NQ1!"
      precision={2}
      side={side}
      entryPrice={draft.entryPrice}
      entryLabel="开仓价"
      stopLoss={draft.stopLoss}
      takeProfit={draft.takeProfit}
      ratioLabel={`盈亏比 ${manualRiskRatio(draft).toFixed(2)} : 1`}
      stopLossMode="touch"
      hideStopMode
      showConfirmControls={false}
      currentCandleX={currentCandleX}
      lineStartX={currentCandleX}
      amountForExit={(price) => (price - draft.entryPrice) * (side === 'long' ? 1 : -1) * NQ_POINT_VALUE_USD}
      toPrice={toPrice}
      toY={toY}
      onEntryPrice={(price) => updatePrice('entryPrice', price)}
      onStopLoss={(price) => updatePrice('stopLoss', price)}
      onTakeProfit={(price) => updatePrice('takeProfit', price)}
    />
    <FloatingCard
      id="initial-risk-editor"
      title="补录初始止盈止损"
      ariaLabel="补录初始止盈止损"
      testId="manual-initial-risk-editor"
      tone={side}
      defaultStyle={{ right: 12, top: 48, width: 310 }}
      minWidth={260}
      onClose={onCancel}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); onCancel() }
      }}
    >
      <p className="mp-muted">拖动图上价格线，按 Enter 确认保存</p>
      <p className="mp-muted">默认价格供调整，请按当时计划补录。</p>
      <div className="mp-risk-fields" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        <PriceInput field="entryPrice" label="入场" value={draft.entryPrice} onCommit={(price) => updatePrice('entryPrice', price)} />
        <PriceInput field="stopLoss" label="止损" value={draft.stopLoss} onCommit={(price) => updatePrice('stopLoss', price)} />
        <PriceInput field="takeProfit" label="止盈" value={draft.takeProfit} onCommit={(price) => updatePrice('takeProfit', price)} />
      </div>
      <p className="mp-initial-risk-text"><b>{side === 'long' ? '做多' : '做空'} · 盈亏比 {manualRiskRatio(draft).toFixed(2)} : 1</b></p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="mp-secondary" onClick={onCancel}>取消</button>
        <button type="button" className="mp-primary" onClick={() => onSave({ ...draft })}>确认保存 · Enter</button>
      </div>
    </FloatingCard>
  </>
}
