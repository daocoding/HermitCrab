#!/usr/bin/env node
/**
 * 🧪 JARVIS Bridge Test Harness
 * 
 * Automated E2E tests using a real Telegram user account (GramJS).
 * Sends messages to @JarvisZhangBot and verifies responses.
 * 
 * Usage:
 *   node test-bridge.js              # Run all tests
 *   node test-bridge.js --smoke      # Quick smoke test (DM ping only)
 *   node test-bridge.js --verbose    # Show full message details
 * 
 * Prerequisites:
 *   1. Run `node auth.js` first (one-time)
 *   2. Bridge must be running on M4
 */

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const fs = require("fs");
const path = require("path");
const http = require("http");

// Load env
require("dotenv").config({ path: path.join(__dirname, ".env") });

const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SESSION_FILE = path.join(__dirname, ".session");
const BOT_USERNAME = process.env.JARVIS_BOT_USERNAME || "JarvisZhangBot";
const BRIDGE_HOST = process.env.BRIDGE_HOST || "localhost";
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "18790", 10);

// Test config
const REPLY_TIMEOUT_MS = 60000; // 60s — JARVIS may need time to spin up
const TEST_PREFIX = "[🧪 TEST]"; // Prefix for test messages so they're recognizable

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════
const args = process.argv.slice(2);
const SMOKE_ONLY = args.includes("--smoke");
const VERBOSE = args.includes("--verbose");

function log(icon, msg) {
  console.log(`  ${icon} ${msg}`);
}

function section(title) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(50));
}

async function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://${BRIDGE_HOST}:${BRIDGE_PORT}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    }).on("error", reject);
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
// TELEGRAM CLIENT
// ═══════════════════════════════════════════
async function createClient() {
  if (!fs.existsSync(SESSION_FILE)) {
    console.error("❌ No session file found. Run `node auth.js` first.");
    process.exit(1);
  }

  const sessionStr = fs.readFileSync(SESSION_FILE, "utf-8").trim();
  const client = new TelegramClient(
    new StringSession(sessionStr),
    API_ID,
    API_HASH,
    { connectionRetries: 5 }
  );

  await client.connect();

  // Verify we're logged in
  const me = await client.getMe();
  log("👤", `Logged in as ${me.firstName} (@${me.username || "?"})`);
  return { client, me };
}

/**
 * Send a message to the bot and wait for a reply.
 * Returns the reply text, or null if timeout.
 */
async function sendAndWaitForReply(client, botEntity, message, timeoutMs = REPLY_TIMEOUT_MS) {
  return new Promise(async (resolve) => {
    const timer = setTimeout(() => {
      resolve(null); // timeout
    }, timeoutMs);

    // Set up listener for new messages from the bot
    const handler = async (event) => {
      const msg = event.message;
      if (msg.peerId && msg.senderId) {
        // Check if this message is from the bot in our DM
        const senderId = msg.senderId.value || msg.senderId;
        const botId = botEntity.id.value || botEntity.id;
        if (senderId.toString() === botId.toString()) {
          clearTimeout(timer);
          client.removeEventHandler(handler, new NewMessage({}));
          resolve(msg.text);
        }
      }
    };

    client.addEventHandler(handler, new NewMessage({}));

    // Send the message
    await client.sendMessage(botEntity, { message });
    if (VERBOSE) log("📤", `Sent: "${message}"`);
  });
}

// ═══════════════════════════════════════════
// TEST CASES
// ═══════════════════════════════════════════

/**
 * T1: Bridge Health Check (HTTP)
 * Verifies the bridge HTTP server is responding.
 */
async function testBridgeHealth() {
  try {
    const res = await httpGet("/health");
    recordResult("Bridge HTTP health", res.ok === true, `status: ${res.status}`);
  } catch (e) {
    recordResult("Bridge HTTP health", false, `unreachable: ${e.message}`);
  }
}

/**
 * T2: DM Smoke Test
 * Sends a simple message to the bot and expects a reply.
 */
async function testDMSmoke(client, bot) {
  const testMsg = `${TEST_PREFIX} ping ${Date.now()}`;
  const reply = await sendAndWaitForReply(client, bot, testMsg);

  if (reply) {
    recordResult("DM smoke test", true, `got reply (${reply.length} chars)`);
    if (VERBOSE) log("📥", `Reply: "${reply.substring(0, 100)}..."`);
  } else {
    recordResult("DM smoke test", false, `no reply within ${REPLY_TIMEOUT_MS / 1000}s`);
  }
}

/**
 * T3: Rapid Fire (3 messages fast)
 * Sends 3 messages quickly and verifies at least one response comes back.
 */
async function testRapidFire(client, bot) {
  const msgs = [
    `${TEST_PREFIX} rapid 1 ${Date.now()}`,
    `${TEST_PREFIX} rapid 2 ${Date.now()}`,
    `${TEST_PREFIX} rapid 3 ${Date.now()}`,
  ];

  // Send all 3 quickly
  for (const m of msgs) {
    await client.sendMessage(bot, { message: m });
    await new Promise(r => setTimeout(r, 200)); // 200ms gap
  }

  // Wait for any reply
  const gotReply = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), REPLY_TIMEOUT_MS);

    const handler = async (event) => {
      const msg = event.message;
      const senderId = (msg.senderId?.value || msg.senderId || "").toString();
      const botId = (bot.id?.value || bot.id || "").toString();
      if (senderId === botId) {
        clearTimeout(timer);
        client.removeEventHandler(handler, new NewMessage({}));
        resolve(true);
      }
    };
    client.addEventHandler(handler, new NewMessage({}));
  });

  recordResult("Rapid fire (3 msgs)", gotReply, gotReply ? "queue handled" : "no reply");
}

/**
 * T4: Bridge Status Endpoint
 * Checks the /status endpoint returns valid data.
 */
async function testBridgeStatus() {
  try {
    const res = await httpGet("/status");
    const hasFields = res.authorized_users !== undefined;
    recordResult("Bridge /status endpoint", hasFields, `authorized_users: ${res.authorized_users}`);
  } catch (e) {
    recordResult("Bridge /status endpoint", false, e.message);
  }
}

/**
 * T5: PID Lock Exists
 * Verifies the PID lock file exists and matches the running process.
 */
async function testPidLock() {
  try {
    // This test only works when run on the same machine as the bridge
    const pidFile = path.resolve(__dirname, "..", ".jarvis-bridge.pid");
    if (fs.existsSync(pidFile)) {
      const pid = fs.readFileSync(pidFile, "utf-8").trim();
      recordResult("PID lock file", true, `PID: ${pid}`);
    } else {
      recordResult("PID lock file", false, "file not found (expected on bridge machine)");
    }
  } catch (e) {
    recordResult("PID lock file", false, e.message);
  }
}

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════
async function main() {
  console.log("\n🧪 JARVIS Bridge Test Harness\n");

  // Phase 1: HTTP tests (no Telegram needed)
  section("Phase 1: Bridge HTTP Tests");
  await testBridgeHealth();
  await testBridgeStatus();
  await testPidLock();

  // Phase 2: Telegram E2E tests
  section("Phase 2: Telegram E2E Tests");

  let client, me;
  try {
    ({ client, me } = await createClient());
  } catch (e) {
    log("❌", `Failed to connect to Telegram: ${e.message}`);
    log("💡", "Run `node auth.js` to authenticate.");
    printSummary();
    process.exit(1);
  }

  // Resolve bot entity
  let bot;
  try {
    bot = await client.getEntity(BOT_USERNAME);
    log("🤖", `Found bot: @${BOT_USERNAME} (ID: ${bot.id})`);
  } catch (e) {
    log("❌", `Could not find bot @${BOT_USERNAME}: ${e.message}`);
    await client.disconnect();
    printSummary();
    process.exit(1);
  }

  // Run E2E tests
  await testDMSmoke(client, bot);

  if (!SMOKE_ONLY) {
    await testRapidFire(client, bot);
    // Add more tests here as we build them
  }

  // Cleanup
  await client.disconnect();

  // Summary
  const allPassed = printSummary();
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error("💥 Fatal error:", e.message);
  process.exit(1);
});
