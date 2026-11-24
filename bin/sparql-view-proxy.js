#!/usr/bin/env node
import { text } from 'node:stream/consumers';
import { createConfiguredRewriter, loadConfig, parseToAlgebra, startProxy } from '../src/index.js';

const usage = `Usage:
  sparql-view-proxy [config.json]            start the proxy
  sparql-view-proxy --rewrite [config.json]  rewrite the query read from stdin and print it
  sparql-view-proxy --algebra [--quads]      print the algebra (the jq filter's input) of the query read from stdin

The configuration file defaults to $SPARQL_VIEW_PROXY_CONFIG, then ./config.json.`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(usage);
  process.exit(0);
}
if (args.includes('--algebra')) {
  try {
    console.log(JSON.stringify(parseToAlgebra(await text(process.stdin), { quads: args.includes('--quads') }), null, 2));
    process.exit(0);
  } catch (e) {
    console.error(`sparql-view-proxy: ${e.message}`);
    process.exit(1);
  }
}
const rewriteOnly = args.includes('--rewrite');
const file = args.find((a) => !a.startsWith('-')) ?? process.env.SPARQL_VIEW_PROXY_CONFIG ?? 'config.json';

try {
  const config = await loadConfig(file);
  if (!config.filter) throw new Error(`${file}: "filter" (path of the jq filter) is required`);
  if (rewriteOnly) {
    console.log(await createConfiguredRewriter(config)(await text(process.stdin)));
  } else {
    if (!config.endpoint) throw new Error(`${file}: "endpoint" (upstream SPARQL endpoint URL) is required`);
    if (process.env.PORT) config.port = Number(process.env.PORT);
    const server = await startProxy(config);
    const { address, port } = server.address();
    console.error(`sparql-view-proxy: http://${address.includes(':') ? `[${address}]` : address}:${port}${config.path ?? '/sparql'} -> ${config.endpoint}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  }
} catch (e) {
  console.error(`sparql-view-proxy: ${e.message}`);
  process.exit(1);
}
