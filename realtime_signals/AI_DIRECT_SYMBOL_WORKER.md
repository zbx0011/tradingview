# louie规则监控（20260806版本）

# TVFloat 单品种 AI worker 协议

本协议只供 `AI_DIRECT_PARALLEL_MONITOR.md` 启动的 BTC、XAG、XAU 三个独立 AI worker 使用。

生产 worker 必须使用 `model=deepseek-v4-flash`、`reasoning_effort=max` 运行；不得回退到 GPT-5.6 Sol/Terra/Luna。

历史审核记录的 `model` 字段可能来自其他模型（如 `gpt-5.6-sol`、`gpt-5.6-luna`），
用户随时可能切换模型；不要把历史字段与当前模型不一致当作错误，也不要改写或回填旧记录。

所有 AI 输出文本（`reasons`、`location_summary`、`structure_summary`、
`audit_summary` 等）必须使用简体中文，禁止英文。

## 不可越界的职责

- 每个 worker 只处理分配给自己的一个固定品种，不得读取或判断其他品种。
- worker 只读取 SQLite 中已经由本轮唯一采集器冻结的已收盘 5 分钟 K 线。
- 禁止调用 TradingView MCP、禁止切标签、禁止绘图、禁止创建或删除警报。
- 禁止调用 `execute_signal.mjs` 或 `drain_ai_execution_queue.py`。
- 禁止旧候选筛选、旧 A/B 规则、旧生产入口和任何未获批准的 ATR/百分比硬门槛。
- 程序不筛交易候选；`next` 只做运行时效控制，返回的每根仍处于实时执行窗口的新收盘 K 都必须由 AI 直接给出 `NO_SIGNAL / OBSERVE / SIGNAL`。
- 生产 worker 不补审已经错过实时窗口的历史 K。历史逐根审计必须使用独立回放流程，绝不能转成实时提醒。

## 规则上下文

首次启动时完整读取：

1. `migration/codex-handoff/source-rules/Louie交易规则完整整理_案例扩展版.md`
2. `migration/codex-handoff/source-rules/louie-case-expanded.md`
3. `realtime_signals/AI_DIRECT_MONITOR.md`

后续复用同一个 worker 时，先用 `rule_source_manifest()` 的 SHA-256 判断规则源是否变化；未变化可复用已加载上下文，变化则重新完整读取。规则优先级、六类机会、逐根防作弊、震荡与通道定义、二次时间戳审计和禁用项全部沿用 `AI_DIRECT_MONITOR.md`。

## 单次工作

固定映射：

- BTC worker：`BYBIT / BTCUSDT.P / 5`
- XAG worker：`OANDA / XAGUSD / 5`
- XAU worker：`OANDA / XAUUSD / 5`

依次执行：

1. `python realtime_signals/ai_direct_guard.py next --vendor VENDOR --symbol SYMBOL --timeframe 5 --limit 3`
2. 核对 `live_only=true`。`expired_unreviewed_count` 只用于审计统计，不得补审、不得产生实时信号。对 `pending_bars` 按时间升序逐根执行 `snapshot --history-bars 864 --tail 864`。
3. 严格核对 `no_future_bars=true`、`data_cutoff=bar_time`、`max_included_bar_time=bar_time`、`target_bar[0]=bar_time`。
4. 只用该冻结快照判断。若第一次判断为 `SIGNAL`，对同一快照做独立第二遍时间戳审计；不得读取新数据。
5. 用 UTF-8 JSON Base64 调用 `record`。只负责落库；即使返回 `should_execute=true`，也不得自行执行。
6. 一根完成后再处理下一根，保证同品种状态因果顺序不乱。

## 实时信号截止时间

- 信号 K 的 `bar_time` 是开盘时间；实时执行截止时间固定为 `bar_time + 600`，即下一根 5 分钟 K 收盘时。
- 为单一 TradingView 执行器预留至少 90 秒。剩余时间不多于 90 秒时，AI 的 `SIGNAL` 结论仍写入审计表，但 `execution_status=expired`、`should_execute=false`。
- `expired` 绝不允许触发悬浮窗闪烁、TradingView 标注或 TradingView 警报。这只是执行时效规则，不改变 Louie 交易判断，也不把 `SIGNAL` 改写成 `NO_SIGNAL`。

最终只返回紧凑 JSON 摘要：品种、已审核 bar_time、各 verdict 数量、新 SIGNAL 的 bar_time、错误。不要向用户发送通知，不要输出完整 K 线历史。
