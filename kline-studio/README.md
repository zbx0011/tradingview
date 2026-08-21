# K 线工坊

一个本地运行、可部署到 GitHub Pages 的 TradingView 风格专业 K 线工作台。不包含论坛、聊天、发布或真实交易账户功能。

## 本机一键启动

在 Windows 上下载仓库后，双击 `start-local.cmd` 即可启动。首次启动会自动执行 `npm ci`，之后打开：

```text
http://127.0.0.1:4173/
```

也可以手动运行：

```powershell
npm ci
npm run dev
```

要求 Node.js 20 或更高版本。

## GitHub Pages

仓库中的 `.github/workflows/deploy-pages.yml` 会在 `master` 分支更新后自动构建 `kline-studio` 并发布到 GitHub Pages。第一次发布时，在仓库 Settings → Pages 将 Source 设为 **GitHub Actions**。构建会自动使用 `/<仓库名>/` 作为 Vite base path，刷新和静态数据路径不会丢失。

## 跨电脑保持一致

本机服务会把做题历史和收藏安全同步到私有仓库 `zbx0011/kline-studio-sync-private`：

1. 启动网站时，后台自动拉取全部私有备份并去重合并。
2. 做题历史或收藏变化后 5 秒，后台自动保存合并前恢复点、上传最新结果并从远端回下载校验 SHA-256。
3. 后台上传前会通过 GitHub API 确认仓库 visibility 为 `PRIVATE`；不是私有仓库时立即停止。
4. 整个流程使用同源 localhost 接口，不打开 Windows 文件选择框，也不会把 GitHub 凭据交给网页。

需要先在该电脑的 Git 凭据管理器登录有权访问私有仓库的 GitHub 账号。默认同步克隆位于 `%LOCALAPPDATA%\KlineStudio\sync-private`；可用环境变量 `KLINE_STUDIO_SYNC_REPO` 指向已有克隆。设置面板仍保留「私有仓库一键同步」和 JSON 文件导入/导出作为即时同步及离线恢复入口。

GitHub Pages 只有静态前端，不会暴露本机同步接口；自动同步仅在 `http://127.0.0.1:4173/` 的本机服务中启用。

## 验证

```powershell
npm run build
npm test -- --run
npm run lint
```

## 功能

- XAUUSD、XAGUSD、US500、BTCUSDT.P、ETHUSD 品种切换
- 1 分钟到周线的 9 种周期，右侧价格轴和成交量面板
- K 线、空心 K、折线、面积图；EMA20、MA、BOLL、成交量指标
- 鼠标滚轮缩放、拖拽平移、十字光标、A 自动适配和 L 坐标模式
- TradingView 风格的左侧绘图工具、快捷键、对象树、右键菜单和绘图编辑
- K 线回放：图表选点、日期时间、最早/随机 K 线、播放/暂停、单步、速度和关闭回到实时
- 回放交易与震荡区间作为静态 JSON 图层保存，按品种和周期隔离显示
- 模拟订单、价格提醒、收藏工具、图表设置和可导入/导出的完整工作区

## 数据说明

仓库内的 `public/data` 和 `src/data` 包含功能验证所需的静态 K 线、回放交易、回放信号及震荡区间数据。XAUUSD、XAGUSD、US500 的 1 分钟快照取自 Dukascopy 公开历史数据，覆盖 2026-06-01 至最近同步时间；BTCUSDT.P 的 1 分钟快照取自 KuCoin XBTUSDTM 永续合约，覆盖最近 90 天并保留交易所真实无成交空档，文件为 `public/data/btcusdt-p-1m-30d.json`。在线行情只在用户主动请求时读取公开市场接口；应用不会自动把图表跳回最新位置。数据仅用于软件功能验证，不构成交易建议。

图表底层使用 Apache-2.0 授权的 [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)，页面保留库的归属标识。
