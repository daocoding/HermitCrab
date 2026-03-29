#!/usr/bin/env bash
# Stop the M5 overnight orchestrator
PID_FILE="/tmp/orchestrator-m5.pid"
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        echo "✅ Orchestrator stopped (PID $PID)"
    else
        echo "⚠️  Orchestrator not running (stale PID file)"
    fi
    rm -f "$PID_FILE"
else
    echo "No PID file found. Checking for process..."
    pkill -f "ORCHESTRATOR_PORT=18794" && echo "✅ Killed" || echo "Nothing to kill"
fi
