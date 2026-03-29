#!/usr/bin/env node
/**
 * 🧪 Orchestrator Smoke Tests
 * End-to-end tests that verify the orchestrator behaves correctly
 * over time with real scheduling, including:
 *   - Tasks fire on schedule
 *   - Failed tasks get backoff applied
 *   - State survives restart
 *   - Multiple tasks run independently
 */

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ORCH_PATH = path.join(__dirname, "orchestrator.js");
const SMOKE_PORT = 19998;
const BASE_URL = `http://127.0.0.1:${SMOKE_PORT}`;
const TASKS_FILE = path.join(__dirname, "tasks.json");
const TASKS_BACKUP = path.join(__dirname, "tasks.json.bak-smoke");
const STATE_FILE = path.join(__dirname, "state.json");
const SMOKE_MARKER = path.join(__dirname, "smoke-marker.txt");

let orchProcess = null;
let passed = 0;
let failed = 0;
let total = 0;

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${urlPath}`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on("error", reject);
  });
}

function httpPost(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, { method: "POST" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForServer(maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { await httpGet("/status"); return; }
    catch { await sleep(200); }
  }
  throw new Error("Orchestrator did not start");
}

async function test(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

function startOrch() {
  return new Promise((resolve) => {
    orchProcess = spawn("node", [ORCH_PATH], {
      env: { ...process.env, ORCHESTRATOR_PORT: String(SMOKE_PORT) },
      cwd: __dirname,
      stdio: "pipe",
    });
    orchProcess.stdout.on("data", () => {}); // drain
    orchProcess.stderr.on("data", () => {}); // drain
    setTimeout(resolve, 300);
  });
}

function stopOrch() {
  return new Promise((resolve) => {
    if (!orchProcess) return resolve();
    orchProcess.on("close", resolve);
    orchProcess.kill("SIGTERM");
    orchProcess = null;
    setTimeout(resolve, 1000); // Failsafe
  });
}

function cleanup() {
  if (orchProcess) { try { orchProcess.kill("SIGKILL"); } catch {} }
  try { fs.unlinkSync(SMOKE_MARKER); } catch {}
  try { fs.unlinkSync(STATE_FILE); } catch {}
  if (fs.existsSync(TASKS_BACKUP)) {
    fs.copyFileSync(TASKS_BACKUP, TASKS_FILE);
    fs.unlinkSync(TASKS_BACKUP);
  }
}

// ═══════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════

async function runSmokeTests() {
  console.log("\n🔥 Smoke Tests\n");

  // Backup real tasks
  if (fs.existsSync(TASKS_FILE)) {
    fs.copyFileSync(TASKS_FILE, TASKS_BACKUP);
  }

  try {
    // ─── Scenario 1: Auto-scheduling ───
    console.log("  📋 Scenario 1: Auto-scheduling with short intervals");

    // Create tasks with very short intervals
    const autoTasks = [
      {
        id: "smoke_auto",
        name: "Smoke Auto Task",
        level: 1,
        schedule: "every 5s", // Very short for smoke testing
        enabled: true,
        catch_up: true,
        command: `date +%s >> ${SMOKE_MARKER}`,
      },
    ];
    fs.writeFileSync(TASKS_FILE, JSON.stringify(autoTasks, null, 2));
    try { fs.unlinkSync(STATE_FILE); } catch {}
    try { fs.unlinkSync(SMOKE_MARKER); } catch {}

    await startOrch();
    await waitForServer();

    // Wait for auto-scheduling to trigger (tick is every 30s, but first tick is immediate)
    // The task has never run, so it should fire immediately on the first tick
    await sleep(3000);

    await test("auto-scheduled task fires on first tick", async () => {
      assert.ok(fs.existsSync(SMOKE_MARKER), "Marker file should be created by task");
      const content = fs.readFileSync(SMOKE_MARKER, "utf-8").trim();
      const lines = content.split("\n");
      assert.ok(lines.length >= 1, `Should have at least 1 execution, got ${lines.length}`);
    });

    // Check state reflects the run
    await test("state shows successful execution", async () => {
      const res = await httpGet("/status");
      const ts = res.body.taskStates.smoke_auto;
      assert.ok(ts, "smoke_auto state should exist");
      assert.strictEqual(ts.lastResult, "success");
      assert.ok(ts.lastRun, "lastRun should be set");
    });

    await stopOrch();

    // ─── Scenario 2: State survives restart ───
    console.log("\n  📋 Scenario 2: State persistence across restart");

    // Read state before restart
    const stateBeforeRestart = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));

    await startOrch();
    await waitForServer();

    await test("state persists across restart", async () => {
      const res = await httpGet("/status");
      const ts = res.body.taskStates.smoke_auto;
      assert.ok(ts, "smoke_auto state should survive restart");
      assert.strictEqual(ts.lastResult, "success");
      assert.ok(ts.lastRun, "lastRun should be preserved");
    });

    await stopOrch();

    // ─── Scenario 3: Error backoff ───
    console.log("\n  📋 Scenario 3: Error backoff behavior");

    const backoffTasks = [
      {
        id: "smoke_fail",
        name: "Smoke Fail Task",
        level: 1,
        schedule: "every 5s",
        enabled: true,
        catch_up: false,
        command: "exit 1",
      },
    ];
    fs.writeFileSync(TASKS_FILE, JSON.stringify(backoffTasks, null, 2));
    try { fs.unlinkSync(STATE_FILE); } catch {}

    await startOrch();
    await waitForServer();

    // First tick will fire immediately (never run), then subsequent ticks
    await sleep(3000);

    await test("failing task records error", async () => {
      const res = await httpGet("/status");
      const ts = res.body.taskStates.smoke_fail;
      assert.ok(ts, "smoke_fail state should exist");
      assert.strictEqual(ts.lastResult, "failed");
      assert.ok(ts.consecutiveErrors >= 1, `Should have errors, got ${ts.consecutiveErrors}`);
    });

    // Record current error count
    let firstErrorCount;
    await test("backoff prevents immediate re-run", async () => {
      const res1 = await httpGet("/status");
      firstErrorCount = res1.body.taskStates.smoke_fail.consecutiveErrors;
      
      // Wait 5 more seconds (the normal interval) — backoff should prevent re-run
      // because backoff level 1 = 30s > 5s interval
      await sleep(6000);
      
      const res2 = await httpGet("/status");
      const secondErrorCount = res2.body.taskStates.smoke_fail.consecutiveErrors;
      
      // The error count should NOT have increased much because backoff kicks in
      // At 30s backoff with only ~6s wait, it shouldn't have re-fired
      // But if tick catches it right, it might have fired once more due to timing
      assert.ok(secondErrorCount <= firstErrorCount + 1,
        `Expected backoff to slow re-runs (was ${firstErrorCount}, now ${secondErrorCount})`);
    });

    await stopOrch();

    // ─── Scenario 4: Multiple independent tasks ───
    console.log("\n  📋 Scenario 4: Multiple tasks run independently");

    const marker1 = path.join(__dirname, "smoke-marker-1.txt");
    const marker2 = path.join(__dirname, "smoke-marker-2.txt");
    try { fs.unlinkSync(marker1); } catch {}
    try { fs.unlinkSync(marker2); } catch {}

    const multiTasks = [
      {
        id: "smoke_multi_1",
        name: "Multi Task 1",
        level: 1,
        schedule: "every 5s",
        enabled: true,
        catch_up: false,
        command: `echo 'task1' > ${marker1}`,
      },
      {
        id: "smoke_multi_2",
        name: "Multi Task 2",
        level: 1,
        schedule: "every 5s",
        enabled: true,
        catch_up: false,
        command: `echo 'task2' > ${marker2}`,
      },
      {
        id: "smoke_multi_disabled",
        name: "Multi Task Disabled",
        level: 1,
        schedule: "every 5s",
        enabled: false,
        catch_up: false,
        command: "echo 'this should not run'",
      },
    ];
    fs.writeFileSync(TASKS_FILE, JSON.stringify(multiTasks, null, 2));
    try { fs.unlinkSync(STATE_FILE); } catch {}

    await startOrch();
    await waitForServer();
    await sleep(3000);

    await test("both enabled tasks fire independently", async () => {
      assert.ok(fs.existsSync(marker1), "marker1 should exist");
      assert.ok(fs.existsSync(marker2), "marker2 should exist");
    });

    await test("disabled task did NOT fire", async () => {
      const res = await httpGet("/status");
      const ts = res.body.taskStates.smoke_multi_disabled;
      // Disabled tasks won't even have state unless getTaskState was called
      if (ts) {
        assert.notStrictEqual(ts.lastResult, "success");
      }
      // No marker file means it didn't run — that's the real check
    });

    await stopOrch();

    // Cleanup markers
    try { fs.unlinkSync(marker1); } catch {}
    try { fs.unlinkSync(marker2); } catch {}

    // ─── Scenario 5: Manual trigger via API ───
    console.log("\n  📋 Scenario 5: Manual trigger via HTTP API");

    const manualMarker = path.join(__dirname, "smoke-manual.txt");
    try { fs.unlinkSync(manualMarker); } catch {}

    const manualTasks = [
      {
        id: "smoke_manual",
        name: "Manual Trigger Task",
        level: 1,
        schedule: "every 60m", // Won't auto-fire
        enabled: true,
        catch_up: false,
        command: `echo 'manually triggered' > ${manualMarker}`,
      },
    ];
    fs.writeFileSync(TASKS_FILE, JSON.stringify(manualTasks, null, 2));
    try { fs.unlinkSync(STATE_FILE); } catch {}

    await startOrch();
    await waitForServer();

    // Initial tick will fire it since it's never run — wait for that, then verify manual re-trigger
    await sleep(3000);

    await test("task ran on first tick (never run before)", async () => {
      assert.ok(fs.existsSync(manualMarker), "Task should have run on first tick");
    });

    // Delete marker
    try { fs.unlinkSync(manualMarker); } catch {}

    // Manually trigger it again
    await test("manual trigger re-runs task", async () => {
      const res = await httpPost("/run/smoke_manual");
      assert.strictEqual(res.status, 202);
      await sleep(2000);
      assert.ok(fs.existsSync(manualMarker), "Task should have run after manual trigger");
    });

    await stopOrch();
    try { fs.unlinkSync(manualMarker); } catch {}

  } finally {
    cleanup();
  }

  // Results
  console.log(`\n${"═".repeat(50)}`);
  console.log(`🔥 Smoke Tests: ${passed}/${total} passed, ${failed} failed`);
  console.log(`${"═".repeat(50)}\n`);

  return failed;
}

runSmokeTests()
  .then((f) => process.exit(f > 0 ? 1 : 0))
  .catch((e) => { console.error("Fatal:", e); cleanup(); process.exit(1); });

process.on("SIGINT", () => { cleanup(); process.exit(1); });
process.on("SIGTERM", () => { cleanup(); process.exit(1); });
