import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  createProxy, createRewriter, createConfiguredRewriter, jqTransform, loadConfig, startProxy, JqError,
} from '../src/index.js';

const fixtures = fileURLToPath(new URL('fixtures/', import.meta.url));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
const urlOf = (server, path = '') => `http://127.0.0.1:${server.address().port}${path}`;

test('identity transform round-trips queries through the algebra', async () => {
  const rewrite = createRewriter((algebra) => algebra);
  const out = await rewrite('PREFIX ex: <http://ex/> SELECT ?s WHERE { ?s ex:p ?o FILTER(?o > 1) } ORDER BY ?s LIMIT 3');
  assert.match(out, /SELECT \?s WHERE/);
  assert.match(out, /<http:\/\/ex\/p>/);
  assert.match(out, /LIMIT 3/);
});

test('protocol dataset overrides FROM clauses', async () => {
  const rewrite = createRewriter((algebra) => algebra);
  const out = await rewrite('SELECT * FROM <http://a> WHERE { ?s ?p ?o }', { defaultGraphs: ['http://b'], namedGraphs: ['http://c'] });
  assert.match(out, /FROM <http:\/\/b>/);
  assert.match(out, /FROM NAMED <http:\/\/c>/);
  assert.doesNotMatch(out, /http:\/\/a/);
});

test('rejects syntax errors and updates with status 400', async () => {
  const rewrite = createRewriter((algebra) => algebra);
  await assert.rejects(rewrite('SELECT WHERE {'), { status: 400 });
  await assert.rejects(rewrite('CLEAR ALL'), { status: 400 });
});

test('jq filter imports jqpm packages and local modules', async () => {
  const config = await loadConfig(`${fixtures}config.json`);
  const rewrite = createConfiguredRewriter(config);
  const out = await rewrite('SELECT * WHERE { ?s <http://front/p> ?o }');
  assert.match(out, /<http:\/\/back\/p>/);
  assert.doesNotMatch(out, /front/);
});

test('jq error() rejects a query with status 400', async () => {
  const config = await loadConfig(`${fixtures}config.json`);
  const rewrite = createConfiguredRewriter(config);
  await assert.rejects(rewrite('SELECT * WHERE { SERVICE <http://x> { ?s ?p ?o } }'), (e) => {
    assert.ok(e instanceof JqError);
    assert.equal(e.status, 400);
    assert.match(e.message, /SERVICE is not allowed/);
    return true;
  });
});

test('a broken jq filter is a server error', async () => {
  const transform = jqTransform({ filter: `${fixtures}view.jq`, libraryPaths: [] }); // module not found
  await assert.rejects(transform({}), { status: 500 });
});

test('example view keeps CONSTRUCT templates in the front-end vocabulary', async () => {
  const config = await loadConfig(fileURLToPath(new URL('../examples/foaf-as-schema/config.json', import.meta.url)));
  const out = await createConfiguredRewriter(config)(
    'CONSTRUCT { ?p <http://schema.org/name> ?n } WHERE { ?p <http://schema.org/name> ?n }');
  const [template, where] = out.split(/\bWHERE\b/);
  assert.match(template, /<http:\/\/schema.org\/name>/);
  assert.match(where, /<http:\/\/xmlns.com\/foaf\/0.1\/name>/);
  assert.doesNotMatch(where, /schema.org/);
});

test('argFiles pass the contents of JSON files as jq arguments', async () => {
  const transform = jqTransform({ filter: `${fixtures}argfiles/echo.jq`, argFiles: { data: 'data.json' } });
  assert.deepEqual(await transform({ x: 1 }), { x: 1, data: { answer: 42, list: [1, 'two', null] } });
});

test('argFiles errors are reported when the transform is built', () => {
  const filter = `${fixtures}argfiles/echo.jq`;
  assert.throws(() => jqTransform({ filter, argFiles: { data: 'missing.json' } }), /cannot read the file of jq argument \$data/);
  assert.throws(() => jqTransform({ filter, argFiles: { data: 'broken.json' } }), /not valid JSON/);
  assert.throws(() => jqTransform({ filter, args: { data: 1 }, argFiles: { data: 'data.json' } }), /both args and argFiles/);
  assert.throws(() => jqTransform({ filter, args: { data: 'x'.repeat(200000) } }), /too large[^]*import ".\/data" as \$data;/);
});

test('loadConfig resolves argFiles against the configuration folder', async () => {
  const config = await loadConfig(fileURLToPath(new URL('../examples/foaf-as-schema/config.json', import.meta.url)));
  assert.equal(config.argFiles.mapping, fileURLToPath(new URL('../examples/foaf-as-schema/mapping.json', import.meta.url)));
});

let upstream;
let proxy;
let received;
const logs = [];

before(async () => {
  upstream = await listen(createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://x');
    received = {
      method: req.method,
      accept: req.headers.accept,
      authorization: req.headers.authorization,
      query: req.method === 'POST' ? new URLSearchParams(body).get('query') : url.searchParams.get('query'),
    };
    res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
    res.end(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }));
  }));
  const config = await loadConfig(`${fixtures}config.json`);
  proxy = await startProxy({ ...config, endpoint: urlOf(upstream, '/sparql'), headers: { authorization: 'Bearer t' }, log: (m) => logs.push(m), port: 0, host: '127.0.0.1' });
});

after(() => {
  upstream.close();
  proxy.close();
});

const q = 'SELECT * WHERE { ?s <http://front/p> ?o }';

test('GET query is rewritten and forwarded with the Accept header', async () => {
  const res = await fetch(`${urlOf(proxy, '/sparql')}?query=${encodeURIComponent(q)}`, { headers: { accept: 'application/sparql-results+json' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/sparql-results+json');
  assert.deepEqual(await res.json(), { head: { vars: [] }, results: { bindings: [] } });
  assert.equal(received.method, 'POST');
  assert.equal(received.accept, 'application/sparql-results+json');
  assert.equal(received.authorization, 'Bearer t');
  assert.match(received.query, /<http:\/\/back\/p>/);
  assert.match(logs.at(-1), /rewritten:\n[^]*<http:\/\/back\/p>/);
});

test('log: true is accepted by the library API', async () => {
  assert.equal(typeof createProxy({ ...(await loadConfig(`${fixtures}config.json`)), log: true }), 'function');
});

test('POST form and POST sparql-query are accepted', async () => {
  let res = await fetch(urlOf(proxy, '/sparql'), { method: 'POST', body: new URLSearchParams({ query: q, 'default-graph-uri': 'http://g' }) });
  assert.equal(res.status, 200);
  assert.match(received.query, /FROM <http:\/\/g>/);
  res = await fetch(`${urlOf(proxy, '/sparql')}?named-graph-uri=http://n`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: q });
  assert.equal(res.status, 200);
  assert.match(received.query, /FROM NAMED <http:\/\/n>/);
});

test('protocol errors', async () => {
  const base = urlOf(proxy, '/sparql');
  assert.equal((await fetch(`${base}?query=SELECT`)).status, 400);
  assert.equal((await fetch(`${base}?query=${encodeURIComponent('SELECT * { SERVICE <http://x> { ?s ?p ?o } }')}`)).status, 400);
  assert.equal((await fetch(`${base}?update=CLEAR%20ALL`, { method: 'POST' })).status, 415);
  assert.equal((await fetch(base, { method: 'POST', body: new URLSearchParams({ update: 'CLEAR ALL' }) })).status, 400);
  assert.equal((await fetch(base, { method: 'PUT' })).status, 405);
  assert.equal((await fetch(urlOf(proxy, '/other'))).status, 404);
});

test('GET without parameters returns a service description', async () => {
  const res = await fetch(urlOf(proxy, '/sparql'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/turtle/);
  assert.match(await res.text(), /sd:Service/);
});

test('unreachable upstream is a 502', async () => {
  const config = await loadConfig(`${fixtures}config.json`);
  const p = await startProxy({ ...config, port: 0, host: '127.0.0.1' });
  try {
    assert.equal((await fetch(`${urlOf(p, '/sparql')}?query=${encodeURIComponent(q)}`)).status, 502);
  } finally {
    p.close();
  }
});
