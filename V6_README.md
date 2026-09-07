# V6 portable replay package

这套入口是已经跑通过的 V6 执行链：严格因果 PNG 回放、原始信号导出、下一根进场/反向确认、结构移动止损、固定风险回测和完成校验。

## 固定身份

- `rule_set_key`: `louie_structural_trailing_v6_nextbar_opposite`
- `rule_set_id`: `louie_al_brooks_full_corpus_ema20_structural_trailing_v6_nextbar_opposite_20260830`
- `rule_set_sha256`: `60619931bebe8c8b1c1f1f2554a2632201cb0e44ea60b350849256c362fd02b4`
- 默认模型：`gpt-5.6-luna`
- 默认推理强度：`max`
- 默认服务层：`default`
- 默认起始索引：由命令行明确指定；常用预热为 `start_idx=300`

V6 的完整规则文本、Al Brooks 案例补充、来源身份和哈希都在仓库中。原始课程 PDF、视频、旧账本、账号凭据没有放进 GitHub；`v6-source-identity.json` 只保存来源文件的冻结大小与 SHA-256。

## 另一台电脑首次使用

1. 安装 Python 3.11 或更新版本，并在仓库根目录执行：

   ```powershell
   python -m pip install -r requirements.txt
   ```

2. 安装并登录 Codex CLI。不要把 `auth.json`、token 或账号文件复制进仓库。

3. 准备冻结行情 JSON。文件必须有 `symbol`、`timeframe_minutes` 和 `bars`，并且必须使用同一份冻结数据；预检会计算 SHA-256。

4. 用 V6 锁定入口运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\realtime_signals\run_v6_replay.ps1 `
     -DataPath D:\data\xauusd_5m_20260629.json `
     -WorkPath D:\v6-runs\work\xauusd_20260629 `
     -OutputPath D:\v6-runs\outputs\xauusd_20260629 `
     -StartIdx 300 `
     -BarCount 276
   ```

该命令完成后会生成 `raw_signals.json`、`signals_with_trade_plans.json`、`backtest.json`、`validation.json` 和 `completion_receipt.json`。它不会上传 K 线工坊。

## 断点续跑

只在同一份数据、同一工作目录和同一输出目录上使用 `-Resume`：

```powershell
powershell -ExecutionPolicy Bypass -File .\realtime_signals\run_v6_replay.ps1 `
  -DataPath D:\data\xauusd_5m_20260629.json `
  -WorkPath D:\v6-runs\work\xauusd_20260629 `
  -OutputPath D:\v6-runs\outputs\xauusd_20260629 `
  -StartIdx 300 -BarCount 276 -Resume
```

不要删除或覆盖 `ledger`、`orchestrator_progress.json`、`decisions.jsonl` 和 `turn_logs`。配置、数据哈希、规则哈希或账本不一致时，入口会拒绝续跑。

## “完全一致”的边界

在同一 V6 规则哈希、同一冻结行情 SHA-256、同一 `gpt-5.6-luna/max/default`、同一 Codex CLI 版本和同一 PNG/因果门实现下，执行契约是一致的。模型服务返回本身不是静态二进制，因此换电脑后如果 CLI 版本、账号服务状态或数据文件不同，不能承诺每次模型输出字节级相同；完成回执会把这些身份值全部写出，便于审计。
