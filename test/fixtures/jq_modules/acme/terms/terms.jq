# A package as jqpm installs it: jq_modules/<owner>/<repo>/<repo>.jq
def rename($from; $to):
  walk(if type == "object" and .termType == "NamedNode" and .value == $from then .value = $to else . end);
