# Chapter 06: The Orchestrator ⏰

> *Your AI shouldn't wait for you to wake up. It should work while you sleep and have a report ready by morning.*

Up to now, your AI is **reactive** — it sits idle until you send a message. That's like hiring a brilliant assistant and only letting them respond to emails.

The Orchestrator turns your AI into a **proactive** system. It schedules tasks, monitors health, and runs overnight operations — all without human input.

## What You'll Build

```
┌────────────────────────────────────────────────────┐
│                   Orchestrator                      │
│                                                    │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐      │
│  │ L1: cron  │  │ L2: brain │  │ L3: heart │      │
│  │ (scripts) │  │  (AI LLM) │  │  (pulse)  │      │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘      │
│        │              │              │             │
│  Every 5-10m     Every 30-60m    Every 60s         │
│  • disk check    • embed docs    • "I'm alive"     │
│  • memory check  • analyze logs  • state save      │
│  • restart svc   • morning report                  │
│  • caffeinate    • research task                   │
│                                                    │
└─────────────────────────┬──────────────────────────┘
                          │
                    push notification
                          │
                          ▼
                    📱 Your Phone
                    "Morning. All green.
                     3 docs indexed.
                     1 email needs reply."
```

## The Three Tiers

### Tier 1: Lightweight (No AI needed)

Simple scripts that run frequently. No LLM calls, no cost.

| Task | Interval | What It Does |
|------|----------|-------------|
| `health_check` | 5 min | Disk space, memory, CPU |
| `caffeinate_guard` | 10 min | Prevent machine from sleeping |
| `process_monitor` | 5 min | Verify bridges are running |
| `service_restart` | on failure | Restart crashed bridges |

### Tier 2: AI-Powered (Uses LLM)

Tasks that need your AI brain. Run less frequently to manage costs.

| Task | Interval | What It Does |
|------|----------|-------------|
| `document_indexing` | 30 min | Index new files into semantic memory |
| `log_analysis` | 1 hour | Scan logs for errors, summarize findings |
| `morning_report` | Daily 6 AM | Compile overnight summary, send to phone |
| `research_task` | On demand | Long-running research you queued up |

### Tier 3: Heartbeat (Infrastructure)

The pulse that proves the orchestrator itself is alive.

| Signal | Interval | Purpose |
|--------|----------|---------|
| Heartbeat file | 60 sec | `touch` a file — external monitors can check |
| State snapshot | 60 sec | Save current task status to disk |
| Self-watchdog | 5 min | Verify own process, restart if stuck |

## Implementation

### The Core: `orchestrator.js`

```javascript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';

// ── Configuration ──────────────────────────────────
const CONFIG = {
  tasksFile: process.env.TASKS_FILE || 'tasks.json',
  stateFile: process.env.STATE_FILE || 'state.json',
  heartbeatFile: process.env.HEARTBEAT_FILE || '.heartbeat',
  notifyEndpoint: process.env.NOTIFY_ENDPOINT, // e.g., ntfy.sh/your-topic
};

// ── Task Definition ────────────────────────────────
/*
  tasks.json:
  [
    {
      "id": "health_check",
      "tier": 1,
      "intervalMinutes": 5,
      "command": "bash scripts/health-check.sh",
      "enabled": true
    },
    {
      "id": "morning_report",
      "tier": 2,
      "intervalMinutes": 1440,
      "runAt": "06:00",
      "command": "node scripts/morning-report.js",
      "enabled": true
    }
  ]
*/

function loadTasks() {
  const raw = readFileSync(CONFIG.tasksFile, 'utf-8');
  return JSON.parse(raw);
}

function loadState() {
  if (!existsSync(CONFIG.stateFile)) return {};
  return JSON.parse(readFileSync(CONFIG.stateFile, 'utf-8'));
}

function saveState(state) {
  writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

// ── Heartbeat ──────────────────────────────────────
function heartbeat() {
  writeFileSync(CONFIG.heartbeatFile, new Date().toISOString());
}

// ── Notification ───────────────────────────────────
async function notify(message) {
  if (!CONFIG.notifyEndpoint) return;
  
  try {
    await fetch(CONFIG.notifyEndpoint, {
      method: 'POST',
      body: message,
    });
  } catch (err) {
    console.error(`[notify] Failed: ${err.message}`);
  }
}

// ── Task Runner ────────────────────────────────────
function shouldRun(task, state) {
  const taskState = state[task.id] || {};
  const lastRun = taskState.lastRun ? new Date(taskState.lastRun) : null;
  const now = new Date();

  // Check if enough time has passed
  if (lastRun) {
    const elapsed = (now - lastRun) / 1000 / 60; // minutes
    if (elapsed < task.intervalMinutes) return false;
  }

  // Check runAt (daily tasks)
  if (task.runAt) {
    const [hours, minutes] = task.runAt.split(':').map(Number);
    const runTime = new Date(now);
    runTime.setHours(hours, minutes, 0, 0);
    
    // Only run if we're past the run time AND haven't run today
    if (now < runTime) return false;
    if (lastRun && lastRun.toDateString() === now.toDateString()) return false;
  }

  return true;
}

async function runTask(task, state) {
  const startTime = Date.now();
  console.log(`[${task.id}] Starting (Tier ${task.tier})...`);

  try {
    const output = execSync(task.command, {
      timeout: task.tier === 1 ? 30000 : 300000, // T1: 30s, T2: 5min
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${task.id}] ✅ Done (${elapsed}s)`);

    state[task.id] = {
      lastRun: new Date().toISOString(),
      status: 'success',
      elapsed: parseFloat(elapsed),
      output: output.slice(-500), // Keep last 500 chars
    };
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[${task.id}] ❌ Failed (${elapsed}s): ${err.message}`);

    state[task.id] = {
      lastRun: new Date().toISOString(),
      status: 'failed',
      elapsed: parseFloat(elapsed),
      error: err.message.slice(-500),
    };

    // Notify on failure for important tasks
    if (task.tier <= 2) {
      await notify(`❌ Task ${task.id} failed: ${err.message.slice(0, 100)}`);
    }
  }

  saveState(state);
}

// ── Main Loop ──────────────────────────────────────
async function orchestrate() {
  console.log('🦀 Orchestrator starting...');
  const tasks = loadTasks();
  let state = loadState();

  console.log(`   ${tasks.length} tasks loaded`);
  console.log(`   Heartbeat: ${CONFIG.heartbeatFile}`);
  console.log(`   Notifications: ${CONFIG.notifyEndpoint || 'disabled'}`);

  // Initial heartbeat
  heartbeat();

  // Main tick — runs every 60 seconds
  const tick = async () => {
    heartbeat();
    
    const activeTasks = tasks.filter(t => t.enabled);
    
    for (const task of activeTasks) {
      if (shouldRun(task, state)) {
        await runTask(task, state);
      }
    }
  };

  // Run immediately, then on interval
  await tick();
  setInterval(tick, 60_000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🦀 Orchestrator shutting down...');
    saveState(state);
    await notify('🛑 Orchestrator stopped');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  await notify('🦀 Orchestrator started');
}

orchestrate().catch(console.error);
```

### Task: Health Check (`scripts/health-check.sh`)

```bash
#!/bin/bash
# Tier 1: Lightweight health check (no AI needed)

echo "=== Health Check $(date) ==="

# Disk space
DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | tr -d '%')
echo "Disk: ${DISK_USAGE}% used"
if [ "$DISK_USAGE" -gt 90 ]; then
  echo "⚠️ DISK WARNING: ${DISK_USAGE}% full"
  exit 1
fi

# Memory
if [[ "$(uname)" == "Darwin" ]]; then
  MEM_PRESSURE=$(memory_pressure | grep "System-wide memory free percentage" | awk '{print $NF}' | tr -d '%')
  echo "Memory free: ${MEM_PRESSURE}%"
else
  MEM_FREE=$(free -m | awk 'NR==2 {printf "%.0f", $7/$2*100}')
  echo "Memory free: ${MEM_FREE}%"
fi

# Bridge processes
BRIDGES=$(pgrep -f "bridge.js" | wc -l | tr -d ' ')
echo "Bridge processes: ${BRIDGES}"
if [ "$BRIDGES" -eq 0 ]; then
  echo "⚠️ No bridge processes running"
  exit 1
fi

echo "✅ All healthy"
```

### Task: Morning Report (`scripts/morning-report.js`)

```javascript
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

const ai = new Anthropic();
const JOURNAL_DIR = join(process.cwd(), 'memory', 'journal');
const STATE_FILE = join(process.cwd(), 'state.json');
const NOTIFY_URL = process.env.NOTIFY_ENDPOINT;

async function generateMorningReport() {
  // Gather overnight state
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  
  // Get yesterday's and today's journal
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  
  const journals = [yesterday, today]
    .map(date => {
      const file = join(JOURNAL_DIR, `${date}.md`);
      try { return readFileSync(file, 'utf-8'); } 
      catch { return ''; }
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  // Task status summary
  const taskSummary = Object.entries(state)
    .map(([id, s]) => `${s.status === 'success' ? '✅' : '❌'} ${id}: ${s.status} (${s.elapsed}s)`)
    .join('\n');

  // Ask AI to write the report
  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: `Write a brief morning report (max 5 lines) for Tony. 
Be concise and friendly. Include: system status, any overnight alerts, 
and what needs attention today. Use emoji sparingly.`,
    messages: [{
      role: 'user',
      content: `Overnight task status:\n${taskSummary}\n\nRecent journal:\n${journals}`
    }],
  });

  const report = response.content[0].text;
  
  // Send to phone
  if (NOTIFY_URL) {
    await fetch(NOTIFY_URL, { method: 'POST', body: report });
  }
  
  console.log(report);
}

generateMorningReport().catch(console.error);
```

### Task Configuration (`tasks.json`)

```json
[
  {
    "id": "health_check",
    "tier": 1,
    "intervalMinutes": 5,
    "command": "bash scripts/health-check.sh",
    "enabled": true
  },
  {
    "id": "caffeinate_guard",
    "tier": 1,
    "intervalMinutes": 10,
    "command": "pgrep caffeinate || caffeinate -dims &",
    "enabled": true
  },
  {
    "id": "bridge_monitor",
    "tier": 1,
    "intervalMinutes": 5,
    "command": "pgrep -f bridge.js || node bridge.js &",
    "enabled": true
  },
  {
    "id": "morning_report",
    "tier": 2,
    "intervalMinutes": 1440,
    "runAt": "06:00",
    "command": "node scripts/morning-report.js",
    "enabled": true
  }
]
```

## Push Notifications

The orchestrator needs a way to reach you. The simplest solution: **[ntfy.sh](https://ntfy.sh)** — a free, open-source push notification service.

```bash
# Send a notification from anywhere
curl -d "Hello from your AI" ntfy.sh/your-secret-topic
```

Install ntfy on your phone, subscribe to your topic, and your AI can ping you anytime.

Set it up:
```bash
# In your .env
NOTIFY_ENDPOINT=https://ntfy.sh/your-secret-topic-name
```

> 🔒 **Security tip**: Use a random, unguessable topic name. Anyone who knows the topic can send you notifications.

## Running the Orchestrator

### Development

```bash
node orchestrator.js
```

### Production (macOS with launchd)

Create `~/Library/LaunchAgents/com.ai-assistant.orchestrator.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" 
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ai-assistant.orchestrator</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/your/orchestrator.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/your/project</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/orchestrator.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/orchestrator-error.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.ai-assistant.orchestrator.plist
```

### Production (Linux with systemd)

```ini
# /etc/systemd/system/ai-orchestrator.service
[Unit]
Description=AI Assistant Orchestrator
After=network.target

[Service]
Type=simple
User=yourusername
WorkingDirectory=/path/to/your/project
ExecStart=/usr/bin/node orchestrator.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable ai-orchestrator
sudo systemctl start ai-orchestrator
```

## File Structure After This Chapter

```
my-ai-assistant/
├── bridge.js
├── orchestrator.js          ← NEW: The brain that runs tasks
├── tasks.json               ← NEW: Task configuration
├── state.json               ← NEW: Auto-generated runtime state
├── .heartbeat               ← NEW: Auto-touched heartbeat file
├── scripts/
│   ├── health-check.sh      ← NEW: Tier 1 health check
│   └── morning-report.js    ← NEW: Tier 2 AI-powered report
├── memory/
│   ├── working-memory.md
│   └── journal/
├── .env
└── package.json
```

## What This Unlocks

With the orchestrator running, your AI assistant is now **autonomous**:

- 🌅 **Morning**: You wake up to a push notification summarizing the night's work
- 🏥 **Crashes**: Bridges restart automatically, you never notice
- 📊 **Monitoring**: Disk, memory, process health — checked every 5 minutes
- 🔍 **Indexing**: New documents embedded into vector memory overnight
- 📱 **Alerts**: Problems reach your phone immediately

You're no longer managing an AI tool. You're running an AI **system**.

---

<div align="center">

**Your AI now works while you sleep.** Time to make it unkillable.

[← Chapter 05: Bridge Protocol](05-bridge-protocol.md) · [**Chapter 07: Self-Healing →**](07-self-healing.md)

</div>
