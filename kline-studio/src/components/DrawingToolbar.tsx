import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode } from 'react'
import {
  ChevronLeft, ChevronRight, Eye, EyeOff, Link2, LockKeyhole, Magnet,
  Ruler, Star, Trash2, UnlockKeyhole, ZoomIn,
} from 'lucide-react'
import { type DrawingAction, type DrawingHistory } from '../lib/drawings'
import { getTool, getToolGroupForTool, TOOL_GROUPS, type ToolGroupId } from '../lib/toolCatalog'
import { GROUP_ICONS, TOOL_ICONS } from '../lib/toolIconShapes'
import { ToolIcon, ToolSvg } from './ToolIcons'

export type MagnetMode = 'off' | 'weak' | 'strong'

interface Props {
  activeTool: string
  setActiveTool: (tool: string) => void
  favoriteTools: string[]
  toggleFavoriteTool: (tool: string) => void
  history: DrawingHistory
  dispatch: Dispatch<DrawingAction>
  magnetMode: MagnetMode
  setMagnetMode: (mode: MagnetMode) => void
  keepDrawing: boolean
  setKeepDrawing: (value: boolean) => void
  drawingsLocked: boolean
  setDrawingsLocked: (value: boolean) => void
  drawingsHidden: boolean
  setDrawingsHidden: (value: boolean) => void
  indicatorsHidden: boolean
  setIndicatorsHidden: (value: boolean) => void
  syncDrawings: boolean
  setSyncDrawings: (value: boolean) => void
  positionsHidden: boolean
  setPositionsHidden: (value: boolean) => void
  indicatorCount: number
  removeIndicators: () => void
  notify: (message: string) => void
}

const LAST_GROUP_TOOLS_KEY = 'kline-studio-last-group-tools-v1'
const SNAP_TO_INDICATORS_KEY = 'kline-studio-magnet-snap-indicators-v1'
const ALWAYS_REMOVE_LOCKED_KEY = 'kline-studio-always-remove-locked-v1'

function loadPreference(key: string, fallback: boolean) {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === 'true'
  } catch {
    return fallback
  }
}

function savePreference(key: string, value: boolean) {
  try { localStorage.setItem(key, String(value)) } catch { /* storage unavailable */ }
}

function loadLastGroupTools(): Partial<Record<ToolGroupId, string>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_GROUP_TOOLS_KEY) ?? '{}') as Record<string, unknown>
    const result: Partial<Record<ToolGroupId, string>> = {}
    for (const group of TOOL_GROUPS) {
      const id = parsed[group.id]
      if (typeof id === 'string' && group.tools.some((item) => item.id === id)) result[group.id] = id
    }
    return result
  } catch {
    return {}
  }
}

/** "Alt+T" → "Alt + T" (TradingView spacing). */
function formatShortcut(shortcut: string) {
  return /^[A-Za-z]+(\+[A-Za-z0-9]+)+$/.test(shortcut) ? shortcut.split('+').join(' + ') : shortcut
}

/** Pencil with a small padlock: "keep drawing mode". */
const KEEP_DRAWING_ICON = <>
  <path d="M5 23l1.2-4.6L17.4 7.2a2.3 2.3 0 0 1 3.3 3.3L9.6 21.8z" /><path d="M15.6 9l3.4 3.4" />
  <rect x="17" y="19.5" width="7" height="5.5" rx="1" /><path d="M18.6 19.5v-1.6a1.9 1.9 0 0 1 3.8 0v1.6" />
</>

export function DrawingToolbar({
  activeTool, setActiveTool, favoriteTools, toggleFavoriteTool, history, dispatch, magnetMode, setMagnetMode, keepDrawing, setKeepDrawing,
  drawingsLocked, setDrawingsLocked, drawingsHidden, setDrawingsHidden, indicatorsHidden, setIndicatorsHidden,
  syncDrawings, setSyncDrawings, positionsHidden, setPositionsHidden, indicatorCount, removeIndicators, notify,
}: Props) {
  const toolbarRef = useRef<HTMLElement>(null)
  const [openGroup, setOpenGroup] = useState<ToolGroupId | null>(null)
  const [openAction, setOpenAction] = useState<'magnet' | 'hide' | 'remove' | null>(null)
  const [actionMenuTop, setActionMenuTop] = useState(0)
  const [lastMagnetMode, setLastMagnetMode] = useState<Exclude<MagnetMode, 'off'>>(magnetMode === 'strong' ? 'strong' : 'weak')
  const [snapToIndicators, setSnapToIndicators] = useState(() => loadPreference(SNAP_TO_INDICATORS_KEY, false))
  const [alwaysRemoveLocked, setAlwaysRemoveLocked] = useState(() => loadPreference(ALWAYS_REMOVE_LOCKED_KEY, false))
  const removableDrawingIds = history.present.filter((drawing) => alwaysRemoveLocked || !drawing.locked).map((drawing) => drawing.id)
  const removableDrawingCount = removableDrawingIds.length
  const [lastGroupTools, setLastGroupTools] = useState(loadLastGroupTools)
  const [helpTool, setHelpTool] = useState<{ id: string; top: number } | null>(null)
  const activeGroup = getToolGroupForTool(activeTool)?.id
  const selectedGroup = TOOL_GROUPS.find((group) => group.id === openGroup)

  useEffect(() => {
    const closeOnOutside = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) { setOpenGroup(null); setOpenAction(null) }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpenGroup(null); setOpenAction(null) }
    }
    document.addEventListener('pointerdown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('pointerdown', closeOnOutside); window.removeEventListener('keydown', closeOnEscape) }
  }, [])

  const visibleTools = selectedGroup?.tools ?? []

  // TradingView remembers the last tool picked in each group and shows it on the group button.
  useEffect(() => {
    const group = getToolGroupForTool(activeTool)
    if (!group) return
    const timer = window.setTimeout(() => setLastGroupTools((current) => {
      if (current[group.id] === activeTool) return current
      const next = { ...current, [group.id]: activeTool }
      try { localStorage.setItem(LAST_GROUP_TOOLS_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
      return next
    }), 0)
    return () => window.clearTimeout(timer)
  }, [activeTool])

  const chooseTool = (id: string) => {
    setActiveTool(id)
    setOpenGroup(null)
    setOpenAction(null)
  }

  const toggleGroup = (id: ToolGroupId) => {
    setOpenGroup((current) => current === id ? null : id)
    setOpenAction(null)
    setHelpTool(null)
  }

  const toggleActionMenu = (id: 'magnet' | 'hide' | 'remove', top: number) => {
    setActionMenuTop(top)
    setOpenAction((current) => current === id ? null : id)
    setOpenGroup(null)
  }

  const clearDrawings = () => {
    if (removableDrawingCount === history.present.length) {
      if (history.present.length) dispatch({ type: 'clear' })
    } else if (removableDrawingCount > 0) {
      dispatch({ type: 'delete-many', ids: removableDrawingIds })
    }
    notify(`已移除 ${removableDrawingCount} 个绘图`)
    setOpenAction(null)
  }

  return (
    <aside ref={toolbarRef} className="left-toolbar expanded-toolbar" aria-label="绘图工具">
      <div className="drawing-group-buttons">
        {TOOL_GROUPS.map((group) => {
          const groupTool = lastGroupTools[group.id] ?? group.defaultTool
          const icon = TOOL_ICONS[groupTool] ?? GROUP_ICONS[group.id]
          const isOpen = openGroup === group.id
          return (
            <div className={`tv-tool-group ${isOpen ? 'menu-open' : ''}`} key={group.id}>
              <button
                type="button"
                className={`tool-group-button ${activeGroup === group.id ? 'active' : ''} ${isOpen ? 'menu-open' : ''}`}
                aria-label={getTool(groupTool).label}
                data-testid={`tool-group-main-${group.id}`}
                onClick={() => chooseTool(groupTool)}
              >
                <ToolSvg className="tool-group-svg">{icon}</ToolSvg>
              </button>
              <button
                type="button"
                className="tv-group-arrow"
                aria-label={`${group.label}，展开工具`}
                aria-expanded={isOpen}
                data-testid={`tool-group-${group.id}`}
                onClick={() => toggleGroup(group.id)}
              >
                {isOpen ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
              </button>
              <span className="tv-tool-tooltip for-main" role="tooltip">{getTool(groupTool).label}</span>
              <span className="tv-tool-tooltip for-arrow" role="tooltip">{group.label}</span>
            </div>
          )
        })}
      </div>

      <div className="toolbar-separator" />
      <ToolbarButton label="测量" tooltip="测量（按住 Shift + 点击）" active={activeTool === 'measure'} onClick={() => chooseTool('measure')}><Ruler size={24} strokeWidth={1.3} /></ToolbarButton>
      <ToolbarButton label="局部放大" tooltip="放大" active={activeTool === 'zoom'} onClick={() => chooseTool('zoom')}><ZoomIn size={24} strokeWidth={1.3} /></ToolbarButton>
      <div className="toolbar-separator" />

      <ToolbarButton
        label="磁铁" tooltip={magnetMode === 'strong' ? '强磁铁' : '弱磁铁'} active={magnetMode !== 'off'}
        onClick={() => { const next = magnetMode === 'off' ? lastMagnetMode : 'off'; setMagnetMode(next); notify(next === 'off' ? '磁铁已关闭' : next === 'strong' ? '强磁铁已开启' : '弱磁铁已开启') }}
        menuOpen={openAction === 'magnet'} menuLabel="磁铁选项" onToggleMenu={(top) => toggleActionMenu('magnet', top)}
      ><Magnet size={24} strokeWidth={1.3} /></ToolbarButton>
      <ToolbarButton label="保持绘图模式" tooltip="保持绘图模式" active={keepDrawing} pressed={keepDrawing} onClick={() => { setKeepDrawing(!keepDrawing); notify(!keepDrawing ? '已开启连续绘制' : '已关闭连续绘制') }}><ToolSvg className="tool-group-svg">{KEEP_DRAWING_ICON}</ToolSvg></ToolbarButton>
      <ToolbarButton label="锁定所有绘图" tooltip={drawingsLocked ? '解锁所有绘图' : '锁定所有绘图'} active={drawingsLocked} pressed={drawingsLocked} onClick={() => { setDrawingsLocked(!drawingsLocked); notify(!drawingsLocked ? '所有绘图已锁定' : '所有绘图已解锁') }}>{drawingsLocked ? <LockKeyhole size={24} strokeWidth={1.3} /> : <UnlockKeyhole size={24} strokeWidth={1.3} />}</ToolbarButton>
      <ToolbarButton
        label="隐藏所有绘图" tooltip={drawingsHidden ? '显示所有绘图' : '隐藏所有绘图'} active={drawingsHidden || indicatorsHidden || positionsHidden}
        onClick={() => setDrawingsHidden(!drawingsHidden)}
        menuOpen={openAction === 'hide'} menuLabel="隐藏选项" onToggleMenu={(top) => toggleActionMenu('hide', top)}
      >{drawingsHidden || indicatorsHidden || positionsHidden ? <EyeOff size={24} strokeWidth={1.3} /> : <Eye size={24} strokeWidth={1.3} />}</ToolbarButton>
      <ToolbarButton label="同步绘图" tooltip="同步绘图" active={syncDrawings} pressed={syncDrawings} onClick={() => { setSyncDrawings(!syncDrawings); notify(!syncDrawings ? '已开启布局绘图同步' : '已关闭绘图同步') }}><Link2 size={24} strokeWidth={1.3} /></ToolbarButton>
      <div className="toolbar-separator" />
      <ToolbarButton
        label="移除绘图" tooltip="移除绘图" danger
        onClick={clearDrawings}
        menuOpen={openAction === 'remove'} menuLabel="移除选项" onToggleMenu={(top) => toggleActionMenu('remove', top)}
      ><Trash2 size={24} strokeWidth={1.3} /></ToolbarButton>
      <div className="tool-spacer" />

      {selectedGroup && (
        <section className="tool-palette tv-tool-palette" role="dialog" aria-label={`${selectedGroup.label}工具`} data-testid={`tool-menu-${selectedGroup.id}`} onScroll={() => setHelpTool(null)}>
          <div className={`tool-palette-list ${selectedGroup.id === 'icons' ? 'icon-grid-list' : ''}`}>
            {Array.from(new Set(visibleTools.map((item) => item.section))).map((section) => (
              <div className="tool-section" key={section}>
                <h4>{section}</h4>
                <div className={selectedGroup.id === 'icons' ? 'icon-tool-grid' : ''}>
                  {visibleTools.filter((item) => item.section === section).map((item) => {
                    const favorite = favoriteTools.includes(item.id)
                    return (
                      <div className={`tool-option-row ${activeTool === item.id ? 'selected' : ''}`} key={item.id}>
                        <button className="tool-option-main" data-testid={`tool-option-${item.id}`} data-behavior={item.behavior} aria-pressed={activeTool === item.id} onClick={() => chooseTool(item.id)}>
                          <span className="tool-glyph"><ToolIcon toolId={item.id} glyph={item.glyph} /></span>
                          <span className="tool-option-copy"><b>{item.label}</b></span>
                        </button>
                        {selectedGroup.id !== 'icons' && <span
                          className="tool-help"
                          role="img"
                          aria-label={`${item.label}说明：${item.description}`}
                          onPointerEnter={(event) => {
                            const palette = event.currentTarget.closest('.tool-palette')
                            const rowRect = event.currentTarget.getBoundingClientRect()
                            const paletteRect = palette?.getBoundingClientRect()
                            setHelpTool({ id: item.id, top: paletteRect ? rowRect.top - paletteRect.top + rowRect.height / 2 : 0 })
                          }}
                          onPointerLeave={() => setHelpTool(null)}
                        >?</span>}
                        {item.shortcut && selectedGroup.id !== 'icons' && <kbd>{formatShortcut(item.shortcut)}</kbd>}
                        <button className={`favorite-button ${favorite ? 'active' : ''}`} aria-label={`${favorite ? '取消收藏' : '收藏'}${item.label}`} aria-pressed={favorite} title={favorite ? '从收藏中移除' : '添加到收藏'} onClick={() => toggleFavoriteTool(item.id)}><Star size={20} strokeWidth={1.4} fill={favorite ? 'currentColor' : 'none'} /></button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          {helpTool && <div className="tool-help-popover" style={{ top: helpTool.top }} role="tooltip"><b>{getTool(helpTool.id).label}</b><span>{getTool(helpTool.id).description}</span></div>}
        </section>
      )}

      {openAction === 'magnet' && <ToolbarMenu top={actionMenuTop} label="磁铁选项">
        <MenuItem icon={<Magnet size={22} strokeWidth={1.3} />} label="弱磁铁" selected={magnetMode === 'weak'} onClick={() => { setMagnetMode('weak'); setLastMagnetMode('weak'); setOpenAction(null) }} />
        <MenuItem icon={<Magnet size={22} strokeWidth={1.3} />} label="强磁铁" selected={magnetMode === 'strong'} onClick={() => { setMagnetMode('strong'); setLastMagnetMode('strong'); setOpenAction(null) }} />
        <div className="tv-menu-separator" />
        <MenuToggle label="吸附到指标" checked={snapToIndicators} onChange={(value) => { setSnapToIndicators(value); savePreference(SNAP_TO_INDICATORS_KEY, value) }} />
      </ToolbarMenu>}

      {openAction === 'hide' && <ToolbarMenu top={actionMenuTop} label="隐藏选项">
        <MenuItem label="隐藏绘图" selected={drawingsHidden} onClick={() => { setDrawingsHidden(!drawingsHidden); setOpenAction(null) }} />
        <MenuItem label="隐藏指标" selected={indicatorsHidden} onClick={() => { setIndicatorsHidden(!indicatorsHidden); setOpenAction(null) }} />
        <MenuItem label="隐藏仓位和订单" selected={positionsHidden} onClick={() => { setPositionsHidden(!positionsHidden); setOpenAction(null) }} />
        <MenuItem label="隐藏所有" selected={drawingsHidden && indicatorsHidden && positionsHidden} onClick={() => { const next = !(drawingsHidden && indicatorsHidden && positionsHidden); setDrawingsHidden(next); setIndicatorsHidden(next); setPositionsHidden(next); setOpenAction(null) }} />
      </ToolbarMenu>}

      {openAction === 'remove' && <ToolbarMenu top={actionMenuTop} label="移除选项">
        <MenuItem label={`移除${removableDrawingCount}个绘图`} onClick={() => { clearDrawings(); setOpenAction(null) }} />
        <MenuItem label={`移除${indicatorCount}个指标`} onClick={() => { removeIndicators(); notify('所有指标已移除'); setOpenAction(null) }} />
        <MenuItem label={`移除${removableDrawingCount}个绘图和${indicatorCount}个指标`} onClick={() => { clearDrawings(); removeIndicators(); setOpenAction(null) }} />
        <div className="tv-menu-separator" />
        <MenuToggle label="始终删除锁定的绘图" checked={alwaysRemoveLocked} onChange={(value) => { setAlwaysRemoveLocked(value); savePreference(ALWAYS_REMOVE_LOCKED_KEY, value) }} />
      </ToolbarMenu>}
    </aside>
  )
}

interface ToolbarButtonProps {
  label: string
  tooltip: string
  children: ReactNode
  onClick: () => void
  active?: boolean
  pressed?: boolean
  danger?: boolean
  menuOpen?: boolean
  menuLabel?: string
  onToggleMenu?: (top: number) => void
}

function ToolbarButton({ label, tooltip, children, onClick, active, pressed, danger, menuOpen, menuLabel, onToggleMenu }: ToolbarButtonProps) {
  return <div className={`tv-tool-group ${menuOpen ? 'menu-open' : ''}`}>
    <button type="button" className={`tool-group-button ${active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''} ${danger ? 'danger-tool' : ''}`} aria-label={label} aria-pressed={pressed} onClick={onClick}>{children}</button>
    {onToggleMenu && <button
      type="button" className="tv-group-arrow" aria-label={menuLabel} aria-expanded={menuOpen}
      onClick={(event) => {
        const group = event.currentTarget.parentElement
        const toolbar = group?.closest('.left-toolbar')
        onToggleMenu(group && toolbar ? group.getBoundingClientRect().top - toolbar.getBoundingClientRect().top : 0)
      }}
    >{menuOpen ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}</button>}
    <span className="tv-tool-tooltip for-main" role="tooltip">{tooltip}</span>
    {onToggleMenu && <span className="tv-tool-tooltip for-arrow" role="tooltip">{menuLabel}</span>}
  </div>
}

function ToolbarMenu({ top, label, children }: { top: number; label: string; children: ReactNode }) {
  const menuRef = useRef<HTMLElement>(null)
  // Keep the menu inside the window: menus opened from the bottom buttons grow upward.
  // Runs after every render because React re-applies the `top` style on each render.
  useLayoutEffect(() => {
    const menu = menuRef.current
    const toolbar = menu?.offsetParent
    if (!menu || !toolbar) return
    const toolbarTop = toolbar.getBoundingClientRect().top
    const maxTop = window.innerHeight - toolbarTop - menu.offsetHeight - 8
    menu.style.top = `${Math.max(0, Math.min(top, maxTop))}px`
  })
  return <section ref={menuRef} className="tv-toolbar-menu" role="menu" aria-label={label} style={{ top }}>{children}</section>
}

function MenuItem({ icon, label, selected, onClick }: { icon?: ReactNode; label: string; selected?: boolean; onClick: () => void }) {
  return <button type="button" role="menuitemcheckbox" aria-checked={Boolean(selected)} className={`tv-menu-item ${selected ? 'selected' : ''}`} onClick={onClick}>{icon && <span className="tv-menu-icon">{icon}</span>}<span>{label}</span></button>
}

function MenuToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="tv-menu-toggle"><span>{label}</span><input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" /></label>
}
