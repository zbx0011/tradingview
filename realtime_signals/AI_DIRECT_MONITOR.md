# louie规则监控（20260806版本）

# TVFloat｜XAU 复盘同源的 AI 直接判断 5 分钟监控

本文是当前唯一生产规范。实时监控必须复现本次 XAUUSD 三天 5 分钟逐根复盘的规则来源与因果流程：

- 规则只来自两份 Louie 原文和本文记录的本次 XAU 复盘要求；
- AI 直接判断每一根新收盘 K 线，程序不得筛候选、判状态或决定信号；
- 程序只负责采集、冻结数据截止点、存档、去重、绘图、TradingView 警报和悬浮窗同步；
- 正式信号必须再做一次独立的时间戳审计；任何需要后续 K 线才能成立的证据只能等待，不能回填到更早的 K 线；
- 严格防作弊和实时过期必须同时成立：信号 K 只在下一根 5 分钟 K 线收盘前具有实时执行资格；过期结论可供审计，但不得再触发任何提醒；
- 不使用 A/B 等级。

## 1. 唯一规则来源

每次 AI 判断前，必须完整读取以下两个文件，不能只记录文件名或摘要：

1. `migration/codex-handoff/source-rules/Louie交易规则完整整理_案例扩展版.md`
2. `migration/codex-handoff/source-rules/louie-case-expanded.md`

再应用本次 XAU 逐根复盘要求：

1. 严格按“背景 → 位置 → 结构 → 接受/跟随 → EMA 辅助 → 信号 K”判断。
2. 截止目标 K 收盘，只能引用目标 K 及更早的数据。
3. 若需要再等一至两根 K 线确认，当前只能 `OBSERVE`；确认实际出现后，信号属于确认 K，不能回填到最初触发 K。
4. 例如：第一根突破只能说明首次突破；第一根同向跟随只能说明首次跟随；只有第二根跟随收盘后才能说“连续跟随”。
5. 震荡区间由 AI 根据截止当时的完整历史因果重建。有效人工橙框是高优先级证据和用户修正，但没有橙框不等于 AI 禁止识别真实震荡。
6. 二次审计必须逐项列出所有引用 K 的时间，并证明没有任何时间晚于 `data_cutoff`。
7. 正式机会只分 `SIGNAL`，次级或尚待确认的情形为 `OBSERVE`，无机会为 `NO_SIGNAL`；禁止 A/B。

如果两个原文、本文要求或旧生产文件冲突，优先级为：本次明确要求 > 两份 Louie 原文 > 其他历史实现。禁止引用 `range_signal_semantics.py`、旧候选过滤器、旧回放结果、旧 A/B 规则或“最新规则”补充判断。任何影响信号的规则若不能追溯到上述来源，不得自行增加。

特别禁止：固定 ATR 门槛、固定实体比例、收盘位于 K 线顶部/底部百分比、32%/35%/36.18%、固定“三分之一”入场门槛，以及其他未获用户明确批准的数字过滤器。ATR、EMA20、EMA50、成交量只能作为上下文证据。

## 2. 固定监控范围

只监控：

1. `BYBIT:BTCUSDT.P` 5 分钟
2. `OANDA:XAGUSD` 5 分钟
3. `OANDA:XAUUSD` 5 分钟

北京时间周一至周五全天执行；周六、周日立即返回 `DONT_NOTIFY`，不读 TradingView 和数据库。

## 3. 单次唤醒流程

### 3.1 单例锁

先生成本轮唯一 GUID，并执行：

```powershell
python realtime_signals/ai_direct_guard.py cycle-begin --owner OWNER --lease-seconds 1800
```

若 `acquired=false`，安静返回 `DONT_NOTIFY`。成功后所有路径必须进入 `finally`：先恢复最右侧 TradingView 标签页为 `BYBIT:BTCUSDT.P` 5m，再执行：

```powershell
python realtime_signals/ai_direct_guard.py cycle-end --owner OWNER
```

### 3.2 采集

```powershell
node realtime_signals/collect_tv.mjs
```

只允许已收盘 K：`open_time + 300 <= 当前 UTC - 5 秒`。采集失败立即报告，不继续判断。

### 3.3 逐品种、逐根处理

顺序固定为 BTC、白银、黄金。每个品种先执行：

```powershell
python realtime_signals/ai_direct_guard.py next --vendor VENDOR --symbol SYMBOL --timeframe 5 --limit 3
```

必须核对 `live_only=true`。`next` 只返回仍有实时执行窗口的新收盘 K；`expired_unreviewed_count` 只是历史漏审统计，生产监控不得补审这些旧 K，也不得让旧 K 阻塞最新 K。对 `pending_bars` 按时间升序逐根处理。每根判断完成后立即存档；若有正式且未过期的信号，立即进入唯一执行队列，然后才处理下一根。

为每根目标 K 生成完整因果快照：

```powershell
python realtime_signals/ai_direct_guard.py snapshot --vendor VENDOR --symbol SYMBOL --timeframe 5 --bar-time BAR_TIME --history-bars 864 --tail 864
```

必须核对：

- `no_future_bars=true`
- `data_cutoff=bar_time`
- `max_included_bar_time=bar_time`
- `target_bar[0]=bar_time`

AI 只能使用这份快照和已经完整读取的两份原文。判断期间禁止读取当前 TradingView 图、实时行情、数据库原始 K 线或任何 `bar_time` 之后的数据。图形化辅助如需使用，也必须由该快照离线渲染，且右端严格截止目标 K。

## 4. AI 直接判断

每根 K 都必须直接输出，不允许程序预筛：

所有由 AI 生成的文本字段（`reasons`、`location_summary`、`structure_summary`、
`outer_state`、`inner_state`、`audit_summary` 等）一律使用简体中文；禁止输出
英文句子（品种代码、数字、价格除外）。

```json
{
  "verdict": "NO_SIGNAL | OBSERVE | SIGNAL",
  "direction": "none | long | short",
  "setup_type": "none 或六类机会之一",
  "grade": "none",
  "outer_state": "外层状态",
  "inner_state": "内层状态和位置",
  "reasons": ["截至目标K收盘已成立的具体证据"],
  "location_summary": "位置摘要",
  "structure_summary": "结构摘要",
  "confirmation_price": null,
  "invalidation_price": null,
  "context": {
    "levels_reason": "执行确认价与失效价的结构依据",
    "state_transition": "截至当前已经成立的状态转换",
    "range_or_channel_anchors": ["当时已知的边界和时间锚点"],
    "previous_signal_status": "相反方向旧信号是否已失效",
    "second_time_audit": null
  }
}
```

六类机会沿用用户指定分类：

1. `震荡内部：边缘反向`
2. `震荡突破：位移突破`
3. `宽通道边缘：反向波段`
4. `宽通道突破：更大级别反转`
5. `宽通道顺势：在有利边缘跟随主方向`
6. `窄通道：等待回踩顺势参与`

`OBSERVE/NO_SIGNAL` 必须使用 `direction/setup_type/grade=none`，两个价格为 `null`。

`SIGNAL` 必须使用 `grade=none`，方向为 long/short，并给出供程序设置警报的确认价和失效价；多头为 `确认价 >= 收盘 > 失效价`，空头为 `确认价 <= 收盘 < 失效价`。这两个价格只负责执行和风险语义，不得反过来决定是否有信号。

### 4.1 独立二次时间戳审计

第一遍得到 `SIGNAL` 后，必须把同一份快照重新作为一个独立审计问题检查，不得读取任何新数据。审计不评价后来涨跌，只检查“在该 K 收盘时是否已经知道”。

若理由包含当时尚未发生的跟随、确认、回踩结果或未来价格，改为 `OBSERVE`。通过时写入：

```json
"second_time_audit": {
  "passed": true,
  "data_cutoff": 目标K的open_time,
  "max_included_bar_time": 目标K的open_time,
  "signal_bar_time": 目标K的open_time,
  "earliest_decision_time": 目标K的open_time加300秒,
  "future_reference_count": 0,
  "referenced_bar_times": ["所有被引用K线的open_time，均不晚于data_cutoff"],
  "audit_summary": "为何此刻已经成立；若涉及跟随，明确这是第几根跟随"
}
```

没有通过该审计的结果禁止以 `SIGNAL` 落库或执行。

## 5. 核心主观规则

- 先外层、后内层；先市场阶段、后机会。不能因为出现漂亮 K 线反拼市场状态。
- 震荡中部不做边缘反向；相邻 K 的相近影线簇只算一次测试。
- 震荡应有明显横向平衡、时间分离的上下沿测试和交替访问；进入前趋势腿、离开后的趋势腿、V 形反转、短暂停顿和小旗形不能硬塞进震荡。
- 边界优先贴近多组分离影线反复触碰、同时多数实体/收盘留在内部的位置；人工修正边界优先。
- 尚未离开的震荡在逻辑上持续有效；真正离开后才讨论突破。突破必须引用预先存在的真实边界。
- 边缘扫流动性后收回的针形 K 或十字星可以形成早期机会，不必等待大阴/大阳；但不得靠未授权固定比例决定。
- 宽通道必须有重复、交替的上下摆动，两侧边界大致同向；单边趋势、V 形反转、一次回调或选择性连少数点不是宽通道。
- 窄通道必须持续单向推进、浅回调、有限重叠，多数位于 EMA20 一侧；只考虑早期第一或第二次真正回踩重要位置。走远、深回撤、反复穿均线或多次回调后不得继续标窄通道回踩。
- 高潮后的第一次反转只观察；要等失败延续、重新收回、反向跟随或第二次反转实际出现。
- 同品种短时相反信号必须证明旧信号失效且市场状态真实转换。
- 所有描述必须写成“截至这根 K 收盘已经知道”，禁止用后来走势证明、偷看或回填。

## 6. 存档与执行

把 `snapshot_sha256`、`model=deepseek-v4-flash`、`reasoning_effort=max` 和判断一同用 UTF-8 JSON 转 Base64：

```powershell
python realtime_signals/ai_direct_guard.py record --payload-base64 BASE64
```

Guard 会重建同一因果快照、核对哈希、禁止 A/B，并验证二次审计。信号 K 的 `bar_time` 是开盘时间，实时执行截止时间为 `bar_time + 600`（下一根 5 分钟 K 收盘）；为 TradingView 串行执行预留至少 90 秒。剩余时间不多于 90 秒时，AI 的 `SIGNAL` 结论仍以 `execution_status=expired` 留在审计表，但 `should_execute=false`。只有 `should_execute=true` 才立即执行：

```powershell
node realtime_signals/execute_signal.mjs --payload-base64 BASE64
```

执行器只负责：切换最右侧标签页至精确品种 5m、在信号 K 收盘价画绿色/红色 callout、建立确认和失效 TradingView 警报、写入数据库和触发悬浮窗。禁止改变 AI 的市场状态、类型或理由，禁止创建订单。

执行队列每次认领前必须先把已到截止时间或剩余执行时间不多于 90 秒的 `pending` 原子改为 `expired`。执行器收到的 deadline 取“本轮总截止时间”和“该信号 `bar_time+600`”中的较早者。`expired` 不写入正式 `signals`，不绘图、不建警报、不触发悬浮窗，也不作为错误通知。最后必须调用 `mark-execution` 回写 `succeeded/failed/duplicate`；失败要保留原始错误并立即通知。

所有新记录固定：

- `rules_version=louie-xau-replay-v1`
- `model_version=codex-deepseek-v4-flash-max-monitor`
- `grade=none`（数据库兼容层可以显示“信号”，但不能恢复 A/B 语义）

## 7. 通知

- 三个品种均无新 `SIGNAL` 且无错误：`DONT_NOTIFY`。
- 新信号通知包含：品种、方向、类型、北京时间信号 K 时间、该 K 收盘价、当时成立理由、确认价与失效价；不显示 A/B。
- 采集、因果校验、数据库、绘图或警报失败：立即报告具体品种、步骤和原始原因。

本文和 `ai_direct_guard.py + collect_tv.mjs + execute_signal.mjs` 是当前唯一 5m 生产闭环。旧候选任务、旧复核入口和第二个 Collector 必须保持禁用。
