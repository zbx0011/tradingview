# TradingView 工具箱

## K 线工坊（当前主网站）

本仓库同时提供新的 TradingView 风格 K 线网站，源码和静态 K 线/回放数据位于 [`kline-studio/`](./kline-studio)。Windows 下载 ZIP 后可直接双击 [`start-kline-studio.cmd`](./start-kline-studio.cmd)；首次启动会自动安装依赖并打开本地开发服务器。

GitHub Pages 会通过 [`deploy-kline-studio-pages.yml`](./.github/workflows/deploy-kline-studio-pages.yml) 自动构建并发布网站。第一次发布时，在仓库 Settings → Pages 将 Source 设为 **GitHub Actions**。

当前浏览器里的绘图、回放进度、模拟订单、对象树状态、指标参数和面板偏好不属于 Git 文件。请在网站「图表设置」中导出完整工作区 JSON，换电脑后在同一位置导入；静态数据则随仓库版本一起发布。

一个 Windows 置顶悬浮窗，从正在运行的 TradingView Desktop 图表标签读取标的、现价和涨跌幅。

## 旧版悬浮行情

1. 启动 TradingView Desktop。
2. 为每个希望显示的标的打开一个图表标签。标签标题需要类似 `XAUUSD ▼ 4,115.030 −0.36%`。
3. 双击 `TradingView悬浮行情.exe`。
4. 拖动悬浮窗可以改变位置；点击右上角齿轮可以添加/选择标的、拖动 `☰` 调整显示顺序，并通过 `− / +` 分别调整“标的 ↔ 价格”和“价格 ↔ 涨跌”的列间距。透明度、字体大小、标的顺序和列间距都会自动保存。主窗口锁定运行，不提供关闭按钮或右键退出入口；如确需结束，请使用 Windows 任务管理器。

开机自动启动通过 Windows 当前用户的“启动”文件夹快捷方式配置，不需要管理员权限。

程序只允许一个悬浮窗实例运行；重复启动时会唤起已经存在的窗口。拖动主窗口右下角的 `◢` 可以调整大小，窗口会根据 DPI 缩放和标的数量自动保证最低可读高度。

程序只读取 TradingView 顶部图表标签的公开文字，不使用 OCR，也不读取右侧观察列表。每个需要显示的标的都必须在 TradingView 中打开为顶部标签页。

设置中的“手动添加”只决定悬浮窗显示哪些标签名称，不会创建 TradingView 标签页或连接额外行情源。

TradingView 可以被其他窗口遮挡。为了让 Windows 持续提供全部标签文字，程序检测到 TradingView 最小化时会在其他窗口后方无焦点恢复它；不会抢走当前应用的输入焦点。若 TradingView 退出、标签不再提供价格或连续 5 秒无法读取，悬浮窗会显示“暂停”，不会把旧价格伪装成实时价格。

## 数据范围和限制

- 本工具不连接、破解或复制 TradingView 的私有行情接口，只读取 Windows 已公开显示的标签文字。
- 只能读取 TradingView 标签栏中实际存在且带价格的图表标签。
- TradingView 更新界面结构后，读取规则可能需要适配。
- 本工具仅用于行情查看，不应作为自动下单或交易风控的数据源。

## 从源码运行

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python tv_float.py
```

## 打包

```powershell
.venv\Scripts\pyinstaller --noconfirm --clean --onefile --windowed --name TradingView悬浮行情 tv_float.py
```

配置保存在 `%LOCALAPPDATA%\TVFloat\config.json`。
