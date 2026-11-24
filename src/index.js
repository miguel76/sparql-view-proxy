import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { jqTransform } from './jq.js';
import { createRewriter } from './rewrite.js';
import { createHandler, startServer } from './server.js';

export { jqTransform, JqError } from './jq.js';
export { createRewriter, parseToAlgebra, algebraToQuery, withDataset, QueryError } from './rewrite.js';
export { createHandler, startServer } from './server.js';

/**
 * Reads a JSON configuration file. Relative paths in it (`filter`,
 * `libraryPaths`) are taken relative to the file's folder.
 */
export async function loadConfig(file) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  const base = dirname(resolve(file));
  if (config.filter) config.filter = resolve(base, config.filter);
  config.libraryPaths = (config.libraryPaths ?? ['jq_modules']).map((p) => resolve(base, p));
  return config;
}

/** Builds the query rewriter `(query, dataset?) => Promise<string>` described by a configuration. */
export function createConfiguredRewriter({ filter, libraryPaths, args, jq, quads, baseIRI }) {
  return createRewriter(jqTransform({ filter, libraryPaths, args, jq }), { quads, baseIRI });
}

// `log` may be a function or `true` for timestamped messages on stderr.
const logger = (log) => (typeof log === 'function' ? log
  : log ? (message) => console.error(`[${new Date().toISOString()}] ${message}`) : undefined);

/** Builds a Node HTTP request handler for the proxy described by a configuration. */
export function createProxy(config) {
  return createHandler({ ...config, log: logger(config.log), rewrite: createConfiguredRewriter(config) });
}

/** Starts the proxy described by a configuration; resolves to the listening `http.Server`. */
export function startProxy({ path = '/sparql', ...config }) {
  return startServer({ ...config, path, log: logger(config.log), rewrite: createConfiguredRewriter(config) });
}
