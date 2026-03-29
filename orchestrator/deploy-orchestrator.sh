#!/bin/bash
# 🦀🎯 Deploy HermitCrab Orchestrator to launchd
# Run this ON M4 (the machine where orchestrator will run)
# Usage: bash deploy-orchestrator.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$SCRIPT_DIR/com.hermitcrab.orchestrator.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.hermitcrab.orchestrator.plist"
LOG_DIR="$HOME/Library/Logs/HermitCrab"
LABEL="com.hermitcrab.orchestrator"

echo "🦀🎯 Deploying HermitCrab Orchestrator"
echo "══════════════════════════════════════"

# 1. Check we're on the right machine
MACHINE=$(scutil --get ComputerName 2>/dev/null || hostname)
echo "📍 Machine: $MACHINE"

# 2. Create log directory
mkdir -p "$LOG_DIR"
echo "📁 Log dir: $LOG_DIR"

# 3. Check if already running
EXISTING_PID=$(launchctl list 2>/dev/null | grep "$LABEL" | awk '{print $1}')
if [ -n "$EXISTING_PID" ] && [ "$EXISTING_PID" != "-" ]; then
  echo "⚠️  Orchestrator already running (PID $EXISTING_PID). Stopping first..."
  launchctl bootout gui/$(id -u) "$PLIST_DST" 2>/dev/null || true
  sleep 2
  echo "   Stopped."
fi

# 4. Copy plist to LaunchAgents
cp "$PLIST_SRC" "$PLIST_DST"
echo "📋 Plist installed: $PLIST_DST"

# 5. Quick syntax check
if ! node -c "$SCRIPT_DIR/orchestrator.js" 2>/dev/null; then
  echo "❌ orchestrator.js has syntax errors! Aborting."
  exit 1
fi
echo "✅ Syntax check passed"

# 6. Quick port check
if lsof -i :18793 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️  Port 18793 already in use. Killing old process..."
  kill $(lsof -t -i :18793) 2>/dev/null || true
  sleep 1
fi

# 7. Load and start
launchctl bootstrap gui/$(id -u) "$PLIST_DST"
echo "🚀 Loaded into launchd"

# 8. Wait and verify
sleep 3
NEW_PID=$(launchctl list 2>/dev/null | grep "$LABEL" | awk '{print $1}')
if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "-" ]; then
  echo "✅ Orchestrator running (PID $NEW_PID)"
  
  # 9. Health check via HTTP
  sleep 1
  STATUS=$(curl -s http://localhost:18793/status 2>/dev/null)
  if echo "$STATUS" | grep -q "running"; then
    echo "✅ HTTP API responding"
    echo ""
    echo "Status:"
    echo "$STATUS" | python3 -m json.tool 2>/dev/null || echo "$STATUS"
  else
    echo "⚠️  HTTP API not responding yet (may need a moment)"
  fi
else
  echo "❌ Orchestrator failed to start. Check logs:"
  echo "   tail -20 $LOG_DIR/orchestrator.log"
  echo "   tail -20 $LOG_DIR/orchestrator.err"
  exit 1
fi

echo ""
echo "══════════════════════════════════════"
echo "✅ Deployment complete!"
echo ""
echo "Useful commands:"
echo "  Status:   curl -s http://localhost:18793/status | python3 -m json.tool"
echo "  Tasks:    curl -s http://localhost:18793/tasks | python3 -m json.tool"
echo "  Reload:   bash scripts/reload-bridges.sh orchestrator"
echo "  Logs:     tail -f $LOG_DIR/orchestrator.log"
echo "  Stop:     launchctl bootout gui/$(id -u) $PLIST_DST"
