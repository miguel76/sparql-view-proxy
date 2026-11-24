# Small helpers over Traqula's SPARQL algebra (plain JSON, RDF/JS-style terms).

def iri($value): {termType: "NamedNode", value: $value};

# Replaces every IRI found in $map (an object from IRI to IRI).
def rename_iris($map):
  walk(if type == "object" and .termType == "NamedNode" and $map[.value] != null
       then .value = $map[.value] else . end);

# Evaluates the whole query against the given default graph
# (overriding FROM / FROM NAMED and the protocol's dataset).
def restrict_to_graph($graph):
  {type: "from", input: (if .type == "from" then .input else . end),
   default: [iri($graph)], named: []};
