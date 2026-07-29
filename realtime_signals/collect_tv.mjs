// Token-free TradingView collection. It spawns the existing local MCP server
// directly, so scheduled collection does not create a model turn.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'file:///C:/Users/zbx00/tools/tradingview-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from 'file:///C:/Users/zbx00/tools/tradingview-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

// The MCP SDK hides Windows child processes only when it detects an Electron
// host. Mark this dedicated background collector as such so its Node server
// receives CREATE_NO_WINDOW and never flashes a terminal on the desktop.
if (process.platform === 'win32' && !('type' in process)) {
  process.type = 'tvfloat-background';
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptDir);
const serverRoot = 'C:/Users/zbx00/tools/tradingview-mcp';
const watchlist = [
  ['BYBIT', 'BTCUSDT.P', 'BYBIT:BTCUSDT.P'],
  ['OANDA', 'XAGUSD', 'OANDA:XAGUSD'],
  ['OANDA', 'XAUUSD', 'OANDA:XAUUSD'],
  ['ICMARKETS', 'US500', 'ICMARKETS:US500'],
];
const timeframe = '15';
const barSeconds = 15 * 60;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (result) => JSON.parse(result.content[0].text);
const waitForClosedBarSafetyWindow = async () => {
  const nowMilliseconds = Date.now();
  const secondsIntoWindow = (nowMilliseconds / 1000) % barSeconds;
  const safeSecond = 6;
  if (secondsIntoWindow < safeSecond) {
    await sleep(Math.ceil((safeSecond - secondsIntoWindow) * 1000) + 150);
  }
};
const waitForSymbol = async (client, full) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
    if (state.symbol === full && String(state.resolution) === timeframe) return state;
    await sleep(800);
  }
  const state = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
  throw new Error(`chart switch failed: expected ${full} ${timeframe}m, got ${state.symbol} ${state.resolution}m`);
};
const plausible = (symbol, close) => {
  if (symbol === 'BTCUSDT.P') return close > 1_000;
  if (symbol === 'XAGUSD') return close > 10 && close < 200;
  if (symbol === 'US500') return close > 1_000 && close < 20_000;
  return close > 1_000 && close < 10_000;
};
const latestStored = (vendor, symbol) => JSON.parse(execFileSync(
  'python',
  ['realtime_signals/kline_store.py', 'latest', '--vendor', vendor, '--symbol', symbol, '--timeframe', timeframe],
  { cwd: root, encoding: 'utf8', windowsHide: true },
));
const ingestBatch = (vendor, symbol, bars) => {
  const encoded = Buffer.from(JSON.stringify({ bars }), 'utf8').toString('base64');
  return JSON.parse(execFileSync(
    'python',
    ['realtime_signals/kline_store.py', 'ingest', '--vendor', vendor, '--symbol', symbol, '--timeframe', timeframe, '--payload-base64', encoded],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  ));
};
const storePayload = (command, payload) => {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return JSON.parse(execFileSync(
    'python',
    ['realtime_signals/kline_store.py', command, '--payload-base64', encoded],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  ));
};
const isOrangeRangeColor = (value) => {
  const color = String(value || '').toLowerCase().replace(/\s+/g, '');
  return color.includes('#f59e0b')
    || color.includes('#ff9800')
    || color.includes('rgba(255,152,0')
    || color.includes('rgb(255,152,0');
};
const syncChartRanges = async (client, vendor, symbol) => {
  const listing = parse(await client.callTool({ name: 'draw_list', arguments: {} }));
  const rectangles = (listing.shapes || []).filter(
    (shape) => String(shape.name || shape.type || '').toLowerCase() === 'rectangle',
  );
  const ranges = [];
  for (const shape of rectangles) {
    const detail = parse(await client.callTool({
      name: 'draw_get_properties',
      arguments: { entity_id: shape.id },
    }));
    const properties = detail.properties || {};
    const points = detail.points || [];
    if (
      properties.visible === false
      || points.length < 2
      || !isOrangeRangeColor(properties.color || properties.linecolor)
    ) continue;
    ranges.push({
      entity_id: String(shape.id),
      start_time: Math.min(Number(points[0].time), Number(points[1].time)),
      end_time: Math.max(Number(points[0].time), Number(points[1].time)),
      upper: Math.max(Number(points[0].price), Number(points[1].price)),
      lower: Math.min(Number(points[0].price), Number(points[1].price)),
      color: String(properties.color || properties.linecolor || ''),
    });
  }
  return storePayload('sync-chart-ranges', {
    vendor,
    symbol,
    timeframe,
    ranges,
  });
};

const transport = new StdioClientTransport({ command: process.execPath, args: ['src/server.js'], cwd: serverRoot, stderr: 'inherit' });
const client = new Client({ name: 'tvfloat-collector', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
try {
  const rightmost = parse(await client.callTool({ name: 'tab_switch_rightmost', arguments: {} }));
  if (!rightmost.success) throw new Error(`rightmost tab switch failed: ${rightmost.error || 'unknown error'}`);
  await sleep(800);
  await client.callTool({ name: 'chart_set_timeframe', arguments: { timeframe } });
  await waitForClosedBarSafetyWindow();
  const originalRange = parse(await client.callTool({ name: 'chart_get_visible_range', arguments: {} }));
  const cutoff = Math.floor(Date.now() / 1000) - 5;
  const results = [];
  for (const [vendor, symbol, full] of watchlist) {
    const latest = latestStored(vendor, symbol);
    const needsBackfill = !latest.open_time || Number(latest.bar_count || 0) < 120;
    const requestedCount = needsBackfill ? 500 : 40;
    await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: full } });
    const state = await waitForSymbol(client, full);
    const rangeSync = await syncChartRanges(client, vendor, symbol);
    if (needsBackfill) {
      await client.callTool({
        name: 'chart_set_visible_range',
        arguments: { from: cutoff - 3 * 86_400, to: cutoff },
      });
      await sleep(1600);
    }
    let payload;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      payload = parse(await client.callTool({ name: 'data_get_ohlcv', arguments: { count: requestedCount, summary: false } }));
      const last = payload.bars?.at(-1);
      if (last && plausible(symbol, last.close)) break;
      await sleep(1200);
    }
    if (!payload?.bars?.length || !plausible(symbol, payload.bars.at(-1).close)) throw new Error(`stale OHLCV returned for ${full}`);
    const bars = payload.bars.filter((bar) => bar.time + barSeconds <= cutoff);
    const ingestResults = [];
    for (let index = 0; index < bars.length; index += 40) {
      ingestResults.push(ingestBatch(vendor, symbol, bars.slice(index, index + 40)));
    }
    results.push({
      vendor,
      symbol,
      bars: bars.length,
      initial_backfill: needsBackfill,
      ingest_batches: ingestResults.length,
      ingest: ingestResults.at(-1) || {},
      chart_ranges: rangeSync,
    });
  }
  await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: 'BYBIT:BTCUSDT.P' } });
  await waitForSymbol(client, 'BYBIT:BTCUSDT.P');
  const restoreRange = originalRange.visible_range;
  if (originalRange.success && Number.isFinite(restoreRange?.from) && Number.isFinite(restoreRange?.to)) {
    await client.callTool({
      name: 'chart_set_visible_range',
      arguments: { from: restoreRange.from, to: restoreRange.to },
    });
  }
  process.stdout.write(`${JSON.stringify({ success: true, results })}\n`);
} finally {
  await client.close();
}
