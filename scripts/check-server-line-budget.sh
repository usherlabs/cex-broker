#!/usr/bin/env bash
set -euo pipefail

MAX_LINES="${SERVER_TS_MAX_LINES:-400}"
SERVER_FILE="${1:-src/server.ts}"
ACTUAL="$(wc -l < "$SERVER_FILE" | tr -d ' ')"

if [ "$ACTUAL" -gt "$MAX_LINES" ]; then
	echo "error: $SERVER_FILE has $ACTUAL lines (budget: $MAX_LINES)" >&2
	exit 1
fi

echo "ok: $SERVER_FILE within line budget ($ACTUAL <= $MAX_LINES)"