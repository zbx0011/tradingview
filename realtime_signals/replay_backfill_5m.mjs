// louie规则回放（20260806版本）
// One-shot, token-free TradingView backfill for a historical 5-minute replay
// (XAGUSD only). Does not sync drawings/ranges and does not run the monitor.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTradingViewMcpSdk,
  resolveTradingViewMcpRoot,
} from './tradingview_mcp_runtime.mjs';

if (process.platform === 'win32' && !('type' in process)) {
  process.type = 'tvfloat-background';
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptDir);
const serverRoot = resolveTradingViewMcpRoot();
const { Client, StdioClientTransport } = await loadTradingViewMcpSdk(serverRoot);
const timeframe = '5';
const barSeconds = 5 * 60;
const watchlist = [['OANDA', 'XAGUSD', 'OANDA:XAGUSD']];
const hoursIndex = process.argv.indexOf('--hours');
const requestedHours = hoursIndex >= 0 ? Number(process.argv[hoursIndex + 1]) : 6 * 24;
if (!Number.isFinite(requestedHours) || requestedHours <= 0 || requestedHours > 30 * 24) {
  throw new Error(`invalid --hours value: ${process.argv[hoursIndex + 1] || requestedHours}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (result) => JSON.parse(result.content[0].text);

const focusPython = fs.existsSync(path.join(root, '.venv', 'Scripts', 'python.exe'))
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : 'python';
const focusGuard = (args) => {
  try {
    const output = execFileSync(
      focusPython,
      [path.join(scriptDir, 'focus_guard.py'), ...args],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        env: { ...process.env, PYTHONUTF8: '1' },
      },
    );
    const lines = output.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
};

const ingestBatch = (vendor, symbol, bars) => {
  const encoded = Buffer.from(JSON.stringify({ bars }), 'utf8').toString('base64');
  return JSON.parse(execFileSync(
    focusPython,
    [
      'realtime_signals/kline_store.py',
      'ingest',
      '--vendor',
      vendor,
      '--symbol',
      symbol,
      '--timeframe',
      timeframe,
      '--payload-base64',
      encoded,
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  ));
};

const waitForChart = async (client, full, expectedTimeframe = timeframe) => {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const state = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
    if (state.symbol === full && String(state.resolution) === String(expectedTimeframe)) return;
    await sleep(750);
  }
  throw new Error(`chart switch failed for ${full} ${expectedTimeframe}m`);
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/server.js'],
  cwd: serverRoot,
  stderr: 'inherit',
});
const client = new Client(
  { name: 'tvfloat-replay-backfill-5m', version: '1.0.0' },
  { capabilities: {} },
);

await client.connect(transport);
const savedFocus = focusGuard(['save']);
focusGuard(['unminimize']);
try {
  const rightmost = parse(await client.callTool({ name: 'tab_switch_rightmost', arguments: {} }));
  if (!rightmost.success) throw new Error(rightmost.error || 'rightmost tab switch failed');
  const originalState = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
  const originalRange = parse(await client.callTool({ name: 'chart_get_visible_range', arguments: {} }));
  await client.callTool({ name: 'chart_set_timeframe', arguments: { timeframe } });
  const cutoff = Math.floor(Date.now() / 1000) - 5;
  const from = cutoff - Math.ceil(requestedHours * 3600);
  const results = [];

  for (const [vendor, symbol, full] of watchlist) {
    await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: full } });
    await waitForChart(client, full);
    await client.callTool({
      name: 'chart_set_visible_range',
      arguments: { from, to: cutoff },
    });
    await sleep(2200);
    const payload = parse(await client.callTool({
      name: 'ui_evaluate',
      arguments: {
        expression: `(() => {
          const bars = window.TradingViewApi._activeChartWidgetWV.value()
            ._chartWidget.model().mainSeries().bars();
          const result = [];
          for (let index = bars.firstIndex(); index <= bars.lastIndex(); index += 1) {
            const value = bars.valueAt(index);
            if (value) {
              result.push({
                time: value[0],
                open: value[1],
                high: value[2],
                low: value[3],
                close: value[4],
                volume: value[5] || 0,
              });
            }
          }
          return { bars: result, bar_count: result.length, total_available: bars.size() };
        })()`,
      },
    }));
    const extracted = payload.result || payload;
    const bars = (extracted.bars || []).filter(
      (bar) => Number(bar.time) + barSeconds <= cutoff,
    );
    if (!bars.length) throw new Error(`no closed bars returned for ${full}`);
    const batches = [];
    for (let index = 0; index < bars.length; index += 40) {
      batches.push(ingestBatch(vendor, symbol, bars.slice(index, index + 40)));
    }
    results.push({
      vendor,
      symbol,
      returned: extracted.bar_count,
      total_available: extracted.total_available,
      ingested_closed: bars.length,
      first_time: bars[0].time,
      last_time: bars.at(-1).time,
      batches: batches.length,
    });
  }

  if (originalState.success && originalState.symbol) {
    await client.callTool({
      name: 'chart_set_symbol',
      arguments: { symbol: originalState.symbol },
    });
    await client.callTool({
      name: 'chart_set_timeframe',
      arguments: { timeframe: String(originalState.resolution || timeframe) },
    });
    await waitForChart(
      client,
      originalState.symbol,
      String(originalState.resolution || timeframe),
    );
  }
  if (
    originalRange.success
    && Number.isFinite(originalRange.visible_range?.from)
    && Number.isFinite(originalRange.visible_range?.to)
  ) {
    await client.callTool({
      name: 'chart_set_visible_range',
      arguments: {
        from: originalRange.visible_range.from,
        to: originalRange.visible_range.to,
      },
    });
  }
  process.stdout.write(`${JSON.stringify({
    success: true,
    requested_hours: requestedHours,
    from,
    cutoff,
    results,
    restored_chart: originalState.success
      ? { symbol: originalState.symbol, resolution: String(originalState.resolution) }
      : null,
  })}\n`);
} finally {
  await client.close();
  if (savedFocus?.hwnd) focusGuard(['restore', String(savedFocus.hwnd)]);
}
