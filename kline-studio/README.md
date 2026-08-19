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

GitHub 会保存随项目发布的 K 线快照、回放交易 JSON、回放震荡区间 JSON 和其它静态数据。浏览器里的工作区状态（绘图、对象树隐藏/展开、模拟订单图层可见性、回放进度、指标参数、面板位置/尺寸/字体、自选工具等）通过设置面板的：

1. 在当前电脑点击「图表设置 → 导出完整工作区」，得到 `kline-studio-workspace-YYYY-MM-DD.json`。
2. 在另一台电脑下载仓库并双击 `start-local.cmd`。
3. 打开「图表设置 → 导入工作区备份」，选择这个 JSON 文件，页面会自动刷新并恢复状态。

这样静态数据来自 GitHub，个人工作区来自备份文件，不依赖某一台电脑的浏览器缓存。

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
