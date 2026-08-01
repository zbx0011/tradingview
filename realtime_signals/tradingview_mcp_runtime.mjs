import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function isServerRoot(candidate) {
  return Boolean(
    candidate
    && fs.existsSync(path.join(candidate, 'src', 'server.js'))
    && fs.existsSync(path.join(candidate, 'node_modules', '@modelcontextprotocol', 'sdk')),
  );
}

export function resolveTradingViewMcpRoot() {
  const candidates = [
    process.env.TRADINGVIEW_MCP_ROOT,
    process.env.TV_MCP_ROOT,
    path.join(os.homedir(), 'tools', 'tradingview-mcp'),
  ].filter(Boolean).map((candidate) => path.resolve(candidate));

  const serverRoot = candidates.find(isServerRoot);
  if (!serverRoot) {
    throw new Error(
      'TradingView MCP runtime not found. Run the migration installer or set '
      + 'TRADINGVIEW_MCP_ROOT to a folder containing src/server.js and node_modules.',
    );
  }
  return serverRoot;
}

export async function loadTradingViewMcpSdk(serverRoot = resolveTradingViewMcpRoot()) {
  const clientRoot = path.join(
    serverRoot,
    'node_modules',
    '@modelcontextprotocol',
    'sdk',
    'dist',
    'esm',
    'client',
  );
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(path.join(clientRoot, 'index.js')).href),
    import(pathToFileURL(path.join(clientRoot, 'stdio.js')).href),
  ]);
  return { Client, StdioClientTransport };
}
