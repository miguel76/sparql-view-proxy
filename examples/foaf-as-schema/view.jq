# A schema.org view over data that is stored using FOAF.
# Input: the SPARQL algebra of the query sent to the proxy.
# Output: the SPARQL algebra of the query sent to the upstream endpoint.
import "./lib/algebra" as A;

def schema_to_foaf: {
  "http://schema.org/Person": "http://xmlns.com/foaf/0.1/Person",
  "http://schema.org/name":   "http://xmlns.com/foaf/0.1/name",
  "http://schema.org/knows":  "http://xmlns.com/foaf/0.1/knows",
  "http://schema.org/image":  "http://xmlns.com/foaf/0.1/depiction"
};

A::rename_iris(schema_to_foaf)
| if $ARGS.named.graph then A::restrict_to_graph($ARGS.named.graph) else . end
