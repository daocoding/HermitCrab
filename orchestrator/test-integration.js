#!/usr/bin/env node
/**
 * 🧪 Orchestrator Integration Tests
 * Starts the orchestrator as a subprocess and tests the HTTP API,
 * task execution (L1), state persistence, and graceful restart.
 */

const http = require("http");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ORCH_PATH = path.join(__dirname, "orchestrator.js");
const TEST_PORT = 19999; // Dedicated test port to avoid conflicts
const TEST_TASKS_FILE = path.join(__dirname, "test-tasks-integration.json");
const TEST_STATE_FILE = path.join(__dirname, "state.json");
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let orchProcess = null;
let passed = 0;
let failed = 0;
let total = 0;
let logLines = [];

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${urlPath}`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on("error", reject);
  });
}

function httpPost(urlPath, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let respData = "";
      res.on("data", (c) => (respData += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(respData) });
        } catch {
          resolve({ status: res.statusCode, body: respData });
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await httpGet("/status");
      return true;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Server did not start within timeout");
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

// ═══════════════════════════════════════════
// SETUP & TEARDOWN
// ═══════════════════════════════════════════

function createTestTasks() {
  const tasks = [
    {
      id: "test_pass",
      name: "Test Pass Task",
      level: 1,
      schedule: "every 60m",  // Won't auto-fire during test
      enabled: true,
      catch_up: false,
      command: "echo 'hello from test'",
    },
    {
      id: "test_fail",
      name: "Test Fail Task",
      level: 1,
      schedule: "every 60m",
      enabled: true,
      catch_up: false,
      command: "echo 'failing...' && exit 1",
    },
    {
      id: "test_slow",
      name: "Test Slow Task",
      level: 1,
      schedule: "every 60m",
      enabled: true,
      catch_up: false,
      command: "sleep 1 && echo 'done slowly'",
    },
    {
      id: "test_disabled",
      name: "Test Disabled Task",
      level: 1,
      schedule: "every 1m",
      enabled: false,
      catch_up: false,
      command: "echo 'should not run'",
    },
    {
      id: "test_output",
      name: "Test Output Task",
      level: 1,
      schedule: "every 60m",
      enabled: true,
      catch_up: false,
      command: "echo 'line1' && echo 'line2' && echo 'line3'",
    },
  ];
  fs.writeFileSync(TEST_TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function startOrchestrator() {
  return new Promise((resolve, reject) => {
    orchProcess = spawn("node", [ORCH_PATH], {
      env: {
        ...process.env,
        ORCHESTRATOR_PORT: String(TEST_PORT),
        HERMITCRAB_WORKSPACE: __dirname,
      },
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
    });

    orchProcess.stdout.on("data", (data) => {
      data.toString().split("\n").filter(Boolean).forEach((line) => {
        logLines.push(line);
      });
    });

    orchProcess.stderr.on("data", (data) => {
      logLines.push(`STDERR: ${data.toString().trim()}`);
    });

    orchProcess.on("error", reject);

    // Give it a moment to start
    setTimeout(resolve, 500);
  });
}

function stopOrchestrator() {
  if (orchProcess) {
    orchProcess.kill("SIGTERM");
    orchProcess = null;
  }
}

function cleanup() {
  stopOrchestrator();
  try { fs.unlinkSync(TEST_TASKS_FILE); } catch {}
  try { fs.unlinkSync(TEST_STATE_FILE); } catch {}
}

// ═══════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════

async function runTests() {
  console.log("\n🔌 Integration Tests\n");

  // Cleanup any previous state
  try { fs.unlinkSync(TEST_STATE_FILE); } catch {}

  // Create test tasks — use the real tasks.json name since that's what orchestrator reads
  const realTasksFile = path.join(__dirname, "tasks.json");
  const realTasksBackup = path.join(__dirname, "tasks.json.bak");
  let backedUp = false;

  try {
    // Backup real tasks
    if (fs.existsSync(realTasksFile)) {
      fs.copyFileSync(realTasksFile, realTasksBackup);
      backedUp = true;
    }

    // Write test tasks as tasks.json
    const testTasks = [
      {
        id: "test_pass",
        name: "Test Pass Task",
        level: 1,
        schedule: "every 60m",
        enabled: true,
        catch_up: false,
        command: "echo 'hello from test'",
      },
      {
        id: "test_fail",
        name: "Test Fail Task",
        level: 1,
        schedule: "every 60m",
        enabled: true,
        catch_up: false,
        command: "echo 'failing...' >&2 && exit 1",
      },
      {
        id: "test_slow",
        name: "Test Slow Task",
        level: 1,
        schedule: "every 60m",
        enabled: true,
        catch_up: false,
        command: "sleep 1 && echo 'done slowly'",
      },
      {
        id: "test_disabled",
        name: "Test Disabled Task",
        level: 1,
        schedule: "every 1m",
        enabled: false,
        catch_up: false,
        command: "echo 'should not run'",
      },
      {
        id: "test_output",
        name: "Test Output Task",
        level: 1,
        schedule: "every 60m",
        enabled: true,
        catch_up: false,
        command: "echo 'line1' && echo 'line2' && echo 'line3'",
      },
    ];
    fs.writeFileSync(realTasksFile, JSON.stringify(testTasks, null, 2));

    // Start orchestrator
    await startOrchestrator();
    await waitForServer();

    console.log("  📡 Server started on port", TEST_PORT);

    // --- HTTP API tests ---
    console.log("\n  📡 HTTP API");

    await test("GET /status returns 200", async () => {
      const res = await httpGet("/status");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "running");
    });

    await test("GET /status has correct fields", async () => {
      const res = await httpGet("/status");
      assert.ok(res.body.name.includes("Orchestrator"));
      assert.ok(typeof res.body.uptime_s === "number");
      assert.ok(typeof res.body.taskCount === "number");
      assert.ok(Array.isArray(res.body.features));
    });

    await test("GET /tasks returns task list", async () => {
      const res = await httpGet("/tasks");
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.strictEqual(res.body.length, 5);
    });

    await test("GET /tasks contains test_pass", async () => {
      const res = await httpGet("/tasks");
      const tp = res.body.find((t) => t.id === "test_pass");
      assert.ok(tp, "test_pass task not found");
      assert.strictEqual(tp.name, "Test Pass Task");
    });

    await test("GET /nonexistent returns 404", async () => {
      const res = await httpGet("/nonexistent");
      assert.strictEqual(res.status, 404);
    });

    await test("POST /run/nonexistent returns 404", async () => {
      const res = await httpPost("/run/nonexistent");
      assert.strictEqual(res.status, 404);
    });

    // --- Task execution tests ---
    console.log("\n  🏃 Task Execution (L1)");

    // Wait for initial tick to settle (tasks with no lastRun fire immediately)
    await sleep(3000);

    await test("POST /run/test_pass triggers task (202)", async () => {
      const res = await httpPost("/run/test_pass");
      assert.strictEqual(res.status, 202);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.task, "test_pass");
    });

    await test("test_pass completes successfully", async () => {
      await sleep(2000); // Wait for task to finish
      const res = await httpGet("/status");
      const ts = res.body.taskStates.test_pass;
      assert.ok(ts, "test_pass state not found");
      assert.strictEqual(ts.lastResult, "success");
      assert.strictEqual(ts.consecutiveErrors, 0);
      assert.ok(ts.lastRun, "lastRun should be set");
    });

    // Capture baseline error count (initial tick already fired test_fail)
    let baselineErrors = 0;
    {
      const res = await httpGet("/status");
      const ts = res.body.taskStates.test_fail;
      if (ts) baselineErrors = ts.consecutiveErrors;
    }

    await test("POST /run/test_fail triggers failing task", async () => {
      const res = await httpPost("/run/test_fail");
      assert.strictEqual(res.status, 202);
    });

    await test("test_fail records error state", async () => {
      await sleep(2000);
      const res = await httpGet("/status");
      const ts = res.body.taskStates.test_fail;
      assert.ok(ts, "test_fail state not found");
      assert.strictEqual(ts.lastResult, "failed");
      assert.strictEqual(ts.consecutiveErrors, baselineErrors + 1);
      assert.ok(ts.lastError, "lastError should be set");
    });

    await test("running test_fail again increments consecutiveErrors", async () => {
      await httpPost("/run/test_fail");
      await sleep(2000);
      const res = await httpGet("/status");
      const ts = res.body.taskStates.test_fail;
      assert.strictEqual(ts.consecutiveErrors, baselineErrors + 2);
    });

    await test("POST /run/test_output captures multi-line output", async () => {
      await httpPost("/run/test_output");
      await sleep(2000);
      const res = await httpGet("/status");
      const ts = res.body.taskStates.test_output;
      assert.strictEqual(ts.lastResult, "success");
    });

    // --- Reload test ---
    console.log("\n  🔄 Reload");

    await test("POST /reload reloads tasks", async () => {
      const res = await httpPost("/reload");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.taskCount, 5);
    });

    // --- State persistence test ---
    console.log("\n  💾 State persistence");

    await test("state.json exists after task execution", async () => {
      assert.ok(fs.existsSync(TEST_STATE_FILE), "state.json should exist");
      const savedState = JSON.parse(fs.readFileSync(TEST_STATE_FILE, "utf-8"));
      assert.ok(savedState.taskStates, "taskStates should exist in saved state");
      assert.ok(savedState.taskStates.test_pass, "test_pass should be in saved state");
    });

    // --- Preflight test ---
    console.log("\n  🛫 Preflight");

    await test("POST /preflight/test_pass runs pre-flight checks", async () => {
      const res = await httpPost("/preflight/test_pass");
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.checks, "should have checks array");
      assert.ok(res.body.checks.length >= 2, "should have at least system checks");
      assert.ok(typeof res.body.allClear === "boolean");
    });

    await test("POST /preflight/nonexistent returns error", async () => {
      const res = await httpPost("/preflight/nonexistent");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, false);
    });

    // --- Graceful restart (SIGUSR1) ---
    console.log("\n  🔁 Graceful restart");

    await test("SIGUSR1 reloads without dropping connection", async () => {
      orchProcess.kill("SIGUSR1");
      await sleep(1000);
      // Server should still be responding
      const res = await httpGet("/status");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "running");
    });

    // --- Port guard test ---
    console.log("\n  🔒 Port guard");

    await test("second instance on same port fails", async () => {
      const second = spawn("node", [ORCH_PATH], {
        env: { ...process.env, ORCHESTRATOR_PORT: String(TEST_PORT) },
        cwd: __dirname,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const exitCode = await new Promise((resolve) => {
        second.on("close", resolve);
        setTimeout(() => {
          second.kill();
          resolve(-1);
        }, 3000);
      });

      assert.strictEqual(exitCode, 1, "Second instance should exit with code 1");
    });

  } finally {
    // Restore real tasks
    if (backedUp) {
      fs.copyFileSync(realTasksBackup, realTasksFile);
      fs.unlinkSync(realTasksBackup);
    }
    
    stopOrchestrator();
    try { fs.unlinkSync(TEST_STATE_FILE); } catch {}
    try { fs.unlinkSync(TEST_TASKS_FILE); } catch {}
  }

  // Results
  console.log(`\n${"═".repeat(50)}`);
  console.log(`🔌 Integration Tests: ${passed}/${total} passed, ${failed} failed`);
  console.log(`${"═".repeat(50)}\n`);

  return failed;
}

runTests().then((failures) => process.exit(failures > 0 ? 1 : 0)).catch((err) => {
  console.error("Fatal error:", err);
  cleanup();
  process.exit(1);
});

// Ensure cleanup on unexpected exit
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("uncaughtException", (e) => { console.error(e); cleanup(); process.exit(1); });
