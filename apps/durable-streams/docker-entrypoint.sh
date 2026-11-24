#!/bin/sh
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

auth_token="${DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_TOKEN:-${DURABLE_STREAMS_AUTH_TOKEN:-}}"
host="${DEPLOYMENTS_AI_DURABLE_STREAMS_HOST:-${HOST:-0.0.0.0}}"
port="${DEPLOYMENTS_AI_DURABLE_STREAMS_PORT:-${PORT:-4437}}"
data_dir="${DEPLOYMENTS_AI_DURABLE_STREAMS_DATA_DIR:-${DURABLE_STREAMS_DATA_DIR:-/data}}"
long_poll_timeout_ms="${DEPLOYMENTS_AI_DURABLE_STREAMS_LONG_POLL_TIMEOUT_MS:-20000}"

[ "${#auth_token}" -ge 32 ] || fail "Durable Streams auth token must contain at least 32 characters."
case "$host" in
  "" | *[!A-Za-z0-9._:%-]*) fail "Durable Streams host is invalid." ;;
esac
case "$port" in
  "" | *[!0-9]*) fail "Durable Streams port must be an integer from 1 through 65535." ;;
esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] ||
  fail "Durable Streams port must be an integer from 1 through 65535."
case "$data_dir" in
  /*) ;;
  *) fail "Durable Streams data directory must be an absolute path." ;;
esac
case "$long_poll_timeout_ms" in
  "" | *[!0-9]*) fail "Durable Streams long-poll timeout must be a positive integer." ;;
esac
[ "$long_poll_timeout_ms" -ge 1 ] ||
  fail "Durable Streams long-poll timeout must be a positive integer."

export DURABLE_STREAMS_AUTH_TOKEN="$auth_token"
export DURABLE_STREAMS_EFFECTIVE_HOST="$host"
export DURABLE_STREAMS_EFFECTIVE_PORT="$port"
export DURABLE_STREAMS_EFFECTIVE_DATA_DIR="${data_dir%/}"
[ -n "$DURABLE_STREAMS_EFFECTIVE_DATA_DIR" ] || DURABLE_STREAMS_EFFECTIVE_DATA_DIR="/"
export DURABLE_STREAMS_EFFECTIVE_LONG_POLL_TIMEOUT="${long_poll_timeout_ms}ms"

exec durable-streams-server run --config /etc/durable-streams/Caddyfile --adapter caddyfile
