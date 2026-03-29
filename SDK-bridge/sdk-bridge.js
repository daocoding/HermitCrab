#!/usr/bin/env node
/**
 * 🦀🏢 HermitCrab SDK Bridge — Microsoft 365 Agents SDK
 * 
 * Built on the official Agents SDK (@microsoft/agents-hosting-express)
 * to future-proof against Bot Framework retirement.
 * 
 * This bridge runs ALONGSIDE teams-bridge.js during the transition period.
 * Same Antigravity CLI pattern, same session management.
 * 
 * Architecture:
 *   Teams → Azure Bot → Tailscale Funnel → SDK Bridge → Antigravity CLI → Agent session
 *   Agent session → curl POST /reply → SDK Bridge → Bot Service → Teams
 */

const { AgentApplication, startServer } = require("@microsoft/agents-hosting-express");
const http = require("http");
const { execFile, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const WORKSPACE = process.env.WORKSPACE || path.resolve(__dirname, "../..");
const CLI_PATH = process.env.CLI_PATH || path.join(os.homedir(), ".local/bin/antigravity-cli");
const BRIDGE_PORT = process.env.BRIDGE_PORT || "";
const REPLY_PORT = parseInt(process.env.SDK_REPLY_PORT || "18796", 10);
const SDK_PORT = parseInt(process.env.SDK_PORT || "3978", 10);
const PERSONA_NAME = process.env.PERSONA_NAME || "Zen";

// Persona
const PERSONA_FILE = process.env.PERSONA_FILE || path.join(WORKSPACE, "hermitcrab/personas/zen.md");
let PERSONA_TEXT = "";
try { PERSONA_TEXT = fs.readFileSync(PERSONA_FILE, "utf-8"); } catch (_) {}

const PATH_ENV = [
  path.join(os.homedir(), ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
const busySessions = new Map();
const pendingReplies = new Map();
const recentActivityIds = new Map();
const typingTimers = new Map();
const replyWatchdogs = new Map();
const REPLY_TIMEOUT_MS = 180000; // 3 minutes
const DEDUP_WINDOW_MS = 10000;

// Session registry
const SESSION_FILE = path.join(WORKSPACE, "hermitcrab/sdk-sessions.json");
function loadSessionRegistry() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8")); } catch (_) { return {}; }
}
function saveSessionRegistry(reg) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(reg, null, 2));
}
function getSessionUUID(conversationId) {
  const reg = loadSessionRegistry();
  const entry = reg[conversationId];
  return typeof entry === "string" ? entry : entry?.uuid;
}

// Logging
function log(direction, data = {}) {
  const entry = { direction, ...data, ts: new Date().toISOString() };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

// ═══════════════════════════════════════════
// AGENTS SDK APP
// ═══════════════════════════════════════════
const app = new AgentApplication();

app.onMessage(async (context) => {
  const activity = context.activity;
  
  // Dedup
  if (activity.id && recentActivityIds.has(activity.id)) {
    log("DEDUP", { activity_id: activity.id });
    return;
  }
  if (activity.id) {
    recentActivityIds.set(activity.id, Date.now());
    setTimeout(() => recentActivityIds.delete(activity.id), DEDUP_WINDOW_MS);
  }
  
  const conversationId = activity.conversation?.id;
  const senderName = activity.from?.name || "Unknown";
  const text = (activity.text || "").replace(/<[^>]+>/g, "").trim();
  
  if (!text || !conversationId) return;
  
  log("IN", { conversation_id: conversationId, sender: senderName, text });
  
  // Send typing indicator
  await context.sendActivity({ type: "typing" });
  
  // Start watchdog
  startReplyWatchdog(conversationId, context);
  
  // Busy gate
  const session = busySessions.get(conversationId);
  log("BUSY_CHECK", { conversation_id: conversationId, is_busy: !!session?.busy });
  
  if (session?.busy) {
    session.queue.push({ senderName, text, context });
    log("QUEUED", { conversation_id: conversationId, queue_length: session.queue.length });
    return;
  }
  
  busySessions.set(conversationId, { busy: true, queue: [] });
  log("BUSY_SET", { conversation_id: conversationId });
  
  // Store reply context
  pendingReplies.set(conversationId, context);
  
  // Wake agent
  wakeAgent(conversationId, senderName, text);
});

// ═══════════════════════════════════════════
// WAKE AGENT
// ═══════════════════════════════════════════
function wakeAgent(conversationId, senderName, text) {
  const existingUUID = getSessionUUID(conversationId);
  const isNewSession = !existingUUID;
  
  const personaBlock = PERSONA_TEXT
    ? `\n--- IDENTITY ---\n${PERSONA_TEXT}\n--- END IDENTITY ---\n`
    : "";
  
  const firstTimePrompt = `🏢 TEAMS CHANNEL — HermitCrab SDK Bridge
${personaBlock}You are ${PERSONA_NAME}, connected to Microsoft Teams via the Agents SDK. A user is chatting with you.
From: ${senderName}, conversation: ${conversationId}

This is a PERSISTENT session. All future messages from this user will arrive here.

To reply, ALWAYS run this curl command:
curl -s -X POST http://localhost:${REPLY_PORT}/reply -H "Content-Type: application/json" -d '{"conversation_id": "${conversationId}", "text": "YOUR_REPLY_HERE"}'

Replace YOUR_REPLY_HERE with your response.
You MUST run the curl command or the user won't see your response.

First message from ${senderName}: "${text}"`;

  const followUpPrompt = `🏢 from ${senderName}: "${text}"

Reply via: curl -s -X POST http://localhost:${REPLY_PORT}/reply -H "Content-Type: application/json" -d '{"conversation_id": "${conversationId}", "text": "YOUR_REPLY"}'`;

  const prompt = isNewSession ? firstTimePrompt : followUpPrompt;
  const portArgs = BRIDGE_PORT ? ["-p", BRIDGE_PORT] : [];
  const args = isNewSession
    ? [...portArgs, "-a", prompt]
    : [...portArgs, "-a", "-r", existingUUID, prompt];

  log("WAKE", {
    conversation_id: conversationId,
    method: isNewSession ? "new-session" : "resume-session",
    session_uuid: existingUUID || "(creating)",
    sender: senderName,
  });

  execFile(CLI_PATH, args, {
    cwd: WORKSPACE,
    env: { ...process.env, PATH: PATH_ENV },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error) {
      log("WAKE_ERROR", { error: error.message });
      if (!isNewSession) {
        const registry = loadSessionRegistry();
        delete registry[conversationId];
        saveSessionRegistry(registry);
        wakeAgent(conversationId, senderName, text);
      } else {
        exec(`curl -s -d "⚠️ HermitCrab SDK: wake failed for ${senderName}" ntfy.sh/tonysM5`);
      }
      return;
    }

    const rawOutput = (stdout || "") + (stderr || "");
    const output = rawOutput.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\[\?[0-9]*[a-zA-Z]|\r/g, "").trim();

    if (isNewSession && output) {
      const match = output.match(/Cascade:\s*([a-f0-9]+)/i);
      if (match) {
        const partialUUID = match[1];
        setTimeout(() => resolveAndSaveSession(conversationId, partialUUID), 2000);
      }
    }

    if (output) {
      log("WAKE_OK", { output, session: isNewSession ? "new" : "resumed" });
    }
  });
}

// ═══════════════════════════════════════════
// SESSION RESOLUTION
// ═══════════════════════════════════════════
function resolveAndSaveSession(conversationId, partialUUID) {
  const sessionsDir = path.join(os.homedir(), ".antigravity", "sessions");
  try {
    const files = fs.readdirSync(sessionsDir);
    const match = files.find(f => f.startsWith(partialUUID) && f.endsWith(".json"));
    if (match) {
      const fullUUID = match.replace(".json", "");
      const registry = loadSessionRegistry();
      registry[conversationId] = { uuid: fullUUID };
      saveSessionRegistry(registry);
      log("SESSION", { conversation_id: conversationId, uuid: fullUUID, event: "registered" });
    }
  } catch (err) {
    log("SESSION_ERROR", { error: err.message });
  }
}

// ═══════════════════════════════════════════
// WATCHDOG
// ═══════════════════════════════════════════
function startReplyWatchdog(conversationId, context) {
  const existing = replyWatchdogs.get(conversationId);
  if (existing) clearTimeout(existing.timer);
  
  const timer = setTimeout(async () => {
    replyWatchdogs.delete(conversationId);
    log("WATCHDOG", { conversation_id: conversationId, action: "timeout", seconds: REPLY_TIMEOUT_MS / 1000 });
    try {
      const ctx = pendingReplies.get(conversationId);
      if (ctx) {
        await ctx.sendActivity("⏳ That's taking longer than expected. I'm still working on it — you can send another message in the meantime.");
      }
    } catch (_) {}
    busySessions.delete(conversationId);
    log("WATCHDOG", { conversation_id: conversationId, action: "busy_cleared" });
  }, REPLY_TIMEOUT_MS);
  
  replyWatchdogs.set(conversationId, { timer, context });
}

// ═══════════════════════════════════════════
// REPLY SERVER (for agent curl)
// ═══════════════════════════════════════════
const replyServer = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  
  if (req.method === "POST" && req.url === "/reply") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { conversation_id, text } = JSON.parse(body);
      
      if (!conversation_id || !text) {
        res.writeHead(400); res.end(JSON.stringify({ error: "Need conversation_id and text" }));
        return;
      }
      
      const context = pendingReplies.get(conversation_id);
      if (!context) {
        res.writeHead(404); res.end(JSON.stringify({ error: "No reply context" }));
        return;
      }
      
      // Clear watchdog
      const wd = replyWatchdogs.get(conversation_id);
      if (wd) { clearTimeout(wd.timer); replyWatchdogs.delete(conversation_id); }
      
      // Clear busy state BEFORE sending (learned from teams-bridge bug!)
      const session = busySessions.get(conversation_id);
      const queuedMessages = session?.queue?.length > 0 ? [...session.queue] : [];
      busySessions.delete(conversation_id);
      log("BUSY_CLEAR", { conversation_id, queue_drained: queuedMessages.length });
      
      // Send reply via Agents SDK context
      await context.sendActivity(text);
      
      log("OUT", { conversation_id, text: text.substring(0, 100) + (text.length > 100 ? "..." : "") });
      
      // Drain queue
      if (queuedMessages.length > 0) {
        const next = queuedMessages.shift();
        log("DRAIN", { conversation_id, remaining: queuedMessages.length });
        busySessions.set(conversation_id, { busy: true, queue: queuedMessages });
        pendingReplies.set(conversation_id, next.context);
        startReplyWatchdog(conversation_id, next.context);
        wakeAgent(conversation_id, next.senderName, next.text);
      }
      
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      log("REPLY_ERROR", { error: err.message });
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200); res.end(JSON.stringify({ status: "ok", bridge: "sdk", port: SDK_PORT }));
    return;
  }
  
  res.writeHead(404); res.end("Not found");
});

// ═══════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════
async function main() {
  // Start reply server
  replyServer.listen(REPLY_PORT, "127.0.0.1", () => {
    log("SYSTEM", { event: "reply_server_ready", port: REPLY_PORT });
  });
  
  // Start Agents SDK server
  await startServer(app, SDK_PORT);
  
  log("SYSTEM", {
    event: "sdk_bridge_started",
    version: "1.0",
    persona: PERSONA_NAME,
    sdk_port: SDK_PORT,
    reply_port: REPLY_PORT,
    workspace: WORKSPACE,
    cli: CLI_PATH,
  });
  
  console.log(`
╔══════════════════════════════════════════════════════╗
║  🦀🏢 HermitCrab SDK Bridge  v1.0                   ║
║                                                      ║
║  Agents SDK:     http://0.0.0.0:${SDK_PORT}              ║
║  Reply endpoint: http://127.0.0.1:${REPLY_PORT}          ║
║  Persona: ${PERSONA_NAME}                                     ║
╚══════════════════════════════════════════════════════╝
          `);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
