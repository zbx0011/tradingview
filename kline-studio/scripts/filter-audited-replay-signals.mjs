import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function fail(message) {
  throw new Error(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

const [sourceArg, auditArg, outputArg] = process.argv.slice(2)
if (!sourceArg || !auditArg || !outputArg) {
  fail('用法：node scripts/filter-audited-replay-signals.mjs <source.json> <audit.json> <output.json>')
}

const sourcePath = path.resolve(sourceArg)
const auditPath = path.resolve(auditArg)
const outputPath = path.resolve(outputArg)
const sourceBytes = await readFile(sourcePath)
const auditBytes = await readFile(auditPath)
const source = JSON.parse(sourceBytes.toString('utf8'))
const audit = JSON.parse(auditBytes.toString('utf8'))

if (!Array.isArray(source.drawings) || source.counts?.total !== source.drawings.length) {
  fail('来源信号数量无效')
}
if (!Array.isArray(audit.signals) || audit.counts?.reviewed !== source.drawings.length) {
  fail('审计信号数量与来源不一致')
}

const auditByNumber = new Map()
for (const decision of audit.signals) {
  const number = decision.signal_number
  if (!Number.isInteger(number) || number < 1 || number > source.drawings.length || auditByNumber.has(number)) {
    fail(`审计信号编号无效：${number}`)
  }
  if (decision.status !== 'deleted' && !String(decision.status).startsWith('kept')) {
    fail(`审计状态无效：${decision.status}`)
  }
  auditByNumber.set(number, decision)
}

const kept = source.drawings.flatMap((drawing, index) => {
  const originalSignalNumber = index + 1
  const decision = auditByNumber.get(originalSignalNumber)
  if (!decision) fail(`缺少第 ${originalSignalNumber} 条审计决定`)
  if (decision.status === 'deleted') return []
  return [{ ...drawing, original_signal_number: originalSignalNumber }]
})

if (kept.length !== audit.counts.kept) {
  fail(`保留数量不一致：audit=${audit.counts.kept}, actual=${kept.length}`)
}

const result = {
  ...source,
  counts: { ...source.counts, total: kept.length },
  drawings: kept,
  audited_selection: {
    scope: audit.scope,
    source_file: sourcePath,
    source_sha256: sha256(sourceBytes),
    audit_file: auditPath,
    audit_sha256: sha256(auditBytes),
    active_rule_set_id: audit.active_rule_set_id,
    active_rule_version: audit.active_rule_version,
    reviewed: audit.counts.reviewed,
    kept: audit.counts.kept,
    deleted: audit.counts.deleted,
    retained_original_signal_numbers: kept.map((drawing) => drawing.original_signal_number),
    preserves_original_ledger_identity: true,
  },
}

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ outputPath, auditSha256: sha256(auditBytes), kept: kept.length }, null, 2)}\n`)
