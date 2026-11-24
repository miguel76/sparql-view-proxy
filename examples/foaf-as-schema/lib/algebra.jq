# Small helpers over Traqula's SPARQL algebra (plain JSON, RDF/JS-style terms).

def iri($value): {termType: "NamedNode", value: $value};

# Replaces every IRI found in $map (an object from IRI to IRI) in the parts
# of the query matched against the data. CONSTRUCT templates are left as they
# are: they produce the result, so they stay in the front-end vocabulary.
def rename_iris($map):
  def r:
    if type == "array" then map(r)
    elif type != "object" then .
    elif .termType == "NamedNode" and $map[.value] != null then .value = $map[.value]
    elif .type == "construct" then .input |= r
    else map_values(r) end;
  r;

# Evaluates the whole query against the given default graph
# (overriding FROM / FROM NAMED and the protocol's dataset).
def restrict_to_graph($graph):
  {type: "from", input: (if .type == "from" then .input else . end),
   default: [iri($graph)], named: []};
