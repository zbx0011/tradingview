import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManualTimelineDialog, ReasonEditor } from './ManualPractice'
import type { ManualPracticeSession } from '../lib/manualPractice'

const noop = () => undefined
const renderEditor = (unsupported: string | null, persistenceId?: string) => renderToStaticMarkup(<ReasonEditor
  title="开仓理由" initial={['顺势突破']} required background={{ initial: '上升趋势' }}
  unsupportedReasons={unsupported === null ? null : { initial: unsupported }}
  persistenceId={persistenceId} onSave={noop} onCancel={noop}
/>)
const unsupportedInputs = (markup: string) => (markup.match(/<input\b[^>]*>/g) ?? [])
  .filter(input => /aria-label="不支持理由 \d+"/.test(input))

afterEach(() => vi.unstubAllGlobals())

describe('numbered optional unsupported reasons', () => {
  it.each(['\r\n', '\n', '\r'])('splits legacy multiline text on %j into separate inputs', newline => {
    const markup = renderEditor(`逆势风险${newline}阻力临近`)
    const inputs = unsupportedInputs(markup)
    expect(inputs).toHaveLength(2)
    expect(inputs[0]).toContain('aria-label="不支持理由 1"')
    expect(inputs[0]).toContain('value="逆势风险"')
    expect(inputs[1]).toContain('aria-label="不支持理由 2"')
    expect(inputs[1]).toContain('value="阻力临近"')
    expect(markup).not.toContain('<textarea')
  })

  it('starts with one blank optional input without making counter-evidence mandatory', () => {
    const markup = renderEditor('')
    const inputs = unsupportedInputs(markup)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toContain('value=""')
    expect(inputs[0]).not.toContain('aria-required="true"')
    expect(inputs[0]).not.toMatch(/\srequired(?:=|\s|\/?>)/)
    expect(markup).toContain('（可选）')
    expect(markup).not.toContain('role="alert"')
  })

  it('gives every counter-evidence row a sequential number and dedicated add/delete controls', () => {
    const markup = renderEditor('逆势风险\n阻力临近\n成交不足')
    expect(unsupportedInputs(markup)).toHaveLength(3)
    for (const number of [1, 2, 3]) {
      expect(markup).toContain(`aria-label="不支持理由 ${number}"`)
      expect(markup).toContain(`aria-label="删除不支持理由 ${number}"`)
    }
    expect(markup.match(/aria-label="添加不支持理由"/g)).toHaveLength(1)
    expect(markup).not.toContain('aria-label="不支持理由 4"')
  })

  it('omits the entire optional section when unsupported reasons are not enabled', () => {
    const markup = renderEditor(null)
    expect(unsupportedInputs(markup)).toHaveLength(0)
    expect(markup).not.toContain('不支持理由')
    expect(markup).not.toContain('mp-unsupported-reasons')
    expect(markup).toContain('aria-label="理由 1"')
  })

  it('keeps the mandatory background and existing supporting reason separate', () => {
    const markup = renderEditor('逆势风险\n阻力临近')
    const inputs = markup.match(/<input\b[^>]*>/g) ?? []
    const background = inputs.find(input => input.includes('aria-label="背景（必填）"'))
    const reason = inputs.find(input => input.includes('aria-label="理由 1"'))
    expect(background).toContain('value="上升趋势"')
    expect(background).toContain('aria-required="true"')
    expect(reason).toContain('value="顺势突破"')
    expect(markup).toContain('mp-required')
    expect(markup).not.toContain('aria-label="理由 2"')
  })

  it('restores multiline counter-evidence from the existing string-based panel draft', () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'kline-panel-state-v1:reason:legacy-draft'
        ? JSON.stringify({ rows: ['草稿背景', '草稿做单理由'], unsupported: '草稿风险一\r\n草稿风险二' })
        : null,
      setItem: noop,
      removeItem: noop,
    })
    const markup = renderEditor('', 'legacy-draft')
    const inputs = unsupportedInputs(markup)
    expect(inputs).toHaveLength(2)
    expect(inputs[0]).toContain('value="草稿风险一"')
    expect(inputs[1]).toContain('value="草稿风险二"')
    expect(markup).toContain('value="草稿背景"')
    expect(markup).toContain('value="草稿做单理由"')
  })
})

const timelineSession = (unsupportedReasons?: string): ManualPracticeSession => ({
  id: 'unsupported-timeline', symbol: 'NQ1!', dayKey: 'NQ1!:2025-04-14', dayLabel: '2025-04-14',
  startTime: 0, endTime: 7200, cursorTime: 7200, status: 'completed', createdAt: 1, updatedAt: 2, completedAt: 2,
  trades: [{ id: 'counter-evidence', side: 'long', entryTime: 600, entryPrice: 100, stopLoss: 90, takeProfit: 130,
    exitTime: 3600, exitPrice: 120, exitKind: 'manual', background: '上升趋势', reasons: ['顺势突破'],
    unsupportedReasons, exitReasons: ['主动平仓'], quantity: 1 }],
  notes: [],
})
const renderTimeline = (unsupportedReasons?: string) => renderToStaticMarkup(<ManualTimelineDialog
  session={timelineSession(unsupportedReasons)} onClose={noop} onJump={noop} onEditItem={noop}
/>)

describe('unsupported reasons in the timeline', () => {
  it('renders legacy multiline counter-evidence as numbered list items', () => {
    const markup = renderTimeline('逆势风险\r\n阻力临近\r成交不足')
    expect(markup).toContain('不支持理由')
    expect(markup).toMatch(/<ol\b[^>]*>\s*<li>逆势风险<\/li>\s*<li>阻力临近<\/li>\s*<li>成交不足<\/li>\s*<\/ol>/)
    expect(markup).not.toMatch(/<p\b[^>]*class="mp-timeline-unsupported"/)
  })

  it('does not add an empty counter-evidence heading to old trades', () => {
    expect(renderTimeline()).not.toContain('不支持理由')
    expect(renderTimeline('')).not.toContain('不支持理由')
  })
})
