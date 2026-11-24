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
 * `libraryPaths`, `argFiles`) are taken relative to the file's folder.
 */
export async function loadConfig(file) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  const base = dirname(resolve(file));
  if (config.filter) config.filter = resolve(base, config.filter);
  config.libraryPaths = (config.libraryPaths ?? ['jq_modules']).map((p) => resolve(base, p));
  if (config.argFiles) {
    config.argFiles = Object.fromEntries(Object.entries(config.argFiles).map(([name, p]) => [name, resolve(base, p)]));
  }
  return config;
}

/** Builds the query rewriter `(query, dataset?) => Promise<string>` described by a configuration. */
export function createConfiguredRewriter({
  filter, libraryPaths, args, argFiles, jq, jqProcesses, jqTimeout, quads, baseIRI,
}) {
  const transform = jqTransform({ filter, libraryPaths, args, argFiles, jq, processes: jqProcesses, timeout: jqTimeout });
  return createRewriter(transform, { quads, baseIRI });
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
