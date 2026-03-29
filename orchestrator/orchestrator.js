#!/usr/bin/env node
/**
 * 🦀🎯 HermitCrab Orchestrator — Three-Tier Heartbeat System
 * 
 * The orchestrator sits ABOVE both bridges. It initiates actions
 * on schedules, wakes agents, and ensures task resilience.
 * 
 * Three tiers:
 *   L1 (Stateless): New session tasks — LLM-powered but no persistent context
 *   L2 (Stateful):  Wake agent in persistent session with full context
 *   L3 (Shared):    Failed tasks cascade to other agents or L1 fallback
 * 
 * Architecture:
 *   Orchestrator → antigravity-cli (direct agent wake)
 *                → Graph API (Teams posting)
 *                → Telegram bridge /notify (push notifications)
 *                → Teams bridge /notify (Teams notifications)
 *                → ntfy.sh (mobile alerts)
 * 
 * Standalone process. Own launchd plist. Does NOT live inside any bridge.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFile, exec, execSync } = require("child_process");
const os = require("os");

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const WORKSPACE = process.env.HERMITCRAB_WORKSPACE || path.resolve(__dirname, "../..");
const CLI_PATH = process.env.ANTIGRAVITY_CLI || path.join(process.env.HOME, ".local/bin/antigravity-cli");
const BRIDGE_PORT = process.env.ANTIGRAVITY_BRIDGE_PORT || "";
const PATH_ENV = `${path.dirname(CLI_PATH)}:${process.env.PATH}`;
const HTTP_PORT = parseInt(process.env.ORCHESTRATOR_PORT || "18793", 10);

// Bridge endpoints (for notifications)
const TELEGRAM_NOTIFY_URL = "http://localhost:18790/notify";
const TEAMS_NOTIFY_URL = "http://localhost:18795/notify";
const NTFY_TOPIC = "tonysM5";

// Task & state files (overridable via env for multi-machine setups)
const TASKS_FILE = process.env.TASKS_FILE_OVERRIDE || path.join(__dirname, "tasks.json");
const STATE_FILE = process.env.STATE_FILE_OVERRIDE || path.join(__dirname, "state.json");

// Machine identity
const MACHINE_NAME = (() => {
  try { return execSync("scutil --get ComputerName", { encoding: "utf-8" }).trim(); }
  catch { return os.hostname(); }
})();

// Default models
const STATELESS_MODEL = "gemini-3-flash"; // L1: cheap, fast, disposable
const STATEFUL_MODEL = "claude-opus-4.6"; // L2: premium, full context

// Timing
const TICK_INTERVAL_MS = 30000; // Check tasks every 30 seconds
const TASK_TIMEOUT_MS = 300000; // 5 min timeout for task execution
const MAX_CONSECUTIVE_ERRORS = 5;

// Backoff schedule (OpenClaw pattern)
const BACKOFF_SCHEDULE_MS = [
  30000,    // 30s
  60000,    // 1 min
  300000,   // 5 min
  900000,   // 15 min
  3600000,  // 60 min
];

// ═══════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════
function log(event, data = {}) {
  const entry = { event, ...data, ts: new Date().toISOString(), machine: MACHINE_NAME };
  console.log(JSON.stringify(entry));
}

// ═══════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════
let state = {
  taskStates: {},   // taskId → { lastRun, lastResult, consecutiveErrors, nextRun, status, claimedBy }
  startedAt: null,
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (e) {
    log("STATE_LOAD_ERROR", { error: e.message });
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log("STATE_SAVE_ERROR", { error: e.message });
  }
}

function getTaskState(taskId) {
  if (!state.taskStates[taskId]) {
    state.taskStates[taskId] = {
      lastRun: null,
      lastResult: null,
      consecutiveErrors: 0,
      nextRun: null,
      status: "idle",     // idle, running, done, failed, claimed
      claimedBy: null,    // which agent claimed a failed task
      lastError: null,
    };
  }
  return state.taskStates[taskId];
}

// ═══════════════════════════════════════════
// TASK DEFINITIONS
// ═══════════════════════════════════════════
let tasks = [];

function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      tasks = JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8"));
      log("TASKS_LOADED", { count: tasks.length, tasks: tasks.map(t => t.id) });
    } else {
      log("TASKS_FILE_MISSING", { path: TASKS_FILE });
      tasks = [];
    }
  } catch (e) {
    log("TASKS_LOAD_ERROR", { error: e.message });
    tasks = [];
  }
}

// ═══════════════════════════════════════════
// SCHEDULE PARSER — cron-like expressions
// Supports: interval (every Xm/Xh), daily (HH:MM), cron (simple)
// ═══════════════════════════════════════════
function parseSchedule(schedule) {
  // Interval: "every 5m", "every 2h", "every 30s"
  const intervalMatch = schedule.match(/^every\s+(\d+)\s*(s|m|h)$/i);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    const ms = unit === "s" ? value * 1000 : unit === "m" ? value * 60000 : value * 3600000;
    return { type: "interval", ms };
  }

  // Daily: "daily 06:00", "daily 22:30"
  const dailyMatch = schedule.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (dailyMatch) {
    return { type: "daily", hour: parseInt(dailyMatch[1], 10), minute: parseInt(dailyMatch[2], 10) };
  }

  // Once: "once" — run once then disable
  if (schedule.toLowerCase() === "once") {
    return { type: "once" };
  }

  log("SCHEDULE_PARSE_ERROR", { schedule });
  return null;
}

function shouldRunNow(task) {
  const taskState = getTaskState(task.id);
  
  // Don't run if currently running
  if (taskState.status === "running") return false;
  
  // Don't run disabled tasks
  if (task.enabled === false) return false;

  const schedule = parseSchedule(task.schedule);
  if (!schedule) return false;

  const now = Date.now();

  if (schedule.type === "interval") {
    if (!taskState.lastRun) return true; // Never run before
    const elapsed = now - new Date(taskState.lastRun).getTime();
    // Apply backoff if there are consecutive errors
    if (taskState.consecutiveErrors > 0) {
      const backoffIdx = Math.min(taskState.consecutiveErrors - 1, BACKOFF_SCHEDULE_MS.length - 1);
      const backoffMs = BACKOFF_SCHEDULE_MS[backoffIdx];
      return elapsed >= Math.max(schedule.ms, backoffMs);
    }
    return elapsed >= schedule.ms;
  }

  if (schedule.type === "daily") {
    const nowDate = new Date();
    const todayTarget = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 
      schedule.hour, schedule.minute, 0, 0);
    
    // Haven't run today and we're past the target time
    if (!taskState.lastRun) return now >= todayTarget.getTime();
    const lastRunDate = new Date(taskState.lastRun);
    const lastRunDay = `${lastRunDate.getFullYear()}-${lastRunDate.getMonth()}-${lastRunDate.getDate()}`;
    const todayStr = `${nowDate.getFullYear()}-${nowDate.getMonth()}-${nowDate.getDate()}`;
    return lastRunDay !== todayStr && now >= todayTarget.getTime();
  }

  if (schedule.type === "once") {
    return !taskState.lastRun; // Only run if never run before
  }

  return false;
}

// ═══════════════════════════════════════════
// NOTIFICATION HELPERS
// ═══════════════════════════════════════════
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function notifyTelegram(text) {
  try {
    await httpPost(TELEGRAM_NOTIFY_URL, { text });
    log("NOTIFY_TELEGRAM", { text: text.substring(0, 80) });
  } catch (e) {
    log("NOTIFY_TELEGRAM_ERROR", { error: e.message });
  }
}

async function notifyTeams(text, conversationId) {
  try {
    await httpPost(TEAMS_NOTIFY_URL, { text, conversation_id: conversationId });
    log("NOTIFY_TEAMS", { text: text.substring(0, 80) });
  } catch (e) {
    log("NOTIFY_TEAMS_ERROR", { error: e.message });
  }
}

async function notifyNtfy(text) {
  try {
    exec(`curl -s -d "${text.replace(/"/g, '\\"')}" ntfy.sh/${NTFY_TOPIC}`);
    log("NOTIFY_NTFY", { text: text.substring(0, 80) });
  } catch (e) {
    log("NOTIFY_NTFY_ERROR", { error: e.message });
  }
}

async function notifyAll(text) {
  await Promise.allSettled([
    notifyTelegram(text),
    notifyNtfy(text),
  ]);
}

// ═══════════════════════════════════════════
// L1: STATELESS TASK EXECUTION
// New session, no persistent context. Fire-and-forget.
// Can use LLM but starts fresh every time.
// ═══════════════════════════════════════════
async function executeL1(task) {
  const taskState = getTaskState(task.id);
  taskState.status = "running";
  taskState.lastRun = new Date().toISOString();
  saveState();

  log("L1_START", { task: task.id, prompt: task.prompt?.substring(0, 80) });

  return new Promise((resolve) => {
    if (task.command) {
      // Shell command execution
      exec(task.command, { 
        cwd: WORKSPACE, 
        timeout: TASK_TIMEOUT_MS,
        env: { ...process.env, PATH: PATH_ENV },
      }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: error.message, output: stderr || stdout });
        } else {
          resolve({ success: true, output: stdout.trim() });
        }
      });
    } else if (task.prompt) {
      // LLM stateless execution — new session, fire-and-forget
      const model = task.model || STATELESS_MODEL;
      const portArgs = BRIDGE_PORT ? ["-p", BRIDGE_PORT] : [];
      const args = [...portArgs, "-m", model, "-a", task.prompt];

      execFile(CLI_PATH, args, {
        cwd: WORKSPACE,
        env: { ...process.env, PATH: PATH_ENV },
        timeout: TASK_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: error.message, output: stderr || stdout });
        } else {
          resolve({ success: true, output: (stdout || "").trim() });
        }
      });
    } else {
      resolve({ success: false, error: "Task has no command or prompt" });
    }
  });
}

// ═══════════════════════════════════════════
// L2: STATEFUL TASK EXECUTION
// Resume persistent session with full context.
// Agent has memory, patterns, working knowledge.
// ═══════════════════════════════════════════
async function executeL2(task) {
  const taskState = getTaskState(task.id);
  taskState.status = "running";
  taskState.lastRun = new Date().toISOString();
  saveState();

  log("L2_START", { task: task.id, agent: task.agent, session: task.sessionId?.substring(0, 8) });

  return new Promise((resolve) => {
    const model = task.model || STATEFUL_MODEL;
    const portArgs = BRIDGE_PORT ? ["-p", BRIDGE_PORT] : [];
    
    // Build the prompt with orchestrator context
    const orchestratorContext = `[🎯 Orchestrator Heartbeat — ${MACHINE_NAME}]\nScheduled task: "${task.name}"\nTask ID: ${task.id}\n\n`;
    const fullPrompt = orchestratorContext + (task.prompt || task.name);

    let args;
    if (task.sessionId) {
      // Resume existing session
      args = [...portArgs, "-m", model, "-a", "-r", task.sessionId, fullPrompt];
    } else {
      // New session (will need to capture UUID for future resumes)
      args = [...portArgs, "-m", model, "-a", fullPrompt];
    }

    execFile(CLI_PATH, args, {
      cwd: WORKSPACE,
      env: { ...process.env, PATH: PATH_ENV },
      timeout: TASK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const rawOutput = ((stdout || "") + (stderr || "")).replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\[\?[0-9]*[a-zA-Z]|\r/g, "").trim();
      
      if (error) {
        resolve({ success: false, error: error.message, output: rawOutput });
      } else {
        // Try to capture session UUID for future L2 resumes
        const uuidMatch = rawOutput.match(/Cascade:\s*([a-f0-9]+)/i);
        if (uuidMatch && !task.sessionId) {
          log("L2_SESSION_CAPTURED", { task: task.id, partialUUID: uuidMatch[1] });
          // Could update task config with session ID for future runs
        }
        resolve({ success: true, output: rawOutput });
      }
    });
  });
}

// ═══════════════════════════════════════════
// L3: SHARED RESPONSIBILITY
// When a task fails, attempt recovery through other agents
// or escalate the failure for human intervention.
// ═══════════════════════════════════════════
async function handleTaskFailure(task, result) {
  const taskState = getTaskState(task.id);
  taskState.consecutiveErrors++;
  taskState.lastError = result.error || "Unknown error";
  taskState.lastResult = "failed";
  taskState.status = "failed";
  saveState();

  log("TASK_FAILED", { 
    task: task.id, 
    level: task.level,
    errors: taskState.consecutiveErrors,
    error: taskState.lastError,
  });

  // L3 Escalation chain
  if (task.level === 1 && task.l3_heal) {
    // L1 failure → try L2 agent to diagnose and heal
    log("L3_ESCALATE", { task: task.id, from: "L1", to: "L2", healer: task.l3_heal });
    
    const healPrompt = `[🚨 Orchestrator L3 — Task Failure Recovery]\n\nA scheduled task failed and needs your help:\n\nTask: "${task.name}" (${task.id})\nLevel: L1 (stateless)\nError: ${taskState.lastError}\nConsecutive failures: ${taskState.consecutiveErrors}\nCommand/Prompt: ${task.command || task.prompt}\n\nPlease diagnose the issue and attempt to fix it. If you can resolve it, run the task yourself. If you can't, explain what went wrong so Tony can fix it when he's available.`;

    const healTask = {
      id: `l3_heal_${task.id}`,
      name: `Heal: ${task.name}`,
      level: 2,
      agent: task.l3_heal,
      prompt: healPrompt,
      model: STATEFUL_MODEL,
    };

    const healResult = await executeL2(healTask);
    if (healResult.success) {
      taskState.claimedBy = task.l3_heal;
      taskState.status = "claimed";
      log("L3_HEALED", { task: task.id, healer: task.l3_heal });
      saveState();
      return;
    }
  }

  // If L2 task fails, try alternative agents
  if (task.level === 2 && task.l3_fallback_agents && task.l3_fallback_agents.length > 0) {
    for (const fallbackAgent of task.l3_fallback_agents) {
      if (fallbackAgent === task.agent) continue; // Skip the one that already failed

      log("L3_FALLBACK", { task: task.id, from: task.agent, to: fallbackAgent });
      
      const fallbackTask = { ...task, agent: fallbackAgent, id: `l3_fallback_${task.id}` };
      const fallbackResult = await executeL2(fallbackTask);
      
      if (fallbackResult.success) {
        taskState.claimedBy = fallbackAgent;
        taskState.status = "claimed";
        log("L3_CLAIMED", { task: task.id, claimedBy: fallbackAgent });
        saveState();
        return;
      }
    }
  }

  // All recovery failed → alert human
  if (taskState.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    const alertMsg = `🚨 Orchestrator: Task "${task.name}" failed ${taskState.consecutiveErrors} times. Last error: ${taskState.lastError}. Needs human attention.`;
    await notifyAll(alertMsg);
    log("L3_HUMAN_ALERT", { task: task.id, errors: taskState.consecutiveErrors });
  }
}

// ═══════════════════════════════════════════
// TASK RUNNER — the main execution loop
// ═══════════════════════════════════════════
async function runTask(task) {
  const taskState = getTaskState(task.id);

  log("TASK_RUN", { task: task.id, level: task.level, name: task.name });

  let result;
  try {
    if (task.level === 1) {
      result = await executeL1(task);
    } else if (task.level === 2) {
      result = await executeL2(task);
    } else {
      log("TASK_UNKNOWN_LEVEL", { task: task.id, level: task.level });
      return;
    }
  } catch (e) {
    result = { success: false, error: e.message };
  }

  if (result.success) {
    taskState.consecutiveErrors = 0;
    taskState.lastResult = "success";
    taskState.status = "done";
    taskState.lastError = null;
    taskState.claimedBy = null;
    log("TASK_OK", { task: task.id, output: result.output?.substring(0, 200) });
  } else {
    await handleTaskFailure(task, result);
  }

  saveState();
}

// ═══════════════════════════════════════════
// PRE-FLIGHT — Night job roadblock detection
// Before Tony sleeps, analyze the specific night task
// and surface any potential blockers.
// ═══════════════════════════════════════════
async function runPreflight(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  log("PREFLIGHT_START", { task: taskId });

  const checks = [];

  // System checks
  try {
    const diskInfo = execSync("df -h / | tail -1", { encoding: "utf-8" }).trim();
    const diskParts = diskInfo.split(/\s+/);
    const diskUsedPercent = parseInt(diskParts[4]);
    checks.push({
      name: "Disk Space",
      status: diskUsedPercent < 90 ? "✅" : "⚠️",
      detail: `${diskParts[4]} used (${diskParts[3]} available)`,
    });
  } catch (e) {
    checks.push({ name: "Disk Space", status: "❓", detail: e.message });
  }

  // Memory check
  try {
    const memInfo = execSync("vm_stat | head -5", { encoding: "utf-8" });
    checks.push({ name: "Memory", status: "✅", detail: "vm_stat accessible" });
  } catch (e) {
    checks.push({ name: "Memory", status: "❓", detail: e.message });
  }

  // antigravity-cli check
  try {
    execSync(`${CLI_PATH} --version 2>&1 || echo "available"`, { encoding: "utf-8" });
    checks.push({ name: "antigravity-cli", status: "✅", detail: "Available" });
  } catch (e) {
    checks.push({ name: "antigravity-cli", status: "❌", detail: "Not available" });
  }

  // Bridge health checks
  try {
    const telegramHealth = execSync("curl -s http://localhost:18790/status", { encoding: "utf-8", timeout: 5000 });
    checks.push({ name: "Telegram Bridge", status: "✅", detail: "Running" });
  } catch {
    checks.push({ name: "Telegram Bridge", status: "⚠️", detail: "Not responding" });
  }

  try {
    const teamsHealth = execSync("curl -s http://localhost:18795/status 2>/dev/null || curl -s http://localhost:3979/status 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
    checks.push({ name: "Teams Bridge", status: "✅", detail: "Running" });
  } catch {
    checks.push({ name: "Teams Bridge", status: "⚠️", detail: "Not responding" });
  }

  // Task-specific checks from task config
  if (task.preflight_checks) {
    for (const check of task.preflight_checks) {
      try {
        const output = execSync(check.command, { encoding: "utf-8", timeout: 10000 }).trim();
        const passed = check.expect ? output.includes(check.expect) : true;
        checks.push({
          name: check.name,
          status: passed ? "✅" : "⚠️",
          detail: output.substring(0, 100),
        });
      } catch (e) {
        checks.push({ name: check.name, status: "❌", detail: e.message.substring(0, 100) });
      }
    }
  }

  const blockers = checks.filter(c => c.status === "❌" || c.status === "⚠️");
  const allClear = blockers.length === 0;

  const report = {
    task: task.name,
    taskId: task.id,
    timestamp: new Date().toISOString(),
    machine: MACHINE_NAME,
    allClear,
    checks,
    blockers,
  };

  log("PREFLIGHT_DONE", { task: taskId, allClear, blockers: blockers.length });

  return report;
}

// ═══════════════════════════════════════════
// STARTUP CATCH-UP (OpenClaw pattern)
// Check if any tasks were missed while orchestrator was down.
// ═══════════════════════════════════════════
function startupCatchUp() {
  log("STARTUP_CATCHUP", { taskCount: tasks.length });

  for (const task of tasks) {
    if (task.enabled === false) continue;
    if (task.catch_up === false) continue; // Skip tasks that don't want catch-up

    const taskState = getTaskState(task.id);
    if (shouldRunNow(task)) {
      log("CATCHUP_DUE", { task: task.id, lastRun: taskState.lastRun });
      // Will be picked up by the next tick
    }
  }
}

// ═══════════════════════════════════════════
// MAIN TICK — runs on interval, checks all tasks
// ═══════════════════════════════════════════
async function tick() {
  for (const task of tasks) {
    if (shouldRunNow(task)) {
      // Don't await — let tasks run concurrently if needed
      runTask(task).catch(e => {
        log("TICK_ERROR", { task: task.id, error: e.message });
      });
    }
  }
}

// ═══════════════════════════════════════════
// HTTP API — management interface
// ═══════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  // GET /status — health + running tasks
  if (req.method === "GET" && (req.url === "/status" || req.url === "/")) {
    res.writeHead(200);
    res.end(JSON.stringify({
      name: "🦀🎯 HermitCrab Orchestrator",
      status: "running",
      machine: MACHINE_NAME,
      uptime_s: Math.round(process.uptime()),
      taskCount: tasks.length,
      taskStates: state.taskStates,
      features: ["L1_stateless", "L2_stateful", "L3_shared_responsibility", "preflight", "catch_up"],
    }, null, 2));
    return;
  }

  // GET /tasks — list all task definitions
  if (req.method === "GET" && req.url === "/tasks") {
    res.writeHead(200);
    res.end(JSON.stringify(tasks, null, 2));
    return;
  }

  // POST /run/:taskId — manually trigger a task
  if (req.method === "POST" && req.url.startsWith("/run/")) {
    const taskId = req.url.substring(5);
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: `Task "${taskId}" not found` }));
      return;
    }
    // Run async, respond immediately
    runTask(task).catch(e => log("MANUAL_RUN_ERROR", { task: taskId, error: e.message }));
    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, task: taskId, status: "triggered" }));
    return;
  }

  // POST /preflight/:taskId — run pre-flight checks for a task
  if (req.method === "POST" && req.url.startsWith("/preflight/")) {
    const taskId = req.url.substring(11);
    const report = await runPreflight(taskId);
    res.writeHead(200);
    res.end(JSON.stringify(report, null, 2));
    return;
  }

  // POST /reload — reload tasks.json
  if (req.method === "POST" && req.url === "/reload") {
    loadTasks();
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, taskCount: tasks.length }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

// ═══════════════════════════════════════════
// GRACEFUL RESTART (SIGUSR1 — OpenClaw pattern)
// ═══════════════════════════════════════════
process.on("SIGUSR1", () => {
  log("GRACEFUL_RESTART", { reason: "SIGUSR1 received" });
  saveState();
  
  // Reload tasks
  loadTasks();
  
  log("GRACEFUL_RESTART_DONE", { taskCount: tasks.length });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log("SHUTDOWN", { reason: "SIGTERM" });
  saveState();
  process.exit(0);
});

process.on("SIGINT", () => {
  log("SHUTDOWN", { reason: "SIGINT" });
  saveState();
  process.exit(0);
});

// ═══════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════
async function start() {
  log("STARTING", { 
    machine: MACHINE_NAME, 
    workspace: WORKSPACE,
    port: HTTP_PORT,
    cli: CLI_PATH,
    tick_interval: TICK_INTERVAL_MS,
  });

  // Load state and tasks
  loadState();
  state.startedAt = new Date().toISOString();
  loadTasks();

  // Startup catch-up
  startupCatchUp();

  // Start HTTP API
  server.listen(HTTP_PORT, "127.0.0.1", () => {
    log("HTTP_READY", { port: HTTP_PORT, url: `http://localhost:${HTTP_PORT}` });
  });

  // Start the tick loop
  setInterval(() => {
    tick().catch(e => log("TICK_FATAL", { error: e.message }));
  }, TICK_INTERVAL_MS);

  // Initial tick
  await tick();

  log("STARTED", { 
    taskCount: tasks.length, 
    machine: MACHINE_NAME,
  });
}

// ═══════════════════════════════════════════
// MODULE EXPORTS (for testing)
// ═══════════════════════════════════════════
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseSchedule,
    shouldRunNow,
    getTaskState,
    loadState,
    saveState,
    loadTasks,
    runTask,
    executeL1,
    executeL2,
    handleTaskFailure,
    runPreflight,
    startupCatchUp,
    tick,
    httpPost,
    notifyAll,
    // Expose internals for test manipulation
    get state() { return state; },
    set state(s) { state = s; },
    get tasks() { return tasks; },
    set tasks(t) { tasks = t; },
    // Config constants
    BACKOFF_SCHEDULE_MS,
    MAX_CONSECUTIVE_ERRORS,
    TICK_INTERVAL_MS,
    TASK_TIMEOUT_MS,
    STATE_FILE,
    TASKS_FILE,
    // Server (for integration tests)
    server,
    start,
  };
}

// Port guard — prevent double instances (only when run directly)
if (require.main === module) {
  const net = require("net");
  const portCheck = net.createServer();
  portCheck.once("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`❌ Orchestrator already running on port ${HTTP_PORT}`);
      process.exit(1);
    }
  });
  portCheck.once("listening", () => {
    portCheck.close();
    start();
  });
  portCheck.listen(HTTP_PORT, "127.0.0.1");
}
