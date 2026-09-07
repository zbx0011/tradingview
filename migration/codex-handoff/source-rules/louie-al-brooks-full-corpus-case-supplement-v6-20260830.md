# Louie V6：Al Brooks 全案例解释补充层（2026-08-30）

规则集 ID：`louie_al_brooks_full_corpus_ema20_structural_trailing_v6_nextbar_opposite_20260830`。

本层把已冻结的 Al Brooks 全课程、图表百科全书和书籍案例纳入逐根解释。它位于 0818 V5 确定性执行层之下，只补充如何理解当前已释放图形；不得修改执行动作。

## 最高优先级不变量

V6 的执行结果必须继续由 0818 V5 的状态机机械产生：

1. 原始信号规则保持原样；案例只能支持或否定当前信号解释，不能创造课程外新 setup、评分或固定阈值。
2. 信号 K 收盘后只观察紧邻下一根 K；多头以 `next.high > signal.high`、空头以 `next.low < signal.low` 触发。不是下一根收盘价确认，等于不算突破。
3. 初始止损在信号时固定；固定计划风险、单仓位、同向信号忽略均不变。
4. 反向信号只登记待确认退出；仅紧邻下一根严格突破反向信号 K 的风险侧高/低点才平仓，未突破即失效。
5. 移动止损继续使用“强突破—新极值—右侧确认风险侧结构—随后严格突破此前已确认前高/前低—下一根生效”的 0818 结构门槛，只能向有利方向移动。
6. 无固定止盈、无动态课程目标；最后一根、止损优先级和毛收益口径保持 0818 V5 不变。

每根决策必须写入 `v5_0818_execution_unchanged=true`。若案例内容与上述执行冲突，以 0818 V5 为准并把案例标记为 `context_only`。

## 全案例检查顺序

每根闭合 K 按下列顺序检查，不允许只看到形态名称就跳过背景：

1. **语言与单根质量**：术语、图表基础、K 线与信号 K；比较实体、影线、收盘位置、重叠和相邻 K 的强弱。
2. **压力与状态**：买卖压力、缺口、市场周期、Always In、趋势强弱；区分趋势延续、通道、高潮后过渡和震荡。
3. **推进与回调**：回调计数、二次推进、突破后的接受/跟随、失败突破、回测与迟到进场；强突破后计数可重置，但不得回填旧决定。
4. **几何结构**：趋势、宽/窄通道、微通道、交易区间、支撑压力、磁铁与测量移动背景；几何只是解释，Measured Move 不生成目标。
5. **反转家族**：普通反转、Major Trend Reversal、末端旗形、楔形、双顶/双底、三角形、头肩、圆弧顶底、高潮反转；必须验证旧方向失效、新方向接受和跟随，不能见形态名即发反向信号。
6. **执行语境**：交易者方程与概率、Swing/Scalp、订单、保护止损、Actual Risk、加仓和利润管理、趋势后段进场；这些章节只用于解释质量、风险和失败边界，不授权限价加仓、分批、保本、任意止损或课程目标。
7. **How to Trade 案例**：MTR 顶/底、趋势后段、突破、高潮反转、紧/宽多空通道及交易区间的操作案例；必须重新映射到当前 V6 唯一执行状态机，不能复制案例中的不同下单方式。
8. **图表百科与书籍案例**：8800 图表案例、逐 K 线、趋势、区间和反转书籍用于寻找同类背景及失败边界；重复、翻译或版本别名只算同一内容来源，不能通过“多份文件一致”提高权重。

## `brooks_case_lenses`

每根 `case_context` 必须提交一个非空、去重列表，只能使用：

- `terminology_chart_basics`
- `candle_signal_bar_quality`
- `pullback_bar_count`
- `buying_selling_pressure`
- `gap_context`
- `market_cycle_always_in`
- `trend`
- `breakout`
- `channel_microchannel`
- `trading_range`
- `support_resistance`
- `measured_move_context`
- `reversal_mtr`
- `final_flag`
- `wedge`
- `double_top_bottom`
- `triangle`
- `head_shoulders`
- `rounded_top_bottom`
- `climax`
- `trader_equation_probability_context`
- `swing_scalp_context`
- `order_stop_actual_risk_context`
- `scaling_profit_management_context`
- `late_trend_entry`
- `no_matching_brooks_case`

`no_matching_brooks_case` 必须单独出现。它表示已经检查而当前没有可靠案例匹配，不能用来掩盖明显命中的结构。

## `brooks_source_families`

每根还必须提交非空、去重的来源家族：

- `course_01_18_price_action_foundations`
- `course_19_29_patterns_reversals`
- `course_30_36_execution_management_context`
- `course_37_42_how_to_trade`
- `course_43_47_channels_ranges`
- `chart_encyclopedia_8800_cases`
- `books_bar_by_bar_trends_ranges_reversals`
- `no_specific_brooks_source`

若 `brooks_case_lenses=["no_matching_brooks_case"]`，来源家族必须且只能是 `no_specific_brooks_source`；反之不得使用该值。来源家族是宽粒度审计引用，不允许伪造具体页码、视频时间戳或案例编号。

## 允许影响与禁止影响

允许影响：`market_state`、`background`、`location`、`acceptance_follow_through`、`trigger`、`success_failure_boundary`，以及在证据不足时选择 `OBSERVE`/`NO_SIGNAL`。

禁止影响：下一根突破进场定义、初始止损价、仓位数量、同向/反向持仓处理、固定风险、结构移动止损状态机、固定/动态止盈、时段过滤、任意 ATR/百分比/分数/冷却阈值。课程中的限价单、任意时刻进场、加仓、打平、分批、主观提前离场、MM、1R/2R、Actual Risk 目标、期权、特定品种或时段统计全部为 `context_only`。

V6 没有新增开盘后十根或收盘前十根禁入过滤；那是另一个独立规则身份，不能混入以 0818 V5 为父版本的 V6。
