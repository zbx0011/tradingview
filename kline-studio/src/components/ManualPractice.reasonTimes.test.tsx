import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManualLossPanel, ManualReasonTimesDisplay, ManualTimelineDialog } from './ManualPractice'
import { ManualReviewCommentEditor } from './ManualReviewCommentEditor'
import { manualTimeline, type ManualPracticeSession, type ManualReasonTimes, type ManualTrade } from '../lib/manualPractice'

const noop = () => undefined
const marketTime = Date.parse('2026-10-30T06:10:00+08:00') / 1000
const recorded = Date.parse('2026-11-12T01:02:03Z')
const edited = Date.parse('2026-11-12T01:03:04Z')
const secondRecorded = Date.parse('2026-11-12T02:04:05Z')
const legacySaved = Date.parse('2026-11-12T03:05:06Z')
const unrelatedUpdate = Date.parse('2026-11-15T04:06:07Z')
const newTimes: ManualReasonTimes = { createdAt: recorded, updatedAt: edited }
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const reasonTimeTexts = (markup: string) => [...markup.matchAll(/<([a-z][a-z0-9]*)\b[^>]*class="[^"]*\bmp-reason-times\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)]
  .map(match => textOf(match[2]))
const paper = (): ManualPracticeSession => ({
  id: 'original-reason-times', symbol: 'NQ1!', dayKey: 'NQ1!:2026-10-30', dayLabel: '2026-10-30',
  startTime: marketTime - 600, endTime: marketTime + 3600, cursorTime: marketTime + 3600,
  status: 'completed', createdAt: Date.parse('2026-11-01T00:00:00Z'),
  completedAt: Date.parse('2026-11-01T01:00:00Z'), updatedAt: unrelatedUpdate,
  trades: [], notes: [],
})
const trade = (): ManualTrade => ({
  id: 'timed-trade', side: 'long', entryTime: marketTime, entryPrice: 100,
  stopLoss: 95, takeProfit: 110, exitTime: marketTime + 300, exitPrice: 98, exitKind: 'manual',
  background: '震荡', reasons: ['入场原理由'], exitReasons: ['手动离场原理由'],
  reasonTimes: newTimes, exitReasonTimes: { createdAt: secondRecorded, updatedAt: secondRecorded },
})
const renderTimeline = (session: ManualPracticeSession) => renderToStaticMarkup(<ManualTimelineDialog
  session={session} onClose={noop} onJump={noop} onEditItem={noop} onReviewItem={noop}
/>)
const renderLoss = (position = trade()) => {
  const session = { ...paper(), trades: [position] }
  return renderToStaticMarkup(<ManualLossPanel session={session} trade={position} index={0} total={1} mark={null}
    entryComment="" exitComment="" onAdvance={noop} onNext={noop} onPrevious={noop}
    onUnderstood={noop} onConfused={noop} onFavorite={noop} onToggleFavorite={noop} onComment={noop} onExit={noop}
  />)
}

beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop, removeItem: noop }))
afterEach(() => vi.unstubAllGlobals())

describe('original reason time metadata', () => {
  it('renders saved creation and later modification in Beijing time with exact machine-readable timestamps', () => {
    const markup = renderToStaticMarkup(<ManualReasonTimesDisplay times={newTimes} />)
    expect(reasonTimeTexts(markup)).toEqual(['记录时间 2026/11/12 09:02:03 修改时间 2026/11/12 09:03:04'])
    expect(markup).toContain('aria-label="理由保存时间（北京时间）"')
    expect(markup).toMatch(/datetime="2026-11-12T01:02:03\.000Z"/i)
    expect(markup).toMatch(/datetime="2026-11-12T01:03:04\.000Z"/i)
  })

  it('shows one recording time, without claiming an edit, when saved only once', () => {
    const markup = renderToStaticMarkup(<ManualReasonTimesDisplay times={{ createdAt: recorded, updatedAt: recorded }} />)
    expect(reasonTimeTexts(markup)).toEqual(['记录时间 2026/11/12 09:02:03'])
    expect(markup).not.toContain('修改时间')
  })

  it('calls an updated-only legacy timestamp last saved instead of inventing a creation time', () => {
    const markup = renderToStaticMarkup(<ManualReasonTimesDisplay times={{ updatedAt: legacySaved }} />)
    expect(reasonTimeTexts(markup)).toEqual(['最后保存时间 2026/11/12 11:05:06'])
    expect(markup).not.toContain('记录时间')
    expect(markup).not.toContain('修改时间')
  })

  it('renders unknown unsaved reason time as unrecorded', () => {
    const markup = renderToStaticMarkup(<ManualReasonTimesDisplay />)
    expect(reasonTimeTexts(markup)).toEqual(['记录时间 未记录'])
    expect(markup).not.toMatch(/<time\b/)
  })
})

describe('reason times on timeline records', () => {
  it('keeps separate recording histories for long, short and no-trade alternatives on the same candle', () => {
    const session = paper()
    session.notes = [
      { barTime: marketTime, interval: '5m', kind: 'should-trade', side: 'long', biasRank: 0,
        background: '背景', reasons: ['做多原理由'], updatedAt: unrelatedUpdate, reasonTimes: newTimes },
      { barTime: marketTime, interval: '5m', kind: 'should-trade', side: 'short', biasRank: 1,
        background: '背景', reasons: ['做空原理由'], updatedAt: unrelatedUpdate,
        reasonTimes: { createdAt: secondRecorded, updatedAt: secondRecorded } },
      { barTime: marketTime, interval: '5m', kind: 'no-trade', biasRank: 2,
        background: '背景', reasons: ['观望原理由'], updatedAt: legacySaved },
    ]
    const markup = renderTimeline(session)
    const alternatives = markup.split(/<div class="mp-timeline-bias(?: [^"]*)?"/).slice(1)
    expect(alternatives).toHaveLength(3)
    expect(reasonTimeTexts(alternatives[0])).toEqual(['记录时间 2026/11/12 09:02:03 修改时间 2026/11/12 09:03:04'])
    expect(reasonTimeTexts(alternatives[1])).toEqual(['记录时间 2026/11/12 10:04:05'])
    expect(reasonTimeTexts(alternatives[2])).toEqual(['最后保存时间 2026/11/12 11:05:06'])
    expect(textOf(alternatives[0])).toContain('做多原理由')
    expect(textOf(alternatives[1])).toContain('做空原理由')
    expect(textOf(alternatives[2])).toContain('观望原理由')
    expect(reasonTimeTexts(markup).join(' ')).not.toContain('2026/11/15')
    expect(textOf(markup)).toContain('10/30 06:10')
  })

  it('shows distinct entry and manual-exit reason timestamps without treating the market event as the saving time', () => {
    const markup = renderTimeline({ ...paper(), trades: [trade()] })
    expect(reasonTimeTexts(markup)).toEqual([
      '记录时间 2026/11/12 09:02:03 修改时间 2026/11/12 09:03:04',
      '记录时间 2026/11/12 10:04:05',
    ])
    expect(reasonTimeTexts(markup).join(' ')).not.toContain('2026/10/30')
    expect(textOf(markup)).toContain('10/30 06:10')
    expect(textOf(markup)).toContain('10/30 06:15')
  })

  it('shows cancelled-order submission reasoning time rather than its later cancellation update', () => {
    const session = paper()
    session.cancelledOrders = [{
      id: 'cancelled', side: 'short', orderKind: 'limit', entryPrice: 100, stopLoss: 105, takeProfit: 90,
      quantity: 1, createdTime: marketTime, interval: '5m', cancelledTime: marketTime + 300,
      cancellationReason: 'manual', updatedAt: unrelatedUpdate,
      background: '背景', reasons: ['提交挂单的原理由'], reasonTimes: newTimes,
    }]
    const markup = renderTimeline(session)
    expect(reasonTimeTexts(markup)).toEqual(['记录时间 2026/11/12 09:02:03 修改时间 2026/11/12 09:03:04'])
    expect(reasonTimeTexts(markup).join(' ')).not.toContain('2026/11/15')
    expect(textOf(markup)).toContain('提交挂单的原理由')
  })

  it('keeps legacy entry and exit reason saving times unknown instead of copying trade or session times', () => {
    const position = trade()
    delete position.reasonTimes
    delete position.exitReasonTimes
    const markup = renderTimeline({ ...paper(), trades: [position] })
    expect(reasonTimeTexts(markup)).toEqual(['记录时间 未记录', '记录时间 未记录'])
    expect(reasonTimeTexts(markup).join(' ')).not.toContain('2026/')
  })

  it('does not turn an automatic stop exit with no reason into a newly recorded decision', () => {
    const position = { ...trade(), exitKind: 'stop' as const, exitReasons: [], exitReasonTimes: undefined }
    const markup = renderTimeline({ ...paper(), trades: [position] })
    expect(reasonTimeTexts(markup)).toEqual(['记录时间 2026/11/12 09:02:03 修改时间 2026/11/12 09:03:04'])
  })
})

describe('original reason times in loss review and comment editing', () => {
  it('shows entry and manual-exit reason times in the loss panel even without review comments', () => {
    const markup = renderLoss()
    expect(reasonTimeTexts(markup)).toEqual([
      '记录时间 2026/11/12 09:02:03 修改时间 2026/11/12 09:03:04',
      '记录时间 2026/11/12 10:04:05',
    ])
    expect(markup).not.toContain('mp-review-comment-times')
  })

  it('keeps old loss reason times unknown and does not borrow the latest paper update', () => {
    const position = trade()
    delete position.reasonTimes
    delete position.exitReasonTimes
    expect(reasonTimeTexts(renderLoss(position))).toEqual(['记录时间 未记录', '记录时间 未记录'])
  })

  it('keeps original-reason saving time distinct from the review comment saving time in the editor', () => {
    const session = { ...paper(), trades: [trade()] }
    const item = manualTimeline(session).find(entry => entry.kind === 'entry')!
    const comment = { text: '事后评论', createdAt: secondRecorded, updatedAt: secondRecorded }
    const markup = renderToStaticMarkup(<ManualReviewCommentEditor sessionId={session.id} item={item}
      initial={comment.text} comment={comment} onSave={noop} onCancel={noop}
    />)
    expect(reasonTimeTexts(markup)).toEqual(['记录时间 2026/11/12 09:02:03 修改时间 2026/11/12 09:03:04'])
    expect(textOf(markup)).toContain('记录时间 2026/11/12 10:04:05')
    expect(markup).toContain('mp-review-comment-times')
    expect(textOf(markup)).toContain('入场原理由')
  })
})
