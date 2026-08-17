import { useMemo, useState } from 'react'
import { BellRing, Check, ChevronDown, ChevronRight, Eye, EyeOff, Layers3, Pencil, Table2, Trash2, X } from 'lucide-react'
import type { Drawing } from '../lib/drawings'
import type { ChartAlert, PaperOrder } from '../lib/chartContext'
import { formatPrice, INTERVALS, type Candle, type SymbolId } from '../lib/market'
import type { ReplayTradeLayer } from '../lib/replayTradeLayers'
import type { ReplayRangeLayer } from '../lib/replayRangeLayers'
import { shouldRenderReplayRangeSpec, toReplayRangeSpecs } from '../lib/replayRangeRegistry'
import { toReplayTradeConnectionSpecs } from '../lib/replayTradeRegistry'

interface DialogShellProps {
  label: string
  title: string
  subtitle: string
  icon: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  onClose: () => void
}

function DialogShell({ label, title, subtitle, icon, children, footer, onClose }: DialogShellProps) {
  return <div className="modal-backdrop chart-action-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="chart-action-dialog" role="dialog" aria-modal="true" aria-label={label}>
      <header><span>{icon}</span><div><h2>{title}</h2><small>{subtitle}</small></div><button type="button" aria-label={`关闭${label}`} onClick={onClose}><X size={21} /></button></header>
      <div className="chart-action-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </section>
  </div>
}

export function AlertDialog({ symbol, price, onSubmit, onClose }: {
  symbol: SymbolId
  price: number
  onSubmit: (alert: Omit<ChartAlert, 'id' | 'createdAt'>) => void
  onClose: () => void
}) {
  const priceDigits = symbol === 'XAUUSD' ? 3 : symbol === 'BTCUSDT.P' ? 1 : 2
  const [value, setValue] = useState(Number(price.toFixed(priceDigits)))
  const [name, setName] = useState(`${symbol} 价格警报`)
  const [condition, setCondition] = useState<ChartAlert['condition']>('crossing')
  const [frequency, setFrequency] = useState<ChartAlert['frequency']>('once-per-bar')
  const submit = () => onSubmit({ symbol, price: value, name: name.trim() || `${symbol} 价格警报`, condition, frequency })
  return <DialogShell label="创建价格警报" title="创建警报" subtitle={`${symbol} · 价格条件`} icon={<BellRing size={24} />} onClose={onClose} footer={<><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" onClick={submit}>创建</button></>}>
    <div className="chart-action-grid">
      <label>条件<select value={condition} onChange={(event) => setCondition(event.target.value as ChartAlert['condition'])}><option value="crossing">穿越</option><option value="greater">大于</option><option value="less">小于</option></select><ChevronDown size={15} /></label>
      <label>价格<input aria-label="警报价格" type="number" step="0.001" value={value} onChange={(event) => setValue(Number(event.target.value))} /></label>
      <label>触发频率<select value={frequency} onChange={(event) => setFrequency(event.target.value as ChartAlert['frequency'])}><option value="once">仅一次</option><option value="once-per-bar">每根 K 线一次</option><option value="every-time">每次</option></select><ChevronDown size={15} /></label>
      <label className="chart-action-full">警报名称<input aria-label="警报名称" value={name} onChange={(event) => setName(event.target.value)} /></label>
    </div>
  </DialogShell>
}

export function OrderDialog({ symbol, price, initialSide, initialType, onSubmit, onClose }: {
  symbol: SymbolId
  price: number
  initialSide: PaperOrder['side']
  initialType: PaperOrder['type']
  onSubmit: (order: Omit<PaperOrder, 'id' | 'createdAt'>) => void
  onClose: () => void
}) {
  const priceDigits = symbol === 'XAUUSD' ? 3 : symbol === 'BTCUSDT.P' ? 1 : 2
  const [side, setSide] = useState(initialSide)
  const [type, setType] = useState(initialType)
  const [quantity, setQuantity] = useState(1)
  const [value, setValue] = useState(Number(price.toFixed(priceDigits)))
  const submit = () => onSubmit({ symbol, side, type, quantity: Math.max(.001, quantity), price: value })
  return <DialogShell label="模拟订单" title="模拟订单" subtitle={`${symbol} · 不会发送到真实市场`} icon={side === 'buy' ? <span className="order-side-icon buy">↑</span> : <span className="order-side-icon sell">↓</span>} onClose={onClose} footer={<><button type="button" onClick={onClose}>取消</button><button type="button" className={`primary ${side}`} onClick={submit}>{side === 'buy' ? '模拟买入' : '模拟卖出'}</button></>}>
    <div className="order-side-tabs" role="group" aria-label="订单方向"><button type="button" className={side === 'buy' ? 'active buy' : ''} aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>买入</button><button type="button" className={side === 'sell' ? 'active sell' : ''} aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>卖出</button></div>
    <div className="chart-action-grid">
      <label>订单类型<select aria-label="订单类型" value={type} onChange={(event) => setType(event.target.value as PaperOrder['type'])}><option value="limit">限价</option><option value="stop">止损</option></select><ChevronDown size={15} /></label>
      <label>数量<input aria-label="订单数量" type="number" min="0.001" step="0.1" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></label>
      <label className="chart-action-full">价格<input aria-label="订单价格" type="number" step="0.001" value={value} onChange={(event) => setValue(Number(event.target.value))} /></label>
    </div>
  </DialogShell>
}

export function DataTableDialog({ symbol, data, onClose }: { symbol: SymbolId; data: Candle[]; onClose: () => void }) {
  const rows = useMemo(() => data.slice(-300).reverse(), [data])
  return <DialogShell label="K线表格视图" title="表格视图" subtitle={`${symbol} · 最近 ${rows.length} 根 K 线`} icon={<Table2 size={24} />} onClose={onClose}>
    <div className="chart-data-table-wrap"><table><thead><tr><th>时间</th><th>开</th><th>高</th><th>低</th><th>收</th><th>成交量</th></tr></thead><tbody>{rows.map((candle) => <tr key={candle.time}><td>{new Date(candle.time * 1000).toLocaleString('zh-CN', { hour12: false })}</td><td>{formatPrice(candle.open, symbol)}</td><td>{formatPrice(candle.high, symbol)}</td><td>{formatPrice(candle.low, symbol)}</td><td>{formatPrice(candle.close, symbol)}</td><td>{Math.round(candle.volume).toLocaleString('zh-CN')}</td></tr>)}</tbody></table></div>
  </DialogShell>
}

function replayLayerRange(layer: { startTime: number; endTime: number }) {
  const format = (time: number) => new Date(time * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  return `${format(layer.startTime)} — ${format(layer.endTime)}`
}

function replayLayerDateTime(timestamp: number) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp * 1000))
  const values = new Map(parts.map((part) => [part.type, part.value]))
  return `${values.get('year')}-${values.get('month')}-${values.get('day')} ${values.get('hour')}:${values.get('minute')}`
}

function formatReplayPnl(value: number) {
  const formatted = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value))
  return `${value >= 0 ? '+' : '-'}$${formatted}`
}

function replayTradeLayerTitle(layer: ReplayTradeLayer) {
  const baseName = layer.name.replace(/\s*(?:19|20)\d{2}[-/]\d{2}[-/]\d{2}.*$/, '').trim() || layer.name
  const displayTime = layer.finishedAt ?? layer.startedAt ?? layer.startTime
  return `${baseName} · ${replayLayerDateTime(displayTime)}`
}

export function ObjectTreeDialog({ drawings, alerts, orders, replayTradeLayers, replayRangeLayers, selectedReplayRangeId, collapsedReplayRangeLayerIds, onSelectDrawing, onDeleteDrawing, onDeleteAlert, onDeleteOrder, onToggleReplayTradeLayer, onRenameReplayTradeLayer, onDeleteReplayTradeLayer, onToggleReplayRangeLayer, onSetReplayRangeLayerCollapsed, onDeleteReplayRangeLayer, onSelectReplayRange, onToggleReplayRangeObject, onDeleteReplayRangeObject, onClose }: {
  drawings: Drawing[]
  alerts: ChartAlert[]
  orders: PaperOrder[]
  replayTradeLayers: ReplayTradeLayer[]
  replayRangeLayers: ReplayRangeLayer[]
  selectedReplayRangeId: string | null
  collapsedReplayRangeLayerIds: string[]
  onSelectDrawing: (id: string) => void
  onDeleteDrawing: (id: string) => void
  onDeleteAlert: (id: string) => void
  onDeleteOrder: (id: string) => void
  onToggleReplayTradeLayer: (id: string) => void
  onRenameReplayTradeLayer: (id: string, name: string) => void
  onDeleteReplayTradeLayer: (id: string) => void
  onToggleReplayRangeLayer: (id: string) => void
  onSetReplayRangeLayerCollapsed: (id: string, collapsed: boolean) => void
  onDeleteReplayRangeLayer: (id: string) => void
  onSelectReplayRange: (id: string, startTime: number, endTime: number) => void
  onToggleReplayRangeObject: (layerId: string, objectId: string) => void
  onDeleteReplayRangeObject: (objectId: string) => void
  onClose: () => void
}) {
  const simulatedOrderItems = orders.length + replayTradeLayers.length
  const replayRangeObjects = useMemo(() => new Map(replayRangeLayers.map((layer) => [
    layer.id,
    toReplayRangeSpecs(layer.symbol, layer.interval, [layer.sourceId])
      .filter(shouldRenderReplayRangeSpec)
      .filter((range) => !layer.deletedRangeIds.includes(range.id)),
  ])), [replayRangeLayers])
  const replayRangeObjectCount = [...replayRangeObjects.values()].reduce((total, ranges) => total + ranges.length, 0)
  const replayTradeStats = useMemo(() => new Map(replayTradeLayers.map((layer) => {
    const trades = toReplayTradeConnectionSpecs(layer.symbol, layer.interval, [layer.sourceId])
    if (trades.length === 0) return [layer.id, null] as const
    const wins = trades.filter((trade) => trade.pnlUsd > 0).length
    const netPnl = trades.reduce((total, trade) => total + trade.pnlUsd, 0)
    return [layer.id, { winRate: wins / trades.length * 100, netPnl }] as const
  })), [replayTradeLayers])
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null)
  const [layerNameDraft, setLayerNameDraft] = useState('')
  const beginRenameLayer = (layer: ReplayTradeLayer) => {
    setRenamingLayerId(layer.id)
    setLayerNameDraft(layer.name)
  }
  const cancelRenameLayer = () => {
    setRenamingLayerId(null)
    setLayerNameDraft('')
  }
  const commitRenameLayer = (id: string) => {
    const name = layerNameDraft.trim()
    if (!name) return
    onRenameReplayTradeLayer(id, name)
    cancelRenameLayer()
  }
  const subtitle = `${drawings.length} 个绘图 · ${replayRangeObjectCount} 个回放区间 · ${alerts.length} 个警报 · ${simulatedOrderItems} 个模拟订单项`
  return <aside className="object-tree-panel" role="complementary" aria-label="对象树">
    <header><span><Layers3 size={21} /></span><div><h2>对象树</h2><small>{subtitle}</small></div><button type="button" aria-label="关闭对象树" onClick={onClose}><X size={20} /></button></header>
    <div className="object-tree-panel-body">
    <div className="object-tree-section"><h3>绘图</h3>{drawings.length === 0 ? <p>当前图表没有绘图对象</p> : drawings.map((drawing) => <div className="object-tree-row" key={drawing.id}><button type="button" onClick={() => onSelectDrawing(drawing.id)}><span>{drawing.label}</span><small>{drawing.tool}</small></button><button type="button" aria-label={`删除 ${drawing.label}`} onClick={() => onDeleteDrawing(drawing.id)}><Trash2 size={16} /></button></div>)}</div>
    <div className="object-tree-section"><h3>回放震荡区间</h3>{replayRangeLayers.length === 0 ? <p>当前商品没有已导入的回放区间</p> : replayRangeLayers.map((layer) => {
      const ranges = replayRangeObjects.get(layer.id) ?? []
      const hiddenCount = ranges.filter((range) => layer.hiddenRangeIds.includes(range.id)).length
      const collapsed = collapsedReplayRangeLayerIds.includes(layer.id)
      return <div className="object-tree-range-group" key={layer.id}>
        <div className={`object-tree-row object-tree-replay-layer${layer.visible ? '' : ' is-hidden'}`} data-testid={`replay-range-layer-${layer.id}`}>
          <div className="object-tree-layer-main object-tree-range-layer-main">
            <button type="button" className="object-tree-layer-visibility" aria-label={`${layer.visible ? '隐藏' : '显示'} ${layer.name}`} aria-pressed={layer.visible} title={layer.visible ? '隐藏整批回放震荡区间' : '显示整批回放震荡区间'} onClick={() => onToggleReplayRangeLayer(layer.id)}>{layer.visible ? <Eye size={17} /> : <EyeOff size={17} />}</button>
            <button
              type="button"
              className="object-tree-layer-collapse-toggle"
              aria-label={`${collapsed ? '展开' : '折叠'} ${layer.name}`}
              aria-expanded={!collapsed}
              data-testid={`replay-range-layer-toggle-${layer.id}`}
              title={collapsed ? '展开回放震荡区间明细' : '折叠回放震荡区间明细'}
              onClick={() => onSetReplayRangeLayerCollapsed(layer.id, !collapsed)}
            >
              <span className="object-tree-layer-chevron" aria-hidden="true">{collapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}</span>
              <span className="object-tree-layer-copy"><strong>{layer.name}</strong><small>{layer.symbol} · {INTERVALS[layer.interval].label} · {ranges.length} 个区间{hiddenCount ? ` · 已隐藏 ${hiddenCount}` : ''}</small><small>{replayLayerRange(layer)}</small></span>
            </button>
          </div>
          <div className="object-tree-layer-actions"><button type="button" aria-label={`删除回放区间图层 ${layer.name}`} onClick={() => onDeleteReplayRangeLayer(layer.id)}><Trash2 size={16} /></button></div>
        </div>
        {!collapsed && <div className="object-tree-range-items" data-testid={`replay-range-objects-${layer.id}`}>
          {ranges.map((range, index) => {
            const hidden = layer.hiddenRangeIds.includes(range.id) || !layer.visible
            const label = range.kind === 'one_sided_edge' ? (range.activeEdge === 'upper' ? '单边震荡上沿' : '单边震荡下沿') : '震荡区间'
            return <div className={`object-tree-range-item${hidden ? ' is-hidden' : ''}${selectedReplayRangeId === range.id ? ' is-selected' : ''}`} data-testid="replay-range-object-row" data-range-id={range.id} key={range.id}>
              <button type="button" className="object-tree-range-visibility" aria-label={`${layer.hiddenRangeIds.includes(range.id) ? '显示' : '隐藏'} ${label} ${index + 1}`} aria-pressed={!layer.hiddenRangeIds.includes(range.id)} disabled={!layer.visible} onClick={() => onToggleReplayRangeObject(layer.id, range.id)}>{hidden ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              <button type="button" className="object-tree-range-select" aria-label={`选择 ${label} ${index + 1}`} onClick={() => onSelectReplayRange(range.id, range.startTime, range.endTime)}><strong>{label} {index + 1}</strong><small>{range.status === 'broken' ? '已突破' : '有效'} · {replayLayerRange({ startTime: range.startTime, endTime: range.endTime })}</small></button>
              <button type="button" className="object-tree-range-delete" aria-label={`删除 ${label} ${index + 1}`} onClick={() => onDeleteReplayRangeObject(range.id)}><Trash2 size={15} /></button>
            </div>
          })}
        </div>}
      </div>
    })}</div>
    <div className="object-tree-section"><h3>价格警报</h3>{alerts.length === 0 ? <p>当前商品没有价格警报</p> : alerts.map((alert) => <div className="object-tree-row" key={alert.id}><button type="button"><span>{alert.name}</span><small>{formatPrice(alert.price, alert.symbol)}</small></button><button type="button" aria-label={`删除警报 ${alert.name}`} onClick={() => onDeleteAlert(alert.id)}><Trash2 size={16} /></button></div>)}</div>
    <div className="object-tree-section"><h3>模拟订单</h3>{simulatedOrderItems === 0 ? <p>当前商品没有模拟订单</p> : <>
      {replayTradeLayers.map((layer) => {
        const stats = replayTradeStats.get(layer.id)
        const title = replayTradeLayerTitle(layer)
        return <div className={`object-tree-row object-tree-replay-layer${layer.visible ? '' : ' is-hidden'}`} data-testid={`replay-trade-layer-${layer.id}`} key={layer.id}>
        <div className="object-tree-layer-main">
          <button type="button" className="object-tree-layer-visibility" aria-label={`${layer.visible ? '隐藏' : '显示'} ${title}`} aria-pressed={layer.visible} title={layer.visible ? '隐藏整批回放交易标记' : '显示整批回放交易标记'} onClick={() => onToggleReplayTradeLayer(layer.id)}>{layer.visible ? <Eye size={17} /> : <EyeOff size={17} />}</button>
          <span className="object-tree-layer-copy">{renamingLayerId === layer.id
            ? <input autoFocus maxLength={80} aria-label={`修改 ${title} 名称`} value={layerNameDraft} onChange={(event) => setLayerNameDraft(event.target.value)} onFocus={(event) => event.currentTarget.select()} onKeyDown={(event) => {
              if (event.key === 'Enter') commitRenameLayer(layer.id)
              if (event.key === 'Escape') cancelRenameLayer()
            }} />
            : <strong>{title}</strong>}<small>{layer.symbol} · {INTERVALS[layer.interval].label} · {layer.tradeCount} 笔交易 · {layer.markerCount} 个标记</small><small className={`object-tree-layer-stats${stats ? (stats.netPnl >= 0 ? ' is-profit' : ' is-loss') : ''}`} data-testid={`replay-trade-layer-stats-${layer.id}`}>{stats ? `胜率 ${stats.winRate.toFixed(2)}% · 净盈亏 ${formatReplayPnl(stats.netPnl)}` : '胜率 — · 净盈亏 —'}</small><small>{replayLayerRange(layer)}</small></span>
        </div>
        <div className="object-tree-layer-actions">{renamingLayerId === layer.id ? <>
          <button type="button" aria-label={`保存 ${title} 名称`} disabled={!layerNameDraft.trim()} onClick={() => commitRenameLayer(layer.id)}><Check size={16} /></button>
          <button type="button" aria-label={`取消修改 ${title} 名称`} onClick={cancelRenameLayer}><X size={16} /></button>
        </> : <button type="button" aria-label={`重命名模拟订单图层 ${title}`} onClick={() => beginRenameLayer(layer)}><Pencil size={15} /></button>}
          <button type="button" aria-label={`删除模拟订单图层 ${title}`} onClick={() => onDeleteReplayTradeLayer(layer.id)}><Trash2 size={16} /></button>
        </div>
        </div>
      })}
      {orders.map((order) => <div className="object-tree-row" key={order.id}><button type="button"><span>{order.side === 'buy' ? '买入' : '卖出'} {order.quantity} {order.symbol}</span><small>{order.type === 'limit' ? '限价' : '止损'} @ {formatPrice(order.price, order.symbol)}</small></button><button type="button" aria-label={`删除订单 ${order.id}`} onClick={() => onDeleteOrder(order.id)}><Trash2 size={16} /></button></div>)}
    </>}</div>
    </div>
  </aside>
}
