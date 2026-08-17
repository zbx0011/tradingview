import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  AlarmClockPlus, ChevronRight, ClipboardPaste, Copy, Layers3, ListPlus, LockKeyhole,
  RotateCcw, Settings2, Table2, Trash2, TrendingDown, TrendingUp,
} from 'lucide-react'

export interface ChartContextData {
  left: number
  top: number
  xFraction: number
  yFraction: number
  time: number
  price: number
}

interface Props {
  value: ChartContextData
  symbol: string
  priceLabel: string
  drawingsCount: number
  indicatorsCount: number
  clipboardAvailable: boolean
  cursorLocked: boolean
  onClose: () => void
  onReset: () => void
  onCopyPrice: () => void
  onPaste: () => void
  onAlert: () => void
  onBuy: () => void
  onSell: () => void
  onOrder: () => void
  onToggleCursorLock: () => void
  onTable: () => void
  onObjectTree: () => void
  onSaveTemplate: () => void
  onApplyTemplate: () => void
  onResetTemplate: () => void
  onRemoveDrawings: () => void
  onRemoveIndicators: () => void
  onSettings: () => void
}

function Item({ icon, label, shortcut, disabled, danger, submenu, onClick }: {
  icon?: ReactNode
  label: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  submenu?: boolean
  onClick?: () => void
}) {
  return <button type="button" role="menuitem" className={`chart-context-item${danger ? ' danger' : ''}`} disabled={disabled} onClick={onClick}>
    <span className="chart-context-icon">{icon}</span>
    <span className="chart-context-label">{label}</span>
    {shortcut && <kbd>{shortcut}</kbd>}
    {submenu && <ChevronRight className="chart-context-chevron" size={20} />}
  </button>
}

export function ChartContextMenu({
  value, symbol, priceLabel, drawingsCount, indicatorsCount, clipboardAvailable, cursorLocked,
  onClose, onReset, onCopyPrice, onPaste, onAlert, onBuy, onSell, onOrder, onToggleCursorLock,
  onTable, onObjectTree, onSaveTemplate, onApplyTemplate, onResetTemplate,
  onRemoveDrawings, onRemoveIndicators, onSettings,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [templateOpen, setTemplateOpen] = useState(false)
  const submenuOnLeft = value.left > window.innerWidth - 850

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
    first?.focus()
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const closeOnResize = () => onClose()
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', closeOnResize)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', closeOnResize)
    }
  }, [onClose])

  const execute = (action: () => void) => {
    action()
    onClose()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length
    items[nextIndex]?.focus()
  }

  return <div
    ref={ref}
    className="chart-context-menu"
    role="menu"
    aria-label="图表右键菜单"
    style={{ left: value.left, top: value.top }}
    onContextMenu={(event) => event.preventDefault()}
    onKeyDown={handleKeyDown}
  >
    <Item icon={<RotateCcw size={27} />} label="重置图表视图" shortcut="Alt + R" onClick={() => execute(onReset)} />
    <div className="chart-context-separator" />
    <Item icon={<Copy size={21} />} label={`复制价格 ${priceLabel}`} onClick={() => execute(onCopyPrice)} />
    <Item icon={<ClipboardPaste size={22} />} label="粘贴" shortcut="Ctrl + V" disabled={!clipboardAvailable} onClick={() => execute(onPaste)} />
    <div className="chart-context-separator" />
    <Item icon={<AlarmClockPlus size={25} />} label={`以 ${priceLabel} 在 ${symbol} 上添加警报…`} shortcut="Alt + A" onClick={() => execute(onAlert)} />
    <Item icon={<TrendingUp size={25} />} label={`买入 1 ${symbol} @ ${priceLabel} 限价`} shortcut="Alt + Shift + B" onClick={() => execute(onBuy)} />
    <Item icon={<TrendingDown size={25} />} label={`卖出 1 ${symbol} @ ${priceLabel} 止损`} onClick={() => execute(onSell)} />
    <Item icon={<ListPlus size={25} />} label={`以 ${priceLabel} 添加订单到 ${symbol}…`} shortcut="Shift + T" onClick={() => execute(onOrder)} />
    <div className="chart-context-separator" />
    <Item icon={<LockKeyhole size={23} />} label={cursorLocked ? '解除按时间锁定垂直光标线' : '按时间锁定垂直光标线'} onClick={() => execute(onToggleCursorLock)} />
    <div className="chart-context-separator" />
    <Item icon={<Table2 size={23} />} label="表格视图" onClick={() => execute(onTable)} />
    <Item icon={<Layers3 size={23} />} label="对象树" onClick={() => execute(onObjectTree)} />
    <div className="chart-context-template-wrap" onMouseEnter={() => setTemplateOpen(true)}>
      <Item label="图表模板" submenu onClick={() => setTemplateOpen(true)} />
      {templateOpen && <div className={`chart-context-submenu${submenuOnLeft ? ' align-left' : ''}`} role="menu" aria-label="图表模板菜单">
        <Item label="保存当前图表模板" onClick={() => execute(onSaveTemplate)} />
        <Item label="应用已保存的模板" onClick={() => execute(onApplyTemplate)} />
        <Item label="恢复默认指标模板" onClick={() => execute(onResetTemplate)} />
      </div>}
    </div>
    <div className="chart-context-separator" />
    <Item icon={<Trash2 size={22} />} label={`移除 ${drawingsCount} 个绘图`} disabled={drawingsCount === 0} danger onClick={() => execute(onRemoveDrawings)} />
    <Item icon={<Trash2 size={22} />} label={`移除 ${indicatorsCount} 个指标`} disabled={indicatorsCount === 0} danger onClick={() => execute(onRemoveIndicators)} />
    <div className="chart-context-separator" />
    <Item icon={<Settings2 size={24} />} label="设置…" onClick={() => execute(onSettings)} />
  </div>
}
