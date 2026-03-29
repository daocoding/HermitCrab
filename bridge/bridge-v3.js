#!/usr/bin/env node
/**
 * 🦀 HermitCrab Telegram Bridge v3 — antigravity-cli Wake-Up
 * 
 * Architecture:
 *   Telegram → Bridge → antigravity-cli (spawns JARVIS session)
 *   JARVIS session → curl POST /reply → Bridge → Telegram
 * 
 * The bridge is a DUMB PIPE + ALARM CLOCK. It does not think.
 * JARVIS (inside Antigravity) is the ONLY brain.
 */

const { Bot, InputFile } = require("grammy");
const http = require("http");
const https = require("https");
const { exec, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const BOT_TOKEN = process.argv[2] || process.env.TELEGRAM_BOT_TOKEN;
const HTTP_PORT = parseInt(process.env.HERMITCRAB_PORT || "18790", 10);
const WORKSPACE = process.env.HERMITCRAB_WORKSPACE || path.resolve(__dirname, "../..");
const CLI_PATH = process.env.ANTIGRAVITY_CLI || path.join(process.env.HOME, ".local/bin/antigravity-cli");
const INBOX_DIR = path.join(WORKSPACE, "hermitcrab", "inbox");
const CONVO_DIR = path.join(WORKSPACE, "hermitcrab", "conversations");
const AUDIO_DIR = path.join(WORKSPACE, "hermitcrab", "audio");
const PATH_ENV = `${path.dirname(CLI_PATH)}:${process.env.PATH}`;

// ElevenLabs TTS
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
const VOICE_IDS = {
  elise: "EST9Ui6982FZPSi7gCHi",
  tao: "v04RfKTwJurD5EH186vR",
};
const DEFAULT_VOICE = "tao";

if (!BOT_TOKEN) {
  console.error("Usage: node bridge-v3.js <BOT_TOKEN>");
  process.exit(1);
}

fs.mkdirSync(INBOX_DIR, { recursive: true });
fs.mkdirSync(CONVO_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const bot = new Bot(BOT_TOKEN);
let lastChatId = null;

// ═══════════════════════════════════════════
// CONVERSATION LOG — records both sides
// ═══════════════════════════════════════════
function convoPath(chatId) {
  return path.join(CONVO_DIR, `${chatId}.jsonl`);
}

function logConvo(chatId, role, text) {
  const entry = { role, text, ts: new Date().toISOString() };
  fs.appendFileSync(convoPath(chatId), JSON.stringify(entry) + "\n");
}

function readConvoHistory(chatId) {
  const file = convoPath(chatId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function formatConvoForPrompt(chatId) {
  const history = readConvoHistory(chatId);
  if (history.length === 0) return "(no previous messages)";
  return history.map(m => {
    const label = m.role === "user" ? "Tony" : "JARVIS";
    return `[${label}] ${m.text}`;
  }).join("\n");
}

// ═══════════════════════════════════════════
// LOG
// ═══════════════════════════════════════════
function log(direction, data) {
  const entry = { direction, ...data, ts: new Date().toISOString() };
  console.log(JSON.stringify(entry));
}

// ═══════════════════════════════════════════
// INBOUND: Telegram → antigravity-cli → JARVIS
// ═══════════════════════════════════════════
bot.on("message", async (ctx) => {
  const text = ctx.message.text || "";
  const chatId = ctx.chat.id;
  const from = ctx.from?.first_name || "Unknown";
  const username = ctx.from?.username || "";
  
  // Skip /start command
  if (text === "/start") return;
  
  lastChatId = chatId;
  log("IN", { chat_id: chatId, from, username, text });
  
  // Log to conversation history
  logConvo(chatId, "user", text);
  
  // Wake JARVIS
  wakeJarvis(chatId, from, username, text);
});

// ═══════════════════════════════════════════
// WAKE: antigravity-cli spawns a JARVIS session
// ═══════════════════════════════════════════
function wakeJarvis(chatId, from, username, text) {
  const convoHistory = formatConvoForPrompt(chatId);
  
  const prompt = `📱 TELEGRAM MESSAGE via HermitCrab bridge.
From: ${from} (@${username})
Latest message: "${text}"

CONVERSATION HISTORY:
${convoHistory}

You are JARVIS. Tony messaged you on Telegram. You have the full conversation history above.
Respond naturally, with awareness of everything discussed so far.

To send your reply, run this terminal command:
curl -s -X POST http://localhost:${HTTP_PORT}/reply -H "Content-Type: application/json" -d '{"chat_id": ${chatId}, "text": "YOUR_REPLY_HERE"}'

Replace YOUR_REPLY_HERE with your response. Keep it concise — this is a chat message.
You MUST run the curl command or the user won't see your response.`;

  // Write prompt to a temp file to avoid shell escaping issues
  const tmpFile = path.join(os.tmpdir(), `hermitcrab-wake-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt);
  
  log("WAKE", { chat_id: chatId, method: "antigravity-cli -a (via file)" });
  
  // Use execFile with argument array — no shell escaping needed
  execFile(CLI_PATH, ["-a", prompt], { 
    cwd: WORKSPACE, 
    env: { ...process.env, PATH: PATH_ENV },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  }, (error, stdout, stderr) => {
    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch {}
    
    if (error) {
      log("WAKE_ERROR", { error: error.message, stderr: stderr?.trim() });
      // Fallback: notify via ntfy
      exec(`curl -s -d "⚠️ HermitCrab: Telegram msg from ${from} but wake failed: ${error.message}" ntfy.sh/tonysM5`);
      return;
    }
    const output = stdout?.trim();
    if (output) {
      log("WAKE_OK", { output });
    }
  });
}

// ═══════════════════════════════════════════
// HTTP SERVER: JARVIS sends replies here
// ═══════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") {
    res.writeHead(200); res.end(); return;
  }
  
  // POST /reply — JARVIS sends response to Telegram
  if (req.method === "POST" && req.url === "/reply") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { chat_id, text } = JSON.parse(body);
        const target = chat_id || lastChatId;
        
        if (!target || !text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Need chat_id and text" }));
          return;
        }
        
        await bot.api.sendMessage(target, text);
        log("OUT", { chat_id: target, text: text.substring(0, 100) + (text.length > 100 ? "..." : "") });
        
        // Log to conversation history
        logConvo(target, "assistant", text);
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, chat_id: target }));
      } catch (err) {
        log("ERROR", { error: err.message });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  
  // POST /voice-reply — JARVIS sends voice response to Telegram
  if (req.method === "POST" && req.url === "/voice-reply") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { chat_id, text, voice } = JSON.parse(body);
        const target = chat_id || lastChatId;
        const voiceId = VOICE_IDS[voice || DEFAULT_VOICE] || VOICE_IDS[DEFAULT_VOICE];
        
        if (!target || !text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Need chat_id and text" }));
          return;
        }
        
        if (!ELEVENLABS_KEY) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "ELEVENLABS_API_KEY not set" }));
          return;
        }
        
        log("VOICE", { chat_id: target, text: text.substring(0, 60) + "...", voice: voice || DEFAULT_VOICE });
        
        // Call ElevenLabs TTS
        const audioBuffer = await elevenLabsTTS(text, voiceId);
        
        // Send as voice message on Telegram
        const audioFile = path.join(AUDIO_DIR, `reply_${Date.now()}.mp3`);
        fs.writeFileSync(audioFile, audioBuffer);
        
        await bot.api.sendVoice(target, new InputFile(audioFile));
        log("VOICE_OUT", { chat_id: target, file: audioFile });
        
        // Also send text version
        await bot.api.sendMessage(target, text);
        
        // Clean up audio file after a delay
        setTimeout(() => fs.unlinkSync(audioFile), 30000);
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, chat_id: target, voice: true }));
      } catch (err) {
        log("VOICE_ERROR", { error: err.message });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  
  // GET /status — health check
  if (req.method === "GET" && (req.url === "/status" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: "🦀 HermitCrab Bridge",
      status: "running",
      bot: bot.botInfo?.username,
      http_port: HTTP_PORT,
      uptime_s: Math.round(process.uptime()),
      last_chat_id: lastChatId,
      voice_enabled: !!ELEVENLABS_KEY,
    }));
    return;
  }
  
  res.writeHead(404); res.end("Not found");
});

// ═══════════════════════════════════════════
// ELEVENLABS TTS
// ═══════════════════════════════════════════
function elevenLabsTTS(text, voiceId) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });
    
    const options = {
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${voiceId}`,
      method: "POST",
      headers: {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_KEY,
      },
    };
    
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`ElevenLabs API error: ${res.statusCode} ${Buffer.concat(chunks).toString()}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
server.listen(HTTP_PORT, "127.0.0.1", () => {
  log("SYSTEM", { event: "http_ready", port: HTTP_PORT });
});

bot.start({
  onStart: (botInfo) => {
    log("SYSTEM", {
      event: "bridge_started",
      bot: botInfo.username,
      http: `http://localhost:${HTTP_PORT}`,
      workspace: WORKSPACE,
      cli: CLI_PATH,
    });
  },
});

process.on("SIGINT", () => {
  log("SYSTEM", { event: "stopping" });
  server.close();
  bot.stop();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log("FATAL", { error: err.message });
  process.exit(1);
});
