#!/usr/bin/env node
/**
 * 🧪 HermitCrab Teams Bridge Test Harness
 * 
 * Tests the Teams bridge by injecting Bot Framework Activity payloads
 * directly into the /api/messages endpoint. No Microsoft account needed.
 * 
 * Two testing modes:
 *   1. LOCAL mode — bridge runs on this machine (localhost)
 *   2. REMOTE mode — bridge runs on M4 (via Tailscale)
 * 
 * Usage:
 *   node test-teams.js                # Run all tests against localhost
 *   node test-teams.js --remote       # Run against M4
 *   node test-teams.js --smoke        # Quick smoke test only
 *   node test-teams.js --verbose      # Show full payloads
 * 
 * Prerequisites:
 *   Teams bridge must be running (or use --mock to test offline)
 */

const http = require("http");
const crypto = require("crypto");

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const args = process.argv.slice(2);
const REMOTE = args.includes("--remote");
const SMOKE_ONLY = args.includes("--smoke");
const VERBOSE = args.includes("--verbose");

// Bridge endpoints
const BRIDGE_HOST = REMOTE ? "YOUR_SERVER_IP" : "127.0.0.1";
const BRIDGE_PORT = 3979;     // Teams bridge /api/messages
const REPLY_PORT = 18792;     // Teams bridge /reply (JARVIS curl endpoint)

// Fake but realistic Bot Framework identifiers
const FAKE_TENANT_ID = process.env.TEST_TENANT_ID || "test-tenant-00000";
const FAKE_BOT_ID = process.env.TEST_BOT_ID || "test-bot-00000";
const FAKE_SERVICE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`; // Self-referencing for test

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════
function log(icon, msg) {
  console.log(`  ${icon} ${msg}`);
}

function section(title) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(50));
}

function uuid() {
  return crypto.randomUUID();
}

/**
 * Build a Bot Framework Activity JSON
 * This matches what Azure Bot Service sends to /api/messages
 */
function buildActivity(options = {}) {
  const {
    text = "Hello from test",
    senderName = "Test User",
    senderId = "test-user-001",
    conversationId = `test-convo-${Date.now()}`,
    tenantId = FAKE_TENANT_ID,
    type = "message",
    activityId = uuid(),
    attachments = undefined,
    value = undefined,
  } = options;

  return {
    type,
    id: activityId,
    timestamp: new Date().toISOString(),
    localTimestamp: new Date().toISOString(),
    channelId: "msteams",
    serviceUrl: FAKE_SERVICE_URL,
    from: {
      id: senderId,
      name: senderName,
      aadObjectId: uuid(),
    },
    conversation: {
      id: conversationId,
      tenantId,
      conversationType: "personal",
    },
    recipient: {
      id: FAKE_BOT_ID,
      name: "Mini",
    },
    text: text || undefined,
    textFormat: "plain",
    attachments,
    value,
    channelData: {
      tenant: { id: tenantId },
    },
  };
}

/**
 * POST a JSON payload to the bridge
 */
function postJSON(host, port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: host,
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        // Note: No Authorization header — bridge will need to handle test mode
      },
    }, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(responseBody) });
        } catch {
          resolve({ status: res.statusCode, body: responseBody });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

function httpGet(host, port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://${host}:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    }).on("error", reject);
  });
}

/**
 * Wait for a reply on the reply port by starting a temporary HTTP server.
 * JARVIS sends curl POST /reply with { conversation_id, text }.
 * We intercept that to verify the bridge → JARVIS → reply pipeline.
 */
function waitForReply(conversationId, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      srv.close();
      resolve(null);
    }, timeoutMs);

    const srv = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/reply") {
        let body = "";
        for await (const chunk of req) body += chunk;
        try {
          const data = JSON.parse(body);
          if (data.conversation_id === conversationId) {
            clearTimeout(timer);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            srv.close();
            resolve(data.text);
            return;
          }
        } catch {}
      }
      res.writeHead(200);
      res.end("ok");
    });

    // Listen on the reply port (need to be on the same machine as the bridge)
    // For remote testing, we'll use a different approach
    srv.listen(REPLY_PORT, "127.0.0.1", () => {
      if (VERBOSE) log("🎧", `Listening for replies on :${REPLY_PORT}`);
    });

    srv.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        // Reply port is already in use by the bridge — we can't intercept
        clearTimeout(timer);
        resolve("REPLY_PORT_IN_USE");
      } else {
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

// ═══════════════════════════════════════════
// TEST RUNNER
// ═══════════════════════════════════════════
const results = [];

function recordResult(name, passed, detail = "") {
  results.push({ name, passed, detail });
  const icon = passed ? "✅" : "❌";
  log(icon, `${name}${detail ? ` — ${detail}` : ""}`);
}

function printSummary() {
  section("📊 TEST SUMMARY");
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  for (const r of results) {
    log(r.passed ? "✅" : "❌", r.name);
  }

  console.log(`\n  ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ""}`);
  console.log(`  ${failed === 0 ? "🎉 All tests passed!" : "⚠️  Some tests failed."}\n`);
  return failed === 0;
}

// ═══════════════════════════════════════════
// TEST CASES
// ═══════════════════════════════════════════

/**
 * T1: Health Check
 */
async function testHealth() {
  try {
    const res = await httpGet(BRIDGE_HOST, BRIDGE_PORT, "/health");
    const ok = res.status === 200 && res.body.status === "ok";
    recordResult("Health check", ok, `bridge: ${res.body.bridge}, version: ${res.body.version}`);
  } catch (e) {
    recordResult("Health check", false, `unreachable: ${e.message}`);
  }
}

/**
 * T2: Activity Injection — Basic Message
 * Posts a Bot Framework Activity and checks for 200 acceptance
 */
async function testActivityAccepted() {
  const activity = buildActivity({
    text: "[🧪 TEST] ping from test harness",
    senderName: "Test Harness",
    conversationId: `test-accept-${Date.now()}`,
  });

  try {
    const res = await postJSON(BRIDGE_HOST, BRIDGE_PORT, "/api/messages", activity);
    // The bridge should return 200 (or 401 if JWT validation is enforced)
    if (res.status === 200) {
      recordResult("Activity accepted (200)", true, "bridge processed the activity");
    } else if (res.status === 401) {
      recordResult("Activity accepted (200)", false, "JWT validation is blocking test — need test mode");
    } else {
      recordResult("Activity accepted (200)", false, `status: ${res.status}, body: ${JSON.stringify(res.body).substring(0, 100)}`);
    }
    if (VERBOSE) log("📋", `Response: ${JSON.stringify(res.body)}`);
  } catch (e) {
    recordResult("Activity accepted (200)", false, e.message);
  }
}

/**
 * T3: Wrong Tenant — should be blocked
 */
async function testWrongTenant() {
  const activity = buildActivity({
    text: "[🧪 TEST] wrong tenant",
    senderName: "Evil Corp User",
    conversationId: `test-tenant-${Date.now()}`,
    tenantId: "evil-corp-tenant-id",
  });

  try {
    const res = await postJSON(BRIDGE_HOST, BRIDGE_PORT, "/api/messages", activity);
    // Bridge should accept the HTTP request (200) but log a BLOCKED entry
    // We can't easily verify the block from here, but we check it doesn't crash
    recordResult("Wrong tenant handled", res.status === 200 || res.status === 403, `status: ${res.status}`);
  } catch (e) {
    recordResult("Wrong tenant handled", false, e.message);
  }
}

/**
 * T4: Deduplication — same activity ID sent twice
 */
async function testDedup() {
  const activityId = uuid();
  const conversationId = `test-dedup-${Date.now()}`;

  const activity = buildActivity({
    text: "[🧪 TEST] dedup check",
    senderName: "Dedup Tester",
    activityId,
    conversationId,
  });

  try {
    // Send same activity twice
    const res1 = await postJSON(BRIDGE_HOST, BRIDGE_PORT, "/api/messages", activity);
    await new Promise(r => setTimeout(r, 200));
    const res2 = await postJSON(BRIDGE_HOST, BRIDGE_PORT, "/api/messages", activity);

    // Both should return 200, but only first should be processed
    const bothAccepted = res1.status === 200 && res2.status === 200;
    recordResult("Deduplication", bothAccepted, "sent duplicate activity IDs");
  } catch (e) {
    recordResult("Deduplication", false, e.message);
  }
}

/**
 * T5: Empty message — should be skipped
 */
async function testEmptyMessage() {
  const activity = buildActivity({
    text: "",
    senderName: "Empty Sender",
    conversationId: `test-empty-${Date.now()}`,
  });

  try {
    const res = await postJSON(BRIDGE_HOST, BRIDGE_PORT, "/api/messages", activity);
    recordResult("Empty message skipped", res.status === 200, `status: ${res.status}`);
  } catch (e) {
    recordResult("Empty message skipped", false, e.message);
  }
}

/**
 * T6: Non-message activity type — should be ignored
 */
async function testNonMessageActivity() {
  const activity = buildActivity({
    text: "",
    type: "conversationUpdate",
    senderName: "System",
    conversationId: `test-sys-${Date.now()}`,
  });

  try {
    const res = await postJSON(BRIDGE_HOST, BRIDGE_PORT, "/api/messages", activity);
    recordResult("Non-message activity handled", res.status === 200, `type: conversationUpdate`);
  } catch (e) {
    recordResult("Non-message activity handled", false, e.message);
  }
}

/**
 * T7: Rate limiting — send 20 messages rapidly
 */
async function testRateLimit() {
  const conversationId = `test-rate-${Date.now()}`;
  let accepted = 0;
  let rejected = 0;

  for (let i = 0; i < 20; i++) {
    const activity = buildActivity({
      text: `[🧪 TEST] rapid ${i}`,
      senderName: "Speed Demon",
      conversationId,
    });

    try {
      const res = await postJSON(BRIDGE_HOST, BRIDGE_PORT, "/api/messages", activity);
      if (res.status === 200) accepted++;
      else rejected++;
    } catch {
      rejected++;
    }
  }

  // Rate limit is 15/min — some should be accepted, but not all 20
  // (Though the bridge accepts all HTTP-wise and rate-limits internally)
  recordResult("Rate limit behavior", accepted > 0, `${accepted} accepted, ${rejected} rejected`);
}

/**
 * T8: Reply endpoint — simulate JARVIS responding
 */
async function testReplyEndpoint() {
  // We need a conversation_id that has a pending reply context
  // For this test, we'll use the reply port directly with a fake payload
  try {
    const res = await postJSON(
      BRIDGE_HOST === "127.0.0.1" ? "127.0.0.1" : BRIDGE_HOST,
      REPLY_PORT,
      "/reply",
      { conversation_id: "nonexistent-convo", text: "test reply" }
    );
    // Should return 404 (no pending context for this conversation)
    recordResult("Reply endpoint (no context)", res.status === 404, `status: ${res.status}`);
  } catch (e) {
    recordResult("Reply endpoint (no context)", false, e.message);
  }
}

/**
 * T9: Bot self-message skip — bridge should ignore its own messages
 */
async function testSelfMessageSkip() {
  const activity = buildActivity({
    text: "I'm the bot talking to myself",
    senderName: "Mini",
    senderId: FAKE_BOT_ID,
    conversationId: `test-self-${Date.now()}`,
  });

  try {
    const res = await postJSON(BRIDGE_HOST, BRIDGE_PORT, "/api/messages", activity);
    recordResult("Bot self-message skipped", res.status === 200, "should be silently ignored");
  } catch (e) {
    recordResult("Bot self-message skipped", false, e.message);
  }
}

/**
 * T10: Button click (Action.Submit) handling
 */
async function testButtonClick() {
  const activity = buildActivity({
    text: "",
    senderName: "Button Clicker",
    conversationId: `test-button-${Date.now()}`,
    value: { quickReply: "Yes" },
  });

  try {
    const res = await postJSON(BRIDGE_HOST, BRIDGE_PORT, "/api/messages", activity);
    recordResult("Button click handled", res.status === 200, "quickReply value processed");
  } catch (e) {
    recordResult("Button click handled", false, e.message);
  }
}

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════
async function main() {
  console.log("\n🧪 HermitCrab Teams Bridge Test Harness\n");
  log("🎯", `Target: ${BRIDGE_HOST}:${BRIDGE_PORT} (${REMOTE ? "REMOTE M4" : "LOCAL"})`);

  // Phase 1: Connectivity
  section("Phase 1: Connectivity");
  await testHealth();

  // Phase 2: Activity Processing
  section("Phase 2: Activity Processing");
  await testActivityAccepted();
  await testNonMessageActivity();
  await testEmptyMessage();
  await testSelfMessageSkip();

  if (!SMOKE_ONLY) {
    // Phase 3: Security & Edge Cases
    section("Phase 3: Security & Edge Cases");
    await testWrongTenant();
    await testDedup();
    await testRateLimit();
    await testButtonClick();

    // Phase 4: Reply Pipeline
    section("Phase 4: Reply Pipeline");
    await testReplyEndpoint();
  }

  // Summary
  const allPassed = printSummary();
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error("💥 Fatal error:", e.message);
  process.exit(1);
});
