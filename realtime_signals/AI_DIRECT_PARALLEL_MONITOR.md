# louie规则监控（20260806版本）

# TVFloat 单采集器 + 三并行 AI worker + 单执行队列

这是当前唯一生产编排入口。判断规则仍完全来自 `AI_DIRECT_MONITOR.md` 指定的两份 Louie 原文和本次 XAU 逐根复盘要求；本文件只改变并发和执行顺序，不改变任何交易判断语义。

## 架构不变量

1. 每轮只有一个主协调器持有 `direct_ai_cycle` 租约。
2. 每轮只运行一次 `collect_tv.mjs`；三个 AI worker 永远不接触 TradingView。
3. BTC、XAG、XAU 各有一个独立、可复用的 deepseek-v4-flash（推理强度 max）worker，并行审核各自的冻结快照；实际路由必须是 `model=deepseek-v4-flash`、`reasoning_effort=max`（用 default/worker agent 创建；禁止 `luna_worker`，因为 luna_worker 固定为 GPT-5.6 Luna）。
4. worker 只写 `ai_direct_reviews`，不得绘图、建警报或通知。
5. 所有正式 SIGNAL 进入 SQLite `pending` 队列。
6. 主协调器是唯一执行队列消费者；执行前取得 `direct_ai_executor` 租约，逐条原子认领并串行调用 `execute_signal.mjs`。
7. 一个 worker 完成后即可立即排空一次执行队列，不必等待另外两个 worker；但 TradingView 绘图/警报始终只有一个执行者。
8. 相同 bar 的审核主键、信号唯一键和执行状态共同保证幂等。`executing` 超过认领租约后才允许恢复为 `pending`。
9. 严格防作弊与实时过期同时成立：历史 SIGNAL 可保留审计结论，但实时执行截止于下一根 5m K 收盘；过期记录不得进入任何用户提醒通道。

### 模型字段说明（用户可随时切换模型）

- 用户可能中途随时切换监控模型。历史 `ai_direct_reviews.model` /
  `reasoning_effort` 字段会保留当时实际使用的模型，例如
  `gpt-5.6-sol/xhigh`、`gpt-5.6-luna/max`、`deepseek-v4-flash/max`。
- 禁止把历史记录的 model 与当前规范不一致当作错误、告警或需要修复的问题；
  禁止改写、回填或批量更新历史记录。
- 每轮新记录只按本轮实际使用的模型写入；当前自动化固定为
  `deepseek-v4-flash` / `reasoning_effort=max`。

## 每次 heartbeat

### 1. 时间与单例

北京时间周六、周日直接返回 `DONT_NOTIFY`，不读取 TradingView 或数据库。工作日生成唯一 `OWNER`，执行：

```powershell
python realtime_signals/ai_direct_guard.py cycle-wait --owner OWNER --lease-seconds 600 --timeout-seconds 900 --poll-seconds 15
python realtime_signals/ai_direct_guard.py wait-live-slot --sleep --reserve-seconds 150 --safety-seconds 6
```

`cycle-wait` 的含义：如果上一轮监控仍在执行（租约被占用），本轮必须等待租约
释放后立即继续，而不是安静跳过。等待超过 `--timeout-seconds` 仍未获取租约时
报告错误并停止。`wait-live-slot --sleep` 的含义：如果心跳到达太晚、最新已收盘
K 距离执行截止不足 150 秒（含约 60 秒采集时间和 90 秒执行预留），本轮先等到
下一根 5 分钟 K 收盘后 6 秒再开始采集，确保始终在“K 线收盘后马上”处理，且
每轮都有完整的实时执行窗口。

所有后续步骤放入 `try/finally`，最终释放同一 owner。

### 2. 唯一采集器

主协调器先完整读取 `AI_DIRECT_MONITOR.md`，再只运行一次：

```powershell
node realtime_signals/collect_tv.mjs
```

采集器负责最右侧标签、三个精确品种、5m、已收盘安全窗、增量写库和手工震荡框同步。采集失败时不启动 worker，立即报告原始错误。

监控调用 TradingView 期间不得把 TradingView 窗口带到前台。采集器和执行器
（`collect_tv.mjs` / `execute_signal.mjs`）已内置焦点守卫：开始前保存当前
前台窗口，TradingView 最小化时无焦点恢复，结束后把 TradingView 压到后台并
恢复原前台窗口。

### 3. 三个并行 worker

使用协作子代理，不建立三个 Codex 侧边栏任务：

- 优先复用 `/root/tv_btc_worker`、`/root/tv_xag_worker`、`/root/tv_xau_worker`；存在且空闲时用 `followup_task`。
- 不存在时以 `default` agent 创建，任务名分别为 `tv_btc_worker`、`tv_xag_worker`、`tv_xau_worker`。
- 三个 worker 必须使用 `model=deepseek-v4-flash`、`reasoning_effort=max` 运行；禁止回退到 Sol/Terra/Luna。若现有同名 worker 不是 deepseek-v4-flash/max，停止复用并重建。
- 新建 worker 使用最小上下文，并明确要求完整读取 `AI_DIRECT_SYMBOL_WORKER.md`；worker 不得再派生子代理。
- 三个任务必须连续发出后再等待，禁止 BTC 完成后才启动 XAG。

每个任务包必须包含：本轮 OWNER、唯一固定品种、规则协议路径、禁止 TradingView/执行器、完成标准和错误回传要求。

### 3a. 协作子代理消息无法投递时的直接判断回退

已知环境问题（2026-08-05 记录）：协作子代理的初始任务文本可能不会送达，
worker 被唤醒后只会回复“没有收到任务/没有看到你的问题”。主协调器在启动
worker 后必须读取其实际回复；若三个 worker 都出现空任务回复，禁止反复重试
或让 worker 自行猜任务，立即切换到本回退：

- 主协调器自身就是本次 heartbeat 任务，必须运行在 deepseek-v4-flash、
  `reasoning_effort=max`（可先核验当前会话模型；本自动化已固定该模型）。
- 主协调器按 BTC → XAG → XAU 顺序，直接执行与 worker 完全相同的流程：
  `next` → `snapshot`（864/864，核对 `no_future_bars` 等四项）→ 只用冻结
  快照和两份 Louie 原文判断 → `SIGNAL` 必须做独立二次时间戳审计 →
  `record`（payload 固定 `model=deepseek-v4-flash`、`reasoning_effort=max`、
  `rules_version=louie-xau-replay-v1`、`grade=none`）。
- 回退期间主协调器同样禁止直接绘图/建警报；所有正式 SIGNAL 一律进入执行
  队列，由第 4 节的单一执行器串行处理。
- 安全不变量、防作弊、实时过期和通知规则与 worker 路径完全一致。

### 4. 边完成边串行执行

等待任一 worker 完成。每收到一个完成结果，主协调器立即运行一次：

```powershell
python realtime_signals/drain_ai_execution_queue.py --owner OWNER --max-items 12 --claim-lease-seconds 300 --executor-lease-seconds 600 --timeout-seconds 150
```

然后继续等待剩余 worker。三个都完成后再排空一次，捕获竞态中最后落库的 SIGNAL。执行器输出 `failed>0` 时立即记录并通知具体品种、bar_time 和原始错误；成功信号通知沿用 `AI_DIRECT_MONITOR.md`，不显示 A/B。

不得让多个 `drain_ai_execution_queue.py` 同时运行。不得让 worker 直接调用执行器。

执行队列在每次认领前必须把截止时间已到或剩余执行时间不多于 90 秒的 `pending` 改为 `expired`。执行器收到的 deadline 必须取“本轮总截止时间”和“该信号 `bar_time+600`”中的较早者。`expired` 仅留档，不绘图、不建警报、不写入正式 `signals`、不让悬浮窗闪烁，也不作为错误通知。

### 5. 收尾

最终使用最右侧标签恢复 `BYBIT:BTCUSDT.P` 5m，关闭监控打开的观察列表面板，然后：

```powershell
python realtime_signals/ai_direct_guard.py cycle-end --owner OWNER
```

收尾后必须把自动化 `5-k` 的 `next_run_at` 设置为下一个 5 分钟边界（毫秒时间戳，
`%CODEX_HOME%\sqlite\codex-dev.db` 的 `automations` 表），保证下一轮心跳在
收盘边界立即触发，而不是按“上次运行时间 + 5 分钟”逐渐偏移。

三个品种均无新 SIGNAL 且无错误时返回 `DONT_NOTIFY`。任何采集、worker、数据库、绘图或警报错误都按具体步骤通知。一次唤醒结束后停止，等待下一次 heartbeat。

### 6. 上下文控制（每 12-24 小时轮换监控页面）

监控线程的会话历史会随每轮快照/工具输出累积，导致单次请求输入接近模型
上下文上限（大部分为缓存命中）。为了控制上下文膨胀且不降低判断质量：

- 每 12-24 小时新建一个监控页面（例如“DeepSeek 监控 08-06”），然后运行：
  `python realtime_signals/rotate_monitor_thread.py --new-thread-id <新页面ID>`
  把自动化 `5-k` 重定向到新页面（脚本自动备份旧配置并对齐下一次心跳）。
- 轮换不丢任何状态：K 线、逐根审核、信号、区间全部在数据库和文件中。
- 主协调器在每轮开始时检查本线程上下文：若会话文件超过 40MB 或上下文接近
  上限，本轮结束后返回 `ROTATE_MONITOR_PAGE` 提示用户轮换，而不是继续堆叠。
