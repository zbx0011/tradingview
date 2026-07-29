import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'file:///C:/Users/zbx00/tools/tradingview-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from 'file:///C:/Users/zbx00/tools/tradingview-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const manifestPath = process.argv[2];
const targetSymbols = new Set(
  String(process.argv[3] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
if (!manifestPath || !fs.existsSync(manifestPath)) {
  throw new Error('existing replay drawing manifest is required');
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
const parse = (result) => JSON.parse(result.content[0].text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const serverRoot = 'C:/Users/zbx00/tools/tradingview-mcp';
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/server.js'],
  cwd: serverRoot,
  stderr: 'inherit',
});
const client = new Client(
  { name: 'tvfloat-replay-drawing-cleaner', version: '1.0.0' },
  { capabilities: {} },
);
await client.connect(transport);

const removed = [];
const failed = [];
const retained = [];
try {
  await client.callTool({ name: 'tab_switch_rightmost', arguments: {} });
  let activeSymbol = '';
  for (const row of manifest.drawings || []) {
    if (targetSymbols.size > 0 && !targetSymbols.has(row.full_symbol)) {
      retained.push(row);
      continue;
    }
    if (row.full_symbol && activeSymbol !== row.full_symbol) {
      await client.callTool({
        name: 'chart_set_symbol',
        arguments: { symbol: row.full_symbol },
      });
      await client.callTool({
        name: 'chart_set_timeframe',
        arguments: { timeframe: '15' },
      });
      await sleep(900);
      activeSymbol = row.full_symbol;
    }
    const result = parse(await client.callTool({
      name: 'draw_remove_one',
      arguments: { entity_id: row.entity_id },
    }));
    if (result.success) removed.push(row);
    else failed.push({ ...row, error: result.error || 'unknown' });
  }
} finally {
  try {
    await client.callTool({
      name: 'chart_set_symbol',
      arguments: { symbol: 'BYBIT:BTCUSDT.P' },
    });
    await client.callTool({
      name: 'chart_set_timeframe',
      arguments: { timeframe: '15' },
    });
  } catch {}
  await client.close();
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(
  path.dirname(manifestPath),
  `${path.basename(manifestPath, '.json')}.replaced-${stamp}.json`,
);
fs.writeFileSync(
  backupPath,
  JSON.stringify({ ...manifest, replaced_at: new Date().toISOString(), removed, failed }, null, 2),
  'utf8',
);
fs.writeFileSync(
  manifestPath,
  JSON.stringify({
    ...manifest,
    expected_signals: retained.length + failed.length,
    expected_ranges: retained.length + failed.length,
    completed_drawings: retained.length + failed.length,
    updated_at: new Date().toISOString(),
    drawings: [...retained, ...failed],
  }, null, 2),
  'utf8',
);
process.stdout.write(`${JSON.stringify({
  success: failed.length === 0,
  removed: removed.length,
  retained: retained.length,
  failed: failed.length,
  backup: backupPath,
})}\n`);
