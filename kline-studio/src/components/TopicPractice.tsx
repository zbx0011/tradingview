import { useMemo } from 'react'
import { Layers } from 'lucide-react'
import type { ManualPracticeSession } from '../lib/manualPractice'
import { TOPIC_KINDS, TOPIC_KIND_LABEL, summarizeTopic, type TopicCase, type TopicKind } from '../lib/topicPractice'
import './TopicPractice.css'

function points(value: number) {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)} 点`
}

/** 专题练习 card inside the 自主复盘 center: pick the kinds, start or continue. The papers themselves run in the normal 自主复盘 view. */
export function TopicPracticeSection({ cases, sessions, kinds, loading, excludedCount, onToggleKind, onStart, onContinue, onRestoreExcluded }: {
  cases: readonly TopicCase[] | null
  sessions: readonly ManualPracticeSession[]
  kinds: readonly TopicKind[]
  loading: boolean
  onToggleKind: (kind: TopicKind) => void
  onStart: () => void
  onContinue: (sessionId: string) => void
  /** Questions deleted with key 5 (already left out of `cases`). */
  excludedCount: number
  onRestoreExcluded: () => void
}) {
  const summary = useMemo(() => summarizeTopic(cases ?? [], sessions), [cases, sessions])
  const active = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).find((session) => session.topic && session.status === 'active') ?? null, [sessions])
  const selectedTotal = kinds.reduce((sum, kind) => sum + summary[kind].total, 0)
  const selectedFresh = kinds.reduce((sum, kind) => sum + summary[kind].total - summary[kind].done, 0)
  return <section className="mp-start mp-topic">
    <div className="mp-start-copy">
      <h3><Layers size={17} />专题练习</h3>
      <p>大趋势末端 8 小时震荡区间的突破，每个案例一道题。图表先显示前三天作为背景，从突破K线开始逐根揭示，一题最多走一个交易日；画线、指标、开平仓和记理由都和自主复盘一样。</p>
      <ul className="mp-keys">
        <li><kbd>1</kbd> 下一根K线</li>
        <li><kbd>2</kbd> 做多 / 持仓时平仓</li>
        <li><kbd>3</kbd> 做空</li>
        <li><kbd>4</kbd> 下一题（有持仓按现价平仓）</li>
        <li><kbd>5</kbd> 删除本题（从题库移除，不计成绩）并进入下一题</li>
      </ul>
      <table className="mp-topic-table">
        <thead><tr><th>专题</th><th>已做</th><th>平仓笔数</th><th>胜率</th><th>累计</th></tr></thead>
        <tbody>{TOPIC_KINDS.map((kind) => {
          const row = summary[kind]
          return <tr key={kind}><td>{TOPIC_KIND_LABEL[kind]}</td><td>{row.done} / {row.total}</td><td>{row.trades}</td>
            <td>{row.trades ? `${Math.round(row.wins / row.trades * 100)}%` : '—'}</td>
            <td className={row.points > 0 ? 'positive' : row.points < 0 ? 'negative' : ''}>{row.trades ? points(row.points) : '—'}</td></tr>
        })}</tbody>
      </table>
    </div>
    <div className="mp-start-action">
      <div className="mp-start-modes" role="group" aria-label="选择专题（可多选）">
        {TOPIC_KINDS.map((kind) => <button type="button" key={kind} aria-pressed={kinds.includes(kind)} onClick={() => onToggleKind(kind)}>
          {TOPIC_KIND_LABEL[kind]} {summary[kind].total || ''}
        </button>)}
      </div>
      <small className="mp-muted">可以只选一个，也可以两个一起做；题目随机排序，没做过的排在前面。</small>
      {excludedCount > 0 && <button type="button" className="mp-secondary mp-topic-continue" onClick={onRestoreExcluded}>恢复已删除的 {excludedCount} 道题</button>}
      {active && <button type="button" className="mp-secondary mp-topic-continue" disabled={loading} onClick={() => onContinue(active.id)}>继续当前题目：{active.dayLabel}</button>}
      <button type="button" className="mp-primary mp-start-button" disabled={loading || !cases || !kinds.length || !selectedTotal} onClick={onStart}>
        {!cases ? '正在加载专题题库…' : `${active ? '重新抽题开始' : '开始专题练习'}（${selectedTotal} 题，未做 ${selectedFresh}）`}
      </button>
    </div>
  </section>
}
