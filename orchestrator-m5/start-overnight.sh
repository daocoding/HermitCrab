#!/usr/bin/env bash
# ═══════════════════════════════════════════
# 🦀🌙 HermitCrab M5 Overnight Orchestrator
# 
# Starts the Orchestrator on M5 for overnight work.
# Designed to be run right before Tony sleeps.
#
# Usage: bash hermitcrab/orchestrator-m5/start-overnight.sh
# ═══════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/../.." && pwd)"
ORCH_CODE="$WORKSPACE/hermitcrab/orchestrator/orchestrator.js"
ORCH_PORT=18794  # Different from M4's 18793 to avoid confusion
LOG_DIR="$HOME/Library/Logs/HermitCrab"
LOG_FILE="$LOG_DIR/orchestrator-m5.log"

echo "🦀🌙 HermitCrab M5 Overnight Orchestrator"
echo "==========================================="

# Pre-flight checks
echo ""
echo "📋 Pre-flight:"

# 1. Check caffeinate
if pgrep caffeinate > /dev/null 2>&1; then
    echo "  ✅ caffeinate running (Mac won't sleep)"
else
    echo "  ⚠️  Starting caffeinate..."
    caffeinate -dis &
    echo "  ✅ caffeinate started (PID $!)"
fi

# 2. Check antigravity-cli
if [ -x "$HOME/.local/bin/antigravity-cli" ]; then
    echo "  ✅ antigravity-cli available"
else
    echo "  ❌ antigravity-cli not found!"
    exit 1
fi

# 3. Check Antigravity IDE is running (needed for antigravity-cli)
if lsof -i -P -n 2>/dev/null | grep -q "Antigravi.*LISTEN"; then
    echo "  ✅ Antigravity IDE running (bridge extension active)"
else
    echo "  ❌ Antigravity IDE not detected — antigravity-cli won't work!"
    exit 1
fi

# 4. Check orchestrator code exists
if [ -f "$ORCH_CODE" ]; then
    echo "  ✅ Orchestrator code found"
else
    echo "  ❌ Orchestrator code not found at $ORCH_CODE"
    exit 1
fi

# 5. Check port not in use
if lsof -i :"$ORCH_PORT" > /dev/null 2>&1; then
    echo "  ⚠️  Port $ORCH_PORT already in use — orchestrator may already be running"
    echo "      Kill it? (y/n)"
    read -r answer
    if [ "$answer" = "y" ]; then
        kill $(lsof -t -i :"$ORCH_PORT") 2>/dev/null
        sleep 1
        echo "  ✅ Old instance killed"
    else
        echo "  Exiting."
        exit 0
    fi
fi

# 6. System resources
DISK_USE=$(df -h / | tail -1 | awk '{print $5}')
MEM_FREE=$(vm_stat | grep "Pages free" | awk '{print $3}' | tr -d '.')
echo "  📊 Disk: $DISK_USE used | Free memory pages: $MEM_FREE"

# 7. QMD status
QMD_VECTORS=$(qmd status 2>&1 | grep "Vectors:" | awk '{print $2}')
QMD_PENDING=$(qmd status 2>&1 | grep "Pending:" | awk '{print $2}')
echo "  📊 QMD: $QMD_VECTORS vectors, $QMD_PENDING pending"

echo ""
echo "🚀 Starting Orchestrator on port $ORCH_PORT..."

# Create log directory
mkdir -p "$LOG_DIR"

# Start the orchestrator with M5-specific config
ORCHESTRATOR_PORT="$ORCH_PORT" \
HERMITCRAB_WORKSPACE="$WORKSPACE" \
TASKS_FILE_OVERRIDE="$SCRIPT_DIR/tasks.json" \
STATE_FILE_OVERRIDE="$SCRIPT_DIR/state.json" \
nohup node "$ORCH_CODE" >> "$LOG_FILE" 2>&1 &

ORCH_PID=$!
echo "$ORCH_PID" > /tmp/orchestrator-m5.pid

# Wait for startup
sleep 2

# Verify it started
if kill -0 "$ORCH_PID" 2>/dev/null; then
    echo "✅ Orchestrator running (PID $ORCH_PID)"
    echo "   Logs: $LOG_FILE"
    echo "   Port: http://localhost:$ORCH_PORT"
    echo "   Tasks: $(cat "$SCRIPT_DIR/tasks.json" | grep '"id"' | wc -l | xargs) configured"
    echo ""
    echo "🌙 Good night! The Orchestrator will:"
    echo "   • Check QMD embedding every 30 min, restart if stalled"
    echo "   • Monitor system health every 5 min"
    echo "   • Keep caffeinate alive every 10 min"
    echo "   • Send you a morning summary at 6 AM"
    echo ""
    echo "📱 You'll get ntfy notifications for important events."
else
    echo "❌ Orchestrator failed to start! Check $LOG_FILE"
    tail -10 "$LOG_FILE"
    exit 1
fi
