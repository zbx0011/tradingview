import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const DEFAULT_PROJECT = 'D:/项目/tradingview/kline-studio'
const ACTIVE_RULE_SET_IDS = new Set([
  'tvfloat_user_custom_v2_range_lifecycle_bound_20260812',
  'tvfloat_user_custom_v2_effective_swing_sr_20260812',
  'tvfloat_user_custom_v2_strict_narrow_channel_ema20_two_close_any_pullback_20260812',
  'tvfloat_user_custom_v2_strict_narrow_channel_any_pullback_20260812',
  'tvfloat_user_custom_v2_any_pullback_body50_anchor_contact_20260811',
  'tvfloat_user_custom_v2_anchor_candle_contact_first_pullback_20260811',
  'tvfloat_user_custom_v2_anchor_required_first_pullback_20260811',
  'tvfloat_user_custom_v2_five_close_breakout_20260811',
  'tvfloat_user_custom_v2_range30_unanchored_pullback_20260810',
])
const INTERVAL_IDS = new Map([[1, '1m'], [5, '5m'], [15, '15m'], [30, '30m'], [60, '1h'], [120, '2h'], [240, '4h'], [1440, '1d'], [10080, '1w']])

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const key = token.slice(2)
    if (key === 'dry-run') {
      values.dryRun = true
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    values[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    index += 1
  }
  return values
}

function finite(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`Missing or invalid ${label}`)
  return number
}

function integer(value, label) {
  const number = finite(value, label)
  if (!Number.isInteger(number)) throw new Error(`Invalid integer ${label}`)
  return number
}

function nonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function sha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function normalizedSymbol(value) {
  const symbol = String(value ?? '').toUpperCase()
  if (symbol.endsWith('XAUUSD')) return 'XAUUSD'
  if (symbol.includes('BTCUSDT.P')) return 'BTCUSDT.P'
  if (symbol.endsWith('ETHUSD')) return 'ETHUSD'
  throw new Error(`Unsupported website symbol: ${value}`)
}

function beijingDate(unixSeconds) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(unixSeconds * 1000))
  const part = (type) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function validTouchIndices(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length < minimum || value.some((item) => !Number.isInteger(item) || item < 0 || item > maximum)) throw new Error(`Invalid ${label}`)
  if (new Set(value).size !== value.length || value.some((item, index) => index > 0 && item <= value[index - 1])) throw new Error(`Invalid ordered ${label}`)
  return [...value]
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) throw new Error('Usage: node scripts/import-replay-ranges.mjs --input <recognized_ranges.json> [--name <layer>] [--project <dir>] [--dry-run]')
const projectDirectory = resolve(args.project ?? DEFAULT_PROJECT)
const inputPath = resolve(args.input)
try { await access(inputPath) } catch { throw new Error(`Range artifact does not exist: ${inputPath}`) }
const inputBytes = await readFile(inputPath)
const inputSha256 = createHash('sha256').update(inputBytes).digest('hex')
const source = JSON.parse(inputBytes.toString('utf8'))
if (source.schema_version !== 1 || source.artifact_type !== 'custom_v2_recognized_range_lifecycles') throw new Error('Unsupported recognized-range artifact schema')
if (source.rule_set_key !== 'user_custom_v2' || !ACTIVE_RULE_SET_IDS.has(source.rule_set_id)) throw new Error('Range artifact is not a supported 30-bar/one-sided Custom V2 rule set')
sha256(source.rule_set_sha256, 'rule_set_sha256')
sha256(source.source_data_sha256, 'source_data_sha256')
sha256(source.source_decisions_sha256, 'source_decisions_sha256')
if (!Array.isArray(source.ranges)) throw new Error('Range artifact ranges must be an array')
const sourceWindowEndIdx = source.window?.end_idx === undefined
  ? null
  : integer(source.window.end_idx, 'window.end_idx')

const symbol = normalizedSymbol(source.symbol)
const timeframeMinutes = integer(source.timeframe_minutes, 'timeframe_minutes')
const interval = INTERVAL_IDS.get(timeframeMinutes)
if (!interval) throw new Error(`Unsupported website timeframe: ${timeframeMinutes} minutes`)
const timeframeSeconds = timeframeMinutes * 60
const seenIds = new Set()
const ranges = source.ranges.map((range, index) => {
  const rangeId = nonEmpty(range.range_id, '')
  if (!rangeId || seenIds.has(rangeId)) throw new Error(`Invalid or duplicate range_id at index ${index}`)
  seenIds.add(rangeId)
  const kind = range.kind
  if (kind !== 'two_sided_range' && kind !== 'one_sided_edge') throw new Error(`Invalid range kind for ${rangeId}`)
  const startIdx = integer(range.start_idx, `${rangeId}.start_idx`)
  const formationEndIdx = integer(range.formation_end_idx, `${rangeId}.formation_end_idx`)
  const firstDetectedIdx = integer(range.first_detected_idx, `${rangeId}.first_detected_idx`)
  const lastObservedIdx = integer(range.last_observed_idx, `${rangeId}.last_observed_idx`)
  const startTime = integer(range.start_time, `${rangeId}.start_time`)
  const formationEndTime = integer(range.formation_end_time, `${rangeId}.formation_end_time`)
  const firstDetectedTime = integer(range.first_detected_time, `${rangeId}.first_detected_time`)
  const lastObservedTime = integer(range.last_observed_time, `${rangeId}.last_observed_time`)
  const displayEndTime = integer(range.display_end_time, `${rangeId}.display_end_time`)
  const status = range.status === 'broken' ? 'broken' : 'active'
  const brokenAtTime = range.broken_at_time === null ? null : integer(range.broken_at_time, `${rangeId}.broken_at_time`)
  const userConfirmedDisplaySupplement = range.user_confirmed_display_supplement === true
  const evidenceSource = nonEmpty(range.evidence_source, '')
  const supplementReason = nonEmpty(range.supplement_reason, '')
  if (userConfirmedDisplaySupplement && (evidenceSource !== 'frozen_ohlc_user_confirmation' || !supplementReason)) throw new Error(`Invalid user-confirmed supplement provenance for ${rangeId}`)
  // A consolidated lifecycle can keep adding touches after its first causal
  // detection. Validate the 30-bar requirement at first detection, while
  // allowing the final merged formation geometry to extend no later than the
  // last bar on which that lifecycle was observed.
  if (firstDetectedIdx - startIdx + 1 < 30 || formationEndIdx < startIdx || formationEndIdx > lastObservedIdx || firstDetectedIdx < startIdx || firstDetectedIdx > lastObservedIdx || startTime > formationEndTime || formationEndTime > lastObservedTime || firstDetectedTime < startTime || firstDetectedTime > lastObservedTime || displayEndTime < startTime || (status === 'active' && displayEndTime < formationEndTime) || (status === 'broken' && (brokenAtTime === null || displayEndTime !== brokenAtTime))) throw new Error(`Invalid causal range lifecycle for ${rangeId}`)
  const common = {
    rangeId, kind, startIdx, formationEndIdx, firstDetectedIdx, lastObservedIdx,
    startTime, formationEndTime, firstDetectedTime, lastObservedTime,
    displayEndTime, status, brokenAtTime,
    ...(userConfirmedDisplaySupplement ? { userConfirmedDisplaySupplement, evidenceSource, supplementReason } : {}),
  }
  if (kind === 'two_sided_range') {
    const upperZoneLow = finite(range.upper_zone_low, `${rangeId}.upper_zone_low`)
    const upperZoneHigh = finite(range.upper_zone_high, `${rangeId}.upper_zone_high`)
    const lowerZoneLow = finite(range.lower_zone_low, `${rangeId}.lower_zone_low`)
    const lowerZoneHigh = finite(range.lower_zone_high, `${rangeId}.lower_zone_high`)
    const midpoint = finite(range.midpoint, `${rangeId}.midpoint`)
    if (!(lowerZoneLow <= lowerZoneHigh && lowerZoneHigh < midpoint && midpoint < upperZoneLow && upperZoneLow <= upperZoneHigh)) throw new Error(`Invalid two-sided prices for ${rangeId}`)
    const upperTouchIndices = validTouchIndices(range.upper_touch_indices, 2, lastObservedIdx, `${rangeId}.upper_touch_indices`)
    const lowerTouchIndices = validTouchIndices(range.lower_touch_indices, 2, lastObservedIdx, `${rangeId}.lower_touch_indices`)
    if (upperTouchIndices.filter((idx) => idx <= firstDetectedIdx).length < 2 || lowerTouchIndices.filter((idx) => idx <= firstDetectedIdx).length < 2) throw new Error(`Two-sided range ${rangeId} was not proven at first detection`)
    return {
      ...common, upperZoneLow, upperZoneHigh, lowerZoneLow, lowerZoneHigh, midpoint,
      upperTouchIndices, lowerTouchIndices,
    }
  }
  const activeEdge = range.active_edge
  if (activeEdge !== 'upper' && activeEdge !== 'lower') throw new Error(`Invalid active edge for ${rangeId}`)
  const edgeZoneLow = finite(range.edge_zone_low, `${rangeId}.edge_zone_low`)
  const edgeZoneHigh = finite(range.edge_zone_high, `${rangeId}.edge_zone_high`)
  const touchIndices = validTouchIndices(range.touch_indices, 3, lastObservedIdx, `${rangeId}.touch_indices`)
  const detectedTouchIndices = touchIndices.filter((idx) => idx <= firstDetectedIdx)
  if (edgeZoneLow > edgeZoneHigh || detectedTouchIndices.length < 3 || detectedTouchIndices.at(-1) - detectedTouchIndices[0] + 1 < 30) throw new Error(`Invalid one-sided geometry for ${rangeId}`)
  return { ...common, activeEdge, edgeZoneLow, edgeZoneHigh, touchIndices }
})

const reported = source.counts ?? {}
const twoSidedCount = ranges.filter((range) => range.kind === 'two_sided_range').length
if (reported.range_lifecycles !== ranges.length || reported.two_sided_ranges !== twoSidedCount || reported.one_sided_edges !== ranges.length - twoSidedCount) throw new Error('Range artifact counts do not match ranges')
let publishedRanges = ranges
let displayPolicy = null
if (source.display_projection !== undefined) {
  const projection = source.display_projection
  const supportedDisplayPolicies = new Set([
    'one_sided_non_overlapping_body_clear_v6',
    'one_sided_non_overlapping_body_clear_v7',
    'one_sided_non_overlapping_body_clear_v8_five_close_break',
    'one_sided_non_overlapping_body_clear_v9_five_close_touch_extend',
    'one_sided_non_overlapping_post_confirmation_body_clear_v10_five_close_touch_extend',
    'one_sided_untrimmed_lifecycle_bound_v11_five_close_touch_extend',
  ])
  if (!projection || !supportedDisplayPolicies.has(projection.policy_version) || !Array.isArray(projection.ranges) || !Array.isArray(projection.suppressed)) throw new Error('Unsupported recognized-range display projection')
  const baseById = new Map(ranges.map((range) => [range.rangeId, range]))
  const projectedIds = new Set()
  publishedRanges = projection.ranges.map((item, index) => {
    const rangeId = nonEmpty(item?.range_id, '')
    const base = baseById.get(rangeId)
    if (!base || base.kind !== 'one_sided_edge' || projectedIds.has(rangeId)) throw new Error(`Invalid projected range at index ${index}`)
    projectedIds.add(rangeId)
    const displayEndTime = integer(item.display_end_time, `${rangeId}.projection.display_end_time`)
    const status = item.status
    const brokenAtTime = item.broken_at_time === null ? null : integer(item.broken_at_time, `${rangeId}.projection.broken_at_time`)
    const edgeZoneLow = finite(item.edge_zone_low, `${rangeId}.projection.edge_zone_low`)
    const edgeZoneHigh = finite(item.edge_zone_high, `${rangeId}.projection.edge_zone_high`)
    const startIdx = integer(item.start_idx, `${rangeId}.projection.start_idx`)
    const formationEndIdx = integer(item.formation_end_idx, `${rangeId}.projection.formation_end_idx`)
    const startTime = integer(item.start_time, `${rangeId}.projection.start_time`)
    const formationEndTime = integer(item.formation_end_time, `${rangeId}.projection.formation_end_time`)
    const firstDetectedIdx = integer(item.first_detected_idx, `${rangeId}.projection.first_detected_idx`)
    const firstDetectedTime = integer(item.first_detected_time, `${rangeId}.projection.first_detected_time`)
    const confirmedBreakAtIdx = item.confirmed_break_at_idx === null ? null : integer(item.confirmed_break_at_idx, `${rangeId}.projection.confirmed_break_at_idx`)
    const breakConfirmationIndices = Array.isArray(item.break_confirmation_indices) ? item.break_confirmation_indices.map((value, confirmationIndex) => integer(value, `${rangeId}.projection.break_confirmation_indices[${confirmationIndex}]`)) : []
    const touchIndices = validTouchIndices(item.touch_indices, 3, base.lastObservedIdx, `${rangeId}.projection.touch_indices`)
    if ((item.user_confirmed_display_supplement === true) !== (base.userConfirmedDisplaySupplement === true)) throw new Error(`Projected supplement provenance mismatch for ${rangeId}`)
    const geometryOverride = item.geometry_override
    const hasGeometryOverride = geometryOverride !== null && geometryOverride !== undefined
    if (hasGeometryOverride) {
      if (
        !new Set([
          'one_sided_non_overlapping_body_clear_v7',
          'one_sided_non_overlapping_body_clear_v8_five_close_break',
          'one_sided_non_overlapping_body_clear_v9_five_close_touch_extend',
          'one_sided_non_overlapping_post_confirmation_body_clear_v10_five_close_touch_extend',
          'one_sided_untrimmed_lifecycle_bound_v11_five_close_touch_extend',
        ]).has(projection.policy_version)
        || nonEmpty(geometryOverride.reason, '') === ''
        || finite(geometryOverride.zone_low, `${rangeId}.projection.geometry_override.zone_low`) !== edgeZoneLow
        || finite(geometryOverride.zone_high, `${rangeId}.projection.geometry_override.zone_high`) !== edgeZoneHigh
        || integer(geometryOverride.formation_start_idx, `${rangeId}.projection.geometry_override.formation_start_idx`) !== startIdx
        || integer(geometryOverride.formation_end_idx, `${rangeId}.projection.geometry_override.formation_end_idx`) !== formationEndIdx
      ) throw new Error(`Invalid projected geometry override for ${rangeId}`)
    }
    if (
      new Set([
        'one_sided_non_overlapping_body_clear_v8_five_close_break',
        'one_sided_non_overlapping_body_clear_v9_five_close_touch_extend',
        'one_sided_non_overlapping_post_confirmation_body_clear_v10_five_close_touch_extend',
        'one_sided_untrimmed_lifecycle_bound_v11_five_close_touch_extend',
      ]).has(projection.policy_version)
      && (
        integer(item.break_confirmation_closes, `${rangeId}.projection.break_confirmation_closes`) !== 5
        || (status === 'broken' && integer(item.confirmed_break_at_time, `${rangeId}.projection.confirmed_break_at_time`) !== brokenAtTime)
        || (status === 'active' && item.confirmed_break_at_time !== null)
      )
    ) throw new Error(`Invalid five-close lifecycle projection for ${rangeId}`)
    const touchBoundedProjection = new Set([
      'one_sided_non_overlapping_body_clear_v9_five_close_touch_extend',
      'one_sided_non_overlapping_post_confirmation_body_clear_v10_five_close_touch_extend',
      'one_sided_untrimmed_lifecycle_bound_v11_five_close_touch_extend',
    ]).has(projection.policy_version)
    if (touchBoundedProjection) {
      const validConfirmation = status === 'broken'
        ? confirmedBreakAtIdx !== null
          && breakConfirmationIndices.length === 5
          && breakConfirmationIndices.every((value, confirmationIndex) => value === confirmedBreakAtIdx - 4 + confirmationIndex)
          && sourceWindowEndIdx !== null
          && confirmedBreakAtIdx <= sourceWindowEndIdx
        : confirmedBreakAtIdx === null && breakConfirmationIndices.length === 0
      if (!validConfirmation) throw new Error(`Invalid touch-bounded break confirmation for ${rangeId}`)
    }
    const remainsInsideSourceZone = edgeZoneLow >= base.edgeZoneLow && edgeZoneHigh <= base.edgeZoneHigh
    const lifecycleBoundProjection = projection.policy_version === 'one_sided_untrimmed_lifecycle_bound_v11_five_close_touch_extend'
    if (lifecycleBoundProjection && (
      rangeId !== item.range_lifecycle_id
      || hasGeometryOverride
      || edgeZoneLow !== base.edgeZoneLow
      || edgeZoneHigh !== base.edgeZoneHigh
      || item.post_confirmation_body_scan_start_idx !== null
      || !Array.isArray(item.post_confirmation_body_trim_indices)
      || item.post_confirmation_body_trim_indices.length !== 0
    )) throw new Error(`Invalid untrimmed lifecycle projection for ${rangeId}`)
    if ((status !== 'active' && status !== 'broken') || startIdx < base.startIdx || formationEndIdx > base.formationEndIdx || startIdx !== touchIndices[0] || formationEndIdx !== touchIndices.at(-1) || formationEndIdx - startIdx + 1 < 30 || touchIndices.some((idx, touchIndex) => touchIndex > 0 && idx - touchIndices[touchIndex - 1] <= 5) || firstDetectedIdx < base.firstDetectedIdx || firstDetectedIdx < formationEndIdx || firstDetectedIdx > base.lastObservedIdx || startTime < base.startTime || formationEndTime > base.formationEndTime || startTime > formationEndTime || firstDetectedTime < formationEndTime || firstDetectedTime > base.lastObservedTime || displayEndTime < formationEndTime || (status === 'broken' && (brokenAtTime === null || (touchBoundedProjection ? displayEndTime > brokenAtTime : brokenAtTime !== displayEndTime))) || (!hasGeometryOverride && !remainsInsideSourceZone) || edgeZoneLow >= edgeZoneHigh) throw new Error(`Invalid projected lifecycle for ${rangeId}`)
    return { ...base, startIdx, formationEndIdx, firstDetectedIdx, startTime, formationEndTime, firstDetectedTime, displayEndTime, status, brokenAtTime, edgeZoneLow, edgeZoneHigh, touchIndices, ...(touchBoundedProjection ? { confirmedBreakAtIdx, breakConfirmationIndices } : {}), ...(hasGeometryOverride ? { geometryOverride } : {}) }
  })
  const projectionCounts = projection.counts ?? {}
  if (projectionCounts.source_lifecycles !== ranges.length || projectionCounts.published_one_sided_edges !== publishedRanges.length || projectionCounts.suppressed !== projection.suppressed.length || projection.suppressed.length + publishedRanges.length !== ranges.length) throw new Error('Range display projection counts do not match source inventory')
  displayPolicy = projection.policy_version
  if (displayPolicy === 'one_sided_non_overlapping_body_clear_v9_five_close_touch_extend' && projection.display_rule_set_id !== 'tvfloat_user_custom_v2_five_close_breakout_20260811') throw new Error('Invalid touch-bounded display rule identity')
  if (displayPolicy === 'one_sided_non_overlapping_post_confirmation_body_clear_v10_five_close_touch_extend' && projection.display_rule_set_id !== 'tvfloat_user_custom_v2_post_confirmation_body_clear_display_20260811') throw new Error('Invalid post-confirmation body-clear display rule identity')
  if (displayPolicy === 'one_sided_untrimmed_lifecycle_bound_v11_five_close_touch_extend' && projection.display_rule_set_id !== 'tvfloat_user_custom_v2_range_lifecycle_bound_20260812') throw new Error('Invalid lifecycle-bound display rule identity')
}
const publishedTwoSidedCount = publishedRanges.filter((range) => range.kind === 'two_sided_range').length
const publishedUserConfirmedCount = publishedRanges.filter((range) => range.userConfirmedDisplaySupplement === true).length
const sourceId = `${symbol.toLowerCase()}-${interval}-custom-v2-ranges-${source.source_decisions_sha256.slice(0, 16)}`
const layerName = nonEmpty(args.name, `${symbol} 自定义V2震荡区间 · ${beijingDate(source.window.start_time)}`)
const payload = {
  schemaVersion: 1,
  symbol,
  interval,
  timeframeSeconds,
  layer: { sourceId, name: layerName },
  provenance: {
    recognizedRangesFile: basename(inputPath),
    recognizedRangesSha256: inputSha256,
    sourceDecisionsSha256: source.source_decisions_sha256,
    sourceDataSha256: source.source_data_sha256,
    ruleSetId: source.rule_set_id,
    ruleSetSha256: source.rule_set_sha256,
    generatedBy: 'scripts/import-replay-ranges.mjs',
    ...(displayPolicy ? { displayPolicy } : {}),
    ...(source.display_projection?.display_rule_set_id ? { displayRuleSetId: source.display_projection.display_rule_set_id } : {}),
  },
  window: {
    startTime: integer(source.window.start_time, 'window.start_time'),
    endTime: integer(source.window.end_time, 'window.end_time'),
  },
  summary: { ranges: publishedRanges.length, twoSided: publishedTwoSidedCount, oneSided: publishedRanges.length - publishedTwoSidedCount, userConfirmedSupplements: publishedUserConfirmedCount },
  ranges: publishedRanges,
}
const outputPath = resolve(args.output ?? join(projectDirectory, 'src', 'data', 'replay-range-layers', `${sourceId}.json`))
if (!args.dryRun) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}
const result = { dryRun: Boolean(args.dryRun), inputPath, outputPath, sourceId, name: layerName, symbol, interval, ...payload.summary }
console.log(`Imported ${publishedRanges.length} recognized ranges (${publishedTwoSidedCount} two-sided / ${publishedRanges.length - publishedTwoSidedCount} one-sided) as "${layerName}"${args.dryRun ? ' (dry run)' : ''}`)
console.log(`IMPORT_RESULT ${JSON.stringify(result)}`)
