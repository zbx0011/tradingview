# TVFloat 新电脑 Codex 接管上下文

## 1. 项目目标

TVFloat 是一套运行在 Windows 上的 TradingView 机会识别与训练系统。它：

- 从 TradingView Desktop 读取已收盘 K 线；
- 本地保存 K 线、市场状态、震荡区间、候选、正式信号和警报记录；
- 用高召回本地程序筛选候选，只在需要时调用 Codex AI 复核；
- 将 A/B 级机会保存到数据库、标注到 TradingView、创建价格警报；
- 通过悬浮行情窗口持续闪烁未确认信号；
- 将正式信号同步到 Excel，便于事后复盘；
- 不创建订单，不自动交易。

## 2. 迁移与路径发现

不要写死旧电脑或新电脑的用户名。

新电脑安装完成后，实际路径记录在：

`%LOCALAPPDATA%\TVFloat\migration_install_receipt.json`

主要字段：

- `target_root`：新电脑项目根目录；
- `tradingview_mcp_root`：TradingView MCP 根目录；
- `scheduled_task`：计划任务名称；
- `monitor_enabled`：监控是否启用。

默认运行状态目录：

`%LOCALAPPDATA%\TVFloat`

统一数据库：

`%LOCALAPPDATA%\TVFloat\market.db`

计划任务：

`TVFloat-LowToken-Collector`

TradingView MCP 默认目录：

`%USERPROFILE%\tools\tradingview-mcp`

Codex skill 默认目录：

`%USERPROFILE%\.codex\skills\tradingview-mcp`

迁移包不包含 Codex 登录凭据、TradingView 登录凭据、Cookie 或账号密码；新电脑必须自行登录。

## 3. 当前正式运行参数

- 周期：5 分钟；
- 计划任务：每 5 分钟触发一次；
- 时间：周一至周五 24 小时；
- 只使用已收盘 5 分钟 K 线；
- 监控品种及数据商：
  - `BYBIT:BTCUSDT.P`
  - `OANDA:XAGUSD`
  - `OANDA:XAUUSD`
  - `ICMARKETS:US500`
- 所有 TradingView 自动化只允许在视觉上最右侧的专用标签内进行；
- 每轮结束恢复 `BYBIT:BTCUSDT.P`、5 分钟；
- 不得用 `SPX500`、Capital.com 或其他近似符号替代 `ICMARKETS:US500`。

## 4. 当前流水线

每轮运行大致顺序：

1. `collect_tv.mjs`
   - 直接调用 TradingView MCP；
   - 切换最右侧标签中的四个完整品种；
   - 只读取满足收盘条件的 K 线；
   - 增量写入 SQLite；
   - 同步图上的橙色震荡区间。
2. `candidate_filter_v2.py`
   - 高召回候选层；
   - 候选不是正式信号；
   - 同时产生多种市场状态假设，由 AI 独立否决或确认。
3. `range_edge_watch.py` 与 `reconcile_range_edge_alerts.mjs`
   - 不调用模型；
   - 管理震荡区间上下八分之一触碰提醒和 TradingView 警报。
4. `review_candidates.ps1`
   - 为每个候选生成截至该 K 线的复合图；
   - 上半部分为约 36 小时外层视图，下半部分为约 9 小时内层视图；
   - 无未来 K 线；
   - 普通候选使用 `gpt-5.6-terra`、中等推理；
   - 关键状态转换或高等级候选使用 `gpt-5.6-sol`、高推理；
   - 开启 fast mode（约 1.5 倍快速模式）；
   - 候选可并行复核，但按完成顺序逐个执行结果，不等待全部候选结束才出第一个信号；
   - 必须在下一根 5 分钟 K 开始前完成，过期候选记为超时，不补发旧信号。
5. `execute_signal.mjs`
   - 对 AI 结构化结果执行本地硬门槛；
   - 保存正式信号；
   - 删除/替换本系统同品种同周期的旧未触发警报；
   - 绘制 Callout；
   - 创建确认/失效警报；
   - 触发 Excel 更新。

没有候选时不调用候选复核 AI。空闲轮次最多每小时更新一次四品种视觉状态基线。

## 5. 唯一允许的正式机会类型

1. `震荡内部：边缘反向`
2. `震荡突破：位移突破`
3. `宽通道边缘：反向波段`
4. `宽通道突破：更大级别反转`
5. `宽通道顺势：在有利边缘跟随主方向`
6. `窄通道：等待回踩顺势参与`

不得临时创造第七种类型。

## 6. 全局判断原则

- 先判断外层市场阶段，再判断内层结构；
- 信号只能使用信号 K 收盘及之前的数据；
- 相邻 K 线相近影线只算同一次测试；
- 震荡中部不发正式信号；
- 高潮后的第一次反转只观察；必须已有失败延续、重新收回、反向跟随或第二次反转才可正式；
- EMA 触碰只能作为辅助，不能单独定义震荡、宽通道、窄通道或支撑压力；
- 滚动高低点不能单独定义市场边界；
- 同品种短时间内反向信号必须证明前信号已经失效且市场发生真实状态转换；
- 不得使用后续走势证明当时信号正确；
- 不得自行增加 Louie 文档中没有、用户也没有确认的数字阈值；
- 用户已经明确取消“突破 K 收盘必须位于整根 K 底部/顶部 32%”这一规则，任何地方不得恢复该规则。

详细且最终的信号规则以项目中的以下文件为准：

- `realtime_signals\review_decision_prompt.txt`
- `realtime_signals\candidate_filter_v2.py`
- `realtime_signals\review_decision_schema.json`

## 7. 震荡区间规则

### 7.1 图层与优先级

- TradingView 图上的橙色矩形统一解释为震荡区间；
- 用户自己新增的橙框，或用户移动/缩放过的自动橙框，属于 `manual` 区间；
- `manual` 区间绝对优先，后续分析必须使用用户修改后的精确时间和价格；
- 程序不得自行拆分、缩小、替换或重新创建已被用户删除的相同区间；
- 没有适用的同步橙框时，不允许产生“震荡内部”或“震荡突破”正式信号。

### 7.2 区间定义

- 一个震荡区间是完整的横向平衡阶段：
  - 从价格进入该价格区域开始；
  - 包含内部多次交替轮动；
  - 到价格明确离开并进入另一个价格区域结束；
- 不能把内部的小摆动拆成很多局部小框；
- 左边在进入平衡之前的单边上涨/下跌不能纳入；
- 右边离开平衡后的上涨/下跌不能纳入；
- 若当前价格仍未离开区间，橙框必须继续向右延伸，并随新 K 线更新，直到确认离开；
- 前一个小震荡区间的边界可以成为后续更大震荡区间的重要边界。

### 7.3 上下边界

- 上下边界优先选择被分离的结构影线反复触碰、且 K 线实体和收盘多数保留在区间内的水平；
- 不一定使用绝对最高/最低影线；
- 单根流动性扫取影线不应把整个框无限撑大；
- 初次进入区间的过渡 K 可以跨越候选边界；
- 进入平衡后、真正离开前，边界不应持续切穿 K 线实体或让大量收盘落在框外；
- 上沿和下沿都至少需要两组时间上独立的测试；
- 同侧测试需分离，邻近影线簇只算一次；
- 需要交替访问上下边缘；
- 只有一个 V 形反弹、短暂停顿、两根相邻影线或滚动窗口高低点时，禁止画成震荡区间。

### 7.4 区间交易

- 区间内部只在边缘考虑反向；
- 做多信号收盘仍需位于区间下方三分之一；
- 做空信号收盘仍需位于区间上方三分之一；
- 有效边缘的流动性扫取、假突破后收回、双顶/双底、楔形等可以提高等级；
- 不必等待大阳线或大阴线；边缘扫取后收回的针形 K 或十字星，在位置和结构清晰时可以成为高等级早期机会；
- 若价格已经远离有利边缘，即使后面出现大实体反转 K，也不应追成区间边缘信号。

### 7.5 区间上下八分之一提醒

- 当上一根已收盘 K 触及震荡区间上方或下方八分之一价格带时：
  - 对应品种在悬浮窗闪烁；
  - TradingView 创建触碰警报；
- 每根 K 线可以重新提醒一次；
- 区间被确认突破后取消该区间的提醒；
- 用户手动移动或缩放橙框后，警报价格必须跟随新边界更新。

详细且最终的区间识别规则以：

- `realtime_signals\visual_baseline_prompt.txt`
- `realtime_signals\visual_baseline_schema.json`
- `realtime_signals\apply_range_baseline.mjs`

为准。

## 8. 宽通道与窄通道

### 8.1 宽通道

- 必须有视觉上明显、交替出现的上下摆动；
- 两条边界需大致平行并同向；
- 单边下跌、单边上涨、一个 V 形反转或选择性连接局部高低点都不是宽通道；
- 本地 `wide_channel_validation.valid=true` 是必要条件，不是充分条件；
- AI 还必须从复合图和 OHLC 独立确认；
- 宽通道顺势信号自动降一级。

### 8.2 窄通道

- 不得把“宽通道验证失败”自动降级成窄通道；
- 必须有持续的单向推进、浅回调、有限重叠，并主要保持在 EMA20 趋势一侧；
- 单次位移后横盘、深反弹、反复穿越 EMA 或明显双向重叠不是窄通道；
- 顺势参与必须是真正回踩到当时已知的重要位置：
  - EMA20；
  - 分离的前支撑/压力；
  - 已标记震荡突破边界；
- 优先第一次或第二次浅/中等回踩；
- 已经运行很远、已经多次回调、第三次及以后的成熟通道，容易转为宽通道或反转，不应继续当早期窄通道信号。

## 9. TradingView 操作约束

- 所有自动化操作开始前必须切到视觉最右侧标签；
- 只操作该最右侧专用标签；
- 不得切换、关闭或改动其他标签；
- 不得改变用户其他标签的品种、周期、缩放、侧栏、布局或绘图；
- 自动化结束时，将同一个最右侧标签恢复到 `BYBIT:BTCUSDT.P`、5 分钟；
- 切换品种时必须使用完整符号并验证数据商和周期；
- `US500` 必须是 `ICMARKETS:US500`；
- TradingView Desktop 必须通过 CDP 9222 启动；
- 后台辅助程序不得在前台闪现黑色终端窗口。

## 10. 信号、标注与警报

### 10.1 数据库

- 所有正式信号及完整原因必须保存到 SQLite；
- `acknowledged_at` 由用户点击悬浮窗后写入，自动任务不得自行确认；
- 数据库唯一键和候选记忆负责去重；
- 迁移后不得因为换电脑重发历史信号。

### 10.2 图表标注

- 多头只用绿色 `#22c55e`；
- 空头只用红色 `#ef4444`；
- 不画信号水平线；
- 使用一个 Callout；
- Callout 锚点必须是信号 K 的时间和收盘价，不是开盘、高点或低点；
- 标注采用紧凑五行格式；
- 完整长理由留在数据库和 Excel，不把整段文字铺在 K 线上；
- 绘图名称格式示例：
  `TVF #52｜XAGUSD｜5m｜空头B｜07-31 10:30`

### 10.3 TradingView 警报

- 正式信号通常创建确认与失效两条一次性价格警报；
- 新信号形成时，只允许清理数据库明确返回的、同品种同周期的 TVFloat 旧警报；
- 不得删除用户手工创建或无法确认属于本系统的警报；
- TradingView 推送文本保持两行、短且可读，不包含内部字段名、Unix 时间戳或长理由。

## 11. 悬浮窗与 Excel

- 悬浮窗读取统一数据库；
- 未确认多头信号绿色闪烁，空头信号红色闪烁；
- 点击对应品种后才停止闪烁，并跳转 TradingView；
- 标题下显示最近处理时间和处理结果；
- Excel 默认位于：
  `<target_root>\outputs\tvfloat_signal_excel\TVFloat_信号记录.xlsx`
- Excel 保存完整信号、市场状态、原因、确认/失效价、警报与 AI 复核结果；
- 用户可填写事后结果、结果说明和复盘备注，自动刷新应保留人工内容。

## 12. 运行可靠性与成本

- 数据采集、本地筛选和区间边缘提醒不调用模型；
- 无候选时不调用候选复核模型；
- 普通候选 Terra 中等，关键候选 Sol 高；
- 模型只做最终主观复核，本地执行器负责数据库、TradingView 标注和警报；
- 每次模型调用必须有错误日志、超时和失败状态回写；
- 超时信号不允许在后续 K 线期间补发；
- 视觉基线通常最多每小时一次；出现区间边缘、突破、回踩或状态转换候选时可提前更新；
- 候选复合图来自本地数据库，不需要每轮上传全部原始历史。

## 13. 新电脑接管的安全边界

- 先读项目文件、运行只读诊断和迁移测试，再考虑修改；
- 不得重建数据库或清除历史状态；
- 不得删除现有 TradingView 绘图或警报，除非用户明确要求且目标已精确核对；
- 不得同时启用新旧两台电脑的采集任务；
- 若 TradingView、CDP、Codex 登录、数据库或计划任务失败，应报告具体步骤和原始错误；
- 迁移测试全部 PASS 才能宣称接管完成。

## 14. 关键文件索引

- 主运行入口：`realtime_signals\run_lightweight.ps1`
- 计划任务：`realtime_signals\TVFloat-LowToken-Collector.xml`
- TradingView 采集：`realtime_signals\collect_tv.mjs`
- 本地候选：`realtime_signals\candidate_filter_v2.py`
- AI 调度：`realtime_signals\review_candidates.ps1`
- AI 决策提示：`realtime_signals\review_decision_prompt.txt`
- AI 输出结构：`realtime_signals\review_decision_schema.json`
- 信号执行：`realtime_signals\execute_signal.mjs`
- 视觉状态更新：`realtime_signals\update_visual_baseline.ps1`
- 视觉区间提示：`realtime_signals\visual_baseline_prompt.txt`
- 视觉区间结构：`realtime_signals\visual_baseline_schema.json`
- 区间应用：`realtime_signals\apply_range_baseline.mjs`
- 边缘提醒：`realtime_signals\range_edge_watch.py`
- 边缘警报同步：`realtime_signals\reconcile_range_edge_alerts.mjs`
- SQLite 工具：`realtime_signals\kline_store.py`
- Excel 导出：`realtime_signals\export_signals_excel.ps1`
- 迁移安装：`migration\Install-TVFloatMigration.ps1`
- 迁移验证：`migration\Test-TVFloatMigration.ps1`

本文件是接管摘要。实际运行时，项目里的代码、提示词、schema、数据库和迁移回执是最终事实来源；发现不一致时必须先报告，不得静默猜测。
