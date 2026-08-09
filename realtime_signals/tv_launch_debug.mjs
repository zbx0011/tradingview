#!/usr/bin/env node
/* Relaunch TradingView Desktop with CDP port 9222 via the installed MCP runtime. */

import {
  loadTradingViewMcpSdk,
  resolveTradingViewMcpRoot,
} from './tradingview_mcp_runtime.mjs';

const serverRoot = resolveTradingViewMcpRoot();
const { Client, StdioClientTransport } = await loadTradingViewMcpSdk(serverRoot);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/server.js'],
  cwd: serverRoot,
  stderr: 'inherit',
});
const client = new Client(
  { name: 'tvfloat-tv-launch', version: '1.0.0' },
  { capabilities: {} },
);
await client.connect(transport);
try {
  const launched = await client.callTool({
    name: 'tv_launch',
    arguments: { kill_existing: true, port: 9222 },
  });
  process.stdout.write(`${JSON.stringify(launched)}\n`);
} finally {
  await client.close();
}
