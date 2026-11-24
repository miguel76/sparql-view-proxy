import { Parser } from '@traqula/parser-sparql-1-2';
import { Generator } from '@traqula/generator-sparql-1-2';
import { toAlgebra, toAst } from '@traqula/algebra-sparql-1-2';

/** Error raised for a request the proxy cannot accept, e.g. a syntax error. */
export class QueryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'QueryError';
    this.status = status;
  }
}

const parser = new Parser();
const generator = new Generator();

/** Parses a SPARQL query string into its (plain JSON) SPARQL algebra. */
export function parseToAlgebra(query, { quads = false, baseIRI } = {}) {
  let ast;
  try {
    ast = parser.parse(query, baseIRI ? { baseIRI } : undefined);
  } catch (e) {
    throw new QueryError(`SPARQL syntax error: ${e.message}`);
  }
  if (ast.type !== 'query') throw new QueryError('Only SPARQL queries are accepted, not updates');
  return toAlgebra(ast, { quads });
}

/** Serializes SPARQL algebra (as produced by `parseToAlgebra`) back to a query string. */
export function algebraToQuery(algebra) {
  return generator.generate(toAst(algebra));
}

/**
 * Applies a dataset given through the SPARQL protocol (`default-graph-uri` /
 * `named-graph-uri`), which overrides any FROM / FROM NAMED in the query, by
 * putting it into the algebra, so the transform sees the effective dataset.
 */
export function withDataset(algebra, { defaultGraphs = [], namedGraphs = [] } = {}) {
  if (!defaultGraphs.length && !namedGraphs.length) return algebra;
  const iri = (value) => ({ termType: 'NamedNode', value });
  return {
    type: 'from',
    input: algebra.type === 'from' ? algebra.input : algebra,
    default: defaultGraphs.map(iri),
    named: namedGraphs.map(iri),
  };
}

/**
 * Builds a query rewriter: `(query, dataset?) => Promise<string>`. Its
 * `close()` method calls the transform's `close()`, if it has one.
 * @param {(algebra: object) => object | Promise<object>} transform front-end algebra to back-end algebra
 * @param {{ quads?: boolean, baseIRI?: string }} [options] how the algebra is built
 */
export function createRewriter(transform, options = {}) {
  const rewrite = async (query, dataset) => {
    const algebra = withDataset(parseToAlgebra(query, options), dataset);
    const rewritten = await transform(algebra);
    try {
      return algebraToQuery(rewritten);
    } catch (e) {
      throw new QueryError(`Cannot serialize the rewritten algebra: ${e.message}`, 500);
    }
  };
  rewrite.close = () => transform.close?.();
  return rewrite;
}
