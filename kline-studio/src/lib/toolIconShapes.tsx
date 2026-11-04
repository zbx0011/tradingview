import type { ReactNode } from 'react'

// Shapes for TradingView-style outline icons for drawing tools (28×28 grid).
// Anchor "nodes" are hollow circles; the line segments stop at the circle edge.

const R = 2.4

function node(x: number, y: number) {
  return <circle cx={x} cy={y} r={R} />
}

/** Segment between two points, trimmed so it does not run into node circles. */
function seg(x1: number, y1: number, x2: number, y2: number, trimStart = false, trimEnd = false) {
  const length = Math.hypot(x2 - x1, y2 - y1) || 1
  const dx = (x2 - x1) / length
  const dy = (y2 - y1) / length
  const ax = trimStart ? x1 + dx * R : x1
  const ay = trimStart ? y1 + dy * R : y1
  const bx = trimEnd ? x2 - dx * R : x2
  const by = trimEnd ? y2 - dy * R : y2
  return <path d={`M${ax.toFixed(2)} ${ay.toFixed(2)}L${bx.toFixed(2)} ${by.toFixed(2)}`} />
}

const longShort = (letter: 'L' | 'S') => <>
  {seg(6, 5, 25, 5, true)}
  {seg(3, 14, 25, 14)}
  {seg(6, 23, 25, 23, true)}
  {node(6, 5)}{node(6, 23)}
  <text x={15} y={letter === 'L' ? 11.6 : 20.6} textAnchor="middle" fontSize="7.5" fontWeight="600" fill="currentColor" stroke="none">{letter}</text>
</>

export const TOOL_ICONS: Record<string, ReactNode> = {
  // Cursors
  cursor: <path d="M14 3v7M14 18v7M3 14h7M18 14h7" />,
  'cursor-dot': <circle cx={14} cy={14} r={2.2} fill="currentColor" />,
  'cursor-arrow': <path d="M8 4v18l5-5 3.5 7 2.5-1.2-3.4-6.8H22z" />,
  eraser: <><path d="M5 18 15 8l7 7-7 7H9z" /><path d="M10 13l7 7M13 22h11" /></>,

  // Lines
  trend: <>{seg(6, 22, 22, 6, true, true)}{node(6, 22)}{node(22, 6)}</>,
  'arrow-line': <>{seg(6, 22, 22, 6, true)}{node(6, 22)}<path d="M15 6h7v7" /></>,
  ray: <>{seg(5, 23, 13, 15, true, true)}{seg(13, 15, 25, 3, true)}{node(5, 23)}{node(13, 15)}</>,
  'info-line': <>{seg(5, 22, 18, 9, true, true)}{node(5, 22)}{node(18, 9)}<rect x={15} y={17} width={9} height={7} rx={2.2} /></>,
  'extended-line': <>{seg(3, 25, 10, 18, false, true)}{seg(10, 18, 18, 10, true, true)}{seg(18, 10, 25, 3, true)}{node(10, 18)}{node(18, 10)}</>,
  'trend-angle': <>{seg(5, 22, 21, 7, true, true)}{seg(5, 22, 24, 22, true)}{node(5, 22)}{node(21, 7)}<path d="M13 22a8 8 0 0 0-2.3-5.6" /></>,
  horizontal: <>{seg(2, 14, 14, 14, false, true)}{seg(14, 14, 26, 14, true)}{node(14, 14)}</>,
  'horizontal-ray': <>{seg(5, 14, 26, 14, true)}{node(5, 14)}</>,
  vertical: <>{seg(14, 2, 14, 14, false, true)}{seg(14, 14, 14, 26, true)}{node(14, 14)}</>,
  'cross-line': <>{seg(2, 14, 14, 14, false, true)}{seg(14, 14, 26, 14, true)}{seg(14, 2, 14, 14, false, true)}{seg(14, 14, 14, 26, true)}{node(14, 14)}</>,

  // Channels
  'parallel-channel': <>{seg(3, 17, 8, 12, false, true)}{seg(8, 12, 17, 3, true)}{seg(11, 25, 20, 16, false, true)}{seg(20, 16, 25, 11, true)}{node(8, 12)}{node(20, 16)}</>,
  'regression-trend': <><path d="M4 13 24 5v8L4 21z" />{seg(4, 17, 24, 9, true, true)}{node(4, 17)}{node(24, 9)}</>,
  'flat-top-bottom': <>{seg(5, 14, 23, 5, true, true)}{seg(5, 23, 23, 23, true, true)}{node(5, 14)}{node(23, 5)}{node(5, 23)}{node(23, 23)}</>,
  'disjoint-channel': <>{seg(5, 12, 23, 4, true, true)}{seg(5, 17, 23, 24, true, true)}{node(5, 12)}{node(23, 4)}{node(5, 17)}{node(23, 24)}</>,
  'anchored-vwap': <><path d="M7.4 19.6C11 12 15 17 18 11s5-6 7-6" />{node(6, 22)}</>,

  // Fibonacci & friends
  fib: <><path d="M3 5h18.6M3 11.5h22M3 17h22" />{seg(6, 23, 25, 23, true)}{node(6, 23)}{node(24, 5)}</>,

  // Forecast
  'long-position': longShort('L'),
  'short-position': longShort('S'),

  // Shapes
  brush: <><path d="M4 24c0-4 2.5-7 6-7 2.2 0 3.6 1.5 3.6 3.4C13.6 23 10 24 4 24z" /><path d="M12.6 17.4 24 6" /><path d="M16 9.6c2.4.4 3.7 1.6 4 3.8" /></>,
  rectangle: <><path d="M8.4 6h11.2M8.4 22h11.2M6 8.4v11.2M22 8.4v11.2" />{node(6, 6)}{node(22, 6)}{node(6, 22)}{node(22, 22)}</>,
  'rotated-rectangle': <>{seg(6, 9, 23, 5, true, true)}{seg(23, 5, 22, 21, true, true)}{seg(22, 21, 5, 24, true, true)}{seg(5, 24, 6, 9, true, true)}{seg(6, 9, 22, 21, true, true)}{node(6, 9)}{node(23, 5)}{node(22, 21)}{node(5, 24)}</>,
  'arrow-up': <path d="M10.5 24h7v-9.5h5L14 4 5.5 14.5h5z" />,
  'arrow-down': <path d="M10.5 4h7v9.5h5L14 24 5.5 13.5h5z" />,

  // Annotations / icons
  text: <path d="M6 6h16M14 6v17M10 23h8" />,
  'icon-heart': <path d="M14 23S4 16.6 4 10.4C4 7 6.4 5 9.2 5c2 0 3.6 1.2 4.8 3 1.2-1.8 2.8-3 4.8-3C21.6 5 24 7 24 10.4 24 16.6 14 23 14 23z" />,
}

/** Icons for the left-toolbar group buttons (when the group has no remembered tool icon). */
export const GROUP_ICONS: Record<string, ReactNode> = {
  cursors: TOOL_ICONS.cursor,
  trend: TOOL_ICONS.trend,
  'fib-gann': <><path d="M3 5h18.6M3 10.5h22M3 16h22" />{seg(6, 22, 25, 22, true)}{node(6, 22)}{node(24, 5)}</>,
  patterns: <>{seg(5, 22, 9, 6, true, true)}{seg(9, 6, 15, 15, true, true)}{seg(15, 15, 21, 6, true, true)}{seg(21, 6, 24, 22, true, true)}{seg(9, 6, 21, 6, true, true)}{seg(5, 22, 15, 15, true, true)}{node(5, 22)}{node(9, 6)}{node(15, 15)}{node(21, 6)}{node(24, 22)}</>,
  forecast: TOOL_ICONS['long-position'],
  shapes: TOOL_ICONS.brush,
  annotations: TOOL_ICONS.text,
  icons: TOOL_ICONS['icon-heart'],
}
