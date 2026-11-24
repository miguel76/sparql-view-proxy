# sparql-view-proxy

SPARQL endpoint proxy to build RDF views based on query rewriting using jq.

The proxy serves a [SPARQL 1.1 Protocol](https://www.w3.org/TR/sparql11-protocol/)
query endpoint in front of another (upstream) SPARQL endpoint. Every query it
receives is rewritten and the rewritten query is sent upstream; the upstream
response is streamed back unchanged.

```
query ──► Traqula parser ──► SPARQL algebra ──► jq filter ──► SPARQL algebra ──► Traqula generator ──► upstream
                             (front-end view)                 (back-end data)
```

The rewriting is defined as a **jq filter from front-end SPARQL algebra to
back-end SPARQL algebra**, as represented in JSON by
[Traqula](https://github.com/comunica/traqula). The filter is a normal jq
program, so it can `import`/`include` other files and packages installed with
[jqpm](https://github.com/miguel76/jqpm).

A deployment is just two files: a jq filter and a JSON configuration.

## Quick start

`config.json`:

```json
{
  "endpoint": "https://example.org/sparql",
  "filter": "view.jq"
}
```

`view.jq`, a view that exposes FOAF data through schema.org terms:

```jq
def schema_to_foaf: {
  "http://schema.org/name":  "http://xmlns.com/foaf/0.1/name",
  "http://schema.org/knows": "http://xmlns.com/foaf/0.1/knows"
};
walk(if type == "object" and .termType == "NamedNode" and schema_to_foaf[.value]
     then .value = schema_to_foaf[.value] else . end)
```

Run it with Docker, mounting the folder that holds both files on `/config`:

```bash
docker build -t sparql-view-proxy .
```

```bash
docker run -p 8080:8080 -v "$PWD:/config:ro" sparql-view-proxy
```

or with Node.js (20.19+ or 22.12+), with `jq` on the `PATH`:

```bash
npx sparql-view-proxy config.json
```

The endpoint is then at `http://localhost:8080/sparql`.

See [`examples/foaf-as-schema`](examples/foaf-as-schema) for a fuller example
that also imports a local module and restricts the view to one graph.

## Configuration

Relative paths are relative to the configuration file's folder.

| key            | default            | description |
|----------------|--------------------|-------------|
| `endpoint`     | (required)         | URL of the upstream SPARQL endpoint. |
| `filter`       | (required)         | Path of the jq filter file. |
| `libraryPaths` | `["jq_modules"]`   | jq module search paths (jq's `-L`). The default is where jqpm installs packages. |
| `args`         | `{}`               | Named arguments for the filter: each `"name": value` is available as `$name` (and in `$ARGS.named`). |
| `jq`           | `"jq"`             | The jq executable. |
| `quads`        | `false`            | Build the algebra with quads (graph names pushed into the patterns) instead of `graph` operators. |
| `baseIRI`      | none               | Base IRI to resolve relative IRIs in queries. |
| `method`       | `"POST"`           | How queries are sent upstream: `"POST"` (form-encoded) or `"GET"`. |
| `headers`      | `{}`               | Extra headers for upstream requests, e.g. `{"authorization": "Bearer …"}`. |
| `timeout`      | `0`                | Upstream timeout in milliseconds (`0`: none). |
| `port`         | `8080`             | Port to listen on (the `PORT` environment variable overrides it). |
| `host`         | all interfaces     | Address to listen on. |
| `path`         | `"/sparql"`        | Path of the endpoint. |
| `cors`         | `true`             | Allow cross-origin requests from browsers. |
| `log`          | `false`            | Log each query, its rewriting and errors to stderr. |

## Writing the jq filter

- **Input:** the SPARQL algebra of the query sent to the proxy, as plain JSON.
  Operations have a `type` (`project`, `bgp`, `join`, `filter`, `from`, …);
  RDF terms follow [RDF/JS](https://rdf.js.org/data-model-spec/)
  (`{"termType": "NamedNode", "value": "http://…"}`).
- **Output:** exactly one value, the SPARQL algebra of the query to send upstream.
- **Rejecting a query:** raise an error, e.g. `error("SERVICE is not allowed")`;
  the client gets a `400 Bad Request` with the message.
- **Dataset:** a dataset given through the protocol (`default-graph-uri`,
  `named-graph-uri`) overrides `FROM`/`FROM NAMED` as the protocol requires,
  and the filter sees it as the top-level `from` operation.

To see what the filter receives, print the algebra of a query:

```bash
echo 'SELECT ?n WHERE { ?p <http://schema.org/name> ?n }' | npx sparql-view-proxy --algebra
```

and to try the rewriting without starting the server:

```bash
echo 'SELECT ?n WHERE { ?p <http://schema.org/name> ?n }' | npx sparql-view-proxy --rewrite config.json
```

### Modules and jqpm

jq runs in the filter's folder with `-L` for each `libraryPaths` entry and for
each folder in the `JQ_LIBRARY_PATH` environment variable (the convention
`jqpm exec` uses). So a filter can:

- `import "./lib/helpers" as H;`: a file next to the filter;
- `import "owner/repo" as X;`: a package installed by `jqpm install` in
  `jq_modules/` next to the configuration.

With Docker, if the configuration folder has a `jqpackage.json` but no
`jq_modules/`, the container runs `jqpm install` at startup into a temporary
folder (the configuration mount can be read-only). Ship `jq_modules/` with the
configuration instead to start without network access to the package
repositories.

## As a library

```js
import { createServer } from 'node:http';
import { createProxy, loadConfig, createRewriter, jqTransform } from 'sparql-view-proxy';

// The same proxy as the CLI, as a request handler (works with http, Express, …)
const handler = createProxy(await loadConfig('config.json'));
createServer(handler).listen(8080);

// Or just the rewriting
const rewrite = createRewriter(jqTransform({ filter: 'view.jq', args: { graph: 'http://g' } }));
console.log(await rewrite('SELECT * WHERE { ?s ?p ?o }'));

// The transform can be any function from algebra to algebra
const rewriteInJs = createRewriter((algebra) => ({ ...algebra, /* … */ }));
```

Exports: `createProxy`, `startProxy`, `loadConfig`, `createConfiguredRewriter`,
`createHandler`, `startServer`, `createRewriter`, `jqTransform`,
`parseToAlgebra`, `algebraToQuery`, `withDataset`, `QueryError`, `JqError`.

## Scope and limitations

- Queries only: SPARQL updates are refused.
- Responses are passed through unchanged (status, `Content-Type`, caching
  headers); the client's `Accept` header is forwarded for content negotiation.
- The rewritten query is generated from the algebra, so it is normalized:
  prefixes are expanded, and `SELECT *` lists its variables explicitly.
- jq runs as a separate process per query (a few milliseconds), because that
  is what gives filters jq's full module system; the in-process jq bindings
  for Node.js cannot load modules from disk.
