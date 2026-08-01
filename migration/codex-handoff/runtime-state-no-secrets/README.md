# TVFloat 运行状态快照（不含密钥）

这是旧电脑 `%LOCALAPPDATA%\TVFloat` 中用于恢复业务语义的安全快照。仓库为私有仓库，但本目录仍明确排除了 `config.json`、连接密钥、日志、数据库 WAL/SHM 临时文件、旧回放结果和编译产物。

## 内容

- `market.db`：K 线、人工/自动震荡区间、信号、确认状态、AI 复核和 TradingView 警报记录。
- `candidate_memory.json`：候选记忆。
- `candidate_queue.json`：候选队列快照。
- `visual_baseline.json`：视觉基线。
- `range_edge_alert_plan.json`：震荡区间边缘警报计划。

## 恢复位置

在确认新电脑监控已经停止后，将这些文件复制到：

`%LOCALAPPDATA%\TVFloat\`

不要从 GitHub 恢复 `config.json`。连接地址和密钥应在新电脑本地重新配置或通过私下迁移。

## SHA-256

- `market.db`: `898F40ABC498C5F0A730357B9C3E9909842862E373E110600AE74037F8B73196`
- `candidate_memory.json`: `D85EB0AC2A5EC488F6F17368E7FE79C107FF452CC8F86EA433EECA8BD2381FAC`
- `candidate_queue.json`: `D8A0E8DE2300C4C4A2932A4DCED835299B7635C37055397BCA3D5507C6CA6766`
- `visual_baseline.json`: `1B5E0E5A620D40D4867AEC5232742CE2B11597D920563998E62A244C4CB5D6C5`
- `range_edge_alert_plan.json`: `F5EB391DE1DD9C4983A41B34755983F5E2AC96C1A17D3F221254FEB4F43A4A19`

## 对应实际源码

本快照对应仓库根目录的 `tv_float.py`、`tv_sync_client.py`、`tv_sync_host.py`、`tv_sync_protocol.py` 和 `realtime_signals/`。四个入口源码在快照时的 SHA-256：

- `tv_float.py`: `9BC20102E41034C345CAB302160DF87F0E8DAAF4C7C21247D28BDF2CF6D94AF0`
- `tv_sync_client.py`: `8B2F0F4BB9F43DA59CCA3D26CB6B50216DA33DF3D8AF5BF800128B80DD580BA6`
- `tv_sync_host.py`: `986FE9BC56B0AE6DE16E571A90AB743E15E04FB1852040EC029EF7281DCDB290`
- `tv_sync_protocol.py`: `136A07D1BDBFF0A25F9490761E722AC2CAD100D85D33F5A9FB2AB09C9911355B`
