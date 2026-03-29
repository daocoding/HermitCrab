#!/usr/bin/env node
/**
 * 🧪 Orchestrator Unit Tests
 * Tests pure logic functions in isolation — no HTTP, no subprocess, no bridges.
 */

const assert = require("assert");
const path = require("path");

// Suppress orchestrator logs during testing
const originalLog = console.log;
const originalError = console.error;
let logCapture = [];
console.log = (...args) => logCapture.push(args.map(String).join(" "));
console.error = (...args) => logCapture.push(args.map(String).join(" "));

const orch = require("./orchestrator");

// Restore console after require (module-level logs captured)
// Keep suppressed for tests — re-enable per test if needed

let passed = 0;
let failed = 0;
let total = 0;

function test(name, fn) {
  total++;
  logCapture = [];
  try {
    fn();
    passed++;
    originalLog(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    originalLog(`  ❌ ${name}`);
    originalLog(`     ${e.message}`);
    if (logCapture.length > 0) {
      originalLog(`     Logs: ${logCapture.slice(-3).join(" | ")}`);
    }
  }
}

function resetState() {
  orch.state = { taskStates: {}, startedAt: null };
}

// ═══════════════════════════════════════════
// parseSchedule tests
// ═══════════════════════════════════════════

originalLog("\n📐 parseSchedule");

test("parses 'every 5m'", () => {
  const result = orch.parseSchedule("every 5m");
  assert.deepStrictEqual(result, { type: "interval", ms: 300000 });
});

test("parses 'every 30s'", () => {
  const result = orch.parseSchedule("every 30s");
  assert.deepStrictEqual(result, { type: "interval", ms: 30000 });
});

test("parses 'every 2h'", () => {
  const result = orch.parseSchedule("every 2h");
  assert.deepStrictEqual(result, { type: "interval", ms: 7200000 });
});

test("parses 'every 1m' (boundary)", () => {
  const result = orch.parseSchedule("every 1m");
  assert.deepStrictEqual(result, { type: "interval", ms: 60000 });
});

test("parses 'daily 06:00'", () => {
  const result = orch.parseSchedule("daily 06:00");
  assert.deepStrictEqual(result, { type: "daily", hour: 6, minute: 0 });
});

test("parses 'daily 22:30'", () => {
  const result = orch.parseSchedule("daily 22:30");
  assert.deepStrictEqual(result, { type: "daily", hour: 22, minute: 30 });
});

test("parses 'once'", () => {
  const result = orch.parseSchedule("once");
  assert.deepStrictEqual(result, { type: "once" });
});

test("parses 'ONCE' (case insensitive)", () => {
  const result = orch.parseSchedule("ONCE");
  assert.deepStrictEqual(result, { type: "once" });
});

test("parses 'EVERY 10M' (case insensitive)", () => {
  const result = orch.parseSchedule("EVERY 10M");
  assert.deepStrictEqual(result, { type: "interval", ms: 600000 });
});

test("returns null for invalid schedule", () => {
  const result = orch.parseSchedule("sometime today");
  assert.strictEqual(result, null);
});

test("returns null for empty string", () => {
  const result = orch.parseSchedule("");
  assert.strictEqual(result, null);
});

test("returns null for cron-like (not implemented)", () => {
  const result = orch.parseSchedule("0 */5 * * *");
  assert.strictEqual(result, null);
});

// ═══════════════════════════════════════════
// getTaskState tests
// ═══════════════════════════════════════════

originalLog("\n📦 getTaskState");

test("creates default state for new task", () => {
  resetState();
  const ts = orch.getTaskState("test_task_1");
  assert.strictEqual(ts.lastRun, null);
  assert.strictEqual(ts.lastResult, null);
  assert.strictEqual(ts.consecutiveErrors, 0);
  assert.strictEqual(ts.status, "idle");
  assert.strictEqual(ts.claimedBy, null);
  assert.strictEqual(ts.lastError, null);
});

test("returns same reference on second call", () => {
  resetState();
  const ts1 = orch.getTaskState("test_task_2");
  ts1.status = "running";
  const ts2 = orch.getTaskState("test_task_2");
  assert.strictEqual(ts2.status, "running");
  assert.strictEqual(ts1, ts2);
});

test("different tasks get different states", () => {
  resetState();
  const ts1 = orch.getTaskState("task_a");
  const ts2 = orch.getTaskState("task_b");
  ts1.status = "done";
  assert.strictEqual(ts2.status, "idle");
});

// ═══════════════════════════════════════════
// shouldRunNow tests
// ═══════════════════════════════════════════

originalLog("\n⏰ shouldRunNow");

test("interval task with no lastRun → should run", () => {
  resetState();
  const task = { id: "t1", schedule: "every 5m", enabled: true };
  assert.strictEqual(orch.shouldRunNow(task), true);
});

test("interval task run recently → should NOT run", () => {
  resetState();
  const task = { id: "t2", schedule: "every 5m", enabled: true };
  const ts = orch.getTaskState("t2");
  ts.lastRun = new Date().toISOString(); // Just ran
  assert.strictEqual(orch.shouldRunNow(task), false);
});

test("interval task run long ago → should run", () => {
  resetState();
  const task = { id: "t3", schedule: "every 5m", enabled: true };
  const ts = orch.getTaskState("t3");
  ts.lastRun = new Date(Date.now() - 600000).toISOString(); // 10 min ago
  assert.strictEqual(orch.shouldRunNow(task), true);
});

test("disabled task → should NOT run", () => {
  resetState();
  const task = { id: "t4", schedule: "every 1m", enabled: false };
  assert.strictEqual(orch.shouldRunNow(task), false);
});

test("running task → should NOT re-run", () => {
  resetState();
  const task = { id: "t5", schedule: "every 1m", enabled: true };
  const ts = orch.getTaskState("t5");
  ts.status = "running";
  assert.strictEqual(orch.shouldRunNow(task), false);
});

test("once task never run → should run", () => {
  resetState();
  const task = { id: "t6", schedule: "once", enabled: true };
  assert.strictEqual(orch.shouldRunNow(task), true);
});

test("once task already run → should NOT run", () => {
  resetState();
  const task = { id: "t7", schedule: "once", enabled: true };
  const ts = orch.getTaskState("t7");
  ts.lastRun = new Date().toISOString();
  assert.strictEqual(orch.shouldRunNow(task), false);
});

test("invalid schedule → should NOT run", () => {
  resetState();
  const task = { id: "t8", schedule: "whenever", enabled: true };
  assert.strictEqual(orch.shouldRunNow(task), false);
});

// ═══════════════════════════════════════════
// Backoff logic tests
// ═══════════════════════════════════════════

originalLog("\n🔄 Backoff logic");

test("1 consecutive error → 30s backoff", () => {
  resetState();
  const task = { id: "tb1", schedule: "every 5m", enabled: true };
  const ts = orch.getTaskState("tb1");
  ts.lastRun = new Date(Date.now() - 35000).toISOString(); // 35s ago
  ts.consecutiveErrors = 1;
  // 30s backoff, but interval is 5m → max(5m, 30s) = 5m → should NOT run (only 35s passed)
  assert.strictEqual(orch.shouldRunNow(task), false);
});

test("1 consecutive error with short interval → backoff wins", () => {
  resetState();
  const task = { id: "tb2", schedule: "every 10s", enabled: true };
  const ts = orch.getTaskState("tb2");
  ts.lastRun = new Date(Date.now() - 15000).toISOString(); // 15s ago
  ts.consecutiveErrors = 1;
  // max(10s, 30s) = 30s, only 15s passed → should NOT run
  assert.strictEqual(orch.shouldRunNow(task), false);
});

test("1 consecutive error with short interval, enough time passed → should run", () => {
  resetState();
  const task = { id: "tb3", schedule: "every 10s", enabled: true };
  const ts = orch.getTaskState("tb3");
  ts.lastRun = new Date(Date.now() - 31000).toISOString(); // 31s ago
  ts.consecutiveErrors = 1;
  // max(10s, 30s) = 30s, 31s passed → should run
  assert.strictEqual(orch.shouldRunNow(task), true);
});

test("5 consecutive errors → 60min backoff (max)", () => {
  resetState();
  const task = { id: "tb4", schedule: "every 1m", enabled: true };
  const ts = orch.getTaskState("tb4");
  ts.lastRun = new Date(Date.now() - 900000).toISOString(); // 15 min ago
  ts.consecutiveErrors = 5;
  // backoff index 4 → 3600000 (60min), max(1m, 60m) = 60m, only 15m passed → should NOT run
  assert.strictEqual(orch.shouldRunNow(task), false);
});

test("errors beyond schedule length → caps at max backoff", () => {
  resetState();
  const task = { id: "tb5", schedule: "every 1m", enabled: true };
  const ts = orch.getTaskState("tb5");
  ts.lastRun = new Date(Date.now() - 3700000).toISOString(); // 61+ min ago
  ts.consecutiveErrors = 100; // Way beyond schedule length
  // Should cap at index 4 (60min), 61min passed → should run
  assert.strictEqual(orch.shouldRunNow(task), true);
});

test("0 consecutive errors → no backoff applied", () => {
  resetState();
  const task = { id: "tb6", schedule: "every 10s", enabled: true };
  const ts = orch.getTaskState("tb6");
  ts.lastRun = new Date(Date.now() - 11000).toISOString(); // 11s ago
  ts.consecutiveErrors = 0;
  // Normal interval: 10s, 11s passed → should run
  assert.strictEqual(orch.shouldRunNow(task), true);
});

// ═══════════════════════════════════════════
// Daily schedule tests
// ═══════════════════════════════════════════

originalLog("\n📅 Daily schedule");

test("daily task, past target time, never run → should run", () => {
  resetState();
  // Set target to 1 hour ago
  const now = new Date();
  const pastHour = now.getHours() > 0 ? now.getHours() - 1 : 23;
  const task = { id: "td1", schedule: `daily ${String(pastHour).padStart(2, "0")}:00`, enabled: true };
  assert.strictEqual(orch.shouldRunNow(task), true);
});

test("daily task, before target time, never run → should NOT run", () => {
  resetState();
  // Set target to 1 hour from now  
  const now = new Date();
  const futureHour = (now.getHours() + 1) % 24;
  const task = { id: "td2", schedule: `daily ${String(futureHour).padStart(2, "0")}:00`, enabled: true };
  // If we're at hour 23, futureHour wraps to 0 which is "earlier" — skip this edge case
  if (futureHour > now.getHours()) {
    assert.strictEqual(orch.shouldRunNow(task), false);
  } else {
    // Midnight wrap — this actually means "past target" for tomorrow, which is past in today's sense
    // Just mark as passed since this is an edge case at 11pm
    originalLog("     (skipped — midnight wrap edge case)");
  }
});

test("daily task, already run today → should NOT run", () => {
  resetState();
  const now = new Date();
  const pastHour = now.getHours() > 0 ? now.getHours() - 1 : 23;
  const task = { id: "td3", schedule: `daily ${String(pastHour).padStart(2, "0")}:00`, enabled: true };
  const ts = orch.getTaskState("td3");
  ts.lastRun = new Date().toISOString(); // Run today
  assert.strictEqual(orch.shouldRunNow(task), false);
});

// ═══════════════════════════════════════════
// BACKOFF_SCHEDULE_MS validation
// ═══════════════════════════════════════════

originalLog("\n📊 Constants");

test("backoff schedule has 5 levels", () => {
  assert.strictEqual(orch.BACKOFF_SCHEDULE_MS.length, 5);
});

test("backoff schedule is ascending", () => {
  for (let i = 1; i < orch.BACKOFF_SCHEDULE_MS.length; i++) {
    assert.ok(orch.BACKOFF_SCHEDULE_MS[i] > orch.BACKOFF_SCHEDULE_MS[i - 1],
      `Level ${i} (${orch.BACKOFF_SCHEDULE_MS[i]}) should be > level ${i - 1} (${orch.BACKOFF_SCHEDULE_MS[i - 1]})`);
  }
});

test("MAX_CONSECUTIVE_ERRORS is reasonable", () => {
  assert.ok(orch.MAX_CONSECUTIVE_ERRORS >= 3 && orch.MAX_CONSECUTIVE_ERRORS <= 10);
});

// ═══════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════

console.log = originalLog;
console.error = originalError;

originalLog(`\n${"═".repeat(50)}`);
originalLog(`📐 Unit Tests: ${passed}/${total} passed, ${failed} failed`);
originalLog(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
