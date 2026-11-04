import type { ReactNode } from 'react'

// Outline icons for the quick drawing toolbar (TradingView-style line icons).
// Round "node" handles are filled with the toolbar colour so they read as hollow.
const NODE_FILL = '#131313'

function Node({ x, y }: { x: number; y: number }) {
  return <circle cx={x} cy={y} r={2.6} fill={NODE_FILL} />
}

const ICONS: Record<string, ReactNode> = {
  text: <path d="M7 8h18M16 8v18M11.5 26h9" />,
  'horizontal-ray': <><path d="M11.5 16H28" /><Node x={9} y={16} /></>,
  'arrow-down': <path d="M12 5h8v11h6L16 27 6 16h6z" />,
  vertical: <><path d="M16 4v9M16 19v9" /><Node x={16} y={16} /></>,
  rectangle: <><path d="M9 9h14v14H9z" /><Node x={9} y={9} /><Node x={23} y={9} /><Node x={9} y={23} /><Node x={23} y={23} /></>,
  'arrow-up': <path d="M12 27h8V16h6L16 5 6 16h6z" />,
  'long-position': <>
    <path d="M12 6h16M7 16h21M12 26h16" /><Node x={9} y={6} /><Node x={9} y={26} />
  </>,
  'short-position': <>
    <path d="M12 6h16M7 16h21M12 26h16" /><Node x={9} y={6} /><Node x={9} y={26} />
  </>,
  horizontal: <><path d="M3 16h10.5M18.5 16H29" /><Node x={16} y={16} /></>,
  abcd: <><path d="M7.3 23.7 11.2 9.6M14.6 9.4 18.4 20M21.6 20.3 25.8 8.6" /><Node x={6} y={26} /><Node x={13} y={7.5} /><Node x={20} y={22.5} /><Node x={27} y={6} /></>,
  'rotated-rectangle': <><path d="M7 10 27 6l-2 18-18 3zM7 10l18 14" /><Node x={7} y={10} /><Node x={27} y={6} /><Node x={25} y={24} /><Node x={7} y={27} /></>,
}

export function QuickToolIcon({ toolId, fallback }: { toolId: string; fallback: string }) {
  const icon = ICONS[toolId]
  if (!icon) return <>{fallback}</>
  return <svg className="quick-tool-icon" viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {icon}
    {toolId === 'long-position' && <text x="16" y="14" textAnchor="middle" fontSize="9" fontWeight="600" fill="currentColor" stroke="none">L</text>}
    {toolId === 'short-position' && <text x="16" y="25" textAnchor="middle" fontSize="9" fontWeight="600" fill="currentColor" stroke="none">S</text>}
  </svg>
}
