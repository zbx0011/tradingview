# TVFloat 监控迁移

迁移包会带走：

- 当前监控源码与所有规则文件；
- `market.db` 中的 K 线、状态、信号、震荡区间与警报记录；
- 悬浮窗配置、候选去重状态、视觉基线与当前区间警报计划；
- 当前 TradingView MCP 源码及 Codex 的 `tradingview-mcp` skill；
- 信号 Excel 和生成器。

不会带走 Codex 登录凭据、TradingView 登录凭据、浏览器 Cookie。新电脑必须分别登录。

## 第一次演练（旧电脑不停机）

在旧电脑项目目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\migration\Export-TVFloatMigration.ps1
```

将桌面的 `TVFloat-Migration-*.zip` 复制到新电脑，解压后执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\workspace\migration\Install-TVFloatMigration.ps1
```

默认只安装并注册一个“禁用”状态的计划任务，避免两台电脑同时报警。

## 新电脑准备

1. 安装 Node.js、Python、Codex 和 TradingView Desktop。
2. 在 Codex 登录同一个 OpenAI 账号。
3. 在 TradingView Desktop 登录，并确保自己的布局已经云端保存。
4. 启动 TradingView 时必须开启 CDP 端口 9222。迁移包中的
   `tradingview-mcp\scripts\launch_tv_debug.bat` 可用于启动。
5. 最右侧保留监控专用标签页；监控会在该标签内切换四个品种。
6. 运行：

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\你的用户名\Documents\TVFloatMonitor\migration\Test-TVFloatMigration.ps1
```

全部 PASS 后，才做正式切换。

## 正式切换

旧电脑执行最终导出（这一步会禁用旧电脑定时任务）：

```powershell
powershell -ExecutionPolicy Bypass -File .\migration\Export-TVFloatMigration.ps1 -FinalCutover
```

把新的压缩包复制到新电脑；如果演练时已经有数据库，正式安装要明确覆盖：

```powershell
powershell -ExecutionPolicy Bypass -File .\workspace\migration\Install-TVFloatMigration.ps1 -OverwriteExistingState -EnableMonitor -EnableFloatAtLogon
```

然后再次运行验证，并可增加一次真实采集烟雾测试：

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\你的用户名\Documents\TVFloatMonitor\migration\Test-TVFloatMigration.ps1 -RunCollectorSmokeTest
```

只有新电脑验证完成后才保持新任务启用；不要重新启用旧电脑任务。

## 保留不变的运行参数

- 周一至周五 24 小时；
- 每 5 分钟触发；
- 使用 5 分钟已收盘 K；
- `BYBIT:BTCUSDT.P`、`OANDA:XAGUSD`、`OANDA:XAUUSD`、`ICMARKETS:US500`；
- AI 快速复核、逐个完成逐个执行信号；
- 继续使用原数据库去重，因此迁移后不会因为换电脑自动重发旧信号。
