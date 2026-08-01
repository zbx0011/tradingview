// Keep TradingView price alerts aligned with active orange range rectangles.
// Price alerts are on_first_fire, so an alert that fired during the previous
// bar is re-armed after that 5-minute close while the range remains valid.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (result) => JSON.parse(result.content[0].text);
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, values) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
    return pairs;
  }, []),
);
const input = args.input || path.join(process.env.LOCALAPPDATA, 'TVFloat', 'range_edge_alert_plan.json');
if (!fs.existsSync(input)) throw new Error(`range edge plan not found: ${input}`);
const plan = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));

const store = (command, body = null) => {
  const commandArgs = ['realtime_signals/kline_store.py', command];
  if (body !== null) {
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
    commandArgs.push('--payload-base64', encoded);
  }
  return JSON.parse(execFileSync(
    'python',
    commandArgs,
    { cwd: root, encoding: 'utf8', windowsHide: true },
  ));
};
const keyOf = (item) => `${item.range_id}:${item.side}`;
const waitForSymbol = async (client, symbol) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
    if (state.symbol === symbol && String(state.resolution) === timeframe) return state;
    await sleep(600);
  }
  const state = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
  throw new Error(
    `chart did not become ready: expected ${symbol} ${timeframe}m, `
      + `got ${state.symbol} ${state.resolution}m`,
  );
};
const compactPrice = (value) => Number(value).toLocaleString('en-US', {
  maximumFractionDigits: 6,
  useGrouping: false,
});

if (args['validate-only'] === 'true') {
  process.stdout.write(`${JSON.stringify({
    success: true,
    validated: true,
    desired: (plan.desired || []).length,
    tracked: (plan.tracked || []).length,
  })}\n`);
  process.exit(0);
}

const desiredByKey = new Map((plan.desired || []).map((item) => [keyOf(item), item]));
const trackedByKey = new Map((plan.tracked || []).map((item) => [keyOf(item), item]));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/server.js'],
  cwd: serverRoot,
  stderr: 'inherit',
});
const client = new Client(
  { name: 'tvfloat-range-edge-alerts', version: '1.0.0' },
  { capabilities: {} },
);
await client.connect(transport);
const results = [];
let currentSymbol = null;
try {
  const rightmost = parse(await client.callTool({ name: 'tab_switch_rightmost', arguments: {} }));
  if (!rightmost.success) {
    throw new Error(`rightmost tab switch failed: ${rightmost.error || 'unknown error'}`);
  }
  await sleep(500);
  // Required by the TradingView workflow: read and cache state once at start.
  const initialState = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
  currentSymbol = initialState.symbol;
  const listed = parse(await client.callTool({ name: 'alert_list', arguments: {} }));
  if (!listed.success) throw new Error(listed.error || 'alert_list failed');
  const activeById = new Map(
    (listed.alerts || []).map((alert) => [String(alert.alert_id), Boolean(alert.active)]),
  );

  // A deleted, expired, manually removed, or breakout-invalidated rectangle
  // must not leave a live edge alert behind.
  for (const [key, tracked] of trackedByKey) {
    if (desiredByKey.has(key)) continue;
    if (tracked.status === 'cancelled' && tracked.tradingview_alert_id == null) continue;
    const oldId = tracked.tradingview_alert_id == null
      ? null
      : String(tracked.tradingview_alert_id);
    let status = 'cancelled';
    if (oldId && activeById.get(oldId) === true) {
      try {
        const removed = parse(await client.callTool({
          name: 'alert_delete',
          arguments: { alert_id: Number(oldId) },
        }));
        if (!removed.success) throw new Error(removed.error || 'alert_delete failed');
      } catch (error) {
        status = 'cancel_failed';
        results.push({ key, action: status, error: String(error.message || error) });
      }
    }
    store('upsert-range-edge-alert', {
      ...tracked,
      tradingview_alert_id: status === 'cancelled' ? null : oldId,
      status,
    });
    if (status === 'cancelled') results.push({ key, action: 'cancelled' });
  }

  for (const [key, desired] of desiredByKey) {
    const tracked = trackedByKey.get(key);
    const oldId = tracked?.tradingview_alert_id == null
      ? null
      : String(tracked.tradingview_alert_id);
    const sameGeometry = tracked
      && Number(tracked.range_updated_at) === Number(desired.range_updated_at)
      && tracked.condition === desired.condition
      && Number(tracked.threshold) === Number(desired.threshold);
    if (sameGeometry && oldId && activeById.get(oldId) === true) {
      results.push({ key, action: 'kept', alert_id: oldId });
      continue;
    }

    // Manual rectangle edits replace the old threshold.  A fired alert is
    // already inactive and simply gets re-armed for the next candle.
    if (oldId && activeById.get(oldId) === true) {
      const removed = parse(await client.callTool({
        name: 'alert_delete',
        arguments: { alert_id: Number(oldId) },
      }));
      if (!removed.success) {
        store('upsert-range-edge-alert', {
          ...desired,
          tradingview_alert_id: oldId,
          status: 'replace_failed',
        });
        results.push({ key, action: 'replace_failed', error: removed.error || 'alert_delete failed' });
        continue;
      }
    }

    if (currentSymbol !== desired.full_symbol) {
      await client.callTool({
        name: 'chart_set_symbol',
        arguments: { symbol: desired.full_symbol },
      });
      await client.callTool({
        name: 'chart_set_timeframe',
        arguments: { timeframe },
      });
      await waitForSymbol(client, desired.full_symbol);
      currentSymbol = desired.full_symbol;
    }
    const sideText = desired.side === 'lower' ? '震荡下1/8' : '震荡上1/8';
    const operator = desired.side === 'lower' ? '≤' : '≥';
    const message = `${desired.symbol}｜${sideText}｜${operator}${compactPrice(desired.threshold)}`;
    try {
      const created = parse(await client.callTool({
        name: 'alert_create',
        arguments: {
          price: Number(desired.threshold),
          condition: desired.condition,
          message,
        },
      }));
      if (!created.success) throw new Error(created.error || 'alert_create failed');
      const alertId = created.alert_id ?? created.id ?? created.alertId;
      if (alertId == null) throw new Error('alert_create returned no alert id');
      store('upsert-range-edge-alert', {
        ...desired,
        tradingview_alert_id: String(alertId),
        status: sameGeometry ? 'rearmed' : 'created',
      });
      results.push({
        key,
        action: sameGeometry ? 'rearmed' : 'created',
        alert_id: String(alertId),
      });
    } catch (error) {
      store('upsert-range-edge-alert', {
        ...desired,
        tradingview_alert_id: null,
        status: 'failed',
      });
      results.push({ key, action: 'failed', error: String(error.message || error) });
    }
  }
} finally {
  try {
    await client.callTool({
      name: 'chart_set_symbol',
      arguments: { symbol: 'BYBIT:BTCUSDT.P' },
    });
    await client.callTool({
      name: 'chart_set_timeframe',
      arguments: { timeframe },
    });
  } catch {}
  await client.close();
}

const failed = results.filter((item) => item.action.endsWith('failed'));
process.stdout.write(`${JSON.stringify({
  success: failed.length === 0,
  desired: desiredByKey.size,
  created: results.filter((item) => item.action === 'created').length,
  rearmed: results.filter((item) => item.action === 'rearmed').length,
  kept: results.filter((item) => item.action === 'kept').length,
  cancelled: results.filter((item) => item.action === 'cancelled').length,
  failed,
})}\n`);
if (failed.length) process.exitCode = 1;
