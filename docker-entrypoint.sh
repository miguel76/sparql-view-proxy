#!/bin/sh
# If the configuration folder declares jq dependencies (jqpackage.json) but
# does not ship them (jq_modules/), install them with jqpm into a writable
# folder and expose it to the filter through JQ_LIBRARY_PATH.
set -e
dir=$(dirname "$SPARQL_VIEW_PROXY_CONFIG")
if [ -f "$dir/jqpackage.json" ] && [ ! -d "$dir/jq_modules" ]; then
  work=$(mktemp -d)
  cp "$dir"/jqpackage*.json "$work"/
  (cd "$work" && jqpm install) >&2
  export JQ_LIBRARY_PATH="$work/jq_modules${JQ_LIBRARY_PATH:+:$JQ_LIBRARY_PATH}"
fi
exec node /app/bin/sparql-view-proxy.js "$@"
