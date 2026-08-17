import { useEffect, useRef, useState, type Dispatch, type ReactNode } from 'react'
import {
  Activity, ChevronDown, Crosshair, Eye, EyeOff, Heart, Link2, LockKeyhole, Magnet, MousePointer2,
  PencilLine, Ruler, Shapes, SlidersHorizontal, Star, Trash2, TrendingUp, Type, UnlockKeyhole,
  Waypoints, X, ZoomIn,
} from 'lucide-react'
import { type DrawingAction, type DrawingHistory } from '../lib/drawings'
import { getToolGroupForTool, TOOL_GROUPS, type ToolGroupId } from '../lib/toolCatalog'

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
  removeIndicators: () => void
  notify: (message: string) => void
}

const GROUP_ICONS: Record<ToolGroupId, typeof Crosshair> = {
  cursors: Crosshair,
  trend: TrendingUp,
  'fib-gann': SlidersHorizontal,
  patterns: Waypoints,
  forecast: Activity,
  shapes: Shapes,
  annotations: Type,
  icons: Heart,
}

export function DrawingToolbar({
  activeTool, setActiveTool, favoriteTools, toggleFavoriteTool, history, dispatch, magnetMode, setMagnetMode, keepDrawing, setKeepDrawing,
  drawingsLocked, setDrawingsLocked, drawingsHidden, setDrawingsHidden, indicatorsHidden, setIndicatorsHidden,
  syncDrawings, setSyncDrawings, removeIndicators, notify,
}: Props) {
  const toolbarRef = useRef<HTMLElement>(null)
  const [openGroup, setOpenGroup] = useState<ToolGroupId | null>(null)
  const [openAction, setOpenAction] = useState<'magnet' | 'hide' | 'remove' | null>(null)
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

  const chooseTool = (id: string) => {
    setActiveTool(id)
    setOpenGroup(null)
    setOpenAction(null)
  }

  const toggleGroup = (id: ToolGroupId) => {
    setOpenGroup((current) => current === id ? null : id)
    setOpenAction(null)
  }

  const toggleActionMenu = (id: 'magnet' | 'hide' | 'remove') => {
    setOpenAction((current) => current === id ? null : id)
    setOpenGroup(null)
  }

  const clearDrawings = () => {
    if (history.present.length) dispatch({ type: 'clear' })
    notify('所有绘图已删除')
    setOpenAction(null)
  }

  return (
    <aside ref={toolbarRef} className="left-toolbar expanded-toolbar" aria-label="绘图工具">
      <div className="drawing-group-buttons">
        {TOOL_GROUPS.map((group) => {
          const Icon = GROUP_ICONS[group.id]
          return (
            <button
              type="button" key={group.id}
              className={`tool-group-button ${activeGroup === group.id ? 'active' : ''} ${openGroup === group.id ? 'menu-open' : ''}`}
              aria-label={`${group.label}，展开工具`}
              aria-expanded={openGroup === group.id}
              data-testid={`tool-group-${group.id}`}
              title={group.label}
              onClick={() => toggleGroup(group.id)}
            >
              <Icon size={22} /><ChevronDown className="group-chevron" size={10} />
            </button>
          )
        })}
      </div>

      <div className="toolbar-separator" />
      <button className={`tool-group-button ${activeTool === 'measure' ? 'active' : ''}`} aria-label="测量" title="测量（按住 Shift + 点击）" onClick={() => chooseTool('measure')}><Ruler size={21} /></button>
      <button className={`tool-group-button ${activeTool === 'zoom' ? 'active' : ''}`} aria-label="局部放大" title="局部放大" onClick={() => chooseTool('zoom')}><ZoomIn size={22} /></button>
      <div className="toolbar-separator" />

      <button className={`tool-group-button ${magnetMode !== 'off' ? 'active' : ''}`} aria-label="磁吸选项" aria-expanded={openAction === 'magnet'} title="磁吸（Ctrl 临时切换）" onClick={() => toggleActionMenu('magnet')}><Magnet size={21} /><ChevronDown className="group-chevron" size={10} /></button>
      <button className={`tool-group-button ${keepDrawing ? 'active' : ''}`} aria-label="保持绘图模式" aria-pressed={keepDrawing} title="保持绘图模式" onClick={() => { setKeepDrawing(!keepDrawing); notify(!keepDrawing ? '已开启连续绘制' : '已关闭连续绘制') }}><PencilLine size={21} /></button>
      <button className={`tool-group-button ${drawingsLocked ? 'active' : ''}`} aria-label="锁定所有绘图" aria-pressed={drawingsLocked} title="锁定所有绘图" onClick={() => { setDrawingsLocked(!drawingsLocked); notify(!drawingsLocked ? '所有绘图已锁定' : '所有绘图已解锁') }}>{drawingsLocked ? <LockKeyhole size={21} /> : <UnlockKeyhole size={21} />}</button>
      <button className={`tool-group-button ${drawingsHidden || indicatorsHidden ? 'active' : ''}`} aria-label="隐藏选项" aria-expanded={openAction === 'hide'} title="隐藏选项（Ctrl+Alt+H 隐藏绘图）" onClick={() => toggleActionMenu('hide')}>{drawingsHidden || indicatorsHidden ? <EyeOff size={21} /> : <Eye size={21} />}<ChevronDown className="group-chevron" size={10} /></button>
      <button className={`tool-group-button ${syncDrawings ? 'active' : ''}`} aria-label="同步绘图" aria-pressed={syncDrawings} title="同步绘图" onClick={() => { setSyncDrawings(!syncDrawings); notify(!syncDrawings ? '已开启布局绘图同步' : '已关闭绘图同步') }}><Link2 size={21} /></button>
      <div className="tool-spacer" />
      <button className="tool-group-button danger-tool" aria-label="删除选项" aria-expanded={openAction === 'remove'} title="删除选项（Delete 删除选中绘图）" onClick={() => toggleActionMenu('remove')}><Trash2 size={21} /><ChevronDown className="group-chevron" size={10} /></button>

      {selectedGroup && (
        <section className="tool-palette" role="dialog" aria-label={`${selectedGroup.label}工具`} data-testid={`tool-menu-${selectedGroup.id}`}>
          <div className={`tool-palette-list ${selectedGroup.id === 'icons' ? 'icon-grid-list' : ''}`}>
            {Array.from(new Set(visibleTools.map((item) => item.section))).map((section) => (
              <div className="tool-section" key={section}>
                <h4>{section}</h4>
                <div className={selectedGroup.id === 'icons' ? 'icon-tool-grid' : ''}>
                  {visibleTools.filter((item) => item.section === section).map((item) => (
                    <div className={`tool-option-row ${activeTool === item.id ? 'selected' : ''}`} key={item.id}>
                      <button className="tool-option-main" data-testid={`tool-option-${item.id}`} data-behavior={item.behavior} aria-pressed={activeTool === item.id} title={item.description} onClick={() => chooseTool(item.id)}>
                        <span className="tool-glyph">{item.glyph}</span><span className="tool-option-copy"><b>{item.label}</b>{selectedGroup.id !== 'icons' && <small>{item.description}</small>}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
                      </button>
                      <button className={`favorite-button ${favoriteTools.includes(item.id) ? 'active' : ''}`} aria-label={`${favoriteTools.includes(item.id) ? '取消收藏' : '收藏'}${item.label}`} title="收藏工具" onClick={() => toggleFavoriteTool(item.id)}><Star size={14} fill={favoriteTools.includes(item.id) ? 'currentColor' : 'none'} /></button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {openAction === 'magnet' && <ActionMenu title="磁吸模式" onClose={() => setOpenAction(null)}>
        <ActionChoice icon={<MousePointer2 size={17} />} label="关闭磁吸" detail="自由放置绘图点" active={magnetMode === 'off'} onClick={() => { setMagnetMode('off'); setOpenAction(null) }} />
        <ActionChoice icon={<Magnet size={17} />} label="弱磁吸" detail="贴近时辅助吸附" active={magnetMode === 'weak'} onClick={() => { setMagnetMode('weak'); setOpenAction(null) }} />
        <ActionChoice icon={<Magnet size={17} />} label="强磁吸" detail="强制吸附到最近点" active={magnetMode === 'strong'} onClick={() => { setMagnetMode('strong'); setOpenAction(null) }} />
      </ActionMenu>}

      {openAction === 'hide' && <ActionMenu title="隐藏选项" onClose={() => setOpenAction(null)}>
        <ActionChoice icon={drawingsHidden ? <EyeOff size={17} /> : <Eye size={17} />} label="隐藏绘图" detail={`${history.present.length} 个绘图对象`} active={drawingsHidden} onClick={() => setDrawingsHidden(!drawingsHidden)} />
        <ActionChoice icon={indicatorsHidden ? <EyeOff size={17} /> : <Eye size={17} />} label="隐藏指标" detail="MA、EMA、BOLL 和成交量" active={indicatorsHidden} onClick={() => setIndicatorsHidden(!indicatorsHidden)} />
        <ActionChoice icon={<EyeOff size={17} />} label="隐藏全部" detail="同时隐藏绘图与指标" active={drawingsHidden && indicatorsHidden} onClick={() => { const next = !(drawingsHidden && indicatorsHidden); setDrawingsHidden(next); setIndicatorsHidden(next) }} />
      </ActionMenu>}

      {openAction === 'remove' && <ActionMenu title="删除选项" onClose={() => setOpenAction(null)} danger>
        <ActionChoice icon={<Trash2 size={17} />} label={`删除 ${history.present.length} 个绘图`} detail="可使用 Ctrl+Z 撤销" disabled={!history.present.length} onClick={clearDrawings} />
        <ActionChoice icon={<Activity size={17} />} label="删除所有指标" detail="不会删除 K 线" onClick={() => { removeIndicators(); notify('所有指标已移除'); setOpenAction(null) }} />
        <ActionChoice icon={<Trash2 size={17} />} label="删除绘图与指标" detail="清理当前工作区" onClick={() => { clearDrawings(); removeIndicators() }} />
      </ActionMenu>}
    </aside>
  )
}

function ActionMenu({ title, onClose, children, danger = false }: { title: string; onClose: () => void; children: ReactNode; danger?: boolean }) {
  return <section className={`toolbar-action-menu ${danger ? 'danger' : ''}`} role="dialog" aria-label={title}><header><b>{title}</b><button onClick={onClose} aria-label={`关闭${title}`}><X size={15} /></button></header><div>{children}</div></section>
}

function ActionChoice({ icon, label, detail, active, disabled, onClick }: { icon: ReactNode; label: string; detail: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button className={`action-choice ${active ? 'active' : ''}`} disabled={disabled} onClick={onClick}><span>{icon}</span><span><b>{label}</b><small>{detail}</small></span>{active && <span className="choice-check">✓</span>}</button>
}
