import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { Candle } from '../lib/market'

export type ApprenticeActionKind = 'plan' | 'filled' | 'cancel' | 'exit'

export interface ApprenticeActionMarker {
  id: string
  time: number
  kind: ApprenticeActionKind
  side?: 'long' | 'short'
  price?: number
  label: string
  source: 'decision' | 'event'
  idx?: number
}

export interface AlSwingApprenticePanelProps {
  apiBaseUrl?: string
  onBarsChange?: (bars: readonly Candle[]) => void
  onFocusTime?: (time: number) => void
  onMarkersChange?: (markers: readonly ApprenticeActionMarker[]) => void
}

type JsonRecord = Record<string, unknown>

interface ProgressPayload extends JsonRecord {
  stage?: string
  status?: string
  material_complete?: number
  material_validated?: number
  material_selected?: number
  material_total?: number
  source_review?: JsonRecord
  bar_complete?: number
  bar_total?: number
  running?: boolean | number
  queued?: boolean | number
  failed?: boolean | number
  tokens_recorded?: number | JsonRecord
  cached_input_tokens_recorded?: number | JsonRecord
  eta_seconds?: number | null
  last_output_at?: string | number | null
  updated_at?: string | number | null
  errors?: unknown[]
  model?: JsonRecord
}

interface ReportState {
  progress: ProgressPayload | null
  decisions: JsonRecord[]
  events: JsonRecord[]
  learning: JsonRecord[]
  bars: Candle[]
  error: string | null
  fetchedAt: number | null
}

const EMPTY_REPORT: ReportState = {
  progress: null,
  decisions: [],
  events: [],
  learning: [],
  bars: [],
  error: null,
  fetchedAt: null,
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 32,
  top: 14,
  right: 14,
  width: 'min(390px, calc(100% - 28px))',
  maxHeight: 'calc(100% - 28px)',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  color: 'var(--text)',
  background: 'color-mix(in srgb, var(--surface) 96%, transparent)',
  border: '1px solid var(--border-strong)',
  borderRadius: 10,
  boxShadow: '0 12px 30px rgba(0, 0, 0, .28)',
  backdropFilter: 'blur(12px)',
  pointerEvents: 'auto',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  minHeight: 52,
  padding: '0 14px',
  borderBottom: '1px solid var(--border)',
}

const scrollStyle: CSSProperties = {
  minHeight: 0,
  overflowY: 'auto',
  padding: '11px 13px 14px',
}

const mutedStyle: CSSProperties = { color: 'var(--text-muted)', fontSize: 11 }

const statGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 7,
  marginBottom: 10,
}

const statStyle: CSSProperties = {
  minWidth: 0,
  padding: '8px 9px',
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--surface-2)',
}

const sectionTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  margin: '13px 0 7px',
  fontSize: 12,
}

const decisionStyle: CSSProperties = {
  padding: '9px 10px',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--surface-2)',
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  for (const key of ['items', 'rows', 'decisions', 'events', 'data', 'results']) {
    if (Array.isArray(value[key])) return value[key] as unknown[]
  }
  return []
}

function asRecords(value: unknown): JsonRecord[] {
  return asArray(value).filter(isRecord)
}

function parseBars(value: unknown): Candle[] {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value)
      ? (['bars', 'items', 'rows', 'data'].map((key) => value[key]).find(Array.isArray) as unknown[] | undefined) ?? []
      : []
  const bars = rows.map((row): Candle | null => {
    if (Array.isArray(row) && row.length >= 6) {
      const [time, open, high, low, close, volume] = row.map(asNumber)
      if ([time, open, high, low, close, volume].every((item) => item !== null) && time! >= 1_000_000_000) return { time: time!, open: open!, high: high!, low: low!, close: close!, volume: volume! }
      return null
    }
    if (!isRecord(row)) return null
    const time = parseTimestamp(row.time ?? row.timestamp)
    const open = asNumber(row.open)
    const high = asNumber(row.high)
    const low = asNumber(row.low)
    const close = asNumber(row.close)
    const volume = asNumber(row.volume) ?? 0
    if (time === null || open === null || high === null || low === null || close === null) return null
    return { time, open, high, low, close, volume }
  }).filter((bar): bar is Candle => Boolean(bar))
  const deduped = new Map<number, Candle>()
  bars.forEach((bar) => deduped.set(bar.time, bar))
  return [...deduped.values()].sort((left, right) => left.time - right.time)
}

function parseTimestamp(value: unknown): number | null {
  const numeric = asNumber(value)
  if (numeric !== null) {
    if (numeric > 10_000_000_000) return Math.floor(numeric / 1000)
    if (numeric >= 1_000_000_000) return Math.floor(numeric)
    return null
  }
  const text = asString(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

function recordTimestamp(record: JsonRecord, fallback?: JsonRecord): number | null {
  const keys = ['time', 'timestamp', 'at', 'event_time', 'action_time', 'decision_time', 'entry_time', 'fill_time', 'cancel_time', 'exit_time']
  for (const source of [record, fallback]) {
    if (!source) continue
    for (const key of keys) {
      const time = parseTimestamp(source[key])
      if (time !== null) return time
    }
  }
  return null
}

function recordValue(record: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return null
}

function nestedActionRecord(value: unknown): JsonRecord | null {
  if (isRecord(value)) return value
  if (typeof value === 'string' && value.trim()) return { action: value.trim() }
  return null
}

function actionKind(record: JsonRecord): ApprenticeActionKind | null {
  const nested = isRecord(record.action) ? record.action : null
  const raw = [
    record.kind,
    record.type,
    record.event,
    record.event_type,
    record.action_type,
    record.status,
    record.phase,
    nested?.kind,
    nested?.type,
    nested?.event,
    nested?.event_type,
    nested?.status,
  ].map(asString).filter(Boolean).join(' ').toLowerCase()
  if (/order[_ -]?filled|成交/.test(raw) && /protective[_ -]?stop|exit|reduce|平仓|止损|止盈/.test(raw)) return 'exit'
  if (/order[_ -]?filled|成交/.test(raw) && /entry|open|开仓|入场/.test(raw)) return 'filled'
  if (!raw || /wait|hold|observe|watch|skip|pending|继续等待/.test(raw)) return null
  if (/cancel|撤单|撤销/.test(raw)) return 'cancel'
  if (/fill|filled|成交|execut|entry|open|开仓|入场/.test(raw)) return 'filled'
  if (/exit|close|closed|stop|take.?profit|tp|平仓|退出|止损|止盈/.test(raw)) return 'exit'
  if (/plan|order|signal|计划|挂单|委托/.test(raw)) return 'plan'
  return null
}

function actionSide(record: JsonRecord): 'long' | 'short' | undefined {
  const nested = isRecord(record.action) ? record.action : null
  const raw = [
    record.side,
    record.position_side,
    record.direction,
    nested?.side,
    nested?.position_side,
    nested?.direction,
  ].map(asString).filter(Boolean).join(' ').toLowerCase()
  if (/short|sell|空|跌/.test(raw)) return 'short'
  if (/long|buy|多|涨/.test(raw)) return 'long'
  return undefined
}

function actionPrice(record: JsonRecord): number | undefined {
  const nested = isRecord(record.action) ? record.action : null
  const value = recordValue(record, ['price', 'entry_price', 'fill_price', 'cancel_price', 'exit_price', 'level'])
    ?? (nested ? recordValue(nested, ['price', 'entry_price', 'fill_price', 'cancel_price', 'exit_price', 'level']) : null)
  const number = asNumber(value)
  return number !== null && number > 0 ? number : undefined
}

function actionLabel(kind: ApprenticeActionKind): string {
  return kind === 'plan' ? '计划' : kind === 'filled' ? '成交' : kind === 'cancel' ? '撤单' : '退出'
}

function extractMarkers(decisions: readonly JsonRecord[], events: readonly JsonRecord[]): ApprenticeActionMarker[] {
  const candidates: Array<{ value: JsonRecord; parent: JsonRecord; source: 'decision' | 'event'; index: number; actionIndex?: number }> = []
  decisions.forEach((decision, decisionIndex) => {
    const answer = isRecord(decision.answer) ? decision.answer : decision
    const actions = Array.isArray(answer.actions) ? answer.actions : []
    actions.forEach((action, actionIndex) => {
      const value = nestedActionRecord(action)
      if (value) candidates.push({ value, parent: decision, source: 'decision', index: decisionIndex, actionIndex })
    })
    // Some report writers place a single action beside answer.actions.
    if (actions.length === 0 && (answer.action !== undefined || answer.action_type !== undefined || answer.type !== undefined)) {
      candidates.push({ value: answer, parent: decision, source: 'decision', index: decisionIndex })
    }
  })
  events.forEach((event, index) => candidates.push({ value: event, parent: event, source: 'event', index }))

  const seen = new Set<string>()
  const markers: ApprenticeActionMarker[] = []
  for (const candidate of candidates) {
    const kind = actionKind(candidate.value)
    if (!kind) continue
    const time = recordTimestamp(candidate.value, candidate.parent)
    if (time === null) continue
    const side = actionSide(candidate.value)
    const price = actionPrice(candidate.value)
    const idx = asNumber(recordValue(candidate.parent, ['idx', 'index', 'decision_idx']))
      ?? asNumber(recordValue(candidate.value, ['idx', 'index']))
      ?? undefined
    const explicitId = asString(recordValue(candidate.value, ['id', 'event_id', 'action_id']))
    const dedupeKey = explicitId ? `${candidate.source}:${explicitId}` : `${kind}:${time}:${side ?? ''}:${price ?? ''}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    markers.push({
      id: `al-swing-${candidate.source}-${explicitId ?? `${candidate.index}-${candidate.actionIndex ?? 0}-${kind}`}`,
      time,
      kind,
      ...(side ? { side } : {}),
      ...(price !== undefined ? { price } : {}),
      label: actionLabel(kind),
      source: candidate.source,
      ...(idx !== undefined ? { idx } : {}),
    })
  }
  return markers.sort((left, right) => left.time - right.time || left.id.localeCompare(right.id))
}

function formatTime(value: unknown): string {
  const timestamp = parseTimestamp(value)
  if (timestamp === null) return asString(value) ?? '—'
  return new Date(timestamp * 1000).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function formatDateTime(value: unknown): string {
  const timestamp = parseTimestamp(value)
  if (timestamp === null) return asString(value) ?? '—'
  return new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false })
}

function formatEta(seconds: unknown): string {
  const value = asNumber(seconds)
  if (value === null || value < 0) return '—'
  if (value < 60) return `${Math.round(value)} 秒`
  return `${Math.floor(value / 60)} 分 ${Math.round(value % 60)} 秒`
}

function formatTokens(value: unknown): string {
  const number = asNumber(value)
  if (number !== null) return number.toLocaleString('zh-CN')
  if (isRecord(value)) {
    const total = asNumber(value.total) ?? asNumber(value.recorded) ?? asNumber(value.tokens)
    if (total !== null) return total.toLocaleString('zh-CN')
  }
  return '—'
}

function progressCount(value: unknown): number | null {
  const number = asNumber(value)
  return number === null ? null : Math.max(0, Math.floor(number))
}

function evidenceIds(decision: JsonRecord): string[] {
  const answer = isRecord(decision.answer) ? decision.answer : decision
  return (Array.isArray(answer.evidence_ids) ? answer.evidence_ids : [])
    .map(asString)
    .filter((value): value is string => Boolean(value))
}

function evidenceRefs(decision: JsonRecord, learning: readonly JsonRecord[]): string[] {
  const refs = [
    ...(Array.isArray(decision.images) ? decision.images : []),
    ...(isRecord(decision.answer) && Array.isArray(decision.answer.images) ? decision.answer.images : []),
  ]
  const recordsById = new Map(learning.map((record) => [asString(record.id) ?? asString(record.evidence_id) ?? '', record]))
  for (const id of evidenceIds(decision)) {
    const record = recordsById.get(id)
    if (!record) continue
    for (const key of ['caseframe', 'case_frame', 'caseframe_path', 'image', 'image_path']) {
      if (typeof record[key] === 'string') refs.push(record[key])
    }
    if (Array.isArray(record.images)) refs.push(...record.images)
  }
  return [...new Set(refs.map(asString).filter((value): value is string => Boolean(value)))].slice(0, 4)
}

function learningDetails(decision: JsonRecord, learning: readonly JsonRecord[]): JsonRecord[] {
  const ids = new Set(evidenceIds(decision))
  return learning.filter((record) => ids.has(asString(record.id) ?? asString(record.evidence_id) ?? ''))
}

function evidenceUrl(apiBaseUrl: string, ref: string): string {
  if (/^data:image\//i.test(ref)) return ref
  const query = new URLSearchParams({ path: ref })
  return `${apiBaseUrl}/api/evidence?${query.toString()}`
}

function displayPlan(decision: JsonRecord): string {
  const answer = isRecord(decision.answer) ? decision.answer : decision
  return asString(answer.plan) ?? asString(decision.plan) ?? '未命名计划'
}

function displayDecisionText(decision: JsonRecord, key: string): string | null {
  const answer = isRecord(decision.answer) ? decision.answer : decision
  return asString(answer[key]) ?? asString(decision[key])
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', signal, headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function groupDecisions(decisions: readonly JsonRecord[]): Array<{ plan: string; rows: JsonRecord[] }> {
  const groups = new Map<string, JsonRecord[]>()
  decisions.forEach((decision) => {
    const plan = displayPlan(decision)
    const rows = groups.get(plan) ?? []
    rows.push(decision)
    groups.set(plan, rows)
  })
  return [...groups.entries()].map(([plan, rows]) => ({ plan, rows }))
}

export function AlSwingApprenticePanel({ apiBaseUrl = 'http://127.0.0.1:8775', onBarsChange, onFocusTime, onMarkersChange }: AlSwingApprenticePanelProps) {
  const [report, setReport] = useState<ReportState>(EMPTY_REPORT)
  const [collapsed, setCollapsed] = useState(false)

  const refresh = useCallback(async (signal: AbortSignal) => {
    const [progressResult, decisionsResult, eventsResult] = await Promise.allSettled([
      fetchJson(`${apiBaseUrl}/api/progress`, signal),
      fetchJson(`${apiBaseUrl}/api/decisions`, signal),
      fetchJson(`${apiBaseUrl}/api/events`, signal),
    ])
    const [learningResult, barsResult] = await Promise.allSettled([
      fetchJson(`${apiBaseUrl}/api/learning`, signal),
      fetchJson(`${apiBaseUrl}/api/bars`, signal),
    ])
    if (signal.aborted) return
    const failed = [progressResult, decisionsResult, eventsResult].find((result) => result.status === 'rejected')
    setReport((current) => ({
      progress: progressResult.status === 'fulfilled' && isRecord(progressResult.value) ? progressResult.value as ProgressPayload : current.progress,
      decisions: decisionsResult.status === 'fulfilled' ? asRecords(decisionsResult.value) : current.decisions,
      events: eventsResult.status === 'fulfilled' ? asRecords(eventsResult.value) : current.events,
      learning: learningResult.status === 'fulfilled' ? asRecords(learningResult.value) : current.learning,
      bars: barsResult.status === 'fulfilled' ? parseBars(barsResult.value) : current.bars,
      error: failed?.status === 'rejected' ? (failed.reason instanceof Error ? failed.reason.message : '报告服务读取失败') : null,
      fetchedAt: Date.now(),
    }))
  }, [apiBaseUrl])

  useEffect(() => {
    const controller = new AbortController()
    const controllers = new Set<AbortController>([controller])
    const request = () => {
      const nextController = new AbortController()
      controllers.add(nextController)
      void refresh(nextController.signal).finally(() => controllers.delete(nextController))
    }
    const initialTimer = window.setTimeout(request, 0)
    const timer = window.setInterval(request, 5000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
      controllers.forEach((activeController) => activeController.abort())
    }
  }, [refresh])

  const markers = useMemo(() => extractMarkers(report.decisions, report.events), [report.decisions, report.events])
  useEffect(() => {
    if (report.bars.length > 0) onBarsChange?.(report.bars)
  }, [onBarsChange, report.bars])
  useEffect(() => {
    onMarkersChange?.(markers)
  }, [markers, onMarkersChange])

  const progress = report.progress
  const materialComplete = progressCount(progress?.material_validated ?? progress?.material_complete)
  const materialSelected = progressCount(progress?.material_selected)
  const sourceReview = isRecord(progress?.source_review) ? progress.source_review : null
  const sourceReviewCompleted = progressCount(sourceReview?.completed)
  const sourceReviewRequested = progressCount(sourceReview?.requested) ?? materialSelected
  const materialTotal = progressCount(progress?.material_total)
  const barComplete = progressCount(progress?.bar_complete)
  const barTotal = progressCount(progress?.bar_total)
  const failureCount = typeof progress?.failed === 'number'
    ? progress.failed
    : progress?.failed === true ? Math.max(1, progress.errors?.length ?? 0) : progress?.errors?.length ?? 0
  const groups = useMemo(() => groupDecisions(report.decisions), [report.decisions])
  const running = progressCount(sourceReview?.running) ?? progressCount(progress?.running) ?? (progress?.running === true ? 1 : 0)
  const queued = progressCount(sourceReview?.queued) ?? progressCount(progress?.queued) ?? 0
  const status = progress
    ? (progress.status ?? (running > 0 ? 'running' : progress.running === false ? 'stopped' : 'reported'))
    : report.error ? 'offline' : 'loading'
  const stage = asString(progress?.stage)?.toLowerCase()
  const statusRaw = asString(progress?.status)?.toLowerCase()
  const statusLabel = stage === 'waiting_implementation' || statusRaw === 'waiting_implementation'
    ? '实现验收中'
    : stage === 'waiting_evidence' || statusRaw === 'waiting_evidence'
      ? '资料核验中'
      : queued > 0 || statusRaw === 'queued' ? '排队中' : status === 'running' ? '运行中' : status === 'failed' || failureCount > 0 ? '有失败' : status === 'offline' ? '服务未连接' : status === 'loading' ? '读取中' : '已读取'

  return <aside style={panelStyle} data-testid="al-swing-apprentice-panel" data-bars-loaded={report.bars.length} data-action-markers={markers.length} aria-label="Al波段学徒·本段校验">
    <header style={headerStyle}>
      <div>
        <strong style={{ display: 'block', fontSize: 14 }}>Al波段学徒·本段校验</strong>
        <span style={mutedStyle}>只读报告 · XAUUSD · 5 分钟</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span data-testid="al-swing-report-status" style={{
          color: status === 'offline' || status === 'failed' ? 'var(--red)' : status === 'running' ? 'var(--green)' : 'var(--text-muted)',
          fontSize: 11,
          whiteSpace: 'nowrap',
        }}>{statusLabel}</span>
        <button
          type="button"
          aria-label={collapsed ? '展开学徒报告' : '收起学徒报告'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          style={{ ...mutedStyle, padding: '2px 5px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'inherit', cursor: 'pointer' }}
        >{collapsed ? '展开' : '收起'}</button>
      </div>
    </header>
    {!collapsed && <div style={scrollStyle}>
      {report.error && <div role="alert" style={{ ...mutedStyle, marginBottom: 9, color: 'var(--red)' }}>报告服务：{report.error}</div>}
      {!progress && !report.error && <div style={{ ...mutedStyle, padding: '8px 0' }}>正在读取真实进度…</div>}
      <div style={statGridStyle}>
        <div style={statStyle}><span style={mutedStyle}>最终合格</span><b style={{ display: 'block', marginTop: 3 }}>{materialComplete === null ? '—' : `${materialComplete}/${materialTotal ?? 40}`}</b></div>
        <div style={statStyle}><span style={mutedStyle}>资料初审</span><b style={{ display: 'block', marginTop: 3 }}>{sourceReviewCompleted === null ? '—' : `${sourceReviewCompleted}/${sourceReviewRequested ?? materialTotal ?? 40}`}</b></div>
        <div style={statStyle}><span style={mutedStyle}>资料已选</span><b style={{ display: 'block', marginTop: 3 }}>{materialSelected === null ? '—' : `${materialSelected}/${materialTotal ?? 40}`}</b></div>
        <div style={statStyle}><span style={mutedStyle}>K线</span><b style={{ display: 'block', marginTop: 3 }}>{barComplete === null ? '—' : `${barComplete}/${barTotal ?? 342}`}</b></div>
        <div style={statStyle}><span style={mutedStyle}>失败</span><b style={{ display: 'block', marginTop: 3, color: failureCount > 0 ? 'var(--red)' : 'inherit' }}>{progress ? failureCount : '—'}</b></div>
        <div style={statStyle}><span style={mutedStyle}>Tokens（含缓存）</span><b style={{ display: 'block', marginTop: 3 }}>{formatTokens(progress?.tokens_recorded)}</b><small style={{ ...mutedStyle, display: 'block', marginTop: 2 }}>缓存输入：{formatTokens(progress?.cached_input_tokens_recorded)}</small></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, ...mutedStyle }}>
        <span>ETA：<b style={{ color: 'var(--text)' }}>{formatEta(progress?.eta_seconds)}</b></span>
        <span>最新输出：<b style={{ color: 'var(--text)' }}>{formatTime(progress?.last_output_at)}</b></span>
      </div>
      {progress && <div style={{ marginTop: 8, ...mutedStyle }}>阶段：{stage ?? '—'} · 后台请求：{running} · 排队：{queued} · 更新时间：{formatDateTime(progress.updated_at)} · marker {markers.length}</div>}
      {progress && asString(progress.activity_note) && <div style={{ marginTop: 5, lineHeight: 1.4, ...mutedStyle }}>活动：{asString(progress.activity_note)}</div>}
      {progress && Array.isArray(progress.errors) && progress.errors.length > 0 && <div style={{ marginTop: 6, color: 'var(--red)', fontSize: 11, lineHeight: 1.4 }}>{progress.errors.slice(0, 3).map((error, index) => <div key={index}>{typeof error === 'string' ? error : JSON.stringify(error)}</div>)}</div>}

      <div style={sectionTitleStyle}><strong>决策时间线</strong><span style={mutedStyle}>{report.decisions.length} 条</span></div>
      {groups.length === 0
        ? <div style={mutedStyle}>暂无决策记录</div>
        : groups.map((group) => <section key={group.plan} data-testid="al-swing-plan-group">
          <h3 style={{ margin: '8px 0 6px', fontSize: 12, fontWeight: 600 }}>{group.plan}</h3>
          <div style={{ display: 'grid', gap: 6 }}>
            {group.rows.map((decision, rowIndex) => {
              const answer = isRecord(decision.answer) ? decision.answer : decision
              const actions = Array.isArray(answer.actions) ? answer.actions : []
              const decisionIdx = asString(decision.idx) ?? asString(decision.index)
              const decisionTime = recordTimestamp(decision)
              const relatedEvents = report.events.filter((event) => {
                const eventIdx = asString(event.idx) ?? asString(event.decision_idx) ?? asString(event.decision_index)
                return Boolean((decisionIdx && eventIdx && decisionIdx === eventIdx) || (!decisionIdx && decisionTime !== null && recordTimestamp(event) === decisionTime))
              })
              const timelineActions = [
                ...actions.map(nestedActionRecord),
                ...relatedEvents,
              ].filter((value): value is JsonRecord => Boolean(value))
              const refs = evidenceRefs(decision, report.learning)
              const details = learningDetails(decision, report.learning)
              return <article key={`${asString(decision.idx) ?? rowIndex}-${decisionTime ?? 'unknown'}`} style={decisionStyle} data-testid="al-swing-decision-row">
                <button type="button" onClick={() => { if (decisionTime !== null) onFocusTime?.(decisionTime) }} style={{ display: 'flex', width: '100%', padding: 0, border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: decisionTime === null ? 'default' : 'pointer' }}>
                  <span style={{ ...mutedStyle, minWidth: 88 }}>{formatTime(decision.time ?? decision.decision_time)}</span>
                  <span style={{ minWidth: 0, flex: 1 }}><b>{asString(decision.time_beijing) ?? displayDecisionText(decision, 'bias') ?? '决策'}</b>{asString(decision.idx) && <small style={{ ...mutedStyle, marginLeft: 6 }}>#{asString(decision.idx)}</small>}</span>
                </button>
                {displayDecisionText(decision, 'reason') && <p style={{ margin: '7px 0 5px', lineHeight: 1.45, fontSize: 11 }}>{displayDecisionText(decision, 'reason')}</p>}
                {displayDecisionText(decision, 'wait_condition') && <p style={{ margin: '4px 0', ...mutedStyle }}>等待条件：{displayDecisionText(decision, 'wait_condition')}</p>}
                {timelineActions.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
                  {timelineActions.map((action, actionIndex) => {
                    const kind = actionKind(action)
                    const text = asString(action.label) ?? asString(action.description) ?? asString(action.action) ?? asString(action.type)
                    const time = recordTimestamp(action, decision)
                    const price = actionPrice(action)
                    const isPassive = !kind && /wait|hold|observe|等待|持有/i.test(text ?? '')
                    const passiveLabel = /hold|持有/i.test(text ?? '') ? '持有' : '等待'
                    return <span key={`${actionIndex}-${text ?? 'action'}`} style={{ ...mutedStyle, padding: '3px 6px', borderRadius: 5, border: '1px solid var(--border-strong)', color: isPassive ? 'var(--text-muted)' : kind ? 'var(--text)' : 'var(--text-muted)' }}>{kind ? actionLabel(kind) : isPassive ? passiveLabel : text ?? '记录'}{price !== undefined ? ` @ ${price}` : ''}{time !== null ? ` · ${formatTime(time)}` : ''}</span>
                  })}
                </div>}
                {(asString(answer.changed_evidence) || refs.length > 0 || details.length > 0 || evidenceIds(decision).length > 0) && <div style={{ marginTop: 8, ...mutedStyle }}>
                  {asString(answer.changed_evidence) && <div>证据变化：{asString(answer.changed_evidence)}</div>}
                  {refs.length > 0 && <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>{refs.map((ref) => <img key={ref} src={evidenceUrl(apiBaseUrl, ref)} alt={`证据 ${ref.split(/[\\/]/).pop() ?? ref}`} loading="lazy" style={{ width: 92, height: 58, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--border-strong)', background: 'var(--surface)' }} />)}</div>}
                  {details.map((detail, detailIndex) => <div key={`${asString(detail.id) ?? detailIndex}`} style={{ marginTop: 5, lineHeight: 1.4 }}><b>{asString(detail.id) ?? '证据'}</b>{asString(detail.quote) && <span> · {asString(detail.quote)}</span>}{asString(detail.original_quote) && <span> · {asString(detail.original_quote)}</span>}</div>)}
                  {evidenceIds(decision).length > 0 && <div style={{ marginTop: 5 }}>引用：{evidenceIds(decision).join('、')}</div>}
                </div>}
              </article>
            })}
          </div>
        </section>)}
      {report.fetchedAt !== null && <div style={{ marginTop: 12, textAlign: 'right', ...mutedStyle }}>轮询间隔 5 秒</div>}
    </div>}
  </aside>
}
