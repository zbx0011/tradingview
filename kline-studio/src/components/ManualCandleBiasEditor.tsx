import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, NotebookPen, Plus, Trash2 } from 'lucide-react'
import { FloatingCard } from './ManualPractice'
import type { ManualBarNote, ManualCandleBias } from '../lib/manualPractice'
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

interface BiasDraft { background: string; order: ManualCandleBias[]; reasons: Record<ManualCandleBias, string[]> }
const validBiasDraft = (value: unknown): value is BiasDraft => {
  const draft = value as BiasDraft | null
  return Boolean(draft && typeof draft.background === 'string' && Array.isArray(draft.order) && draft.order.length === 3 && new Set(draft.order).size === 3
    && draft.order.every(bias => ['no-trade', 'long', 'short'].includes(bias)) && draft.reasons
    && ['no-trade', 'long', 'short'].every(bias => Array.isArray(draft.reasons[bias as ManualCandleBias]) && draft.reasons[bias as ManualCandleBias].every(row => typeof row === 'string')))
}

export function ManualCandleBiasEditor({ subtitle, notes, initialBias, initialBackground, persistenceId, onSave, onCancel }: {
  subtitle: string
  notes: readonly ManualBarNote[]
  initialBias: ManualCandleBias
  initialBackground: string
  persistenceId?: string
  onSave: (background: string, entries: { bias: ManualCandleBias; reasons: string[] }[]) => void
  onCancel: () => void
}) {
  const [draft, setDraft, discardDraft] = usePanelDraft(`bias:${persistenceId ?? JSON.stringify([subtitle, notes])}`, () => {
    const ranked = [...notes].sort((a, b) => (a.biasRank ?? 99) - (b.biasRank ?? 99)).map(biasOf)
    return {
      background: notes.find(n => n.background.trim())?.background ?? initialBackground,
      order: [...new Set([...ranked, initialBias, 'no-trade', 'long', 'short'])] as ManualCandleBias[],
      reasons: Object.fromEntries((['no-trade', 'long', 'short'] as const).map(bias => {
        const rows = notes.filter(n => biasOf(n) === bias).flatMap(n => n.reasons)
        return [bias, rows.length ? rows : ['']]
      })) as Record<ManualCandleBias, string[]>,
    }
  }, validBiasDraft)
  const { background, order, reasons } = draft
  const setBackground = (value: string) => setDraft(current => ({ ...current, background: value }))
  const setOrder = (update: (value: ManualCandleBias[]) => ManualCandleBias[]) => setDraft(current => ({ ...current, order: update(current.order) }))
  const setReasons = (update: (value: Record<ManualCandleBias, string[]>) => Record<ManualCandleBias, string[]>) => setDraft(current => ({ ...current, reasons: update(current.reasons) }))
  const cancel = () => { discardDraft(); onCancel() }
  const [error, setError] = useState('')
  const move = (index: number, offset: number) => setOrder(current => {
    const next = [...current]
    ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
    return next
  })
  const save = () => {
    const entries = order.map(bias => ({ bias, reasons: reasons[bias].map(s => s.trim()).filter(Boolean) }))
    if (!background.trim() && entries.some(e => e.reasons.length)) { setError('请填写背景'); return }
    discardDraft()
    onSave(background.trim(), entries)
  }
  return <FloatingCard id="candle-bias-editor" title="未开单 K 线 · 偏向与理由" ariaLabel="K线偏向与理由" icon={<NotebookPen size={14} />} className="mp-editor mp-bias-editor" defaultStyle={{ left: 64, bottom: 56, width: 480 }} minWidth={320} minHeight={300} onClose={cancel}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save() }
    }}>
    <p className="mp-editor-subtitle">{subtitle}</p>
    <label className="mp-bias-background">背景<input aria-label="背景（必填）" value={background} onChange={e => { setBackground(e.target.value); setError('') }} /></label>
    <p className="mp-bias-hint">越靠上越偏向；每条理由独立编号，Enter / Tab 添加下一条。</p>
    <div className="mp-bias-options">{order.map((bias, index) => <div key={bias} className={`mp-bias-option bias-${bias}`}>
      <div className="mp-bias-heading"><b>{index + 1}. {labels[bias]} <span className="mp-bias-count">{reasons[bias].filter(row => row.trim()).length} 条理由</span></b>{index === 0 && <small>最偏向</small>}
        <button type="button" aria-label={`${labels[bias]}上移`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></button>
        <button type="button" aria-label={`${labels[bias]}下移`} disabled={index === order.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></button>
      </div>
      <BiasReasonRows label={labels[bias]} rows={reasons[bias]} onChange={rows => setReasons(current => ({ ...current, [bias]: rows }))} />
    </div>)}</div>
    {error && <p className="mp-editor-error" role="alert">{error}</p>}
    <footer><span className="mp-editor-hint">Ctrl+Enter 保存 · Esc 取消</span><button type="button" className="mp-secondary" onClick={cancel}>取消</button><button type="button" className="mp-primary" onClick={save}>保存</button></footer>
  </FloatingCard>
}
