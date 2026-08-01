// One-shot, token-free TradingView backfill for a historical 15-minute replay.
// It does not sync drawings/ranges and does not run the live signal monitor.
import { execFileSync } from 'node:child_process';
import {
  loadTradingViewMcpSdk,
  resolveTradingViewMcpRoot,
} from './tradingview_mcp_runtime.mjs';

if (process.platform === 'win32' && !('type' in process)) {
  process.type = 'tvfloat-background';
}

const root = process.cwd();
const serverRoot = resolveTradingViewMcpRoot();
const { Client, StdioClientTransport } = await loadTradingViewMcpSdk(serverRoot);
const timeframe = '15';
const barSeconds = 15 * 60;
const watchlist = [
  ['BYBIT', 'BTCUSDT.P', 'BYBIT:BTCUSDT.P'],
  ['OANDA', 'XAGUSD', 'OANDA:XAGUSD'],
  ['OANDA', 'XAUUSD', 'OANDA:XAUUSD'],
  ['CAPITALCOM', 'SPX500', 'CAPITALCOM:SPX500'],
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (result) => JSON.parse(result.content[0].text);

const ingestBatch = (vendor, symbol, bars) => {
  const encoded = Buffer.from(JSON.stringify({ bars }), 'utf8').toString('base64');
  return JSON.parse(execFileSync(
    'python',
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

const waitForSymbol = async (client, full) => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
    if (state.symbol === full && String(state.resolution) === timeframe) return;
    await sleep(750);
  }
  throw new Error(`chart switch failed for ${full} ${timeframe}m`);
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/server.js'],
  cwd: serverRoot,
  stderr: 'inherit',
});
const client = new Client(
  { name: 'tvfloat-replay-backfill', version: '1.0.0' },
  { capabilities: {} },
);

await client.connect(transport);
try {
  const rightmost = parse(await client.callTool({ name: 'tab_switch_rightmost', arguments: {} }));
  if (!rightmost.success) throw new Error(rightmost.error || 'rightmost tab switch failed');
  await client.callTool({ name: 'chart_set_timeframe', arguments: { timeframe } });
  const originalRange = parse(await client.callTool({ name: 'chart_get_visible_range', arguments: {} }));
  const cutoff = Math.floor(Date.now() / 1000) - 5;
  const from = cutoff - 8 * 86_400;
  const results = [];

  for (const [vendor, symbol, full] of watchlist) {
    await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: full } });
    await waitForSymbol(client, full);
    await client.callTool({
      name: 'chart_set_visible_range',
      arguments: { from, to: cutoff },
    });
    await sleep(1700);
    // data_get_ohlcv intentionally caps output at 500 bars. Replay needs
    // additional warm-up bars before the five-day scoring window, so read the
    // full series already loaded by chart_set_visible_range.
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

  await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: 'BYBIT:BTCUSDT.P' } });
  await waitForSymbol(client, 'BYBIT:BTCUSDT.P');
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
  process.stdout.write(`${JSON.stringify({ success: true, cutoff, results })}\n`);
} finally {
  await client.close();
}
