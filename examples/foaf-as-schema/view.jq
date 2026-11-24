# A schema.org view over data that is stored using FOAF.
# Input: the SPARQL algebra of the query sent to the proxy.
# Output: the SPARQL algebra of the query sent to the upstream endpoint.
# $mapping (schema.org IRI -> FOAF IRI) is loaded from mapping.json (see argFiles in config.json).
import "./lib/algebra" as A;

A::rename_iris($mapping)
| if $ARGS.named.graph then A::restrict_to_graph($ARGS.named.graph) else . end
