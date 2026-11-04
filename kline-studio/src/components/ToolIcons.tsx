import type { ReactNode } from 'react'
import { TOOL_ICONS } from '../lib/toolIconShapes'

export function ToolSvg({ children, className = 'tool-svg', size = 28 }: { children: ReactNode; className?: string; size?: number }) {
  return <svg className={className} viewBox="0 0 28 28" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
}

export function ToolIcon({ toolId, glyph, className, size }: { toolId: string; glyph: string; className?: string; size?: number }) {
  const icon = TOOL_ICONS[toolId]
  if (!icon) return <span className="tool-glyph-text" aria-hidden="true">{glyph}</span>
  return <ToolSvg className={className} size={size}>{icon}</ToolSvg>
}
