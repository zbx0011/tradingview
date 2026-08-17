export type ToolGroupId = 'cursors' | 'trend' | 'fib-gann' | 'patterns' | 'forecast' | 'shapes' | 'annotations' | 'icons'

export type ToolBehavior =
  | 'cursor' | 'eraser' | 'line' | 'ray' | 'extended-line' | 'info-line' | 'angle'
  | 'horizontal' | 'horizontal-ray' | 'vertical' | 'cross' | 'channel' | 'regression' | 'vwap'
  | 'fib' | 'fib-extension' | 'fib-channel' | 'fib-time' | 'fan' | 'pitchfork' | 'gann-box'
  | 'circles' | 'spiral' | 'arcs' | 'wedge' | 'pattern' | 'wave' | 'cycles' | 'sine'
  | 'long-position' | 'short-position' | 'forecast' | 'range' | 'bars-pattern' | 'ghost-feed'
  | 'sector' | 'volume-profile' | 'brush' | 'highlighter' | 'rectangle' | 'rotated-rectangle'
  | 'ellipse' | 'polyline' | 'triangle' | 'arc' | 'curve' | 'double-curve' | 'arrow' | 'arrow-mark'
  | 'text' | 'note' | 'callout' | 'comment' | 'price-label' | 'signpost' | 'flag' | 'table'
  | 'media' | 'icon' | 'measure' | 'zoom'

export interface ToolDefinition {
  id: string
  label: string
  group: ToolGroupId | 'actions'
  section: string
  behavior: ToolBehavior
  glyph: string
  description: string
  shortcut?: string
}

export interface ToolGroup {
  id: ToolGroupId
  label: string
  description: string
  defaultTool: string
  tools: ToolDefinition[]
}

const tool = (
  id: string, label: string, group: ToolGroupId, section: string, behavior: ToolBehavior,
  glyph: string, description: string, shortcut?: string,
): ToolDefinition => ({ id, label, group, section, behavior, glyph, description, shortcut })

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'cursors', label: '光标', description: '选择光标样式或快速删除对象', defaultTool: 'cursor',
    tools: [
      tool('cursor', '十字光标', 'cursors', '光标', 'cursor', '┼', '查看时间与价格，选择和移动绘图'),
      tool('cursor-dot', '点光标', 'cursors', '光标', 'cursor', '•', '以小点为中心的光标'),
      tool('cursor-arrow', '箭头光标', 'cursors', '光标', 'cursor', '↖', '经典箭头光标'),
      tool('cursor-demo', '演示光标', 'cursors', '光标', 'cursor', '◉', '强调点击位置，适合演示'),
      tool('cursor-magic', '魔法光标', 'cursors', '光标', 'cursor', '✦', '高亮光标模式'),
      tool('eraser', '橡皮擦', 'cursors', '删除', 'eraser', '⌫', '单击删除绘图，按住 Ctrl 可局部擦除自由绘图', 'Ctrl+擦除'),
    ],
  },
  {
    id: 'trend', label: '趋势线工具', description: '标记趋势、支撑阻力和通道', defaultTool: 'trend',
    tools: [
      tool('trend', '趋势线', 'trend', '线', 'line', '╱', '两点确定的线段', 'Alt+T'),
      tool('arrow-line', '箭头', 'trend', '线', 'arrow', '↗', '带箭头的趋势线'),
      tool('ray', '射线', 'trend', '线', 'ray', '⇗', '从起点穿过第二点向右延伸'),
      tool('info-line', '信息线', 'trend', '线', 'info-line', '↗', '显示变化幅度、距离和角度'),
      tool('extended-line', '延长线', 'trend', '线', 'extended-line', '↔', '向两侧无限延伸'),
      tool('trend-angle', '趋势角度', 'trend', '线', 'angle', '∠', '趋势线与水平方向的夹角'),
      tool('horizontal', '水平线', 'trend', '价格线', 'horizontal', '─', '横跨整个图表的价格线', 'Alt+H'),
      tool('horizontal-ray', '水平射线', 'trend', '价格线', 'horizontal-ray', '━', '从起点向右的水平线'),
      tool('vertical', '垂直线', 'trend', '时间线', 'vertical', '│', '标记特定时间', 'Alt+V'),
      tool('cross-line', '交叉线', 'trend', '价格与时间', 'cross', '┼', '同时标记价格和时间', 'Alt+C'),
      tool('parallel-channel', '平行通道', 'trend', '通道', 'channel', '║', '两条平行边界构成的通道'),
      tool('regression-trend', '回归趋势', 'trend', '通道', 'regression', '≋', '线性回归中轨和偏差通道'),
      tool('flat-top-bottom', '平顶/底', 'trend', '通道', 'channel', '⊓', '一侧水平的收敛通道'),
      tool('disjoint-channel', '分离通道', 'trend', '通道', 'channel', '⑂', '边界可独立调整的通道'),
      tool('anchored-vwap', '锚定 VWAP', 'trend', '成交量', 'vwap', 'V', '从指定点开始的成交量加权均价'),
    ],
  },
  {
    id: 'fib-gann', label: 'Gann 和斐波那契', description: '使用比例、时间和角度构建参考水平', defaultTool: 'fib',
    tools: [
      tool('fib', '斐波那契回撤', 'fib-gann', '斐波那契', 'fib', 'F', '价格区间的关键回撤比例', 'Alt+F'),
      tool('trend-fib-extension', '趋势斐波那契扩展', 'fib-gann', '斐波那契', 'fib-extension', 'F+', '基于趋势段投射扩展目标'),
      tool('fib-channel', '斐波那契通道', 'fib-gann', '斐波那契', 'fib-channel', 'FC', '沿趋势方向的比例通道'),
      tool('fib-time-zone', '斐波那契时区', 'fib-gann', '时间', 'fib-time', 'FT', '以斐波那契序列标记时间节点'),
      tool('fib-speed-fan', '斐波那契速度阻力扇', 'fib-gann', '扇形', 'fan', '≣', '按回撤比例展开的速度扇'),
      tool('trend-fib-time', '趋势斐波那契时间', 'fib-gann', '时间', 'fib-time', 'T', '根据基准时间段投射时间目标'),
      tool('fib-circles', '斐波那契圆', 'fib-gann', '圆弧', 'circles', '◎', '以斐波那契比例绘制同心椭圆'),
      tool('fib-spiral', '斐波那契螺旋', 'fib-gann', '圆弧', 'spiral', '@', '斐波那契比例螺旋线'),
      tool('fib-arcs', '斐波那契速度阻力弧', 'fib-gann', '圆弧', 'arcs', '⌒', '按比例分层的阻力弧'),
      tool('fib-wedge', '斐波那契楔形', 'fib-gann', '扇形', 'wedge', '⊲', '圆弧与射线组成的楔形'),
      tool('pitchfork', '安德鲁音叉', 'fib-gann', '音叉', 'pitchfork', 'Ψ', '中轨和两条平行边界'),
      tool('schiff-pitchfork', '希夫音叉', 'fib-gann', '音叉', 'pitchfork', 'Ψ', '修正起点的音叉'),
      tool('modified-schiff', '修正希夫音叉', 'fib-gann', '音叉', 'pitchfork', 'Ψ', '使用更平滑中轨的音叉'),
      tool('inside-pitchfork', '内部音叉', 'fib-gann', '音叉', 'pitchfork', 'Ψ', '内缩边界的音叉'),
      tool('pitchfan', '扇形音叉', 'fib-gann', '扇形', 'fan', '≣', '从共同起点展开多条中轨'),
      tool('gann-box', '甘氏箱', 'fib-gann', 'Gann', 'gann-box', 'G', '价格与时间比例网格；按住 Shift 固定刻度', 'Shift=固定'),
      tool('gann-square-fixed', '甘氏正方形固定', 'fib-gann', 'Gann', 'gann-box', 'G²', '固定比例的甘氏正方形'),
      tool('gann-square', '甘氏正方形', 'fib-gann', 'Gann', 'gann-box', 'G²', '可调整价格时间比例的方形'),
      tool('gann-fan', '甘氏扇', 'fib-gann', 'Gann', 'fan', 'GF', '不同价格/时间角度的扇线'),
    ],
  },
  {
    id: 'patterns', label: '形态', description: '标记谐波、艾略特波浪与周期', defaultTool: 'xabcd',
    tools: [
      tool('xabcd', 'XABCD 形态', 'patterns', '谐波形态', 'pattern', 'X', '五点谐波形态'),
      tool('cypher', 'Cypher 形态', 'patterns', '谐波形态', 'pattern', 'C', 'Cypher 五点形态'),
      tool('abcd', 'ABCD 形态', 'patterns', '谐波形态', 'pattern', 'A', '四点对称形态'),
      tool('triangle-pattern', '三角形形态', 'patterns', '图表形态', 'pattern', '△', '收敛三角形'),
      tool('three-drives', '三驱动形态', 'patterns', '谐波形态', 'pattern', '3', '三个连续驱动腿'),
      tool('head-shoulders', '头肩形态', 'patterns', '图表形态', 'pattern', 'H', '左肩、头部和右肩'),
      tool('elliott-impulse', '艾略特推动波 (12345)', 'patterns', '艾略特波浪', 'wave', '5', '五波推动序列'),
      tool('elliott-triangle', '艾略特三角波 (ABCDE)', 'patterns', '艾略特波浪', 'wave', 'E', '五段三角整理'),
      tool('elliott-triple', '艾略特三重组合波', 'patterns', '艾略特波浪', 'wave', 'W', 'WXYXZ 组合波'),
      tool('elliott-correction', '艾略特修正波 (ABC)', 'patterns', '艾略特波浪', 'wave', 'C', '三波修正序列'),
      tool('elliott-double', '艾略特双重组合波', 'patterns', '艾略特波浪', 'wave', 'W', 'WXY 组合波'),
      tool('cyclic-lines', '周期线', 'patterns', '周期', 'cycles', 'Ⅲ', '按固定间隔重复的垂直线'),
      tool('time-cycles', '时间周期', 'patterns', '周期', 'cycles', '◯', '重复的周期圆弧'),
      tool('sine-line', '正弦线', 'patterns', '周期', 'sine', '∿', '可调整周期和振幅的正弦波'),
    ],
  },
  {
    id: 'forecast', label: '预测和测量', description: '仓位风险、价格时间区间和成交量分析', defaultTool: 'long-position',
    tools: [
      tool('long-position', '多头仓位', 'forecast', '仓位', 'long-position', '↑', '可视化入场、止损和盈利目标'),
      tool('short-position', '空头仓位', 'forecast', '仓位', 'short-position', '↓', '可视化做空的入场、止损和目标'),
      tool('position-forecast', '仓位预测', 'forecast', '预测', 'forecast', '↱', '预测路径与结果区间'),
      tool('date-range', '日期范围', 'forecast', '范围', 'range', '↔', '测量时间、K 线数量和天数'),
      tool('price-range', '价格范围', 'forecast', '范围', 'range', '↕', '测量价格变化和百分比'),
      tool('date-price-range', '日期和价格范围', 'forecast', '范围', 'measure', '⤢', '同时测量时间与价格'),
      tool('bars-pattern', 'K 线形态', 'forecast', '投射', 'bars-pattern', '≡', '复制一段 K 线路径用于对比'),
      tool('ghost-feed', '幽灵行情', 'forecast', '投射', 'ghost-feed', '∿', '绘制可调整的假想价格路径'),
      tool('sector', '扇形区域', 'forecast', '投射', 'sector', '◔', '以起点为中心的角度范围'),
      tool('fixed-volume-profile', '固定范围成交量分布', 'forecast', '成交量', 'volume-profile', '▇', '选定范围的水平成交量分布'),
      tool('anchored-volume-profile', '锚定成交量分布', 'forecast', '成交量', 'volume-profile', '▆', '从锚点到当前的成交量分布'),
    ],
  },
  {
    id: 'shapes', label: '几何图形', description: '自由绘制、经典图形、曲线和箭头', defaultTool: 'brush',
    tools: [
      tool('brush', '画笔', 'shapes', '自由绘制', 'brush', '〜', '自由手绘路径'),
      tool('highlighter', '荧光笔', 'shapes', '自由绘制', 'highlighter', '〰', '宽线条半透明高亮'),
      tool('rectangle', '矩形', 'shapes', '图形', 'rectangle', '▭', '轴对齐矩形', 'Alt+Shift+R'),
      tool('rotated-rectangle', '旋转矩形', 'shapes', '图形', 'rotated-rectangle', '◇', '可沿趋势方向旋转的矩形'),
      tool('path', '路径', 'shapes', '自由绘制', 'polyline', '⌗', '通过多个点连接自由路径'),
      tool('circle', '圆', 'shapes', '图形', 'ellipse', '○', '以中心和半径定义的圆'),
      tool('ellipse', '椭圆', 'shapes', '图形', 'ellipse', '⬭', '横纵半径可调的椭圆；按住 Shift 绘制正圆', 'Shift=正圆'),
      tool('polyline', '折线', 'shapes', '图形', 'polyline', '⋀', '多段直线连接'),
      tool('triangle', '三角形', 'shapes', '图形', 'triangle', '△', '三点定义的三角形'),
      tool('arc', '圆弧', 'shapes', '曲线', 'arc', '⌢', '两点定义的圆弧'),
      tool('curve', '曲线', 'shapes', '曲线', 'curve', '∿', '平滑贝塞尔曲线'),
      tool('double-curve', '双曲线', 'shapes', '曲线', 'double-curve', '≈', '两条平行平滑曲线'),
      tool('shape-arrow', '箭头', 'shapes', '箭头', 'arrow', '➤', '从起点指向终点的箭头'),
      tool('arrow-marker', '箭头标记', 'shapes', '箭头', 'arrow-mark', '➤', '单点箭头标记'),
      tool('arrow-up', '向上箭头', 'shapes', '箭头', 'arrow-mark', '⬆', '向上方向标记'),
      tool('arrow-down', '向下箭头', 'shapes', '箭头', 'arrow-mark', '⬇', '向下方向标记'),
    ],
  },
  {
    id: 'annotations', label: '注释工具', description: '文本、注释、价格标签、表格和旗标', defaultTool: 'text',
    tools: [
      tool('text', '文本', 'annotations', '文本', 'text', 'T', '在图表任意位置添加文本'),
      tool('note', '备注', 'annotations', '文本', 'note', '▣', '紧凑的多行备注'),
      tool('anchored-note', '锚定备注', 'annotations', '文本', 'note', '⚓', '相对于画布固定的备注'),
      tool('signpost', '路标', 'annotations', '标签', 'signpost', '⚑', '带时间或价格的路标'),
      tool('callout', '标注泡泡', 'annotations', '文本', 'callout', '◰', '带指向尾翼的文本气泡'),
      tool('comment', '评论', 'annotations', '文本', 'comment', '◇', '带边框的评论卡片'),
      tool('price-label', '价格标签', 'annotations', '标签', 'price-label', '◀', '贴合价格水平的标签'),
      tool('price-note', '价格备注', 'annotations', '标签', 'price-label', '◁', '价格标签与备注组合'),
      tool('pin', '图钉', 'annotations', '标签', 'signpost', '⌖', '使用图钉标记位置'),
      tool('table', '表格', 'annotations', '内容', 'table', '▦', '在图表上添加小型数据表'),
      tool('flag-mark', '旗标', 'annotations', '标签', 'flag', '⚑', '带文本的旗帜标记'),
      tool('image-placeholder', '图像', 'annotations', '内容', 'media', '▧', '图像位置占位（本地演示）'),
      tool('x-post', 'X 帖子', 'annotations', '内容', 'media', '𝕏', '社交帖子卡片占位'),
      tool('idea-card', '观点卡片', 'annotations', '内容', 'media', '★', '分析观点卡片占位'),
    ],
  },
  {
    id: 'icons', label: '图标', description: '图标、表情符号与贴纸', defaultTool: 'icon-star',
    tools: [
      tool('icon-star', '星标', 'icons', '图标', 'icon', '★', '重点标记'),
      tool('icon-heart', '爱心', 'icons', '图标', 'icon', '♥', '爱心标记'),
      tool('icon-lightning', '闪电', 'icons', '图标', 'icon', '⚡', '闪电标记'),
      tool('icon-check', '确认', 'icons', '图标', 'icon', '✓', '确认标记'),
      tool('icon-cross', '交叉', 'icons', '图标', 'icon', '✕', '否定标记'),
      tool('icon-warning', '警告', 'icons', '图标', 'icon', '⚠', '风险或警告标记'),
      tool('icon-bull', '看涨', 'icons', '交易', 'icon', '🐂', '看涨观点'),
      tool('icon-bear', '看跌', 'icons', '交易', 'icon', '🐻', '看跌观点'),
      tool('icon-rocket', '火箭', 'icons', '交易', 'icon', '🚀', '加速或突破'),
      tool('icon-fire', '火焰', 'icons', '交易', 'icon', '🔥', '热点或强势'),
      tool('icon-target', '靶心', 'icons', '交易', 'icon', '🎯', '目标位'),
      tool('icon-money', '资金', 'icons', '交易', 'icon', '💰', '资金或收益'),
      tool('icon-smile', '微笑', 'icons', '表情', 'icon', '😊', '积极情绪'),
      tool('icon-thinking', '思考', 'icons', '表情', 'icon', '🤔', '等待确认'),
      tool('icon-eyes', '关注', 'icons', '表情', 'icon', '👀', '重点关注'),
      tool('icon-pin', '定位', 'icons', '图标', 'icon', '📍', '位置标记'),
      tool('icon-clock', '时间', 'icons', '图标', 'icon', '⏱', '时间节点'),
      tool('icon-flag', '旗帜', 'icons', '图标', 'icon', '🏁', '阶段结束'),
    ],
  },
]

export const ACTION_TOOLS: ToolDefinition[] = [
  { id: 'measure', label: '测量', group: 'actions', section: '动作', behavior: 'measure', glyph: '⌖', description: '快速测量价格、百分比、K 线数和时间', shortcut: 'Shift+拖拽' },
  { id: 'zoom', label: '局部放大', group: 'actions', section: '动作', behavior: 'zoom', glyph: '+', description: '框选时间范围并放大' },
]

export const ALL_DRAWING_TOOLS = [...TOOL_GROUPS.flatMap((group) => group.tools), ...ACTION_TOOLS]

const TOOL_MAP = new Map(ALL_DRAWING_TOOLS.map((item) => [item.id, item]))

export function getTool(id: string): ToolDefinition {
  return TOOL_MAP.get(id) ?? TOOL_MAP.get('trend')!
}

/** Whether completing the current drawing should return to the cursor. */
export function shouldExitDrawingMode(toolId: string, keepDrawing: boolean): boolean {
  return !keepDrawing || toolId === 'rectangle'
}

export function getToolGroupForTool(id: string): ToolGroup | undefined {
  return TOOL_GROUPS.find((group) => group.tools.some((item) => item.id === id))
}
