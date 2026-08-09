// Draw the 11 v2 causal-replay signals on TradingView as full callouts
// (direction + time + price + complete reason, no ellipsis).
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
  || path.join(root, 'outputs', 'xauusd_replay_5m_20260807_v2_deepseek', 'xauusd_replay_v2_signals.json');
const manifestPath = process.argv[3]
  || path.join(root, 'outputs', 'xauusd_replay_5m_20260807_v2_deepseek', 'xauusd_replay_v2_drawings.json');
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
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
  { name: 'tvfloat-xau-v2-draw', version: '1.0.0' },
  { capabilities: {} },
);

await client.connect(transport);
const savedFocus = focusGuard(['save']);
focusGuard(['unminimize']);
const drawings = [];
try {
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
  const rightmost = parse(await client.callTool({ name: 'tab_switch_rightmost', arguments: {} }));
  if (!rightmost.success) throw new Error(rightmost.error || 'rightmost tab switch failed');
  const before = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
  await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: 'OANDA:XAUUSD' } });
  await client.callTool({ name: 'chart_set_timeframe', arguments: { timeframe } });
  await waitForSymbol(client, 'OANDA:XAUUSD');

  const first = Math.min(...signals.map((s) => Number(s.bar_time)));
  const last = Math.max(...signals.map((s) => Number(s.bar_time)));
  await client.callTool({
    name: 'chart_set_visible_range',
    arguments: { from: first - 60 * 60, to: last + 180 * 60 },
  });
  await sleep(1800);

  for (const signal of signals) {
    const long = signal.direction === 'long';
    const dirText = long ? '做多' : '做空';
    const color = long ? '#22c55e' : '#ef4444';
    const anchor = Number(signal.anchor);
    const secondPrice = anchor + (long ? -0.8 : 0.8);
    const labelText = [
      `${dirText} ｜ ${signal.decision_time_cn}（北京时间收盘）`,
      `收盘 ${Number(signal.close).toFixed(2)} ｜ 锚点${signal.anchor_label} ${anchor.toFixed(2)}`,
      `形态：${signal.setup}`,
      `理由：${signal.reason}`,
    ].join('\n');
    const calloutArguments = {
      shape: 'callout',
      point: { time: Number(signal.bar_time), price: anchor },
      point2: { time: Number(signal.bar_time) + 8 * 300, price: secondPrice },
      text: labelText,
      overrides: JSON.stringify({
        color,
        backgroundColor: 'rgba(15,23,42,0.92)',
        bordercolor: color,
        linewidth: 1,
        fontsize: 11,
        wordWrap: true,
        wordWrapWidth: 620,
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
      key: `xauusd-v2:5:${signal.bar_time}:${signal.direction}`,
      entity_id: drawingId,
      bar_time: Number(signal.bar_time),
      direction: signal.direction,
      setup: signal.setup,
      reason: signal.reason,
    });
    await sleep(150);
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
