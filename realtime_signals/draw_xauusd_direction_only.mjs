// Draw XAUUSD causal-replay signals on TradingView as direction-only callouts.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
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
const inputPath = process.argv[2]
  || path.join(root, 'outputs', 'xauusd_replay_5m_20260806_causal_sol_xhigh', 'xauusd_replay_signals_520bars.json');
const manifestPath = process.argv[3]
  || path.join(root, 'outputs', 'xauusd_replay_5m_20260806_causal_sol_xhigh', 'xauusd_replay_drawings_520bars.json');
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

const signals = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, '')).signals;
if (!Array.isArray(signals) || signals.length === 0) {
  throw new Error(`no signals in ${inputPath}`);
}

const waitForSymbol = async (client, full) => {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const state = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
    if (state.symbol === full && String(state.resolution) === timeframe) return;
    await sleep(500);
  }
  throw new Error(`chart did not become ready for ${full} ${timeframe}m`);
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/server.js'],
  cwd: serverRoot,
  stderr: 'inherit',
});
const client = new Client(
  { name: 'tvfloat-xau-direction-draw', version: '1.0.0' },
  { capabilities: {} },
);

await client.connect(transport);
const savedFocus = focusGuard(['save']);
focusGuard(['unminimize']);
const drawings = [];
try {
  const rightmost = parse(await client.callTool({ name: 'tab_switch_rightmost', arguments: {} }));
  if (!rightmost.success) throw new Error(rightmost.error || 'rightmost tab switch failed');
  const before = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
  await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: 'OANDA:XAUUSD' } });
  await waitForSymbol(client, 'OANDA:XAUUSD');
  await client.callTool({ name: 'chart_set_timeframe', arguments: { timeframe } });
  await waitForSymbol(client, 'OANDA:XAUUSD');

  const first = Math.min(...signals.map((s) => Number(s.bar_time)));
  const last = Math.max(...signals.map((s) => Number(s.bar_time)));
  await client.callTool({
    name: 'chart_set_visible_range',
    arguments: { from: first - 30 * 60, to: last + 90 * 60 },
  });
  await sleep(1800);

  // Remove this script's previous annotations first (recorded in the manifest).
  if (fs.existsSync(manifestPath)) {
    const prior = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const priorDrawings = prior.drawings || [];
    for (const row of priorDrawings) {
      if (!row.entity_id) continue;
      try {
        await client.callTool({
          name: 'draw_remove_one',
          arguments: { entity_id: row.entity_id },
        });
      } catch {}
    }
    process.stdout.write(`${JSON.stringify({ cleared: priorDrawings.length })}\n`);
  }

  for (const signal of signals) {
    const long = signal.direction === 'long';
    const shape = long ? 'arrow_up' : 'arrow_down';
    const color = long ? '#22c55e' : '#ef4444';
    const anchorPrice = Number(signal.signal_price);
    const calloutArguments = {
      shape,
      point: { time: Number(signal.bar_time), price: anchorPrice },
      overrides: JSON.stringify({
        color,
        linewidth: 1,
      }),
    };
    let drawingId = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const drawing = parse(await client.callTool({
        name: 'draw_shape',
        arguments: calloutArguments,
      }));
      if (drawing.success && drawing.entity_id) {
        drawingId = drawing.entity_id;
        break;
      }
      await sleep(250);
    }
    if (!drawingId) {
      throw new Error(`draw failed for ${signal.bar_time}: ${JSON.stringify(signal)}`);
    }
    drawings.push({
      key: `xauusd:5:${signal.bar_time}:${signal.direction}`,
      entity_id: drawingId,
      bar_time: Number(signal.bar_time),
      direction: signal.direction,
      signal_price: anchorPrice,
      shape,
    });
    await sleep(120);
  }
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        version: 1,
        symbol: 'OANDA:XAUUSD',
        timeframe: '5',
        updated_at: new Date().toISOString(),
        before: { symbol: before.symbol, resolution: before.resolution },
        drawings,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`${JSON.stringify({ success: true, drawn: drawings.length, manifest: manifestPath })}\n`);
} finally {
  await client.close();
  if (savedFocus?.hwnd) focusGuard(['restore', String(savedFocus.hwnd)]);
}
