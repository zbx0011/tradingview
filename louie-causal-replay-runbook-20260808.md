# Louie 严格因果回放执行手册（2026-08-08 版）

> 本手册记录“单根因果门 + 结构敏感快照 + deepseek-v4-flash/max + 无状态模式 + 看门狗”的完整回放方法。按文档即可复现、续跑或扩展到最新行情。

## 一、这套方法是什么

- **数据**：OANDA:XAUUSD 5 分钟冻结 K 线（JSON），已跑通 1499 根（2026-07-31 03:00 ～ 2026-08-07 13:50 北京时间）。
- **因果**：单向门。模型提交当前根判断（写入哈希链）后，门才释放下一根；`evidence / max_used_idx ≤ 当前 idx`，物理上无法偷看未来。
- **看图**：deepseek 是纯文本模型，所以“看图”= 结构化文字快照（最近 40 根 OHLC + EMA20/50 + ATR + 100 根区间 + 已确认枢轴 + 结构提示），并同时存 PNG 供人工存档。只有结构变化（突破/假突破/扫荡/EMA 交叉/缺口/大实体）时才生成快照。
- **输出**：setup 用简短中文形态词；reason 用简体中文，按“背景 → 位置 → 接受与跟随 → 触发”。
- **防 token 膨胀**：默认推荐无状态模式（每轮全新会话，只带规则+当前状态+快照），每轮输入恒定，不再随进度滚大。
- **稳定性**：看门狗自动续跑（失败重试、连续卡死自动换新线程、额度受限自动等待）。

## 二、组件与路径

| 文件 | 作用 |
| --- | --- |
| `realtime_signals/xau_causal_gate.py` | 单向因果门：init / status / step；payload 含 `structure_hint` |
| `realtime_signals/chart_text_snapshot.py` | 生成文字快照 + PNG 存档（仅 ≤ 当前 idx） |
| `realtime_signals/xau_causal_mcp_server.py` | MCP server：`status` / `commit` / `chart_snapshot`；已强制 UTF-8 |
| `realtime_signals/run_xau_causal_replay_v2.py` | 编排器：init / resume / 无状态模式 / 快照预算 / 审计 |
| `realtime_signals/run_xau_causal_watchdog.py` | 看门狗：自动重试续跑、换新线程、额度等待 |
| `realtime_signals/run_causal_replay.ps1` | 一键启动包装脚本 |
| `realtime_signals/fetch_xau_ohlcv_extension.mjs` | 从 TradingView 拉取新 K 线（CDP 读整段已加载序列） |
| `realtime_signals/draw_xauusd_v2_signals.mjs` | 把信号标注到 TradingView（方向+时间+价格+完整理由） |

环境要求：

- Python：项目 `.venv\Scripts\python.exe`（含 Pillow；gate 本身只用标准库）。
- Codex CLI：`codex` 可用，deepseek 供应商已配置（`model_provider=custom`，`base_url=https://api.deepseek.com`，`requires_openai_auth=true`）。
- 模型：`deepseek-v4-flash`，推理强度 `max`。
- TradingView MCP：`~/tools/tradingview-mcp`（标注和抓取数据时用）。

## 三、数据文件格式

冻结 JSON 顶层字段：

```json
{
  "symbol": "OANDA:XAUUSD",
  "timeframe_minutes": 5,
  "timezone": "Asia/Shanghai",
  "bar_time_semantics": "open_time; decision no earlier than open_time+5m",
  "bars": [
    {
      "time": 1785438000,
      "open": 4099.745,
      "high": 4103.47,
      "low": 4098.77,
      "close": 4103.425,
      "volume": 3337,
      "beijing_open_time": "2026-07-31 03:00"
    }
  ]
}
```

`time` 为 Unix 秒（北京时间开盘点）。门会自动计算 EMA20/50、ATR14、已确认枢轴和结构提示；这些只用 ≤ 当前 idx 的数据。

当前已用数据：`%LOCALAPPDATA%\Temp\xauusd_causal_extended_20260807.json`（1499 根，SHA-256 `7cea21394893b7b2bc13a4be2cc756bb22cf3db30f5171d5cb1f087c6927bb01`）。

## 四、执行流程

### 1) 新跑一套完整回放（从 idx 0）

```powershell
$env:CAUSAL_WORK  = Join-Path $env:LOCALAPPDATA 'Temp\codex-xau-causal-work'
$env:CAUSAL_HOME  = Join-Path $env:LOCALAPPDATA 'Temp\codex-xau-causal-home'
$env:CAUSAL_DATA  = Join-Path $env:LOCALAPPDATA 'Temp\xauusd_causal_extended_20260807.json'
$env:CAUSAL_STATELESS = '1'   # 推荐：每轮全新会话，token 恒定
& .venv\Scripts\python.exe realtime_signals\run_xau_causal_replay_v2.py
```

或者用包装脚本（默认看门狗+无状态）：

```powershell
.\realtime_signals\run_causal_replay.ps1 -Mode watchdog -Stateless -Work <目录> -Home <目录> -Data <数据文件>
```

### 2) 续跑（中断后继续）

```powershell
& .venv\Scripts\python.exe realtime_signals\run_xau_causal_replay_v2.py --resume
```

- 沿用同一线程：`--resume`（模型记得之前的对话，但 token 会滚大，不推荐长跑）。
- 换新线程、保留账本：`$env:CAUSAL_NEW_THREAD='1'` 后再 `--resume`（解决旧线程“以为做完了”的问题）。
- 无状态续跑：`$env:CAUSAL_STATELESS='1'` 后再 `--resume`（推荐）。

### 3) 自动续跑（推荐正式运行方式）

```powershell
$env:CAUSAL_WORK=<工作目录>; $env:CAUSAL_HOME=<家目录>; $env:CAUSAL_DATA=<数据文件>
& .venv\Scripts\python.exe realtime_signals\run_xau_causal_watchdog.py
```

看门狗参数（环境变量）：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `CAUSAL_WATCHDOG_RETRIES` | 40 | 最大重试次数 |
| `CAUSAL_WATCHDOG_SLEEP` | 45 | 失败后等待秒数 |
| `CAUSAL_WATCHDOG_BLOCKED_SLEEP` | 600 | 额度受限时等待秒数 |
| `CAUSAL_WATCHDOG_NEW_THREAD_AFTER` | 2 | 连续同线程卡死几次后换新线程 |

### 4) 扩展到最新行情（在已有账本后追加）

第一步：拉取 08-04 之后到最新收盘的 K 线（从旧数据最后开盘点 +300 秒开始）：

```powershell
node realtime_signals\fetch_xau_ohlcv_extension.mjs <起始时间戳> <输出json>
```

第二步：合并旧数据 + 新数据（补 `beijing_open_time`），写出新冻结 JSON（SHA 会自动由运行器识别）。

第三步：复制旧账本到新工作目录：

```powershell
$vOld=<旧work>; $vNew=<新work>
New-Item -ItemType Directory -Path "$vNew\ledger" -Force | Out-Null
Copy-Item "$vOld\ledger\decisions.jsonl" "$vNew\ledger\"
Copy-Item "$vOld\ledger\gate_state.json"  "$vNew\ledger\"
Copy-Item "$vOld\orchestrator_progress.json" "$vNew\"
Copy-Item "$vOld\snapshot_log.jsonl" "$vNew\"
```

第四步：用新数据 + 新目录执行 `--resume`（`CAUSAL_NEW_THREAD=1` 或 `CAUSAL_STATELESS=1`）。运行器会自动更新 `gate_state.data_sha256` 和总根数。

## 五、关键参数（`run_xau_causal_replay_v2.py` 顶部）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `MODEL` | deepseek-v4-flash | 判定模型 |
| `EFFORT` | max | 推理强度 |
| `TURN_LIMIT`（可用 `CAUSAL_TURN_LIMIT` 覆盖） | 30 | 每轮最多提交根数 |
| `SNAPSHOTS_PER_TURN` | 12 | 单轮快照上限（超限只警告） |
| `SNAPSHOTS_TOTAL` | 800 | 全程快照上限（超限停止） |

## 六、核验与产出

### 链与防作弊核验

```powershell
$env:PYTHONIOENCODING='utf-8'
$code = @'
import json, hashlib, os
from pathlib import Path
work = Path(os.environ["LOCALAPPDATA"]) / "Temp" / "codex-xau-causal-v3-work-20260807"
rows = [json.loads(l) for l in (work/"ledger"/"decisions.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
def canonical(v): return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
prev = "0"*64; problems = []
for i, r in enumerate(rows):
    if r["previous_chain_sha256"] != prev: problems.append(i)
    rec = {k:v for k,v in r.items() if k not in ("record_sha256","chain_sha256")}
    if hashlib.sha256(canonical(rec)).hexdigest() != r["record_sha256"]: problems.append(i)
    prev = hashlib.sha256((prev + r["record_sha256"]).encode()).hexdigest()
    if r["max_used_idx"] != r["idx"] or any(e<0 or e>r["idx"] for e in r["evidence_indices"]): problems.append(i)
print("rows:", len(rows), "| problems:", len(problems), "| chain tail:", prev)
'@
$code | python -
```

产出（信号统计、逐次信号、与 A01–A15 对比、中文 md 总结）可参照已有示例：

- `outputs/xauusd_replay_5m_20260807_v3_deepseek/xauusd_replay_v3_summary.md`
- 账本：`outputs/xauusd_replay_5m_20260807_v3_deepseek/decisions.jsonl`

标注到 TradingView：

```powershell
node realtime_signals\draw_xauusd_v2_signals.mjs <signals.json> <drawings.json>
```

## 七、已知注意事项

1. **MCP 中文编码**：服务器已强制 UTF-8（Windows 默认 GBK 会把中文读成乱码导致 commit 被拒）。
2. **模型元数据警告**：`model_catalog_json` 会让 MCP 工具消失，所以隔离配置**不要**写这一项；deepseek 会走 fallback 元数据，不影响功能。
3. **图表周期等待**：标注脚本先切周期再等待（顺序不能反）。
4. **快照预算**：波动段可能一轮调用十几张快照；单轮超限只记警告，总预算超限才停止。
5. **token 增长**：同线程 resume 每轮输入会滚到上千万；长跑请用 `CAUSAL_STATELESS=1` 或按量换新线程。
6. **旧线程“以为做完了”**：续跑旧线程可能不提交，用 `CAUSAL_NEW_THREAD=1` 或无状态模式。
7. **deepseek 不支持真图**：快照是文字；若要真图版，换 `gpt-5.6-luna`（支持 image）并把 `chart_snapshot` 返回图片内容（PNG 已生成，改造很小）。

## 八、历史结果速查

- v2（634 根，deepseek 文字快照）：11 个信号；与 A01–A15 对比：A15 完全一致、A04/A10/A11/A13 同向接近、A01 同点反向、9 个未触发。
- v3（1499 根，含最新行情）：35 个信号（前 634 根 11 个 + 扩展 865 根 24 个）；全程链校验 0 问题。
- 旧 Sol 文本版（520 根）：84 个信号（无快照、无合并、逐根确认都计信号）——已由 v2/v3 方法取代。
