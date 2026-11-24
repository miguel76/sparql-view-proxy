import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { QueryError } from './rewrite.js';

const MAX_BODY = 10 * 1024 * 1024;
const FORWARDED_HEADERS = ['content-type', 'cache-control', 'expires', 'last-modified', 'etag', 'content-language'];

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new QueryError('Request body too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Extracts the query and the protocol dataset from a SPARQL 1.1 Protocol query request. */
async function readQueryRequest(req, url) {
  let params = url.searchParams;
  let query;
  if (req.method === 'POST') {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type === 'application/x-www-form-urlencoded') {
      params = new URLSearchParams(await readBody(req));
    } else if (type === 'application/sparql-query') {
      query = await readBody(req);
    } else {
      throw new QueryError(`Unsupported content type: ${type || '(none)'}`, 415);
    }
  }
  if (query === undefined) {
    const queries = params.getAll('query');
    if (queries.length > 1) throw new QueryError('Only one query parameter is allowed');
    query = queries[0];
  }
  if (params.has('update')) throw new QueryError('SPARQL updates are not supported');
  return {
    query,
    dataset: { defaultGraphs: params.getAll('default-graph-uri'), namedGraphs: params.getAll('named-graph-uri') },
  };
}

function serviceDescription(endpoint) {
  return `@prefix sd: <http://www.w3.org/ns/sparql-service-description#> .
<${endpoint}> a sd:Service ;
  sd:endpoint <${endpoint}> ;
  sd:supportedLanguage sd:SPARQL11Query .
`;
}

/**
 * Builds a Node HTTP request handler serving a SPARQL 1.1 Protocol query
 * endpoint: each query is rewritten with `rewrite` and sent to the upstream
 * `endpoint`, whose response is streamed back unchanged.
 *
 * @param {object} options
 * @param {string} options.endpoint upstream SPARQL endpoint URL
 * @param {(query: string, dataset: object) => Promise<string>} options.rewrite query rewriter (see `createRewriter`)
 * @param {string} [options.path] serve only this path (any path when unset)
 * @param {'GET' | 'POST'} [options.method] how queries are sent upstream
 * @param {Record<string, string>} [options.headers] extra headers for upstream requests (e.g. authorization)
 * @param {number} [options.timeout] upstream timeout in milliseconds (none when 0)
 * @param {boolean} [options.cors] answer cross-origin requests
 * @param {(message: string) => void} [options.log] logger for queries and errors
 */
export function createHandler({ endpoint, rewrite, path, method = 'POST', headers = {}, timeout = 0, cors = true, log = () => {} }) {
  if (!endpoint) throw new TypeError('createHandler: an upstream endpoint is required');
  if (!rewrite) throw new TypeError('createHandler: a rewrite function is required');

  return async (req, res) => {
    if (cors) res.setHeader('Access-Control-Allow-Origin', '*');
    const fail = (status, message) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`${message}\n`);
    };
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (path && url.pathname !== path) return fail(404, 'Not found');
      if (req.method === 'OPTIONS' && cors) {
        return res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'Content-Type, Accept',
          'Access-Control-Max-Age': '86400',
        }).end();
      }
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return fail(405, 'Method not allowed');
      }

      const { query, dataset } = await readQueryRequest(req, url);
      if (query === undefined) {
        if (req.method === 'GET' && url.search === '') {
          return res.writeHead(200, { 'Content-Type': 'text/turtle; charset=utf-8' }).end(serviceDescription(url.href));
        }
        throw new QueryError('Missing query parameter');
      }

      const rewritten = await rewrite(query, dataset);
      log(`query:\n${query}\nrewritten:\n${rewritten}`);

      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const signal = timeout ? AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) : controller.signal;
      const upstreamHeaders = { ...headers };
      if (req.headers.accept) upstreamHeaders.accept = req.headers.accept;
      let upstreamUrl = endpoint;
      let body;
      const upstreamParams = new URLSearchParams({ query: rewritten });
      if (method.toUpperCase() === 'GET') {
        const u = new URL(endpoint);
        for (const [k, v] of upstreamParams) u.searchParams.append(k, v);
        upstreamUrl = u;
      } else {
        upstreamHeaders['content-type'] = 'application/x-www-form-urlencoded';
        body = upstreamParams.toString();
      }

      let upstream;
      try {
        upstream = await fetch(upstreamUrl, { method: method.toUpperCase(), headers: upstreamHeaders, body, signal });
      } catch (e) {
        if (controller.signal.aborted) return;
        const timedOut = e.name === 'TimeoutError';
        throw new QueryError(timedOut ? 'Upstream endpoint timed out' : `Upstream endpoint unreachable: ${e.cause?.message ?? e.message}`, timedOut ? 504 : 502);
      }
      const responseHeaders = {};
      for (const name of FORWARDED_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) responseHeaders[name] = value;
      }
      res.writeHead(upstream.status, responseHeaders);
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body)
        .on('error', (e) => { log(`upstream response error: ${e.message}`); res.destroy(); })
        .pipe(res);
    } catch (e) {
      const status = e.status ?? 500;
      log(`error ${status}: ${e.message}`);
      fail(status, e.message);
    }
  };
}

/** Starts an HTTP server with `createHandler(options)` on `options.port` / `options.host`. */
export function startServer({ port = 8080, host, ...options }) {
  const server = createServer(createHandler(options));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
