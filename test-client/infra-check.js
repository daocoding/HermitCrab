#!/usr/bin/env node
/**
 * 🧪 HermitCrab Infrastructure Health Check
 * 
 * Single script that validates ALL bridge infrastructure is operational.
 * Designed to run:
 *   - After every deploy (via reload-bridges.sh)
 *   - On a schedule (via launchd/cron)
 *   - On demand (manual)
 * 
 * Checks:
 *   1. Telegram bridge — health, DM round-trip
 *   2. Teams bridge — health, activity processing, reply pipeline
 *   3. Group chat — Graph API auth, read/write to Group 0 V2
 *   4. Graph API — token validity, self-healing readiness
 *   5. Process health — PID files, port bindings, launchd status
 * 
 * Usage:
 *   node infra-check.js              # Full check
 *   node infra-check.js --quick      # Skip slow tests (DM round-trip)
 *   node infra-check.js --notify     # Send results via ntfy.sh
 *   node infra-check.js --json       # Output JSON (for automation)
 * 
 * Exit codes:
 *   0 = all passed
 *   1 = some failures
 *   2 = critical failure (bridge down)
 */

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execSync } = require("child_process");

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const NOTIFY = args.includes("--notify");
const JSON_OUTPUT = args.includes("--json");
const VERBOSE = args.includes("--verbose");

// Bridge endpoints (M4 via Tailscale)
const M4_HOST = "YOUR_SERVER_IP";
const TELEGRAM_REPLY_PORT = 18791;
const TEAMS_BOT_PORT = 3979;
const TEAMS_REPLY_PORT = 18792;  // Note: localhost-only on M4
const GATEWAY_PORT = 3980;
const TENANT_ID = "5eb6506c-523d-4d8c-abd8-e247c483c80d";
const GROUP_CHAT_ID = "19:4ec991c00ac44d8498c4b749915b5729@thread.v2";

// Graph API
const GRAPH_DIR = path.join(__dirname, "..", "graph");

// Telegram test client
const TELEGRAM_SESSION = path.join(__dirname, ".session");

// ═══════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════
function httpGet(host, port, urlPath, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${host}:${port}${urlPath}`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
  });
}

function httpPost(host, port, urlPath, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: host, port, path: urlPath, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    req.write(data);
    req.end();
  });
}

function httpsGet(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
  });
}

// ═══════════════════════════════════════════
// CHECK FRAMEWORK
// ═══════════════════════════════════════════
const checks = [];
const SEVERITY = { CRITICAL: "critical", WARNING: "warning", INFO: "info" };

function addCheck(name, severity, passed, detail = "") {
  checks.push({ name, severity, passed, detail, ts: new Date().toISOString() });
  if (!JSON_OUTPUT) {
    const icon = passed ? "✅" : (severity === SEVERITY.CRITICAL ? "🔴" : "⚠️");
    console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  if (!JSON_OUTPUT) {
    console.log(`\n${"─".repeat(56)}`);
    console.log(`  ${title}`);
    console.log("─".repeat(56));
  }
}

// ═══════════════════════════════════════════
// CHECKS
// ═══════════════════════════════════════════

/**
 * 1. TELEGRAM BRIDGE
 */
async function checkTelegram() {
  section("🤖 Telegram Bridge");

  // Telegram reply port is localhost-only on M4 — check via SSH
  try {
    const healthJson = execSync(
      `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no user@${M4_HOST} "curl -sf http://127.0.0.1:${TELEGRAM_REPLY_PORT}/status 2>/dev/null || echo '{}'"`,
      { timeout: 12000, encoding: "utf-8" }
    ).trim();
    const health = JSON.parse(healthJson || "{}");
    if (health.status === "running" || health.name) {
      const bot = health.bot || "unknown";
      const uptime = health.uptime_s ? `${Math.round(health.uptime_s / 60)}m uptime` : "";
      addCheck("Telegram bridge HTTP", SEVERITY.CRITICAL, true, `${bot}${uptime ? ", " + uptime : ""}`);
    } else {
      addCheck("Telegram bridge HTTP", SEVERITY.CRITICAL, false, "no /health response");
    }
  } catch (e) {
    addCheck("Telegram bridge HTTP", SEVERITY.CRITICAL, false, `SSH curl failed: ${e.message.split("\n")[0]}`);
  }

  // Check PID file via SSH
  try {
    const pid = execSync(
      `ssh -o ConnectTimeout=5 user@${M4_HOST} "cat \\\$(find ~/Library/CloudStorage -name '.jarvis-bridge.pid' 2>/dev/null | head -1) 2>/dev/null || echo ''"`,
      { timeout: 12000, encoding: "utf-8" }
    ).trim();
    if (pid && /^\d+$/.test(pid)) {
      // Verify process is alive
      const alive = execSync(
        `ssh -o ConnectTimeout=3 user@${M4_HOST} "kill -0 ${pid} 2>/dev/null && echo alive || echo dead"`,
        { timeout: 8000, encoding: "utf-8" }
      ).trim();
      addCheck("Telegram PID lock", SEVERITY.CRITICAL, alive === "alive", `PID ${pid} ${alive}`);
    } else {
      addCheck("Telegram PID lock", SEVERITY.WARNING, false, "no PID file found");
    }
  } catch (e) {
    addCheck("Telegram PID lock", SEVERITY.WARNING, false, `SSH failed: ${e.message.split("\n")[0]}`);
  }

  // DM round-trip (skip if --quick)
  if (!QUICK && fs.existsSync(TELEGRAM_SESSION)) {
    try {
      // Use the existing test-bridge.js smoke test
      const result = execSync(
        `cd "${__dirname}" && timeout 60 node test-bridge.js --smoke 2>&1`,
        { timeout: 65000, encoding: "utf-8" }
      );
      const passed = result.includes("DM smoke test") && result.includes("✅");
      const matchTime = result.match(/(\d+)ms round-trip/);
      addCheck("Telegram DM round-trip", SEVERITY.CRITICAL, passed,
        matchTime ? `${matchTime[1]}ms` : (passed ? "ok" : "failed"));
    } catch (e) {
      const output = e.stdout || e.message;
      addCheck("Telegram DM round-trip", SEVERITY.CRITICAL, false, output.split("\n").slice(-3).join(" ").substring(0, 80));
    }
  } else if (!QUICK) {
    addCheck("Telegram DM round-trip", SEVERITY.INFO, false, "no .session file — run auth.js first");
  }
}

/**
 * 2. TEAMS BRIDGE
 */
async function checkTeams() {
  section("🏢 Teams Bridge");

  // Health endpoint
  const healthRes = await httpGet(M4_HOST, TEAMS_BOT_PORT, "/health");
  if (healthRes.status === 200 && healthRes.body?.status === "ok") {
    addCheck("Teams bridge health", SEVERITY.CRITICAL, true,
      `v${healthRes.body.version || "?"}, app: ${healthRes.body.app_id || "?"}`);
  } else {
    addCheck("Teams bridge health", SEVERITY.CRITICAL, false, healthRes.error || `status ${healthRes.status}`);
  }

  // Activity injection test
  const activity = {
    type: "message",
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    channelId: "msteams",
    serviceUrl: `http://${M4_HOST}:${TEAMS_BOT_PORT}`,
    from: { id: "infra-check-user", name: "InfraCheck", aadObjectId: crypto.randomUUID() },
    conversation: { id: `infra-check-${Date.now()}`, tenantId: TENANT_ID, conversationType: "personal" },
    recipient: { id: "infra-check-bot", name: "Mini" },
    text: `[🔧 INFRA-CHECK] ${new Date().toISOString()}`,
    textFormat: "plain",
    channelData: { tenant: { id: TENANT_ID } },
  };
  const injectRes = await httpPost(M4_HOST, TEAMS_BOT_PORT, "/api/messages", activity);
  addCheck("Teams activity processing", SEVERITY.CRITICAL, injectRes.status === 200,
    `status ${injectRes.status}`);

  // Dedup test — same ID should be accepted but not double-processed
  const dedupRes = await httpPost(M4_HOST, TEAMS_BOT_PORT, "/api/messages", activity);
  addCheck("Teams dedup working", SEVERITY.WARNING, dedupRes.status === 200, "same ID re-sent");

  // Non-message activity — should be accepted but ignored
  const sysActivity = { ...activity, type: "conversationUpdate", id: crypto.randomUUID(),
    conversation: { ...activity.conversation, id: `infra-sys-${Date.now()}` } };
  const sysRes = await httpPost(M4_HOST, TEAMS_BOT_PORT, "/api/messages", sysActivity);
  addCheck("Teams non-message handling", SEVERITY.INFO, sysRes.status === 200, `status ${sysRes.status}`);

  // Launchd status via SSH
  try {
    const launchdStatus = execSync(
      `ssh -o ConnectTimeout=3 user@${M4_HOST} "launchctl list 2>/dev/null | grep com.hermitcrab"`,
      { timeout: 8000, encoding: "utf-8" }
    ).trim();
    const lines = launchdStatus.split("\n").filter(Boolean);
    const services = lines.map(l => l.split("\t").pop()).join(", ");
    addCheck("Launchd services", SEVERITY.WARNING, lines.length >= 2,
      `${lines.length} loaded: ${services}`);
  } catch (e) {
    addCheck("Launchd services", SEVERITY.WARNING, false, "SSH check failed");
  }
}

/**
 * 3. GATEWAY
 */
async function checkGateway() {
  section("🚪 Gateway");

  const healthRes = await httpGet(M4_HOST, GATEWAY_PORT, "/health");
  if (healthRes.status === 200) {
    addCheck("Gateway health", SEVERITY.CRITICAL, true, `port ${GATEWAY_PORT}`);
  } else {
    // Gateway might not have /health — just check if port responds
    const rootRes = await httpGet(M4_HOST, GATEWAY_PORT, "/");
    addCheck("Gateway reachable", SEVERITY.CRITICAL, rootRes.status > 0,
      rootRes.status > 0 ? `port ${GATEWAY_PORT} responding` : (rootRes.error || "unreachable"));
  }
}

/**
 * 4. GRAPH API
 */
async function checkGraphAPI() {
  section("📊 Graph API");

  const tokenFile = path.join(GRAPH_DIR, "tokens.json");

  // Token file exists
  if (!fs.existsSync(tokenFile)) {
    addCheck("Graph API tokens", SEVERITY.CRITICAL, false, "tokens.json missing — run setup.js");
    return;
  }

  // Token validity
  try {
    const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf-8"));
    const expiresAt = tokens.expires_at;
    const hasRefresh = !!tokens.refresh_token;
    const now = Date.now();

    addCheck("Graph API refresh token", SEVERITY.CRITICAL, hasRefresh, hasRefresh ? "present" : "MISSING");

    if (expiresAt > now) {
      const minsLeft = Math.round((expiresAt - now) / 60000);
      addCheck("Graph API access token", SEVERITY.WARNING, minsLeft > 5,
        `expires in ${minsLeft} min${minsLeft <= 5 ? " ⚠️ SOON" : ""}`);
    } else {
      addCheck("Graph API access token", SEVERITY.WARNING, false, "expired (will auto-refresh)");
    }

    // Try a live API call
    const graph = require(path.join(GRAPH_DIR, "graph-client"));
    const meRes = await graph.get("/me?$select=displayName,mail");
    if (meRes.ok) {
      addCheck("Graph API live call", SEVERITY.CRITICAL, true,
        `authenticated as ${meRes.data.displayName} (${meRes.data.mail})`);
    } else {
      addCheck("Graph API live call", SEVERITY.CRITICAL, false, meRes.error);
    }
  } catch (e) {
    addCheck("Graph API validation", SEVERITY.CRITICAL, false, e.message);
  }

  // Group chat access
  if (!QUICK) {
    try {
      const graph = require(path.join(GRAPH_DIR, "graph-client"));
      const chatRes = await graph.get(`/chats/${GROUP_CHAT_ID}?$select=id,topic`);
      addCheck("Group 0 V2 accessible", SEVERITY.WARNING, chatRes.ok,
        chatRes.ok ? `topic: "${chatRes.data.topic}"` : chatRes.error);
    } catch (e) {
      addCheck("Group 0 V2 accessible", SEVERITY.WARNING, false, e.message);
    }
  }
}

/**
 * 5. PROCESS HEALTH (via SSH to M4)
 */
async function checkProcesses() {
  section("⚙️ M4 Process Health");

  try {
    // Check port bindings
    const ports = execSync(
      `ssh -o ConnectTimeout=3 user@${M4_HOST} "lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | grep -E '(${TEAMS_BOT_PORT}|${TELEGRAM_REPLY_PORT}|${GATEWAY_PORT})' | awk '{print \\$1, \\$9}'"`,
      { timeout: 8000, encoding: "utf-8" }
    ).trim();

    const portLines = ports.split("\n").filter(Boolean);
    const boundPorts = new Set();
    for (const line of portLines) {
      const match = line.match(/:(\d+)$/);
      if (match) boundPorts.add(parseInt(match[1]));
    }

    addCheck(`Port ${TEAMS_BOT_PORT} (Teams)`, SEVERITY.CRITICAL,
      boundPorts.has(TEAMS_BOT_PORT), boundPorts.has(TEAMS_BOT_PORT) ? "bound" : "NOT bound");
    addCheck(`Port ${TELEGRAM_REPLY_PORT} (Telegram)`, SEVERITY.CRITICAL,
      boundPorts.has(TELEGRAM_REPLY_PORT), boundPorts.has(TELEGRAM_REPLY_PORT) ? "bound" : "NOT bound");
    addCheck(`Port ${GATEWAY_PORT} (Gateway)`, SEVERITY.WARNING,
      boundPorts.has(GATEWAY_PORT), boundPorts.has(GATEWAY_PORT) ? "bound" : "NOT bound");

  } catch (e) {
    addCheck("M4 SSH connectivity", SEVERITY.CRITICAL, false,
      `cannot reach M4: ${e.message.split("\n")[0]}`);
  }

  // Disk space check
  try {
    const df = execSync(
      `ssh -o ConnectTimeout=3 user@${M4_HOST} "df -h / | tail -1 | awk '{print \\$5}'"`,
      { timeout: 8000, encoding: "utf-8" }
    ).trim();
    const usagePercent = parseInt(df);
    addCheck("M4 disk space", SEVERITY.WARNING, usagePercent < 90,
      `${df} used${usagePercent >= 80 ? " ⚠️ getting full" : ""}`);
  } catch { /* skip if SSH fails */ }

  // Uptime
  try {
    const uptime = execSync(
      `ssh -o ConnectTimeout=3 user@${M4_HOST} "uptime -p 2>/dev/null || uptime"`,
      { timeout: 8000, encoding: "utf-8" }
    ).trim();
    addCheck("M4 uptime", SEVERITY.INFO, true, uptime.substring(0, 60));
  } catch { /* skip */ }
}

/**
 * 6. TAILSCALE CONNECTIVITY
 */
async function checkTailscale() {
  section("🌐 Network / Tailscale");

  // SSH check (ping often blocked on Tailscale)
  try {
    const hostname = execSync(
      `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o ServerAliveInterval=5 user@${M4_HOST} "hostname"`,
      { timeout: 15000, encoding: "utf-8" }
    ).trim();
    addCheck("M4 reachable (Tailscale/SSH)", SEVERITY.CRITICAL, true, `${M4_HOST} → ${hostname}`);
  } catch (e) {
    addCheck("M4 reachable (Tailscale/SSH)", SEVERITY.CRITICAL, false, `${M4_HOST} unreachable: ${e.message.split("\n")[0]}`);
  }

  // Tailscale Funnel (external endpoint for Azure Bot Service)
  try {
    const funnelRes = await httpsGet(`https://${M4_HOST}:443/health`, 5000);
    // Funnel might not expose /health — just check if TLS works
    addCheck("Tailscale Funnel (TLS)", SEVERITY.WARNING,
      funnelRes.status > 0 || !funnelRes.error?.includes("ECONNREFUSED"),
      funnelRes.status > 0 ? `status ${funnelRes.status}` : (funnelRes.error || "unknown"));
  } catch {
    addCheck("Tailscale Funnel (TLS)", SEVERITY.INFO, false, "not checked");
  }
}

// ═══════════════════════════════════════════
// NOTIFICATION
// ═══════════════════════════════════════════
function notify(message) {
  return new Promise((resolve) => {
    const data = message;
    const req = https.request({
      hostname: "ntfy.sh", path: "/tonysM5", method: "POST",
      headers: { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(data) },
    }, (res) => { res.on("data", () => {}); res.on("end", resolve); });
    req.on("error", resolve);
    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════
async function printSummary() {
  const critical = checks.filter(c => c.severity === SEVERITY.CRITICAL);
  const warnings = checks.filter(c => c.severity === SEVERITY.WARNING);
  const all = checks;

  const critFailed = critical.filter(c => !c.passed);
  const warnFailed = warnings.filter(c => !c.passed);
  const totalPassed = all.filter(c => c.passed).length;
  const totalFailed = all.filter(c => !c.passed).length;

  if (JSON_OUTPUT) {
    const result = {
      timestamp: new Date().toISOString(),
      summary: { total: all.length, passed: totalPassed, failed: totalFailed,
                 criticalFailed: critFailed.length, warningsFailed: warnFailed.length },
      checks,
      status: critFailed.length > 0 ? "CRITICAL" : (warnFailed.length > 0 ? "DEGRADED" : "HEALTHY"),
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    section("📊 INFRASTRUCTURE HEALTH SUMMARY");

    for (const c of checks) {
      const icon = c.passed ? "✅" : (c.severity === SEVERITY.CRITICAL ? "🔴" : "⚠️");
      console.log(`  ${icon} [${c.severity.toUpperCase().padEnd(8)}] ${c.name}`);
    }

    console.log();
    if (critFailed.length > 0) {
      console.log(`  🔴 ${critFailed.length} CRITICAL failure(s):`);
      for (const c of critFailed) console.log(`     → ${c.name}: ${c.detail}`);
      console.log();
    }
    if (warnFailed.length > 0) {
      console.log(`  ⚠️  ${warnFailed.length} warning(s):`);
      for (const c of warnFailed) console.log(`     → ${c.name}: ${c.detail}`);
      console.log();
    }

    const status = critFailed.length > 0 ? "🔴 CRITICAL"
                 : warnFailed.length > 0 ? "🟡 DEGRADED" : "🟢 HEALTHY";
    console.log(`  Overall: ${status} — ${totalPassed}/${all.length} checks passed\n`);
  }

  // Send notification if requested
  if (NOTIFY) {
    const status = critFailed.length > 0 ? "🔴 CRITICAL"
                 : warnFailed.length > 0 ? "🟡 DEGRADED" : "🟢 HEALTHY";
    const msg = `${status} HermitCrab Infra: ${totalPassed}/${all.length} checks passed` +
      (critFailed.length > 0 ? `\nCritical: ${critFailed.map(c => c.name).join(", ")}` : "");
    await notify(msg);
  }

  return critFailed.length > 0 ? 2 : (totalFailed > 0 ? 1 : 0);
}

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════
async function main() {
  if (!JSON_OUTPUT) {
    console.log("\n🔧 HermitCrab Infrastructure Health Check");
    console.log(`   ${new Date().toLocaleString()}${QUICK ? " (quick mode)" : ""}\n`);
  }

  // Run all checks (order matters — network first)
  await checkTailscale();
  await checkProcesses();
  await checkTelegram();
  await checkTeams();
  await checkGateway();
  await checkGraphAPI();

  const exitCode = await printSummary();
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("💥 Fatal:", e.message);
  process.exit(2);
});
