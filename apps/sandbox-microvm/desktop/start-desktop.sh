#!/bin/bash
# Starts the sandbox desktop, then hands the process over to the control server.
#
# The display and the session bus start before the control server, so the first exec already finds
# them. The window manager and the Cua Driver daemon start in the background; `cua-driver status`
# reports when the daemon is up.
#
# Every desktop process writes to this process's stdout, which Lambda forwards to CloudWatch when the
# MicroVM runs with an execution role. Each line is tagged with the process that wrote it.
set -euo pipefail

export HOME="${HOME:-/root}"
display_number="${DISPLAY#:}"
bus_socket="${DBUS_SESSION_BUS_ADDRESS#unix:path=}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"

# Runs a command in the background with its stdout and stderr tagged as `[name] line`. The tagger
# runs in its own process substitution, so the command's PID is the one the script waits on.
run_tagged() {
  local name="$1"
  shift
  "$@" > >(sed -u "s/^/[$name] /") 2>&1 &
}

wait_for_socket() {
  local path="$1" name="$2"
  for _ in $(seq 100); do
    [ -S "$path" ] && return 0
    sleep 0.1
  done
  echo "[start-desktop] $name did not start" >&2
  return 1
}

run_tagged xvfb Xvfb "$DISPLAY" -screen 0 "$SANDBOX_DESKTOP_GEOMETRY" -nolisten tcp
wait_for_socket "/tmp/.X11-unix/X$display_number" Xvfb

# at-spi2-core's D-Bus service file starts the accessibility bus on the first request for it.
run_tagged dbus dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --nofork --nopidfile
wait_for_socket "$bus_socket" dbus-daemon

run_tagged metacity metacity
run_tagged cua-driver cua-driver serve
echo "[start-desktop] desktop started on $DISPLAY"

exec python3 /opt/agent-sandbox/control_server.py
