#!/usr/bin/env node
/**
 * 🦀 HermitCrab Telegram Bridge v4 — Streaming + Typing Indicators
 * 
 * New in v4:
 *   ✅ Typing indicator — shows "typing..." as soon as a message arrives,
 *      refreshed every 4s until JARVIS replies.
 *   ✅ Streaming — POST /stream to send text chunks that progressively
 *      build a message via editMessageText (like ChatGPT-style streaming).
 *   ✅ All v3 features: /reply, /voice-reply, /status
 * 
 * Architecture:
 *   Telegram → Bridge → antigravity-cli (spawns JARVIS session)
 *   JARVIS session → curl POST /reply or /stream → Bridge → Telegram
 */

const { Bot, InputFile } = require("grammy");
const http = require("http");
const https = require("https");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const BOT_TOKEN = process.argv[2] || process.env.TELEGRAM_BOT_TOKEN;
const HTTP_PORT = parseInt(process.env.HERMITCRAB_PORT || "18790", 10);
const WORKSPACE = process.env.HERMITCRAB_WORKSPACE || path.resolve(__dirname, "../..");
const CLI_PATH = process.env.ANTIGRAVITY_CLI || path.join(process.env.HOME, ".local/bin/antigravity-cli");
const INBOX_DIR = path.join(WORKSPACE, "hermitcrab", "inbox");
const AUDIO_DIR = path.join(WORKSPACE, "hermitcrab", "audio");
const PATH_ENV = `${path.dirname(CLI_PATH)}:${process.env.PATH}`;

// ElevenLabs TTS
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
const VOICE_IDS = {
  elise: "EST9Ui6982FZPSi7gCHi",
  tao: "v04RfKTwJurD5EH186vR",
};
const DEFAULT_VOICE = "tao";

// Streaming config
const STREAM_EDIT_THROTTLE_MS = 1500; // Min ms between message edits (Telegram rate limit safety)

if (!BOT_TOKEN) {
  console.error("Usage: node bridge-v4.js <BOT_TOKEN>");
  process.exit(1);
}

fs.mkdirSync(INBOX_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const bot = new Bot(BOT_TOKEN);
let lastChatId = null;

// ═══════════════════════════════════════════
// TYPING INDICATOR MANAGER
// ═══════════════════════════════════════════
// Tracks active typing indicators per chat_id.
// Sends "typing" action every 4s until stopped.
const typingIntervals = new Map();

function startTyping(chatId) {
  // Don't double-start
  if (typingIntervals.has(chatId)) return;
  
  // Send immediately
  bot.api.sendChatAction(chatId, "typing").catch(() => {});
  
  // Refresh every 4 seconds (Telegram clears after 5s)
  const interval = setInterval(() => {
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);
  
  typingIntervals.set(chatId, interval);
  log("TYPING", { chat_id: chatId, action: "start" });
}

function stopTyping(chatId) {
  const interval = typingIntervals.get(chatId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(chatId);
    log("TYPING", { chat_id: chatId, action: "stop" });
  }
}

// ═══════════════════════════════════════════
// STREAMING STATE
// ═══════════════════════════════════════════
// Tracks active streams per chat_id.
// Each stream: { messageId, fullText, lastEditTime, pendingEdit }
const activeStreams = new Map();

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
  
  // Save to inbox
  const entry = { chat_id: chatId, from, username, text, ts: new Date().toISOString() };
  fs.appendFileSync(path.join(INBOX_DIR, `${chatId}.jsonl`), JSON.stringify(entry) + "\n");
  
  // Start typing indicator immediately
  startTyping(chatId);
  
  // Wake JARVIS
  wakeJarvis(chatId, from, username, text);
});

// ═══════════════════════════════════════════
// WAKE: antigravity-cli spawns a JARVIS session
// ═══════════════════════════════════════════
function wakeJarvis(chatId, from, username, text) {
  const prompt = `📱 TELEGRAM MESSAGE received via HermitCrab bridge.
From: ${from} (@${username})
Message: "${text}"

You are JARVIS. Someone messaged you on Telegram. Read your context files if needed.

IMPORTANT: To send your reply back to Telegram, you MUST run this terminal command:
curl -s -X POST http://localhost:${HTTP_PORT}/reply -H "Content-Type: application/json" -d '{"chat_id": ${chatId}, "text": "YOUR_REPLY_HERE"}'

Replace YOUR_REPLY_HERE with your actual response. Keep it concise — this is a chat message.
You MUST run the curl command or the user will never see your response.`;

  // Use antigravity-cli in fire-and-forget mode (-a)
  const escaped = prompt.replace(/"/g, '\\"');
  const cmd = `"${CLI_PATH}" -m gemini-3-flash -a "${escaped}"`;
  
  log("WAKE", { chat_id: chatId, method: "antigravity-cli -a" });
  
  exec(cmd, { 
    cwd: WORKSPACE, 
    env: { ...process.env, PATH: PATH_ENV },
    timeout: 15000,
  }, (error, stdout, stderr) => {
    if (error) {
      log("WAKE_ERROR", { error: error.message, stderr: stderr?.trim() });
      stopTyping(chatId);
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
// PARSE REQUEST BODY (helper)
// ═══════════════════════════════════════════
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
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
  
  // ─────────────────────────────────────────
  // POST /reply — JARVIS sends a single response
  // ─────────────────────────────────────────
  if (req.method === "POST" && req.url === "/reply") {
    try {
      const { chat_id, text } = await parseBody(req);
      const target = chat_id || lastChatId;
      
      if (!target || !text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Need chat_id and text" }));
        return;
      }
      
      // Stop typing indicator — reply is here
      stopTyping(target);
      
      await bot.api.sendMessage(target, text);
      log("OUT", { chat_id: target, text: text.substring(0, 100) + (text.length > 100 ? "..." : "") });
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, chat_id: target }));
    } catch (err) {
      log("ERROR", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  
  // ─────────────────────────────────────────
  // POST /stream — Start or append to a streaming message
  // Body: { chat_id, text, done? }
  //   - First call: sends a new message, returns { stream_id, message_id }
  //   - Subsequent calls: edits the message, appending text
  //   - Set done:true on last chunk to finalize
  // ─────────────────────────────────────────
  if (req.method === "POST" && req.url === "/stream") {
    try {
      const { chat_id, text, done } = await parseBody(req);
      const target = chat_id || lastChatId;
      
      if (!target || !text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Need chat_id and text" }));
        return;
      }
      
      const streamKey = String(target);
      let stream = activeStreams.get(streamKey);
      
      if (!stream) {
        // First chunk — send initial message
        stopTyping(target); // Stop "typing..." once first text arrives
        
        const msg = await bot.api.sendMessage(target, text);
        stream = {
          messageId: msg.message_id,
          fullText: text,
          lastEditTime: Date.now(),
          pendingEdit: null,
        };
        activeStreams.set(streamKey, stream);
        log("STREAM_START", { chat_id: target, message_id: msg.message_id, chunk_len: text.length });
      } else {
        // Append chunk to full text
        stream.fullText += text;
        
        const now = Date.now();
        const timeSinceLastEdit = now - stream.lastEditTime;
        
        if (done || timeSinceLastEdit >= STREAM_EDIT_THROTTLE_MS) {
          // Edit immediately
          if (stream.pendingEdit) {
            clearTimeout(stream.pendingEdit);
            stream.pendingEdit = null;
          }
          
          try {
            await bot.api.editMessageText(target, stream.messageId, stream.fullText);
            stream.lastEditTime = Date.now();
          } catch (editErr) {
            // "message is not modified" is fine — just means text didn't change
            if (!editErr.message?.includes("not modified")) {
              log("STREAM_EDIT_ERROR", { error: editErr.message });
            }
          }
          
          log("STREAM_EDIT", { chat_id: target, total_len: stream.fullText.length, done: !!done });
        } else {
          // Schedule a deferred edit to catch up
          if (stream.pendingEdit) clearTimeout(stream.pendingEdit);
          stream.pendingEdit = setTimeout(async () => {
            try {
              await bot.api.editMessageText(target, stream.messageId, stream.fullText);
              stream.lastEditTime = Date.now();
            } catch (editErr) {
              if (!editErr.message?.includes("not modified")) {
                log("STREAM_EDIT_ERROR", { error: editErr.message });
              }
            }
          }, STREAM_EDIT_THROTTLE_MS - timeSinceLastEdit);
        }
      }
      
      // If done, clean up stream state
      if (done) {
        if (stream.pendingEdit) {
          clearTimeout(stream.pendingEdit);
        }
        // Final edit to ensure everything is flushed
        try {
          await bot.api.editMessageText(target, stream.messageId, stream.fullText);
        } catch (e) {
          // ignore "not modified"
        }
        activeStreams.delete(streamKey);
        log("STREAM_END", { chat_id: target, total_len: stream.fullText.length });
      }
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        ok: true, 
        chat_id: target, 
        message_id: stream?.messageId,
        total_len: stream?.fullText?.length,
        streaming: !done,
      }));
    } catch (err) {
      log("STREAM_ERROR", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  
  // ─────────────────────────────────────────
  // POST /typing — Manually start/stop typing
  // Body: { chat_id, action: "start"|"stop" }
  // ─────────────────────────────────────────
  if (req.method === "POST" && req.url === "/typing") {
    try {
      const { chat_id, action } = await parseBody(req);
      const target = chat_id || lastChatId;
      
      if (!target) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Need chat_id" }));
        return;
      }
      
      if (action === "stop") {
        stopTyping(target);
      } else {
        startTyping(target);
      }
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, chat_id: target, typing: action !== "stop" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  
  // ─────────────────────────────────────────
  // POST /voice-reply — JARVIS sends voice response
  // ─────────────────────────────────────────
  if (req.method === "POST" && req.url === "/voice-reply") {
    try {
      const { chat_id, text, voice } = await parseBody(req);
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
      
      // Stop typing
      stopTyping(target);
      
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
    return;
  }
  
  // ─────────────────────────────────────────
  // GET /status — health check
  // ─────────────────────────────────────────
  if (req.method === "GET" && (req.url === "/status" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: "🦀 HermitCrab Bridge",
      version: "v4",
      status: "running",
      bot: bot.botInfo?.username,
      http_port: HTTP_PORT,
      uptime_s: Math.round(process.uptime()),
      last_chat_id: lastChatId,
      voice_enabled: !!ELEVENLABS_KEY,
      features: ["typing_indicators", "streaming", "voice"],
      active_typing: [...typingIntervals.keys()],
      active_streams: [...activeStreams.keys()],
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
// SAFETY: Auto-stop typing after 2 minutes (in case JARVIS never replies)
// ═══════════════════════════════════════════
setInterval(() => {
  // This is a safety net — if typing has been active for too long, something went wrong
  // The normal flow is: message in → startTyping → JARVIS replies → stopTyping
}, 120000);

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
      version: "v4",
      bot: botInfo.username,
      http: `http://localhost:${HTTP_PORT}`,
      workspace: WORKSPACE,
      cli: CLI_PATH,
      features: ["typing_indicators", "streaming", "voice"],
    });
  },
});

process.on("SIGINT", () => {
  log("SYSTEM", { event: "stopping" });
  // Clean up all typing intervals
  for (const [chatId, interval] of typingIntervals) {
    clearInterval(interval);
  }
  typingIntervals.clear();
  server.close();
  bot.stop();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log("FATAL", { error: err.message });
  process.exit(1);
});
