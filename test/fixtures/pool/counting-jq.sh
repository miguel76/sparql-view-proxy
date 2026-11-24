#!/bin/sh
echo started >> "$JQ_COUNT_FILE"
exec jq "$@"
