import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const CUSTOM_V2_SETUPS = [
  '震荡真突破',
  '震荡反转',
  '窄通道首次回调顺势',
  '窄通道回调顺势',
  '支撑压力反转',
  '两天以上支撑压力反转',
]
const CUSTOM_V2_RULE_VERSIONS = new Set([
  'custom_v2_range_lifecycle_bound_effective_swing_sr',
  'custom_v2',
  'custom_v2_range30_one_sided',
  'custom_v2_range30_one_sided_unanchored_pullback',
  'custom_v2_range30_one_sided_unanchored_pullback_five_close_breakout',
  'custom_v2_range30_one_sided_anchor_required_five_close_breakout',
  'custom_v2_range30_one_sided_anchor_candle_contact_five_close_breakout',
  'custom_v2_range30_one_sided_any_pullback_body50_anchor_contact_five_close_breakout',
  'custom_v2_range30_one_sided_strict_narrow_channel_any_pullback_body50_anchor_contact_five_close_breakout',
  'custom_v2_range30_one_sided_strict_narrow_channel_ema20_two_close_any_pullback_body50_anchor_contact_five_close_breakout',
  'custom_v2_range30_one_sided_strict_narrow_channel_ema20_two_close_any_pullback_body50_anchor_contact_five_close_breakout_effective_swing_sr',
])

function fail(message) {
  throw new Error(message)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function safeSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

const sourceArg = process.argv[2]
if (!sourceArg) fail('用法：设置 REPLAY_SIGNAL_FROZEN_DATA 后运行 node scripts/import-replay-signals.mjs <raw-signals.json> [output.json]')

const sourcePath = path.resolve(sourceArg)
const sourceBytes = await readFile(sourcePath)
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
const source = JSON.parse(sourceBytes.toString('utf8'))

if (source.version !== 1 || source.symbol !== 'OANDA:XAUUSD' || source.timeframe_minutes !== 5) fail('仅支持本次 OANDA:XAUUSD 5 分钟 raw-signals v1 文件')
if (source.input_mode !== 'image/png' || source.signal_mode !== 'raw_non_deduplicated') fail('来源必须是严格 PNG、原始非合并信号')
if (source.rule_set_key !== 'user_custom_v2' || !nonEmpty(source.rule_set_id) || !/^[a-f0-9]{64}$/.test(source.rule_set_sha256)) fail('来源不是可追溯的 Custom V2 规则产物')
if (!Array.isArray(source.drawings) || source.drawings.length === 0 || source.counts?.total !== source.drawings.length) fail('信号数量无效')

const frozenDataArg = process.env.REPLAY_SIGNAL_FROZEN_DATA
if (!frozenDataArg) fail('缺少 REPLAY_SIGNAL_FROZEN_DATA；不得用索引差推算 K 线时间')
const frozenDataPath = path.resolve(frozenDataArg)
const frozenDataBytes = await readFile(frozenDataPath)
const frozenDataSha256 = createHash('sha256').update(frozenDataBytes).digest('hex')
const frozenData = JSON.parse(frozenDataBytes.toString('utf8'))
if (frozenDataSha256 !== source.source_data_sha256) fail(`冻结数据哈希与回放来源不一致：${frozenDataSha256}`)
if (!Array.isArray(frozenData.bars) || frozenData.bars.length === 0 || frozenData.timeframe_minutes !== source.timeframe_minutes || frozenData.timezone !== source.timezone) fail('冻结行情结构、周期或时区无效')

const timeframeSeconds = source.timeframe_minutes * 60
const seenIndices = new Set()
const seenTimes = new Set()
const seenSignalNumbers = new Set()
const setupCounts = Object.fromEntries(CUSTOM_V2_SETUPS.map((setup) => [setup, 0]))
let long = 0
let short = 0

function collectCausalIndices(value, indices) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/(?:^|_)(?:idx|indices)$/.test(key)) {
      for (const candidate of Array.isArray(child) ? child : [child]) {
        if (Number.isInteger(candidate)) indices.add(candidate)
      }
    }
    if (child && typeof child === 'object') collectCausalIndices(child, indices)
  }
}

function reasonIndexTokens(reason, signalIdx) {
  return [...reason.matchAll(/(?<![\d.])\d{3,6}(?![\d.])/g)]
    .map((match) => Number(match[0]))
    .filter((candidate) => candidate <= signalIdx && frozenData.bars[candidate])
}

function referencedCandle(idx) {
  const bar = frozenData.bars[idx]
  if (!bar || !Number.isInteger(bar.time) || bar.time % timeframeSeconds !== 0 || !nonEmpty(bar.beijing_open_time)) fail(`冻结行情缺少索引 ${idx} 的精确时间`)
  return { internalIndex: idx, time: bar.time, beijingTime: bar.beijing_open_time }
}

function displayReason(reason, referenceCandles) {
  const labels = new Map(referenceCandles.map((candle) => [candle.internalIndex, `${candle.beijingTime}（北京时间）`]))
  return reason.replace(/(?<![\d.])\d{3,6}(?![\d.])/g, (token) => labels.get(Number(token)) ?? token)
}

const signals = [...source.drawings]
  .sort((left, right) => left.bar_open_time - right.bar_open_time || left.idx - right.idx)
  .map((drawing, index) => {
    const signalNumber = drawing.original_signal_number ?? index + 1
    if (!Number.isInteger(signalNumber) || signalNumber < 1 || seenSignalNumbers.has(signalNumber)) fail(`信号编号重复或无效：${signalNumber}`)
    if (!Number.isInteger(drawing.idx) || seenIndices.has(drawing.idx)) fail(`信号 idx 重复或无效：${drawing.idx}`)
    if (!Number.isInteger(drawing.bar_open_time) || drawing.bar_open_time % timeframeSeconds !== 0 || seenTimes.has(drawing.bar_open_time)) fail(`信号时间重复或未对齐 5 分钟：${drawing.bar_open_time}`)
    if (drawing.side !== 'L' && drawing.side !== 'S') fail(`信号方向无效：${drawing.side}`)
    if (!CUSTOM_V2_SETUPS.includes(drawing.setup) || !nonEmpty(drawing.reason) || !nonEmpty(drawing.beijing_open_time)) fail(`信号规则或理由无效：${drawing.idx}`)
    if (!CUSTOM_V2_RULE_VERSIONS.has(drawing.signal_context?.rule_version) || drawing.signal_context?.signal_bar_idx !== drawing.idx) fail(`信号上下文不一致：${drawing.idx}`)
    const referenceIndices = new Set([drawing.idx, ...drawing.evidence_indices])
    collectCausalIndices(drawing.signal_context, referenceIndices)
    for (const reasonIdx of reasonIndexTokens(drawing.reason, drawing.idx)) referenceIndices.add(reasonIdx)
    const referenceCandles = [...referenceIndices].sort((left, right) => left - right).map(referencedCandle)
    seenIndices.add(drawing.idx)
    seenTimes.add(drawing.bar_open_time)
    seenSignalNumbers.add(signalNumber)
    setupCounts[drawing.setup] += 1
    if (drawing.side === 'L') long += 1
    else short += 1
    return {
      signalNumber,
      idx: drawing.idx,
      time: drawing.bar_open_time,
      beijingTime: drawing.beijing_open_time,
      side: drawing.side === 'L' ? 'long' : 'short',
      setup: drawing.setup,
      reason: drawing.reason,
      displayReason: displayReason(drawing.reason, referenceCandles),
      evidenceIndices: drawing.evidence_indices,
      referenceCandles,
      recordSha256: drawing.record_sha256,
      chainSha256: drawing.chain_sha256,
      signalContext: drawing.signal_context,
    }
  })

const sourceId = `xauusd-custom-v2-signals-${sourceSha256.slice(0, 16)}`
const outputArg = process.argv[3]
const outputPath = outputArg
  ? path.resolve(outputArg)
  : path.resolve('src', 'data', 'replay-signal-layers', `${safeSlug(sourceId)}.json`)

const payload = {
  schemaVersion: 2,
  symbol: 'XAUUSD',
  interval: '5m',
  timeframeSeconds,
  layer: {
    sourceId,
    name: 'XAUUSD Custom V2 原始信号',
  },
  provenance: {
    rawSignalsFile: sourcePath,
    rawSignalsSha256: sourceSha256,
    ruleSetId: source.rule_set_id,
    ruleSetSha256: source.rule_set_sha256,
    sourceDataSha256: source.source_data_sha256,
    frozenDataFile: frozenDataPath,
    frozenDataSha256,
    inputMode: source.input_mode,
    signalMode: source.signal_mode,
    generatedBy: 'scripts/import-replay-signals.mjs',
  },
  window: {
    startTime: signals[0].time,
    endTime: signals.at(-1).time,
    firstBeijingTime: signals[0].beijingTime,
    lastBeijingTime: signals.at(-1).beijingTime,
  },
  summary: {
    signals: signals.length,
    long,
    short,
    setupCounts,
  },
  signals,
}

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ outputPath, sourceId, rawSignalsSha256: sourceSha256, summary: payload.summary }, null, 2)}\n`)
