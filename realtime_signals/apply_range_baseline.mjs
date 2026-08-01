// Apply source-rule visual range candidates to the rightmost TradingView
// tab. User-created/edited/deleted orange rectangles always win.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
const baselinePath = process.argv[2]
  || `${process.env.LOCALAPPDATA}/TVFloat/visual_baseline.json`;
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const timeframe = '5';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (result) => JSON.parse(result.content[0].text);
const fullSymbol = (vendor, symbol) => `${vendor}:${symbol}`;
const storePayload = (command, payload) => {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return JSON.parse(execFileSync(
    'python',
    ['realtime_signals/kline_store.py', command, '--payload-base64', encoded],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  ));
};
const waitForSymbol = async (client, full) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
    if (state.symbol === full && String(state.resolution) === timeframe) return;
    await sleep(700);
  }
  throw new Error(`range drawing chart switch failed for ${full} ${timeframe}m`);
};
const rangesOverlap = (candidate, record) => (
  Number(candidate.start_time) <= Number(record.end_time)
  && Number(candidate.end_time) >= Number(record.start_time)
  && Number(candidate.lower) <= Number(record.upper)
  && Number(candidate.upper) >= Number(record.lower)
);
const geometryExact = (candidate, record) => (
  Number(candidate.start_time) === Number(record.start_time)
  && Number(candidate.end_time) === Number(record.end_time)
  && Number(candidate.upper) === Number(record.upper)
  && Number(candidate.lower) === Number(record.lower)
);
const syncActiveRecords = (market, records) => storePayload('sync-chart-ranges', {
  vendor: market.vendor,
  symbol: market.symbol,
  timeframe,
  ranges: records
    .filter((record) => record.status === 'active')
    .map((record) => ({
      entity_id: record.entity_id,
      start_time: Number(record.start_time),
      end_time: Number(record.end_time),
      upper: Number(record.upper),
      lower: Number(record.lower),
      color: record.color || '#f59e0b',
    })),
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/server.js'],
  cwd: serverRoot,
  stderr: 'inherit',
});
const client = new Client(
  { name: 'tvfloat-range-baseline', version: '1.0.0' },
  { capabilities: {} },
);
await client.connect(transport);
const results = [];
try {
  const rightmost = parse(await client.callTool({
    name: 'tab_switch_rightmost',
    arguments: {},
  }));
  if (!rightmost.success) throw new Error('unable to select rightmost TradingView tab');
  await client.callTool({ name: 'chart_set_timeframe', arguments: { timeframe } });

  for (const market of baseline.markets || []) {
    const affirmedAutoRanges = (market.range_candidates || []).filter(
      (item) => ['auto_existing', 'auto_candidate'].includes(item.source)
        && Number(item.end_time) > Number(item.start_time)
        && Number(item.upper) > Number(item.lower),
    );
    const candidates = affirmedAutoRanges.filter(
      (item) => item.source === 'auto_candidate'
    );
    const records = storePayload('range-records', {
      vendor: market.vendor,
      symbol: market.symbol,
      timeframe,
      include_deleted: true,
    });
    const full = fullSymbol(market.vendor, market.symbol);
    await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: full } });
    await waitForSymbol(client, full);
    const visible = parse(await client.callTool({
      name: 'chart_get_visible_range', arguments: {},
    }));
    const visibleRight = Number(visible.visible_range?.to);

    // An AUTO range inside the reviewed 36-hour panel survives only when the
    // exact-OHLC gate and visual review both affirm it.  Missing drawings are
    // harmless: the database record is still tombstoned so it cannot reappear.
    const panelStart = Number(market.through_bar_time) - (36 * 60 * 60);
    const staleUnprovenAutos = records.filter(
      (record) => record.status === 'active'
        && record.source === 'auto'
        && Number(record.end_time) >= panelStart
        && !affirmedAutoRanges.some((candidate) => geometryExact(candidate, record)),
    );
    for (const record of staleUnprovenAutos) {
      const removed = parse(await client.callTool({
        name: 'draw_remove_one',
        arguments: { entity_id: record.entity_id },
      }));
      if (!removed.success && !String(removed.error || '').includes('no such shape')) {
        throw new Error(`unable to remove unproven auto range ${record.entity_id}`);
      }
      record.status = 'deleted';
      results.push({
        vendor: market.vendor,
        symbol: market.symbol,
        action: 'removed_unproven_auto',
        entity_id: record.entity_id,
      });
    }
    if (staleUnprovenAutos.length) {
      syncActiveRecords(market, records);
    }

    for (const candidate of candidates) {
      const drawnEndTime = candidate.status === 'active' && Number.isFinite(visibleRight)
        ? visibleRight
        : Number(candidate.end_time);
      const userOverlaps = records.filter((record) => rangesOverlap(candidate, record)
        && (record.source === 'manual' || Number(record.locked) === 1));
      if (userOverlaps.some((record) => record.status === 'active')) {
        results.push({
          vendor: market.vendor,
          symbol: market.symbol,
          action: 'skipped_existing_or_user_veto',
          range: candidate,
        });
        continue;
      }
      const matchingAuto = records.find(
        (record) => record.status === 'active'
          && record.source === 'auto'
          && geometryExact(candidate, record),
      );
      if (matchingAuto) {
        results.push({
          vendor: market.vendor,
          symbol: market.symbol,
          action: 'skipped_matching_auto',
          range: candidate,
        });
        continue;
      }
      if (userOverlaps.some((record) => record.status === 'deleted')) {
        results.push({
          vendor: market.vendor,
          symbol: market.symbol,
          action: 'skipped_user_veto',
          range: candidate,
        });
        continue;
      }
      const drawn = parse(await client.callTool({
        name: 'draw_shape',
        arguments: {
          shape: 'rectangle',
          point: {
            time: Number(candidate.start_time),
            price: Number(candidate.upper),
          },
          point2: {
            time: drawnEndTime,
            price: Number(candidate.lower),
          },
          overrides: JSON.stringify({
            color: '#f59e0b',
            linewidth: 2,
            fillBackground: true,
            backgroundColor: 'rgba(245, 158, 11, 0.18)',
            transparency: 50,
          }),
        },
      }));
      if (!drawn.success || !drawn.entity_id) {
        throw new Error(`range draw failed for ${full}`);
      }
      const saved = storePayload('save-auto-range', {
        vendor: market.vendor,
        symbol: market.symbol,
        timeframe,
        entity_id: drawn.entity_id,
        start_time: Number(candidate.start_time),
        end_time: drawnEndTime,
        upper: Number(candidate.upper),
        lower: Number(candidate.lower),
        color: '#f59e0b',
      });
      records.push({
        ...candidate,
        entity_id: drawn.entity_id,
        source: 'auto',
        status: 'active',
        color: '#f59e0b',
      });
      results.push({
        vendor: market.vendor,
        symbol: market.symbol,
        action: 'drawn',
        entity_id: drawn.entity_id,
        saved,
      });
    }
  }
  await client.callTool({
    name: 'chart_set_symbol',
    arguments: { symbol: 'BYBIT:BTCUSDT.P' },
  });
  await waitForSymbol(client, 'BYBIT:BTCUSDT.P');
  process.stdout.write(`${JSON.stringify({ success: true, results })}\n`);
} finally {
  await client.close();
}
