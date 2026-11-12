import { MessageSquare } from 'lucide-react'
import { FloatingCard, ManualReviewCommentTimes } from './ManualPractice'
import { manualReviewCommentKey, type ManualReviewComment, type ManualTimelineItem } from '../lib/manualPractice'
import { formatManualPracticeTime, manualPracticeTimeIso } from '../lib/manualPracticeTime'
import { usePanelDraft } from '../lib/panelDraft'

export function ManualReviewCommentEditor({ sessionId, item, initial, comment, onSave, onCancel }: {
  sessionId: string
  item: ManualTimelineItem
  initial: string
  comment?: ManualReviewComment
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText, discard] = usePanelDraft<string>(`review-comment:${sessionId}:${manualReviewCommentKey(item)}`, () => initial, (value): value is string => typeof value === 'string')
  const save = () => { onSave(text.trim()); discard() }
  const cancel = () => { discard(); onCancel() }
  return <FloatingCard id="review-comment-editor" ariaLabel="复盘评论" title="复盘评论" icon={<MessageSquare size={14} />}
    className="mp-review-editor" defaultStyle={{ left: 96, bottom: 70, width: 440 }} minWidth={320} minHeight={240}
    onClose={cancel} closeLabel="取消" onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); save() }
    }}>
    <p className="mp-editor-subtitle">行情时间 <time dateTime={manualPracticeTimeIso(item.time * 1000)}>{formatManualPracticeTime(item.time * 1000)}</time> · {item.title}</p>
    <div className="mp-review-original"><small>原理由（保留不改）</small>
      {item.background !== null && <p>背景：{item.background || '未填写'}</p>}
      {item.reasons.length > 0 ? <ol className="mp-reason-list">{item.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ol> : <p>未填写理由</p>}
      {item.unsupportedReasons && <><small>不支持理由</small><ol className="mp-reason-list">{item.unsupportedReasons.split(/\r\n|\r|\n/).map(reason => reason.trim()).filter(Boolean).map((reason, index) => <li key={index}>{reason}</li>)}</ol></>}
    </div>
    <label className="mp-review-input"><span>复盘评论</span><textarea aria-label="复盘评论内容" autoFocus rows={5} value={text} onChange={event => setText(event.target.value)} placeholder="回看后如何评价当时的判断？哪些理由成立，哪些需要改进？" /></label>
    <ManualReviewCommentTimes comment={comment} />
    <p className="mp-muted">评论单独保存，不会修改原理由、交易或盈亏。清空后保存可移除评论。</p>
    <footer className="mp-review-footer"><small>Ctrl+Enter 保存 · Esc 取消</small><button type="button" className="mp-secondary" onClick={cancel}>取消</button><button type="button" className="mp-primary" onClick={save}>保存评论</button></footer>
  </FloatingCard>
}
