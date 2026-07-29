// Apply high-confidence visual range candidates to the rightmost TradingView
// tab. User-created/edited/deleted orange rectangles always win.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client } from 'file:///C:/Users/zbx00/tools/tradingview-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from 'file:///C:/Users/zbx00/tools/tradingview-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

if (process.platform === 'win32' && !('type' in process)) {
  process.type = 'tvfloat-background';
}

const root = 'C:/Users/zbx00/OneDrive/private/文档/1111';
const serverRoot = 'C:/Users/zbx00/tools/tradingview-mcp';
const baselinePath = process.argv[2]
  || `${process.env.LOCALAPPDATA}/TVFloat/visual_baseline.json`;
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const timeframe = '15';
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
const overlapRatio = (a1, a2, b1, b2) => {
  const overlap = Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
  return overlap / Math.max(1e-9, Math.min(a2 - a1, b2 - b1));
};
const sameRange = (candidate, record) => (
  overlapRatio(
    Number(candidate.start_time),
    Number(candidate.end_time),
    Number(record.start_time),
    Number(record.end_time),
  ) >= 0.55
  && overlapRatio(
    Number(candidate.lower),
    Number(candidate.upper),
    Number(record.lower),
    Number(record.upper),
  ) >= 0.55
);
const geometryClose = (candidate, record) => {
  const candidateWidth = Math.max(
    1e-9,
    Number(candidate.upper) - Number(candidate.lower),
  );
  const recordWidth = Math.max(
    1e-9,
    Number(record.upper) - Number(record.lower),
  );
  const priceTolerance = 0.12 * Math.max(candidateWidth, recordWidth);
  return Math.abs(Number(candidate.start_time) - Number(record.start_time)) <= 900
    && Math.abs(Number(candidate.end_time) - Number(record.end_time)) <= 900
    && Math.abs(Number(candidate.upper) - Number(record.upper)) <= priceTolerance
    && Math.abs(Number(candidate.lower) - Number(record.lower)) <= priceTolerance;
};
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
    const candidates = (market.range_candidates || []).filter(
      (item) => item.source === 'auto_candidate'
        && Number(item.confidence) >= 0.75
        && Number(item.end_time) > Number(item.start_time)
        && Number(item.upper) > Number(item.lower),
    );
    if (!candidates.length) continue;
    const records = storePayload('range-records', {
      vendor: market.vendor,
      symbol: market.symbol,
      timeframe,
      include_deleted: true,
    });
    const full = fullSymbol(market.vendor, market.symbol);
    await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: full } });
    await waitForSymbol(client, full);

    for (const candidate of candidates) {
      // A deleted overlap is a user veto. Manual/locked ranges always win.
      const overlapping = records.filter((record) => sameRange(candidate, record));
      if (overlapping.some((record) => record.status === 'active'
        && (record.source === 'manual' || Number(record.locked) === 1))) {
        results.push({
          vendor: market.vendor,
          symbol: market.symbol,
          action: 'skipped_existing_or_user_veto',
          range: candidate,
        });
        continue;
      }
      const matchingAuto = overlapping.find(
        (record) => record.status === 'active'
          && record.source === 'auto'
          && geometryClose(candidate, record),
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
      if (overlapping.some((record) => record.status === 'deleted')) {
        results.push({
          vendor: market.vendor,
          symbol: market.symbol,
          action: 'skipped_user_veto',
          range: candidate,
        });
        continue;
      }
      const replaceableAutos = overlapping.filter(
        (record) => record.status === 'active'
          && record.source === 'auto'
          && !geometryClose(candidate, record),
      );
      for (const record of replaceableAutos) {
        const removed = parse(await client.callTool({
          name: 'draw_remove_one',
          arguments: { entity_id: record.entity_id },
        }));
        if (!removed.success) {
          throw new Error(`unable to replace stale auto range ${record.entity_id}`);
        }
        record.status = 'deleted';
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
            time: Number(candidate.end_time),
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
        end_time: Number(candidate.end_time),
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
      if (replaceableAutos.length) {
        syncActiveRecords(market, records);
      }
      results.push({
        vendor: market.vendor,
        symbol: market.symbol,
        action: replaceableAutos.length ? 'replaced_stale_auto' : 'drawn',
        entity_id: drawn.entity_id,
        replaced_entity_ids: replaceableAutos.map((record) => record.entity_id),
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
