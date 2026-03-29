#!/usr/bin/env node
/**
 * 🦀 HermitCrab Telegram Bridge v2 — Wake-Up Edition
 * 
 * A persistent bridge that:
 * 1. Listens for Telegram messages
 * 2. Wakes JARVIS via `antigravity chat` when messages arrive
 * 3. Runs a local HTTP server so JARVIS can send replies back
 * 
 * The bridge is a DUMB PIPE + ALARM CLOCK. It does not think.
 */

const { Bot } = require("grammy");
const http = require("http");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.argv[2] || process.env.TELEGRAM_BOT_TOKEN;
const HTTP_PORT = parseInt(process.env.HERMITCRAB_PORT || "18790", 10);
const WORKSPACE = process.env.HERMITCRAB_WORKSPACE || path.resolve(__dirname, "../..");
const INBOX_DIR = path.join(WORKSPACE, "hermitcrab", "inbox");

if (!BOT_TOKEN) {
  console.error("Usage: node bridge-v2.js <BOT_TOKEN>");
  process.exit(1);
}

// Ensure inbox directory exists
fs.mkdirSync(INBOX_DIR, { recursive: true });

const bot = new Bot(BOT_TOKEN);
const activeChats = new Map();
let lastChatId = null;

// ═══════════════════════════════════════════
// LOG helper
// ═══════════════════════════════════════════
function log(direction, data) {
  const entry = { direction, ...data, timestamp: new Date().toISOString() };
  console.log(JSON.stringify(entry));
  return entry;
}

// ═══════════════════════════════════════════
// INBOUND: Telegram → wake JARVIS
// ═══════════════════════════════════════════
bot.on("message", async (ctx) => {
  const text = ctx.message.text || "";
  const chatId = ctx.chat.id;
  const from = ctx.from?.first_name || "Unknown";
  const username = ctx.from?.username || "";
  
  lastChatId = chatId;
  activeChats.set(chatId, { from, username });
  
  log("IN", { chat_id: chatId, from, username, text });
  
  // Write message to inbox file (for JARVIS to read if needed)
  const inboxEntry = {
    chat_id: chatId,
    from,
    username,
    text,
    timestamp: new Date().toISOString(),
    replied: false,
  };
  
  const inboxFile = path.join(INBOX_DIR, `${chatId}.jsonl`);
  fs.appendFileSync(inboxFile, JSON.stringify(inboxEntry) + "\n");
  
  // Wake JARVIS via antigravity chat
  wakeJarvis(chatId, from, username, text);
});

// ═══════════════════════════════════════════
// WAKE: Trigger antigravity chat
// ═══════════════════════════════════════════
function wakeJarvis(chatId, from, username, text) {
  const prompt = [
    `📱 TELEGRAM MESSAGE from ${from} (@${username}):`,
    `"${text}"`,
    ``,
    `You are JARVIS. Someone sent you a message on Telegram via the HermitCrab bridge.`,
    `Reply by running this exact command (replace YOUR_REPLY with your actual response):`,
    ``,
    `curl -s -X POST http://localhost:${HTTP_PORT}/reply \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"chat_id": ${chatId}, "text": "YOUR_REPLY"}'`,
    ``,
    `Rules:`,
    `- Keep it concise and conversational (it's a chat message)`,
    `- Run the curl command to send your reply`,
    `- You MUST run the curl command, otherwise the user won't see your response`,
  ].join("\n");
  
  // Escape for shell
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  
  // No --reuse-window: opens a NEW conversation so JARVIS gets a dedicated turn
  const cmd = `antigravity chat --mode agent '${escapedPrompt}'`;
  
  log("WAKE", { chat_id: chatId, cmd: "antigravity chat (new conversation)" });
  
  exec(cmd, { cwd: WORKSPACE }, (error, stdout, stderr) => {
    if (error) {
      log("WAKE_ERROR", { error: error.message });
    }
  });
}

// ═══════════════════════════════════════════
// HTTP SERVER: JARVIS sends replies here
// ═══════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  // CORS headers for flexibility
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // POST /reply — send a message to Telegram
  if (req.method === "POST" && req.url === "/reply") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { chat_id, text } = JSON.parse(body);
        const targetChat = chat_id || lastChatId;
        
        if (!targetChat || !text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Need chat_id and text" }));
          return;
        }
        
        await bot.api.sendMessage(targetChat, text);
        log("OUT", { chat_id: targetChat, text });
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, chat_id: targetChat }));
      } catch (err) {
        log("ERROR", { error: err.message });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  
  // GET /status — health check
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "running",
      bot_username: bot.botInfo?.username,
      active_chats: activeChats.size,
      last_chat_id: lastChatId,
      uptime: process.uptime(),
    }));
    return;
  }
  
  res.writeHead(404);
  res.end("Not found");
});

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
server.listen(HTTP_PORT, "127.0.0.1", () => {
  log("SYSTEM", { event: "http_started", port: HTTP_PORT });
});

bot.start({
  onStart: (botInfo) => {
    log("SYSTEM", {
      event: "started",
      bot_username: botInfo.username,
      bot_id: botInfo.id,
      http_port: HTTP_PORT,
      workspace: WORKSPACE,
    });
  },
});

process.on("SIGINT", () => {
  log("SYSTEM", { event: "stopping" });
  server.close();
  bot.stop();
  process.exit(0);
});
