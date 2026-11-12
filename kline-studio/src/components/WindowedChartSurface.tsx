import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ChartSurface, type ChartSurfaceHandle, type ChartSurfaceProps } from './ChartSurface'
import { INTERVALS } from '../lib/market'
import { loadChartView } from '../lib/chartViewPersistence'
import {
  candlesForHistoryWindow, CHART_WINDOW_MARGIN, historyIndexAtTime, historyTimeAtIndex,
  MAX_CHART_BARS, planChartHistoryWindow, type ChartHistoryWindow,
} from '../lib/chartHistoryWindow'

interface WindowSelection { key: string; window: ChartHistoryWindow }
interface PendingView { from: number; to: number; focusLatest?: boolean }

/** The application keeps the complete causal history; the renderer owns a bounded viewport. */
export const WindowedChartSurface = forwardRef<ChartSurfaceHandle, ChartSurfaceProps>(function WindowedChartSurface(props, forwardedRef) {
  const innerRef = useRef<ChartSurfaceHandle>(null)
  const [selection, setSelection] = useState<WindowSelection | null>(null)
  const pendingViewRef = useRef<PendingView | null>(null)
  const { data, symbol, interval } = props
  const sourceSeconds = INTERVALS[interval].seconds
  const key = `${symbol}:${interval}:${data[0]?.time ?? 0}`
  const window = useMemo(() => {
    if (selection?.key === key) {
      const selected = selection.window
      // A replay can replace its causal prefix with a shorter one.
      if (selected.end <= data.length) return selected
    }
    if (data.length > MAX_CHART_BARS) {
      const saved = loadChartView(symbol, interval)
      if (saved && saved.anchorTime >= data[0].time && saved.anchorTime <= data[data.length - 1].time) {
        const anchor = historyIndexAtTime(data, saved.anchorTime, sourceSeconds)
        const from = Number.isFinite(saved.fromTime) ? historyIndexAtTime(data, saved.fromTime!, sourceSeconds) : anchor + saved.anchorOffset
        const to = Number.isFinite(saved.toTime) ? historyIndexAtTime(data, saved.toTime!, sourceSeconds) : from + saved.span
        return planChartHistoryWindow(data, from, to, sourceSeconds)
      }
    }
    return planChartHistoryWindow(data, data.length - 200, data.length - 1, sourceSeconds)
  }, [data, interval, key, selection, sourceSeconds, symbol])
  const plottedData = useMemo(() => candlesForHistoryWindow(data, window, sourceSeconds), [data, sourceSeconds, window])
  const overview = window.seconds > sourceSeconds

  const selectRange = useCallback((from: number, to: number, focusLatest = false) => {
    const next = planChartHistoryWindow(data,
      historyIndexAtTime(data, from, sourceSeconds), historyIndexAtTime(data, to, sourceSeconds), sourceSeconds)
    const sameWindow = next.start === window.start && next.end === window.end && next.seconds === window.seconds
    if (sameWindow) {
      if (focusLatest) innerRef.current?.focusLatest()
      else innerRef.current?.setVisibleLogicalRange({
        from: historyIndexAtTime(plottedData, from, window.seconds),
        to: historyIndexAtTime(plottedData, to, window.seconds),
      })
      return
    }
    pendingViewRef.current = { from, to, focusLatest }
    setSelection({ key, window: next })
  }, [data, key, plottedData, sourceSeconds, window])

  // Child effects first commit setData. Then rebase the viewport by timestamp,
  // so replacing a window never slides saved drawings or the candles on screen.
  useEffect(() => {
    const pending = pendingViewRef.current
    if (!pending || !innerRef.current) return
    pendingViewRef.current = null
    if (pending.focusLatest) innerRef.current.focusLatest()
    else innerRef.current.setVisibleLogicalRange({
      from: historyIndexAtTime(plottedData, pending.from, window.seconds),
      to: historyIndexAtTime(plottedData, pending.to, window.seconds),
    })
  }, [plottedData, window.seconds])

  const handleViewportChange = useCallback(() => {
    props.onViewportChange?.()
    if (pendingViewRef.current || data.length <= MAX_CHART_BARS) return
    const range = innerRef.current?.getVisibleLogicalRange()
    if (!range || !plottedData.length) return
    const from = historyTimeAtIndex(plottedData, range.from, window.seconds)
    const to = historyTimeAtIndex(plottedData, range.to, window.seconds)
    const sourceSpan = historyIndexAtTime(data, to, sourceSeconds) - historyIndexAtTime(data, from, sourceSeconds)
    const changeDetail = overview ? sourceSpan < MAX_CHART_BARS / 3 : sourceSpan > MAX_CHART_BARS / 2
    const nearLeft = window.start > 0 && range.from < CHART_WINDOW_MARGIN
    const nearRight = window.end < data.length && range.to > plottedData.length - CHART_WINDOW_MARGIN
    if (changeDetail || nearLeft || nearRight) selectRange(from, to)
  }, [data, overview, plottedData, props, selectRange, sourceSeconds, window])

  useImperativeHandle(forwardedRef, () => {
    const inner = innerRef.current!
    const focusLatest = () => {
      if (data.length <= MAX_CHART_BARS) { inner.focusLatest(); return }
      const last = data.length - 1
      selectRange(historyTimeAtIndex(data, last - (props.focusHistoryBars ?? 110), sourceSeconds),
        historyTimeAtIndex(data, last, sourceSeconds), true)
    }
    const fitContent = () => {
      if (data.length <= MAX_CHART_BARS) inner.fitContent()
      else selectRange(data[0].time, data[data.length - 1].time)
    }
    return {
      ...inner,
      fitContent,
      focusLatest,
      scrollToRealtime: () => {
        if (data.length <= MAX_CHART_BARS) inner.scrollToRealtime()
        else focusLatest()
      },
      showTimeRange: (from, to) => {
        if (data.length <= MAX_CHART_BARS) inner.showTimeRange(from, to)
        else selectRange(from, to)
      },
      showDuration: (seconds) => {
        if (data.length <= MAX_CHART_BARS) inner.showDuration(seconds)
        else if (seconds === null) fitContent()
        else selectRange(data[data.length - 1].time - seconds, data[data.length - 1].time)
      },
      goToTime: (time) => {
        if (data.length <= MAX_CHART_BARS) { inner.goToTime(time); return }
        const range = inner.getVisibleLogicalRange()
        const span = Math.max(40, Math.min(MAX_CHART_BARS / 3, (range?.to ?? 150) - (range?.from ?? 0)))
        const center = Math.max(0, Math.min(data.length - 1, historyIndexAtTime(data, time, sourceSeconds)))
        selectRange(historyTimeAtIndex(data, center - span / 2, sourceSeconds),
          historyTimeAtIndex(data, center + span / 2, sourceSeconds))
      },
    }
  }, [data, props.focusHistoryBars, selectRange, sourceSeconds])

  return <>
    <ChartSurface {...props} ref={innerRef} data={plottedData} onViewportChange={handleViewportChange} />
    {overview && <div className="history-overview-badge" role="status">历史概览 · 已聚合显示，放大查看{INTERVALS[interval].label} K线</div>}
  </>
})
