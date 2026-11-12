import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManualLossPanel, ManualPracticeCenter, ManualTimelineDialog } from './ManualPractice'
import { ManualReviewCommentEditor } from './ManualReviewCommentEditor'
import { manualReviewCommentKey, manualTimeline, manualTradeCommentKey, type ManualPracticeSession, type ManualReviewComment } from '../lib/manualPractice'
import { formatManualPracticeTime, manualPracticeTimeIso } from '../lib/manualPracticeTime'

const noop = () => undefined
const started = Date.parse('2026-11-10T15:00:01Z')
const finished = Date.parse('2026-11-10T17:02:03Z')
const firstReview = Date.parse('2026-11-12T01:03:04Z')
const lastReview = Date.parse('2026-11-13T14:05:06Z')
const firstComment = Date.parse('2026-11-12T02:03:04Z')
const editedComment = Date.parse('2026-11-13T03:04:05Z')
const unrelatedUpdate = Date.parse('2026-11-14T04:05:06Z')
const paper = (): ManualPracticeSession => ({
  id: 'review-times', symbol: 'NQ1!', dayKey: 'NQ1!:2026-10-30', dayLabel: '2026-10-30',
  startTime: Date.parse('2026-10-30T06:00:00+08:00') / 1000,
  endTime: Date.parse('2026-10-31T05:00:00+08:00') / 1000,
  cursorTime: Date.parse('2026-10-31T05:00:00+08:00') / 1000,
  status: 'completed', createdAt: started, updatedAt: unrelatedUpdate, completedAt: finished,
  reviewStartedAt: firstReview, lastReviewedAt: lastReview,
  trades: [], notes: [{ barTime: Date.parse('2026-10-30T06:10:00+08:00') / 1000,
    interval: '5m', kind: 'no-trade', background: '震荡背景', reasons: ['等待确认'], updatedAt: started }],
})
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const renderHistory = (session: ManualPracticeSession) => renderToStaticMarkup(<ManualPracticeCenter
  store={{ version: 1, activeSessionId: session.status === 'active' ? session.id : null, sessions: [session] }}
  days={[]} loading={false} onStart={noop} onStartLoss={noop} onContinue={noop}
  onRestart={noop} onReview={noop} onDelete={noop} onClose={noop}
/>)
const renderTimeline = (session: ManualPracticeSession) => renderToStaticMarkup(<ManualTimelineDialog
  session={session} onClose={noop} onJump={noop} onEditItem={noop} onReviewItem={noop}
/>)
const withComment = (comment: ManualReviewComment) => {
  const session = paper()
  session.reviewComments = { [manualReviewCommentKey(manualTimeline(session)[0])]: comment }
  return session
}
const renderEditor = (comment?: ManualReviewComment, initial = comment?.text ?? '') => renderToStaticMarkup(<ManualReviewCommentEditor
  sessionId="review-times" item={manualTimeline(paper())[0]} initial={initial} comment={comment}
  onSave={noop} onCancel={noop}
/>)

beforeEach(() => {
  // Local unsaved panel drafts must not make these persisted-time fixtures depend on this computer.
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop, removeItem: noop })
})
afterEach(() => vi.unstubAllGlobals())

describe('practice and review wall-clock times', () => {
  it('shows practice start, completion and latest review in Beijing time on a history row', () => {
    const markup = renderHistory(paper())
    const text = textOf(markup)
    expect(text).toContain('练习开始 2026/11/10 23:00:01')
    expect(text).toContain('练习完成 2026/11/11 01:02:03')
    expect(text).toContain('最近复盘 2026/11/13 22:05:06')
    expect(text).not.toContain('2026/11/14 12:05:06')
    expect(markup).toMatch(/datetime="2026-11-10T17:02:03\.000Z"/i)
  })

  it('shows first and most recent review separately in the timeline, without using market dates', () => {
    const markup = renderTimeline(paper())
    const text = textOf(markup)
    expect(text).toContain('练习开始 2026/11/10 23:00:01')
    expect(text).toContain('练习完成 2026/11/11 01:02:03')
    expect(text).toContain('首次复盘 2026/11/12 09:03:04')
    expect(text).toContain('最近复盘 2026/11/13 22:05:06')
    expect(markup).toMatch(/datetime="2026-11-12T01:03:04\.000Z"/i)
    expect(markup).toMatch(/datetime="2026-11-13T14:05:06\.000Z"/i)
    expect(text).not.toContain('2026/11/14 12:05:06')
  })

  it('keeps unknown legacy review times unknown even when the paper has a recent updatedAt', () => {
    const legacy = paper()
    delete legacy.reviewStartedAt
    delete legacy.lastReviewedAt
    const history = textOf(renderHistory(legacy))
    const timeline = textOf(renderTimeline(legacy))
    expect(history).toContain('最近复盘 未记录')
    expect(timeline).toContain('首次复盘 未记录')
    expect(timeline).toContain('最近复盘 未记录')
    expect(timeline).not.toContain('2026/11/14 12:05:06')
  })

  it('shows an unfinished practice as in progress rather than fabricating a completion time', () => {
    const active = { ...paper(), status: 'active' as const, completedAt: null }
    for (const markup of [renderHistory(active), renderTimeline(active)]) {
      const text = textOf(markup)
      expect(text).toContain('练习完成 进行中')
      expect(text).not.toContain('2026/11/11 01:02:03')
    }
  })

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])('does not render invalid stored wall-clock time %s as a real date', invalid => {
    const session = { ...paper(), createdAt: invalid, completedAt: invalid, reviewStartedAt: invalid, lastReviewedAt: invalid }
    const text = textOf(renderTimeline(session))
    for (const label of ['练习开始', '练习完成', '首次复盘', '最近复盘']) expect(text).toContain(`${label} 未记录`)
    expect(text).not.toContain('1970')
    expect(text).not.toContain('Invalid Date')
  })
})

describe('saved comment creation and edit times', () => {
  it('shows only the creation time when a comment has been saved once', () => {
    const comment = { text: '首次判断', createdAt: firstComment, updatedAt: firstComment }
    for (const markup of [renderEditor(comment), renderTimeline(withComment(comment))]) {
      const text = textOf(markup)
      expect(text).toContain('记录时间 2026/11/12 10:03:04')
      expect(text).not.toContain('修改时间')
      expect(text).not.toContain('最后保存时间')
      expect(markup).toMatch(/datetime="2026-11-12T02:03:04\.000Z"/i)
    }
  })

  it('shows the original recording time and a separate latest modification time after an edit', () => {
    const comment = { text: '修改后的判断', createdAt: firstComment, updatedAt: editedComment }
    for (const markup of [renderEditor(comment), renderTimeline(withComment(comment))]) {
      const text = textOf(markup)
      expect(text).toContain('记录时间 2026/11/12 10:03:04')
      expect(text).toContain('修改时间 2026/11/13 11:04:05')
      expect(markup).toMatch(/datetime="2026-11-13T03:04:05\.000Z"/i)
    }
  })

  it('labels a legacy updatedAt as last saved without inventing a creation time', () => {
    const comment = { text: '旧版评论', updatedAt: editedComment }
    for (const markup of [renderEditor(comment), renderTimeline(withComment(comment))]) {
      const text = textOf(markup)
      expect(text).toContain('最后保存时间 2026/11/13 11:04:05')
      expect(text).not.toContain('记录时间')
      expect(text).not.toContain('修改时间')
    }
  })

  it('does not give an unsaved editor draft a recording or modification timestamp', () => {
    const text = textOf(renderEditor(undefined, '还没保存的评论'))
    expect(text).toContain('记录时间 未记录')
    expect(text).not.toContain('修改时间')
    expect(text).not.toContain('最后保存时间')
  })

  it('does not display a deleted comment or its tombstone time in the timeline', () => {
    const text = textOf(renderTimeline(withComment({ text: '', updatedAt: editedComment })))
    expect(text).not.toContain('2026/11/13 11:04:05')
    expect(text).not.toContain('最后保存时间')
  })
})

const renderLossPanel = (entry?: ManualReviewComment, exit?: ManualReviewComment) => {
  const session = paper()
  const trade = {
    id: 'loss-trade', side: 'long' as const, entryTime: session.startTime + 600, entryPrice: 100,
    stopLoss: 95, takeProfit: 110, exitTime: session.startTime + 900, exitPrice: 95,
    exitKind: 'stop' as const, background: '震荡背景', reasons: ['突破'], exitReasons: [],
  }
  session.trades = [trade]
  session.reviewComments = {
    ...(entry ? { [manualTradeCommentKey(trade.id, 'entry')]: entry } : {}),
    ...(exit ? { [manualTradeCommentKey(trade.id, 'exit')]: exit } : {}),
  }
  return renderToStaticMarkup(<ManualLossPanel session={session} trade={trade} index={0} total={1} mark={null}
    entryComment={entry?.text ?? ''} exitComment={exit?.text ?? ''} onAdvance={noop} onNext={noop}
    onPrevious={noop} onUnderstood={noop} onConfused={noop} onFavorite={noop}
    onToggleFavorite={noop} onComment={noop} onExit={noop}
  />)
}

describe('loss review comment times', () => {
  it('shows separate saved entry and exit comment metadata along with the latest review visit', () => {
    const markup = renderLossPanel(
      { text: '入场需等待', createdAt: firstComment, updatedAt: editedComment },
      { text: '旧版离场评论', updatedAt: finished },
    )
    const text = textOf(markup)
    expect(text).toContain('最近复盘 2026/11/13 22:05:06')
    expect(text).toContain('开仓评论 记录时间 2026/11/12 10:03:04 修改时间 2026/11/13 11:04:05 入场需等待')
    expect(text).toContain('平仓评论 最后保存时间 2026/11/11 01:02:03 旧版离场评论')
    expect(markup.match(/class="mp-review-comment-times"/g)).toHaveLength(2)
  })

  it('adds no comment timestamps when the loss has no saved comments', () => {
    const markup = renderLossPanel()
    expect(markup).not.toContain('mp-review-comment-times')
    const text = textOf(markup)
    expect(text).not.toContain('记录时间')
    expect(text).not.toContain('最后保存时间')
  })
})

describe('saved wall-clock formatting', () => {
  it('formats epoch milliseconds as Beijing time while preserving UTC in the machine-readable value', () => {
    expect(formatManualPracticeTime(finished)).toBe('2026/11/11 01:02:03')
    expect(manualPracticeTimeIso(finished)).toBe('2026-11-10T17:02:03.000Z')
  })

  it('rejects absent, zero, nonfinite, negative and out-of-Date-range values', () => {
    for (const value of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e20]) {
      expect(formatManualPracticeTime(value)).toBe('未记录')
      expect(manualPracticeTimeIso(value)).toBeUndefined()
    }
  })
})
