# Louie 规则回放 / 监控 本地索引（20260806）

> 目的：如果 Codex 更新丢失了聊天记录，从本文件可以找回两套系统的全部入口、
> 文件位置和恢复步骤。两套系统的正式名称：
>
> - 监控：**louie规则监控（20260806版本）**
> - 回放：**louie规则回放（20260806版本）**

---

## 一、louie规则监控（20260806版本）

### 自动化配置（Codex 心跳）

- 配置文件：`C:\Users\zbx00\.codex\automations\5-k\automation.toml`
- 应用数据库：`C:\Users\zbx00\.codex\sqlite\codex-dev.db`（表 `automations`，id=`5-k`）
- 名称：`louie规则监控（20260806版本）`
- 模型：`deepseek-v4-flash` / `reasoning_effort=max`
- 调度：工作日每 5 分钟（heartbeat，绑定一个固定监控页面线程）
- 目标线程：toml 中 `target_thread_id`（当前为 DeepSeek 监控页面）

### 运行时数据库与状态

- K线/审核/信号/区间：`%LOCALAPPDATA%\TVFloat\market.db`
- 配置（悬浮窗位置/标的选择）：`%LOCALAPPDATA%\TVFloat\config.json`
- 会话原始文件：`C:\Users\zbx00\.codex\sessions\...`（按线程 ID 查找）

### 核心文件

| 文件 | 作用 |
| --- | --- |
| `realtime_signals/AI_DIRECT_PARALLEL_MONITOR.md` | 唯一生产编排规范（入口文档） |
| `realtime_signals/AI_DIRECT_MONITOR.md` | 判断规则与逐根因果流程 |
| `realtime_signals/AI_DIRECT_SYMBOL_WORKER.md` | 单品种 worker 协议 |
| `realtime_signals/ai_direct_guard.py` | 租约/快照/落库/二次审计守卫 |
| `realtime_signals/collect_tv.mjs` | 唯一采集器 |
| `realtime_signals/execute_signal.mjs` | 信号执行器（画图+警报，不回放用） |
| `realtime_signals/drain_ai_execution_queue.py` | 执行队列消费者 |
| `realtime_signals/focus_guard.py` | 监控/回放共用：TradingView 后台执行 |
| `realtime_signals/rotate_monitor_thread.py` | 轮换监控页面工具 |
| `tv_float.py` | 悬浮窗 |

### 恢复步骤

1. 确认自动化存在且 ACTIVE：
   `C:\Users\zbx00\.codex\automations\5-k\automation.toml`（status=ACTIVE）。
2. 若目标线程页面丢失：在 Codex 侧边栏新建页面，运行
   `python realtime_signals\rotate_monitor_thread.py --new-thread-id <新页面ID>`。
3. 检查 TradingView 是否带 `--remote-debugging-port=9222` 运行；没有则运行
   `node realtime_signals\tv_launch_debug.mjs`。
4. 等下一个 5 分钟边界心跳自动执行；也可手动验证：
   `node realtime_signals\collect_tv.mjs`。

---

## 二、louie规则回放（20260806版本）

### 5 分钟逐根回放流程（推荐，严格因果）

本版本的回放模型为 `gpt-5.6-sol` / `reasoning_effort=xhigh`；生产监控模型不随回放切换。

1. 回补最近 12 小时数据：`node realtime_signals\replay_backfill_5m.mjs --hours 12`
2. 冻结严格最近 12 小时时间窗内的已闭合 5 分钟 K 线并生成分批上下文（停盘缺口不补造 K 线）：
   `python realtime_signals\replay_5m_batches.py --hours 12 --output-dir outputs\xagusd_replay_5m_20260806_12h_sol_xhigh`
   - 输出：指定目录下的 `batch_*.txt`、逐批默认判定骨架和 `manifest.json`
3. 用真实 Sol xhigh 逐根判定；每个候选 SIGNAL 再用只截断到目标 K 的快照做独立二次审计：
   `python realtime_signals\replay_5m_ai_review.py --base outputs\xagusd_replay_5m_20260806_12h_sol_xhigh --model gpt-5.6-sol --effort xhigh --force`
4. 合并逐根记录：
   `python realtime_signals\merge_replay_decisions.py --base outputs\xagusd_replay_5m_20260806_12h_sol_xhigh --output outputs\xagusd_replay_5m_20260806_12h_sol_xhigh_decisions.jsonl --model gpt-5.6-sol --effort xhigh`
5. 提取信号：
   `python realtime_signals\extract_replay_signals.py --src outputs\xagusd_replay_5m_20260806_12h_sol_xhigh_decisions.jsonl --output outputs\xagusd_replay_signals_20260806_12h_sol_xhigh.json`
6. 画图（无警报、后台执行、中文不省略）：
   `node realtime_signals\draw_review_5m.mjs outputs\xagusd_replay_signals_20260806_12h_sol_xhigh.json outputs\xagusd_replay_drawings_20260806_12h_sol_xhigh.json`

### 旧 15 分钟回放工具（已同步模型/语言/后台行为）

- `replay_backfill_15m.mjs`（回补）
- `replay_15m_ai_review.py`、`pure_ai_full_scan.py`（AI 判定，gpt-5.6-sol/xhigh）
- `draw_replay_15m_results.mjs`、`draw_replay_15m_results_clean.mjs`（画图）
- `review_decision_prompt.txt`、`review_prompt.txt`（输出必须简体中文）

### 回放输出示例

- `outputs\xagusd_review_5m_20260805.txt`（数据导出）
- `outputs\xagusd_replay_5m_decisions.jsonl`（逐根判定）
- `outputs\xagusd_replay_signals_20260805.json`（信号）
- `outputs\xagusd_replay_drawings_20260805.json`（图上标注记录）

---

## 三、共用与注意事项

- `realtime_signals/focus_guard.py`：两套系统共用，保证 TradingView 后台执行、不抢焦点。
- 规则原文（Louie）：`migration/codex-handoff/source-rules/` 下两份文档。
- 模型可随时切换；历史记录的 model 字段保留原样，不作错误处理。
- 回放与生产监控隔离：回放不得修改监控自动化、默认参数、警报或订单。
- 监控页面建议每 12-24 小时轮换一次以控制上下文；轮换不丢任何数据库状态。
