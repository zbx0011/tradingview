import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadTradingViewMcpSdk,
  resolveTradingViewMcpRoot,
} from './tradingview_mcp_runtime.mjs';

const serverRoot = resolveTradingViewMcpRoot();
const { Client, StdioClientTransport } = await loadTradingViewMcpSdk(serverRoot);
const replayRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'TVFloat',
  'replay-15m-5d-20260728',
);
const inputPath = process.argv[2] || path.join(replayRoot, 'replay_ranges.json');
const manifestPath = process.argv[3] || path.join(replayRoot, 'replay_range_drawings.json');
const timeframe = '15';
const barSeconds = 15 * 60;
const activeProjectionBars = 8;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (result) => JSON.parse(result.content[0].text);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storePath = path.join(projectRoot, 'realtime_signals', 'kline_store.py');
const snapshots = new Map();
const snapshotFor = (range) => {
  if (snapshots.has(range.full_symbol)) return snapshots.get(range.full_symbol);
  const value = JSON.parse(execFileSync(
    'python',
    [
      storePath,
      'snapshot',
      '--vendor', range.vendor,
      '--symbol', range.symbol,
      '--timeframe', timeframe,
      '--bars', '864',
      '--tail', '864',
    ],
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true },
  ));
  snapshots.set(range.full_symbol, value);
  return value;
};
const confirmedExitTime = (range, bars) => {
  const upper = Number(range.upper);
  const lower = Number(range.lower);
  const width = Math.max(upper - lower, 1e-9);
  let outsideDirection = '';
  let outsideCount = 0;
  let firstOutsideTime = 0;
  for (const bar of bars) {
    const [time, open, high, low, close] = bar.map(Number);
    if (time <= Number(range.end_time)) continue;
    const direction = close > upper ? 'up' : close < lower ? 'down' : '';
    if (!direction) {
      outsideDirection = '';
      outsideCount = 0;
      firstOutsideTime = 0;
      continue;
    }
    if (direction !== outsideDirection) {
      outsideDirection = direction;
      outsideCount = 1;
      firstOutsideTime = time;
    } else {
      outsideCount += 1;
    }
    const body = Math.abs(close - open);
    const closeBeyond =
      direction === 'up' ? close - upper : lower - close;
    const displacementExit =
      body >= 0.35 * width
      && closeBeyond >= 0.05 * width
      && (
        direction === 'up'
          ? close >= high - 0.25 * Math.max(high - low, 1e-9)
          : close <= low + 0.25 * Math.max(high - low, 1e-9)
      );
    if (outsideCount >= 2 || displacementExit) return firstOutsideTime;
  }
  return 0;
};

const input = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
const previous = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  : { drawings: [] };
const completed = new Map((previous.drawings || []).map((row) => [row.range_id, row]));
const ranges = input.markets.flatMap((market) => market.ranges.map((sourceRange) => {
  const range = {
    ...sourceRange,
    full_symbol: `${sourceRange.vendor}:${sourceRange.symbol}`,
  };
  let effectiveEndTime = Number(range.end_time);
  let activeAtLatest = !range.breakout;
  if (activeAtLatest) {
    const snapshot = snapshotFor(range);
    const recentBars = snapshot.recent_bars || [];
    const exitTime = confirmedExitTime(range, recentBars);
    if (exitTime) {
      effectiveEndTime = Math.max(
        Number(range.start_time),
        exitTime - barSeconds,
      );
      activeAtLatest = false;
    } else if (snapshot.to) {
      effectiveEndTime = Math.max(effectiveEndTime, Number(snapshot.to));
    }
  }
  return {
    ...range,
    effective_end_time: effectiveEndTime,
    active_at_latest: activeAtLatest,
    // Keep a live/unbroken range visibly open beyond the newest closed candle.
    // effective_end_time remains causal; draw_end_time is presentation only.
    draw_end_time:
      effectiveEndTime +
      (activeAtLatest ? activeProjectionBars * barSeconds : 0),
  };
}));
ranges.sort((a, b) => a.full_symbol.localeCompare(b.full_symbol) || a.start_time - b.start_time);
const symbolExtents = new Map();
for (const range of ranges) {
  const current = symbolExtents.get(range.full_symbol) || {
    from: Number(range.start_time),
    to: Number(range.draw_end_time),
  };
  current.from = Math.min(current.from, Number(range.start_time));
  current.to = Math.max(current.to, Number(range.draw_end_time));
  symbolExtents.set(range.full_symbol, current);
}

const waitForSymbol = async (client, symbol) => {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const state = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
    if (state.symbol === symbol && String(state.resolution) === timeframe) return;
    await sleep(500);
  }
  throw new Error(`chart did not become ready for ${symbol} ${timeframe}m`);
};
const saveManifest = () => {
  const drawings = [...completed.values()].sort(
    (a, b) => a.full_symbol.localeCompare(b.full_symbol) || a.start_time - b.start_time,
  );
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      mode: 'strict-causal-replay-ranges',
      expected_ranges: ranges.length,
      completed_drawings: drawings.length,
      updated_at: new Date().toISOString(),
      drawings,
    }, null, 2),
    'utf8',
  );
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/server.js'],
  cwd: serverRoot,
  stderr: 'inherit',
});
const client = new Client(
  { name: 'tvfloat-replay-range-drawer', version: '1.0.0' },
  { capabilities: {} },
);
await client.connect(transport);

let activeSymbol = '';
let newlyDrawn = 0;
let refreshed = 0;
try {
  const rightmost = parse(await client.callTool({ name: 'tab_switch_rightmost', arguments: {} }));
  if (!rightmost.success) throw new Error(rightmost.error || 'rightmost tab switch failed');
  for (const range of ranges) {
    const existing = completed.get(range.range_id);
    let sameGeometry = false;
    if (existing) {
      const immutableUserRange = Boolean(existing.locked || existing.manual_locked);
      sameGeometry =
        Number(existing.start_time) === Number(range.start_time)
        && Number(existing.draw_end_time ?? existing.end_time) === Number(range.draw_end_time)
        && Number(existing.upper) === Number(range.upper)
        && Number(existing.lower) === Number(range.lower);
      if (immutableUserRange) continue;
    }
    if (activeSymbol !== range.full_symbol) {
      await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: range.full_symbol } });
      await client.callTool({ name: 'chart_set_timeframe', arguments: { timeframe } });
      await waitForSymbol(client, range.full_symbol);
      const extent = symbolExtents.get(range.full_symbol);
      await client.callTool({
        name: 'chart_set_visible_range',
        arguments: {
          from: extent.from - 12 * 60 * 60,
          to: extent.to + 12 * 60 * 60,
        },
      });
      await sleep(900);
      activeSymbol = range.full_symbol;
    }
    if (existing) {
      const properties = parse(await client.callTool({
        name: 'draw_get_properties',
        arguments: { entity_id: existing.entity_id },
      }));
      const points = properties.points || [];
      const times = points.map((point) => Number(point.time)).sort((a, b) => a - b);
      const prices = points.map((point) => Number(point.price)).sort((a, b) => a - b);
      const userChangedGeometry =
        properties.success
        && (
          times[0] !== Number(existing.start_time)
          || Math.abs(prices[0] - Number(existing.lower)) > 1e-7
          || Math.abs(prices[prices.length - 1] - Number(existing.upper)) > 1e-7
        );
      if (userChangedGeometry) {
        completed.set(range.range_id, {
          ...existing,
          start_time: times[0],
          draw_end_time: times[times.length - 1],
          lower: prices[0],
          upper: prices[prices.length - 1],
          locked: true,
          manual_locked: true,
          source: 'manual_chart_edit',
        });
        saveManifest();
        continue;
      }
      // The replay input and manifest may agree while the user has moved the
      // live rectangle.  Therefore this shortcut is safe only after reading
      // and comparing the live TradingView geometry above.
      if (sameGeometry) continue;
      const removed = parse(await client.callTool({
        name: 'draw_remove_one',
        arguments: { entity_id: existing.entity_id },
      }));
      if (!removed.success) {
        throw new Error(
          `unable to refresh active range ${range.range_id}: ${removed.error || 'unknown'}`,
        );
      }
      completed.delete(range.range_id);
      refreshed += 1;
    }
    const drawn = parse(await client.callTool({
      name: 'draw_shape',
      arguments: {
        shape: 'rectangle',
        point: { time: Number(range.start_time), price: Number(range.upper) },
        point2: { time: Number(range.draw_end_time), price: Number(range.lower) },
        overrides: JSON.stringify({
          color: '#f59e0b',
          linewidth: 2,
          fillBackground: true,
          backgroundColor: 'rgba(245,158,11,0.16)',
          transparency: 50,
        }),
      },
    }));
    if (!drawn.success || !drawn.entity_id) {
      throw new Error(`range draw failed for ${range.range_id}: ${drawn.error || 'unknown'}`);
    }
    const props = parse(await client.callTool({
      name: 'draw_get_properties',
      arguments: { entity_id: drawn.entity_id },
    }));
    const points = props.points || [];
    const pointTimes = points.map((point) => Number(point.time)).sort((a, b) => a - b);
    const pointPrices = points.map((point) => Number(point.price)).sort((a, b) => a - b);
    if (
      !props.success
      || pointTimes[0] !== Number(range.start_time)
      || pointTimes[pointTimes.length - 1] !== Number(range.draw_end_time)
      || Math.abs(pointPrices[0] - Number(range.lower)) > 1e-7
      || Math.abs(pointPrices[pointPrices.length - 1] - Number(range.upper)) > 1e-7
    ) {
      throw new Error(`range verification failed for ${range.range_id}`);
    }
    completed.set(range.range_id, {
      ...range,
      entity_id: drawn.entity_id,
      color: '#f59e0b',
      source: 'strict_causal_replay_auto',
      user_editable: true,
    });
    newlyDrawn += 1;
    saveManifest();
  }
} finally {
  try {
    await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: 'BYBIT:BTCUSDT.P' } });
    await client.callTool({ name: 'chart_set_timeframe', arguments: { timeframe } });
  } catch {}
  await client.close();
}
saveManifest();
process.stdout.write(`${JSON.stringify({
  success: true,
  expected: ranges.length,
  completed: completed.size,
  newly_drawn: newlyDrawn,
  refreshed,
  manifest: manifestPath,
})}\n`);
