// louie规则监控（20260806版本）
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
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
const focusPython = fs.existsSync(path.join(root, '.venv', 'Scripts', 'python.exe'))
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : 'python';
const focusGuard = (args) => {
  try {
    const output = execFileSync(
      focusPython,
      [path.join(scriptDir, 'focus_guard.py'), ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    );
    const lines = output.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
};
const queueExcelExport = () => {
  try {
    const child = spawn(
      'wscript.exe',
      [
        `${root}/realtime_signals/run_hidden.vbs`,
        'export_signals_excel.ps1',
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.unref();
  } catch {
    // Signal processing must not fail just because the optional Excel refresh
    // could not be queued. The exporter writes its own durable error log.
  }
};
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, values) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
    return pairs;
  }, []),
);
if (!args.input && !args['payload-base64']) {
  throw new Error('execute_signal requires --input or --payload-base64');
}
const deadlineEpoch = Number(args['deadline-epoch'] || 0);
const payload = args['payload-base64']
  ? JSON.parse(Buffer.from(args['payload-base64'], 'base64').toString('utf8'))
  : JSON.parse(fs.readFileSync(args.input, 'utf8').replace(/^\uFEFF/, ''));
const { candidate, decision } = payload;
const fullSymbol = `${candidate.vendor}:${candidate.symbol}`;
const timeframe = '5';
const barSeconds = 5 * 60;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (result) => JSON.parse(result.content[0].text);
const checkDeadline = (reserve = 0) => {
  if (deadlineEpoch && Date.now() / 1000 + reserve >= deadlineEpoch) {
    throw new Error(`execution deadline reached; reserve=${reserve}s`);
  }
};
const store = (command, body) => {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  const output = execFileSync(
    'python',
    ['realtime_signals/kline_store.py', command, '--payload-base64', encoded],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  return JSON.parse(output);
};
const validateDecision = () => {
  if (decision.verdict !== 'SIGNAL') throw new Error('executor received non-signal decision');
  if (!['long', 'short'].includes(decision.direction)) throw new Error('invalid direction');
  if ((decision.grade ?? 'none') !== 'none') throw new Error('XAU replay rules do not use grades');
  if (!Array.isArray(decision.reasons) || decision.reasons.length === 0) throw new Error('missing reasons');
  const allowedSetups = new Set([
    '震荡内部：边缘反向',
    '震荡突破：位移突破',
    '宽通道边缘：反向波段',
    '宽通道突破：更大级别反转',
    '宽通道顺势：在有利边缘跟随主方向',
    '窄通道：等待回踩顺势参与',
  ]);
  if (!allowedSetups.has(decision.setup_type)) throw new Error('invalid setup type');
  const close = Number(candidate.close);
  const confirmation = Number(decision.confirmation_price);
  const invalidation = Number(decision.invalidation_price);
  if (decision.direction === 'long' && !(confirmation >= close && invalidation < close)) {
    throw new Error('invalid long confirmation/invalidation levels');
  }
  if (decision.direction === 'short' && !(confirmation <= close && invalidation > close)) {
    throw new Error('invalid short confirmation/invalidation levels');
  }
};
const waitForSymbol = async (client, symbol) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
    if (state.symbol === symbol && String(state.resolution) === timeframe) return;
    await sleep(500);
  }
  throw new Error(`chart did not become ready for ${symbol} ${timeframe}m`);
};
const shortText = (value, maximum) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
};
const nearlyEqual = (left, right) => {
  const expected = Number(right);
  const actual = Number(left);
  const tolerance = Math.max(1e-8, Math.abs(expected) * 1e-10);
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
};
const calloutVerificationIssues = (detail, expected) => {
  const issues = [];
  const properties = detail?.properties || {};
  const points = Array.isArray(detail?.points) ? detail.points : [];
  const hasPoint = (point) => points.some(
    (actual) => Number(actual.time) === Number(point.time)
      && nearlyEqual(actual.price, point.price),
  );
  // TradingView can normalize a callout's second timestamp when it is placed
  // into future whitespace.  The anchor timestamp and both prices are stable,
  // so verify the second point by its unique price instead of its normalized
  // time coordinate.
  const hasCalloutPoint = points.some(
    (actual) => Number.isFinite(Number(actual.time))
      && nearlyEqual(actual.price, expected.point2.price)
      && !nearlyEqual(actual.price, expected.point.price),
  );
  if (detail?.success !== true) issues.push('properties_read_failed');
  if (!hasPoint(expected.point)) issues.push('anchor_point');
  if (!hasCalloutPoint) issues.push('callout_point');
  if (properties.text !== expected.text) issues.push('text');
  if (String(properties.text || '').split('\n').length !== 5) issues.push('text_lines');
  if (properties.wordWrap !== true) issues.push('word_wrap');
  if (Number(properties.wordWrapWidth) !== 280) issues.push('word_wrap_width');
  if (Number(properties.fontsize) !== 12) issues.push('font_size');
  if (properties.color !== expected.color) issues.push('text_color');
  if (properties.bordercolor !== expected.color) issues.push('border_color');
  if (properties.backgroundColor !== 'rgba(15,23,42,0.90)') issues.push('background_color');
  return issues;
};
const beijingLabel = (epoch) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}).format(new Date(epoch * 1000)).replaceAll('/', '-');

validateDecision();
if (args['validate-only'] === 'true') {
  process.stdout.write(`${JSON.stringify({ success: true, validated: true, full_symbol: fullSymbol })}\n`);
  process.exit(0);
}
checkDeadline(25);
const context = {
  ...(decision.context || {}),
  confirmation_price: Number(decision.confirmation_price),
  invalidation_price: Number(decision.invalidation_price),
  levels_reason: decision.context?.levels_reason || '',
};
const saved = store('save-signal', {
  vendor: candidate.vendor,
  symbol: candidate.symbol,
  timeframe,
  bar_time: Number(candidate.bar_time),
  signal_price: Number(candidate.close),
  direction: decision.direction,
  setup_type: decision.setup_type,
  grade: '信号',
  reasons: decision.reasons,
  context,
  rules_version: 'louie-xau-replay-v1',
  model_version: 'codex-deepseek-v4-flash-max-monitor',
});
if (!saved.inserted) {
  process.stdout.write(`${JSON.stringify({ success: true, duplicate: true, signal_id: saved.signal_id })}\n`);
  process.exit(0);
}
const signalId = Number(saved.signal_id);
process.once('exit', queueExcelExport);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/server.js'],
  cwd: serverRoot,
  stderr: 'inherit',
});
const client = new Client({ name: 'tvfloat-signal-executor', version: '2.0.0' }, { capabilities: {} });
await client.connect(transport);
const closeWatchlist = async () => {
  try {
    await client.callTool({
      name: 'ui_open_panel',
      arguments: { panel: 'watchlist', action: 'close' },
    });
  } catch {}
};
const focusExecutionChart = async () => {
  const rightmost = parse(await client.callTool({
    name: 'tab_switch_rightmost',
    arguments: {},
  }));
  if (!rightmost.success) {
    throw new Error(`rightmost tab switch failed: ${rightmost.error || 'unknown'}`);
  }
  const symbolSet = parse(await client.callTool({
    name: 'chart_set_symbol',
    arguments: { symbol: fullSymbol },
  }));
  if (!symbolSet.success) throw new Error(`chart_set_symbol failed: ${symbolSet.error || 'unknown'}`);
  const timeframeSet = parse(await client.callTool({
    name: 'chart_set_timeframe',
    arguments: { timeframe },
  }));
  if (!timeframeSet.success) {
    throw new Error(`chart_set_timeframe failed: ${timeframeSet.error || 'unknown'}`);
  }
  await waitForSymbol(client, fullSymbol);
};
const cleanup = [];
const alertResults = [];
let drawingId = null;
const savedFocus = focusGuard(['save']);
focusGuard(['unminimize']);
try {
  checkDeadline(20);
  await focusExecutionChart();
  await closeWatchlist();

  const oldRows = store('replaceable-tv-alerts', {
    vendor: candidate.vendor,
    symbol: candidate.symbol,
    timeframe,
    exclude_signal_id: signalId,
  });
  if (oldRows.length) {
    const listed = parse(await client.callTool({ name: 'alert_list', arguments: {} }));
    const activeById = new Map((listed.alerts || []).map((alert) => [String(alert.alert_id), Boolean(alert.active)]));
    for (const row of oldRows) {
      const tvId = String(row.tradingview_alert_id);
      if (activeById.get(tvId) === true) {
        try {
          const removed = parse(await client.callTool({ name: 'alert_delete', arguments: { alert_id: Number(tvId) } }));
          if (!removed.success) throw new Error(removed.error || 'alert_delete failed');
          store('update-tv-alert-status', { alert_row_id: row.alert_row_id, status: 'deleted_replaced' });
          cleanup.push({ alert_id: tvId, status: 'deleted_replaced' });
        } catch (error) {
          store('update-tv-alert-status', { alert_row_id: row.alert_row_id, status: 'delete_failed' });
          cleanup.push({ alert_id: tvId, status: 'delete_failed', error: String(error.message || error) });
        }
      } else {
        store('update-tv-alert-status', { alert_row_id: row.alert_row_id, status: 'inactive_triggered_or_expired' });
        cleanup.push({ alert_id: tvId, status: 'inactive_triggered_or_expired' });
      }
    }
  }

  checkDeadline(12);
  await focusExecutionChart();
  const directionColor = decision.direction === 'long' ? '#22c55e' : '#ef4444';
  const directionText = decision.direction === 'long' ? '多头' : '空头';
  const drawingTitle = `TVF #${signalId}｜${candidate.symbol}｜${timeframe}m｜${directionText}｜${beijingLabel(Number(candidate.bar_time))}`;
  const atr = Math.max(Number(candidate.atr14 || 0), Math.abs(Number(candidate.close)) * 0.0005);
  const secondPrice = Number(candidate.close) + (decision.direction === 'long' ? -0.8 : 0.8) * atr;
  const labelText = [
    `${directionText}信号｜${decision.setup_type}｜5分钟`,
    `北京时间 ${beijingLabel(Number(candidate.bar_time))}｜收盘 ${candidate.close}`,
    `位置：${shortText(decision.location_summary, 24)}`,
    `结构：${shortText(decision.structure_summary, 30)}`,
    `确认 ${decision.confirmation_price}｜失效 ${decision.invalidation_price}`,
  ].join('\n');
  const calloutArguments = {
    shape: 'callout',
    point: { time: Number(candidate.bar_time), price: Number(candidate.close) },
    point2: { time: Number(candidate.bar_time) + 4 * barSeconds, price: secondPrice },
    text: labelText,
    overrides: JSON.stringify({
      title: drawingTitle,
      color: directionColor,
      backgroundColor: 'rgba(15,23,42,0.90)',
      bordercolor: directionColor,
      linewidth: 1,
      fontsize: 12,
      wordWrap: true,
      wordWrapWidth: 280,
    }),
  };
  let verificationIssues = ['not_attempted'];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const drawing = parse(await client.callTool({
      name: 'draw_shape',
      arguments: calloutArguments,
    }));
    if (!drawing.success || !drawing.entity_id) {
      throw new Error(`draw_shape failed: ${drawing.error || 'unknown'}`);
    }
    drawingId = drawing.entity_id;
    await sleep(150);
    let detail;
    try {
      detail = parse(await client.callTool({
        name: 'draw_get_properties',
        arguments: { entity_id: drawingId },
      }));
      verificationIssues = calloutVerificationIssues(detail, {
        point: calloutArguments.point,
        point2: calloutArguments.point2,
        text: labelText,
        color: directionColor,
      });
    } catch (error) {
      verificationIssues = [`properties_error:${String(error.message || error)}`];
    }
    if (verificationIssues.length === 0) break;
    await client.callTool({ name: 'draw_remove_one', arguments: { entity_id: drawingId } });
    drawingId = null;
    if (attempt < 2) await sleep(200);
  }
  if (verificationIssues.length !== 0) {
    throw new Error(`callout verification failed: ${verificationIssues.join(',')}`);
  }

  const alertSpecs = decision.direction === 'long'
    ? [
        ['confirmation', Number(decision.confirmation_price), 'greater_than', '确认'],
        ['invalidation', Number(decision.invalidation_price), 'less_than', '失效'],
      ]
    : [
        ['confirmation', Number(decision.confirmation_price), 'less_than', '确认'],
        ['invalidation', Number(decision.invalidation_price), 'greater_than', '失效'],
      ];
  for (const [kind, price, condition, kindText] of alertSpecs) {
    checkDeadline(3);
    const message = `${candidate.symbol}｜${directionText}${kindText}｜${price}\n${beijingLabel(Number(candidate.bar_time))}｜${decision.setup_type}`;
    try {
      await focusExecutionChart();
      const created = parse(await client.callTool({ name: 'alert_create', arguments: { price, condition, message } }));
      if (!created.success) throw new Error(created.error || 'alert_create failed');
      const tvId = created.alert_id ?? created.id ?? created.alertId;
      if (created.symbol && created.symbol !== fullSymbol) {
        if (tvId != null) {
          await client.callTool({ name: 'alert_delete', arguments: { alert_id: Number(tvId) } });
        }
        throw new Error(`alert created on wrong symbol: ${created.symbol}`);
      }
      store('save-tv-alert', {
        signal_id: signalId,
        alert_kind: kind,
        price,
        condition,
        tradingview_alert_id: tvId == null ? null : String(tvId),
        status: tvId == null ? 'failed' : 'created',
      });
      alertResults.push({ kind, status: tvId == null ? 'failed' : 'created', alert_id: tvId ?? null });
    } catch (error) {
      store('save-tv-alert', {
        signal_id: signalId,
        alert_kind: kind,
        price,
        condition,
        tradingview_alert_id: null,
        status: 'failed',
      });
      alertResults.push({ kind, status: 'failed', error: String(error.message || error) });
    }
  }
} finally {
  try {
    await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: 'BYBIT:BTCUSDT.P' } });
    await client.callTool({ name: 'chart_set_timeframe', arguments: { timeframe } });
  } catch {}
  await closeWatchlist();
  await client.close();
  if (savedFocus?.hwnd) focusGuard(['restore', String(savedFocus.hwnd)]);
}
const success = drawingId !== null && alertResults.every((item) => item.status === 'created');
process.stdout.write(`${JSON.stringify({ success, signal_id: signalId, drawing_id: drawingId, cleanup, alerts: alertResults })}\n`);
if (!success) process.exitCode = 1;
