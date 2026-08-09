// Fetch OANDA:XAUUSD 5m OHLCV from a target start time up to the latest
// closed bar. Uses the MCP to switch/load the chart, then CDP to read the
// full loaded bar series (data_get_ohlcv only returns the tail).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadTradingViewMcpSdk,
  resolveTradingViewMcpRoot,
} from './tradingview_mcp_runtime.mjs';

const serverRoot = resolveTradingViewMcpRoot();
const { Client, StdioClientTransport } = await loadTradingViewMcpSdk(serverRoot);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (result) => JSON.parse(result.content[0].text);

const TARGET_START = Number(process.argv[2] || 1785811800); // 2026-08-04 10:50 +08
const OUT = process.argv[3]
  || path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'xauusd_ohlcv_new_20260807.json');

async function cdpEvaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ws connect failed'));
  });
  const result = await new Promise((resolve, reject) => {
    const id = 1;
    const timer = setTimeout(() => reject(new Error('cdp evaluate timeout')), 15000);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) {
        clearTimeout(timer);
        resolve(msg);
      }
    };
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
  ws.close();
  if (result.result && result.result.exceptionDetails) {
    throw new Error('page evaluate exception: ' + JSON.stringify(result.result.exceptionDetails).slice(0, 300));
  }
  return result.result && result.result.result ? result.result.result.value : undefined;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/server.js'],
  cwd: serverRoot,
  stderr: 'inherit',
});
const client = new Client(
  { name: 'tvfloat-xau-fetch-ext', version: '1.0.0' },
  { capabilities: {} },
);

await client.connect(transport);
try {
  await client.callTool({ name: 'tab_switch_rightmost', arguments: {} });
  await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: 'OANDA:XAUUSD' } });
  await client.callTool({ name: 'chart_set_timeframe', arguments: { timeframe: '5' } });
  const now = Math.floor(Date.now() / 1000);
  await client.callTool({
    name: 'chart_set_visible_range',
    arguments: { from: TARGET_START - 3600, to: now + 600 },
  });
  await sleep(2000);

  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const symbolExpr = `(() => { try { var w = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV && window.TradingViewApi._activeChartWidgetWV.value(); return w ? String(w.symbol()||'') : null; } catch(e){ return null; } })()`;
  let target = null;
  for (const t of pages) {
    try {
      const sym = await cdpEvaluate(t.webSocketDebuggerUrl, symbolExpr);
      if (sym && sym.toUpperCase().includes('XAUUSD')) { target = t; break; }
    } catch {}
  }
  if (!target) throw new Error('no TradingView page found on XAUUSD');

  const barsExpr = `(() => {
    var w = window.TradingViewApi._activeChartWidgetWV.value();
    var m = w._chartWidget.model();
    var b = m.mainSeries().bars();
    var out = [];
    for (var i = b.firstIndex(); i <= b.lastIndex(); i++) {
      var v = b.valueAt(i);
      if (v) out.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
    }
    return out;
  })()`;
  const raw = await cdpEvaluate(target.webSocketDebuggerUrl, barsExpr);
  const bars = (raw || [])
    .filter((b) => Number(b.time) > TARGET_START - 300 && Number(b.time) + 300 <= now - 5)
    .sort((a, b) => a.time - b.time);
  fs.writeFileSync(OUT, JSON.stringify({ symbol: 'OANDA:XAUUSD', timeframe: '5', count: bars.length, bars }, null, 2));
  console.log(JSON.stringify({
    success: true,
    loaded_raw: (raw || []).length,
    bars,
    first: bars[0] && { time: bars[0].time, open: bars[0].open },
    last: bars[bars.length - 1] && { time: bars[bars.length - 1].time, close: bars[bars.length - 1].close },
    out: OUT,
  }));
} finally {
  await client.close();
}
