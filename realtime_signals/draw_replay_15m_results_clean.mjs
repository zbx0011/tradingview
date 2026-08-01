import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadTradingViewMcpSdk,
  resolveTradingViewMcpRoot,
} from './tradingview_mcp_runtime.mjs';

const serverRoot = resolveTradingViewMcpRoot();
const { Client, StdioClientTransport } = await loadTradingViewMcpSdk(serverRoot);
const defaultReplayRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'TVFloat',
  'replay-15m-5d-20260728',
  'ai_reviews',
);
const inputPath = process.argv[2] || path.join(defaultReplayRoot, 'review_results.json');
const manifestPath = process.argv[3] || path.join(defaultReplayRoot, 'replay_drawings.json');
const timeframe = '15';
const barSeconds = 15 * 60;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (result) => JSON.parse(result.content[0].text);

const review = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
const prior = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  : { version: 1, drawings: [] };
const completed = new Map((prior.drawings || []).map((row) => [row.key, row]));

const signals = [];
for (const market of review.markets || []) {
  for (const record of market.results || []) {
    if (record.final_decision?.verdict !== 'SIGNAL') continue;
    signals.push({
      ...record,
      fullSymbol: `${record.vendor}:${record.symbol}`,
      decision: record.final_decision,
    });
  }
}
signals.sort(
  (a, b) => a.fullSymbol.localeCompare(b.fullSymbol) || a.bar_time - b.bar_time,
);

const shortText = (value, maximum) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
};

const waitForSymbol = async (client, symbol) => {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const state = parse(
      await client.callTool({ name: 'chart_get_state', arguments: {} }),
    );
    if (state.symbol === symbol && String(state.resolution) === timeframe) return;
    await sleep(500);
  }
  throw new Error(`chart did not become ready for ${symbol} ${timeframe}m`);
};

const saveManifest = () => {
  const drawings = [...completed.values()].sort(
    (a, b) =>
      a.full_symbol.localeCompare(b.full_symbol) || a.bar_time - b.bar_time,
  );
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        version: 2,
        mode: 'strict-causal-15m-replay-clean-callout',
        input: inputPath,
        expected_signals: signals.length,
        completed_drawings: drawings.length,
        updated_at: new Date().toISOString(),
        drawings,
      },
      null,
      2,
    ),
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
  { name: 'tvfloat-replay-result-drawer-clean', version: '2.0.0' },
  { capabilities: {} },
);
await client.connect(transport);

const results = [];
try {
  const rightmost = parse(
    await client.callTool({ name: 'tab_switch_rightmost', arguments: {} }),
  );
  if (!rightmost.success) {
    throw new Error(rightmost.error || 'rightmost tab switch failed');
  }

  let activeSymbol = '';
  const symbolOrdinals = new Map();
  for (const signal of signals) {
    if (completed.has(signal.key)) {
      results.push({
        key: signal.key,
        skipped: true,
        entity_id: completed.get(signal.key).entity_id,
      });
      continue;
    }
    if (activeSymbol !== signal.fullSymbol) {
      await client.callTool({
        name: 'chart_set_symbol',
        arguments: { symbol: signal.fullSymbol },
      });
      await client.callTool({
        name: 'chart_set_timeframe',
        arguments: { timeframe },
      });
      await waitForSymbol(client, signal.fullSymbol);
      activeSymbol = signal.fullSymbol;
    }

    const ordinal = (symbolOrdinals.get(signal.fullSymbol) || 0) + 1;
    symbolOrdinals.set(signal.fullSymbol, ordinal);
    const decision = signal.decision;
    const isLong = decision.direction === 'long';
    const directionText = isLong ? '多头' : '空头';
    const color = isLong ? '#22c55e' : '#ef4444';
    const signalPrice = Number(
      signal.render?.outer?.close ?? signal.close ?? decision.confirmation_price,
    );
    const invalidation = Number(decision.invalidation_price);
    const denseSignalCluster = signals.some(
      (other) =>
        other.key !== signal.key &&
        other.fullSymbol === signal.fullSymbol &&
        Math.abs(Number(other.bar_time) - Number(signal.bar_time)) <=
          2 * barSeconds,
    );
    const baseOffset = Math.max(
      Math.abs(invalidation - signalPrice) * 0.55,
      Math.abs(signalPrice) * 0.0018,
    );
    const offset = baseOffset * (denseSignalCluster ? 4 : 1);
    const secondPrice = signalPrice + (isLong ? -offset : offset);
    // Alternate callout boxes to the left/right so adjacent opposite signals
    // (for example, an edge reclaim followed by an immediate breakout) remain
    // independently readable instead of stacking on top of each other.
    const horizontalBars = 6 + (ordinal % 3) * 2;
    const horizontalDirection = ordinal % 2 === 1 ? -1 : 1;
    const dateText = String(signal.beijing || '').slice(5);
    const title =
      `TVF #${String(ordinal).padStart(2, '0')}｜${signal.symbol}｜15m｜` +
      `${directionText}${decision.grade}｜${dateText}`;
    const text = [
      `${decision.grade}级 ${directionText}｜${decision.setup_type}`,
      `北京时间 ${signal.beijing}｜收盘 ${signalPrice}`,
      `位置：${shortText(decision.location_summary, 54)}`,
      `结构：${shortText(decision.structure_summary, 68)}`,
      `理由：${shortText((decision.reasons || [])[0], 100)}`,
      `确认 ${decision.confirmation_price}｜失效 ${decision.invalidation_price}`,
    ].join('\n');
    const drawing = parse(
      await client.callTool({
        name: 'draw_shape',
        arguments: {
          shape: 'callout',
          point: { time: Number(signal.bar_time), price: signalPrice },
          point2: {
            time:
              Number(signal.bar_time) +
              horizontalDirection * horizontalBars * barSeconds,
            price: secondPrice,
          },
          text,
          overrides: JSON.stringify({
            title,
            color,
            backgroundColor: 'rgba(15,23,42,0.92)',
            bordercolor: color,
            linewidth: 1,
            fontsize: 11,
            wordWrap: true,
            wordWrapWidth: 300,
          }),
        },
      }),
    );
    if (!drawing.success || !drawing.entity_id) {
      throw new Error(
        `draw_shape failed for ${signal.key}: ${drawing.error || 'unknown'}`,
      );
    }
    const props = parse(
      await client.callTool({
        name: 'draw_get_properties',
        arguments: { entity_id: drawing.entity_id },
      }),
    );
    if (
      !props.success ||
      props.properties?.text !== text ||
      props.properties?.wordWrap !== true ||
      Number(props.properties?.wordWrapWidth) !== 300
    ) {
      throw new Error(`drawing verification failed for ${signal.key}`);
    }
    const row = {
      key: signal.key,
      entity_id: drawing.entity_id,
      title,
      vendor: signal.vendor,
      symbol: signal.symbol,
      full_symbol: signal.fullSymbol,
      timeframe,
      bar_time: Number(signal.bar_time),
      beijing: signal.beijing,
      direction: decision.direction,
      grade: decision.grade,
      setup_type: decision.setup_type,
    };
    completed.set(signal.key, row);
    results.push({ key: signal.key, success: true, entity_id: drawing.entity_id });
    saveManifest();
  }
} finally {
  await client.close();
}

saveManifest();
process.stdout.write(
  `${JSON.stringify({
    success: true,
    expected: signals.length,
    completed: completed.size,
    newly_drawn: results.filter((row) => row.success).length,
    skipped: results.filter((row) => row.skipped).length,
    manifest: manifestPath,
  })}\n`,
);
