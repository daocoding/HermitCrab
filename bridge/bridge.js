#!/usr/bin/env node
/**
 * 🦀 HermitCrab Telegram Bridge — Definitive Edition
 * 
 * Features:
 *   ✅ Conversation history — full thread passed to each JARVIS session
 *   ✅ Typing indicators — "typing..." while JARVIS thinks
 *   ✅ Streaming — POST /stream for progressive message edits
 *   ✅ Voice — POST /voice-reply via ElevenLabs TTS
 *   ✅ Worker sessions — heavy tasks delegated to async worker sessions
 *   ✅ Crash markers — JSONL entries for BB8 crash detection
 *   ✅ execFile — no shell escaping bugs
 * 
 * Architecture:
 *   Telegram → Bridge → antigravity-cli (spawns JARVIS session)
 *   JARVIS session → curl POST /reply|/stream|/voice-reply|/spawn-worker → Bridge → Telegram
 * 
 * Session Design (bridge-session-design.md):
 *   Main session stays FREE for chat. Heavy work → /spawn-worker → async session.
 *   JSONL crash markers track incomplete responses for BB8 recovery.
 * 
 * The bridge is a DUMB PIPE + ALARM CLOCK. It does not think.
 * JARVIS (inside Antigravity) is the ONLY brain.
 */

const { Bot, InputFile } = require("grammy");
const http = require("http");
const https = require("https");
const { exec, execFile, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const SessionDoctor = require("../lib/session-doctor");
const { getRecentHistory: _getHistory } = require("../lib/convo-memory");

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const BOT_TOKEN = process.argv[2] || process.env.TELEGRAM_BOT_TOKEN;
const HTTP_PORT = parseInt(process.env.HERMITCRAB_PORT || "18790", 10);
const WORKSPACE = process.env.HERMITCRAB_WORKSPACE || path.resolve(__dirname, "../..");
const CLI_PATH = process.env.ANTIGRAVITY_CLI || path.join(process.env.HOME, ".local/bin/antigravity-cli");
const BRIDGE_PORT = process.env.ANTIGRAVITY_BRIDGE_PORT || ""; // -p flag for antigravity-cli
const CLI_MODEL = process.env.HERMITCRAB_MODEL || "gemini-3.1-pro"; // -m flag for antigravity-cli
const CONVO_DIR = path.join(WORKSPACE, "hermitcrab", "conversations");
const AUDIO_DIR = path.join(WORKSPACE, "hermitcrab", "audio");
const UPLOAD_DIR = path.join(WORKSPACE, "hermitcrab", "uploads");
const SESSION_REGISTRY = path.join(WORKSPACE, "hermitcrab", "sessions.json");

// ── SESSION DOCTOR — self-healing session management ──
const doctor = new SessionDoctor({
  workspace: WORKSPACE,
  cliPath: CLI_PATH,
  pathEnv: `${path.dirname(CLI_PATH)}:${process.env.PATH}`,
  log,
  config: {
    cooldownFile: path.join(WORKSPACE, "hermitcrab", "telegram-doctor-state.json"),
  },
});
const PATH_ENV = `${path.dirname(CLI_PATH)}:${process.env.PATH}`;

// Machine identity — so the agent always knows which physical machine it's on
const MACHINE_NAME = (() => {
  try { return execSync("/usr/sbin/scutil --get ComputerName", { encoding: "utf-8" }).trim(); }
  catch { return os.hostname(); }
})();
console.log(`Machine identity: ${MACHINE_NAME}`);

// ElevenLabs TTS
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
const VOICE_IDS = {
  elise: "EST9Ui6982FZPSi7gCHi",
  tao: "v04RfKTwJurD5EH186vR",
};
const DEFAULT_VOICE = "tao";

// Streaming config
const STREAM_EDIT_THROTTLE_MS = 1500;

// Security
const AUTHORIZED_CHAT_IDS = new Set(
  (process.env.AUTHORIZED_CHAT_IDS || "1495516896,6023549885,-5025100896,-5090369868")
    .split(",")
    .map(id => parseInt(id.trim(), 10))
    .filter(id => !isNaN(id))
);
// 1495516896  = Tony DM
// 6023549885  = Mo DM
// -5025100896 = Group chat 1
// -5090369868 = Group chat 2
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "10", 10); // max msgs per minute
const rateLimitMap = new Map(); // chatId -> { count, resetAt }

// ── QUOTA & FALLBACK STRATEGY ──
// SessionDoctor handles proactive quota checks via quota.getCachedQuotaFractions().
// These constants are used by the reactive fallback path (catch-block).
const FALLBACK_MODEL = "gemini-3.1-pro";

// ── PERSISTENT COOLDOWN ──
// Once a quota error is detected, remember it so we don't waste attempts
const cooldownState = {
  active: false,
  model: null,        // which model is in cooldown
  expiresAt: null,    // Date.now() + duration
  remainingLabel: "", // human-readable "143h54m59s"
};
const COOLDOWN_FILE = path.join(WORKSPACE, "hermitcrab", "cooldown.json");

function loadCooldown() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      const data = JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf-8"));
      if (data.expiresAt && Date.now() < data.expiresAt) {
        Object.assign(cooldownState, data, { active: true });
        log("COOLDOWN_LOAD", { model: data.model, remaining: Math.round((data.expiresAt - Date.now()) / 1000 / 60) + "min" });
      } else {
        // Expired — clean up
        cooldownState.active = false;
        try { fs.unlinkSync(COOLDOWN_FILE); } catch {}
        log("COOLDOWN_EXPIRED", { msg: "Previous cooldown has expired" });
      }
    }
  } catch (e) {
    log("COOLDOWN_LOAD_ERR", { error: e.message });
  }
}

function setCooldown(model, durationMs, label) {
  cooldownState.active = true;
  cooldownState.model = model;
  cooldownState.expiresAt = Date.now() + durationMs;
  cooldownState.remainingLabel = label;
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldownState, null, 2));
  log("COOLDOWN_SET", { model, durationMs, label, expiresAt: new Date(cooldownState.expiresAt).toISOString() });
}

function isCooldownActive(model) {
  if (!cooldownState.active) return false;
  if (cooldownState.model !== model) return false;
  if (Date.now() >= cooldownState.expiresAt) {
    cooldownState.active = false;
    try { fs.unlinkSync(COOLDOWN_FILE); } catch {}
    log("COOLDOWN_CLEAR", { model, reason: "expired" });
    return false;
  }
  return true;
}

function parseCooldownDuration(errStr) {
  // Match "reset after 143h54m59s" or similar patterns
  const match = errStr.match(/reset after (\d+)h(\d+)m(\d+)s/i);
  if (match) {
    const hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const seconds = parseInt(match[3]);
    const ms = (hours * 3600 + minutes * 60 + seconds) * 1000;
    return { ms, label: `${hours}h${minutes}m${seconds}s` };
  }
  // Fallback: 6 hours if we can't parse
  return { ms: 6 * 60 * 60 * 1000, label: "~6h (estimated)" };
}

// Load cooldown state on startup
loadCooldown();

if (!BOT_TOKEN) {
  console.error("Usage: node bridge.js <BOT_TOKEN>");
  process.exit(1);
}

// ── PID LOCK — prevent duplicate instances (causes 409 + whitelist loss) ──
// PID file in /tmp (not OneDrive) to avoid cross-machine sync conflicts
const PID_FILE = path.join(os.tmpdir(), ".jarvis-bridge.pid");
function acquirePidLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (!isNaN(oldPid)) {
        try {
          process.kill(oldPid, 0); // Check if process exists (signal 0 = no-op)
          // Process is alive — we are the duplicate, exit immediately
          console.error(`FATAL: Another bridge instance is running (PID ${oldPid}). Exiting to prevent 409 conflict.`);
          process.exit(1);
        } catch {
          // Process is dead — stale PID file, safe to continue
        }
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (e) {
    console.error(`Warning: Could not acquire PID lock: ${e.message}`);
  }
}
function releasePidLock() {
  try {
    const stored = fs.readFileSync(PID_FILE, "utf-8").trim();
    if (stored === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {}
}
acquirePidLock();
process.on("exit", releasePidLock);
process.on("SIGTERM", () => { releasePidLock(); process.exit(0); });
process.on("SIGINT", () => { releasePidLock(); process.exit(0); });

fs.mkdirSync(CONVO_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const bot = new Bot(BOT_TOKEN);
let lastChatId = null;

// ── GLOBAL ERROR HANDLER — prevents individual message errors from killing the bot ──
bot.catch((err) => {
  const chatId = err.ctx?.chat?.id;
  log("ERROR", { 
    chat_id: chatId, 
    error: err.error?.message || err.message || String(err),
    code: err.error?.code,
    syscall: err.error?.syscall,
  });
  // Clean up any stuck state for this chat
  if (chatId) {
    stopTyping(chatId);
    busySessions.delete(chatId);
  }
});



// ═══════════════════════════════════════════
// SESSION REGISTRY — one session per chat_id
// ═══════════════════════════════════════════
function loadSessionRegistry() {
  try {
    if (fs.existsSync(SESSION_REGISTRY)) {
      return JSON.parse(fs.readFileSync(SESSION_REGISTRY, "utf-8"));
    }
  } catch (e) {
    log("WARN", { msg: "Failed to load session registry", error: e.message });
  }
  return {};
}

function saveSessionRegistry(registry) {
  fs.writeFileSync(SESSION_REGISTRY, JSON.stringify(registry, null, 2));
}

function getSessionUUID(chatId) {
  const registry = loadSessionRegistry();
  return registry[String(chatId)] || null;
}

function setSessionUUID(chatId, uuid) {
  const registry = loadSessionRegistry();
  registry[String(chatId)] = uuid;
  saveSessionRegistry(registry);
  log("SESSION", { chat_id: chatId, uuid, event: "registered" });
}

// ═══════════════════════════════════════════
// CONVERSATION LOG — records both sides (backup)
// ═══════════════════════════════════════════
function convoPath(chatId) {
  return path.join(CONVO_DIR, `${chatId}.jsonl`);
}

function logConvo(chatId, role, text, opts = {}) {
  const sessionId = getSessionUUID(chatId) || null;
  const entry = { role, text, ts: new Date().toISOString(), session_id: sessionId };
  if (opts.status) entry.status = opts.status; // "incomplete" for crash markers
  if (opts.worker_id) entry.worker_id = opts.worker_id;
  if (opts.task) entry.task = opts.task;
  fs.appendFileSync(convoPath(chatId), JSON.stringify(entry) + "\n");
}

/** Convenience wrapper — reads history for a chatId using its convo file path */
function getRecentHistory(chatId) {
  return _getHistory(convoPath(chatId), { log });
}

// ═══════════════════════════════════════════
// FILE ATTACHMENT DOWNLOAD (Telegram)
// ═══════════════════════════════════════════
async function downloadTelegramFile(fileId, filename, chatId) {
  try {
    // Step 1: Call getFile to get the file_path
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      log("ATTACH_SKIP", { file_id: fileId, reason: "no file_path returned" });
      return null;
    }

    // Step 2: Build download URL
    const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Step 3: Create per-chat subfolder
    const destDir = path.join(UPLOAD_DIR, String(chatId));
    fs.mkdirSync(destDir, { recursive: true });

    // Use original filename if available, otherwise derive from file_path
    const safeName = filename || path.basename(file.file_path);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
    const destPath = path.join(destDir, `${ts}_${safeName}`);

    // Step 4: Download via HTTPS
    return await new Promise((resolve, reject) => {
      https.get(downloadUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          https.get(res.headers.location, (res2) => {
            const fileStream = fs.createWriteStream(destPath);
            res2.pipe(fileStream);
            fileStream.on("finish", () => {
              fileStream.close();
              const size = fs.statSync(destPath).size;
              log("ATTACH_OK", { name: safeName, path: destPath, size });
              resolve({ name: safeName, path: destPath, size, mimeType: file.file_path.split(".").pop() });
            });
            fileStream.on("error", reject);
          }).on("error", reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close();
          const size = fs.statSync(destPath).size;
          log("ATTACH_OK", { name: safeName, path: destPath, size });
          resolve({ name: safeName, path: destPath, size, mimeType: file.file_path.split(".").pop() });
        });
        fileStream.on("error", reject);
      }).on("error", reject);
    });
  } catch (err) {
    log("ATTACH_ERROR", { file_id: fileId, name: filename, error: err.message });
    return null;
  }
}

/**
 * Extract file info from any Telegram message type.
 * Returns array of { fileId, filename, type } objects.
 */
function extractFiles(msg) {
  const files = [];

  if (msg.document) {
    files.push({
      fileId: msg.document.file_id,
      filename: msg.document.file_name || `document_${Date.now()}`,
      type: "document",
    });
  }

  if (msg.photo && msg.photo.length > 0) {
    // Telegram sends multiple sizes; grab the largest (last)
    const largest = msg.photo[msg.photo.length - 1];
    files.push({
      fileId: largest.file_id,
      filename: `photo_${Date.now()}.jpg`,
      type: "photo",
    });
  }

  if (msg.video) {
    files.push({
      fileId: msg.video.file_id,
      filename: msg.video.file_name || `video_${Date.now()}.mp4`,
      type: "video",
    });
  }

  if (msg.audio) {
    files.push({
      fileId: msg.audio.file_id,
      filename: msg.audio.file_name || `audio_${Date.now()}.mp3`,
      type: "audio",
    });
  }

  if (msg.voice) {
    files.push({
      fileId: msg.voice.file_id,
      filename: `voice_${Date.now()}.ogg`,
      type: "voice",
    });
  }

  if (msg.video_note) {
    files.push({
      fileId: msg.video_note.file_id,
      filename: `videonote_${Date.now()}.mp4`,
      type: "video_note",
    });
  }

  if (msg.sticker) {
    const ext = msg.sticker.is_animated ? "tgs" : msg.sticker.is_video ? "webm" : "webp";
    files.push({
      fileId: msg.sticker.file_id,
      filename: `sticker_${Date.now()}.${ext}`,
      type: "sticker",
    });
  }

  return files;
}

/**
 * Process all file attachments in a message.
 * Downloads each file and returns array of { name, path, size, mimeType }.
 */
async function processIncomingFiles(msg, chatId) {
  const fileInfos = extractFiles(msg);
  if (fileInfos.length === 0) return [];

  log("ATTACH_DETECT", { chat_id: chatId, count: fileInfos.length, types: fileInfos.map(f => f.type) });

  const results = [];
  for (const fi of fileInfos) {
    const result = await downloadTelegramFile(fi.fileId, fi.filename, chatId);
    if (result) {
      result.type = fi.type;
      results.push(result);
    }
  }
  return results;
}

// ═══════════════════════════════════════════
// TYPING INDICATOR MANAGER
// ═══════════════════════════════════════════
const typingIntervals = new Map();

function startTyping(chatId) {
  if (typingIntervals.has(chatId)) return;
  bot.api.sendChatAction(chatId, "typing").catch(() => {});
  const interval = setInterval(() => {
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);
  typingIntervals.set(chatId, interval);
}

function stopTyping(chatId) {
  const interval = typingIntervals.get(chatId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(chatId);
  }
  // Clear any reply watchdog
  const watchdog = replyWatchdogs.get(chatId);
  if (watchdog) {
    clearTimeout(watchdog);
    replyWatchdogs.delete(chatId);
  }
}

// ═══════════════════════════════════════════
// REPLY WATCHDOG — auto-recover stuck sessions
// ═══════════════════════════════════════════
const replyWatchdogs = new Map();
const REPLY_TIMEOUT_MS = 90000; // 90 seconds
const REPLY_TIMEOUT_ATTACHMENT_MS = 180000; // 180 seconds for messages with files

function startReplyWatchdog(chatId, opts = {}) {
  const timeoutMs = opts.timeoutMs || REPLY_TIMEOUT_MS;
  const context = opts.context || "text"; // "text", "photo", "voice", "file"
  
  // Clear existing watchdog
  const existing = replyWatchdogs.get(chatId);
  if (existing) clearTimeout(existing);
  
  const timer = setTimeout(async () => {
    replyWatchdogs.delete(chatId);
    // Only fire if typing is still active (meaning no reply came)
    if (typingIntervals.has(chatId)) {
      log("WATCHDOG", { chat_id: chatId, action: "timeout", seconds: timeoutMs / 1000, context });
      stopTyping(chatId);
      
      // Record failure with Session Doctor
      const sessionKey = String(chatId);
      doctor.recordFailure(sessionKey, "timeout", `Watchdog fired — no reply within ${timeoutMs / 1000}s (context: ${context})`);
      
      // Check if doctor recommends rotation
      const health = doctor.checkHealth(sessionKey);
      if (health.action === "rotate") {
        log("WATCHDOG_ROTATE", { chat_id: chatId, reason: health.reason });
        // Rotate session: clear old UUID, doctor resets counters
        const registry = loadSessionRegistry();
        delete registry[sessionKey];
        saveSessionRegistry(registry);
        doctor.recordRotation(sessionKey);
        try {
          await bot.api.sendMessage(chatId, "🔄 Session was unresponsive — I've refreshed my connection. Send your message again.");
        } catch (_) {}
      } else {
        // Context-aware timeout message
        const timeoutMsg = context === "photo" 
          ? "📷 I received your photo but couldn't process it in time. Try sending it again, or add a caption describing what you'd like me to do with it."
          : context === "voice"
          ? "🎙️ I received your voice message but couldn't process it in time. Try again."
          : context === "file"
          ? "📎 I received your file but couldn't process it in time. Try sending it again."
          : "⏳ I'm taking longer than usual — might be stuck on something. Try again in a moment.";
        try {
          await bot.api.sendMessage(chatId, timeoutMsg);
        } catch (_) {}
      }
      
      // ── BUSY CLEAR (Watchdog) ──
      busySessions.delete(chatId);
      log("WATCHDOG", { chat_id: chatId, action: "cleared", doctor_action: health.action });
    }
  }, REPLY_TIMEOUT_MS);
  replyWatchdogs.set(chatId, timer);
}

// ═══════════════════════════════════════════
// BUSY tracking — prevent session contention
// ═══════════════════════════════════════════
const busySessions = new Map(); // chatId -> { busy: true, queue: [] }

// ═══════════════════════════════════════════
// STREAMING STATE
// ═══════════════════════════════════════════
const activeStreams = new Map();
const activeResponseTimers = new Map(); // chatId → timer function from Session Doctor

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
  const text = ctx.message.text || ctx.message.caption || "";
  const chatId = ctx.chat.id;
  const from = ctx.from?.first_name || "Unknown";
  const username = ctx.from?.username || "";
  
  if (text === "/start") return;
  
  // ── /doctor command — session health diagnostics ──
  if (/^\/doctor(@\w+)?$/i.test(text.trim())) {
    const status = doctor.getStatus();
    let msg = `🩺 *Session Doctor*\nTracked: ${status.tracked_sessions} sessions\n`;
    if (status.cooldown) {
      msg += `\n⏳ *Cooldown*: ${status.cooldown.model} — ${status.cooldown.remaining_min}min remaining\n`;
    }
    for (const s of status.sessions) {
      msg += `\n• \`${s.session_key}\`: ${s.success_rate} success, ${s.consecutive_failures} consecutive fails, ${s.rotations} rotations, avg ${s.avg_response_ms || '?'}ms`;
    }
    await ctx.reply(msg, { parse_mode: "Markdown" });
    log("DOCTOR_CMD", { chat_id: chatId });
    return;
  }
  
  // ── SECURITY GATE ──
  if (!AUTHORIZED_CHAT_IDS.has(chatId)) {
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
    log("BLOCKED", { chat_id: chatId, from, username, chat_type: ctx.chat.type, text: text.substring(0, 50) });
    if (isGroup) {
      // Silently ignore group chats — don't spam "Access denied" in someone's group
      return;
    }
    // Only reply with access denial in DMs (someone deliberately messaged the bot)
    await ctx.reply("⛔ This is a private assistant. Access denied.");
    exec(`curl -s -d "🚨 Unauthorized Telegram access attempt from ${from} (@${username}), chat_id: ${chatId}" ntfy.sh/tonysM5`);
    return;
  }
  
  // ── /quota command: show model usage + reset times ──
  if (/^\/quota(@\w+)?$/i.test(text.trim())) {
    try {
      const quota = require("./quota");
      const data = await quota.getQuotaData();
      const msg = quota.formatQuotaMessage(data, MACHINE_NAME);
      await ctx.reply(msg, { parse_mode: "Markdown" });
      log("QUOTA_CMD", { chat_id: chatId, tier: data.tier, models: data.models.length });
    } catch (e) {
      log("QUOTA_ERROR", { error: e.message });
      await ctx.reply(`⚠️ Couldn't fetch quota: ${e.message}`);
    }
    return;
  }
  
  // ── RATE LIMIT ──
  const now = Date.now();
  let bucket = rateLimitMap.get(chatId);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(chatId, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    log("RATE_LIMITED", { chat_id: chatId, from, count: bucket.count });
    await ctx.reply("⏳ Slow down — too many messages. Wait a moment.");
    return;
  }
  
  lastChatId = chatId;
  
  // ── PROCESS FILE ATTACHMENTS ──
  const downloadedFiles = await processIncomingFiles(ctx.message, chatId);
  
  // Skip if no text AND no files
  if (!text && downloadedFiles.length === 0) {
    log("SKIP_EMPTY", { chat_id: chatId, from, reason: "no text and no attachments" });
    return;
  }
  
  // Build message with attachment info (same pattern as Teams bridge)
  let fullMessage = text;
  if (downloadedFiles.length > 0) {
    const fileList = downloadedFiles.map(f => `  📎 ${f.name} (${f.type}) → ${f.path}`).join("\n");
    fullMessage += `${text ? "\n\n" : ""}[Attached files]\n${fileList}\nYou can read these files from the paths above.`;
    
    // If no caption was provided, add a contextual nudge so the model knows what to do
    if (!text) {
      const hasImage = downloadedFiles.some(f => f.type === "photo" || f.type === "sticker");
      const hasVoice = downloadedFiles.some(f => f.type === "voice" || f.type === "video_note");
      if (hasImage) {
        fullMessage += "\n\n(No caption was provided. Use view_file to look at the image and share your thoughts on it.)";
      } else if (hasVoice) {
        fullMessage += "\n\n(No caption was provided. This is a voice message — acknowledge receipt.)";
      } else {
        fullMessage += "\n\n(No caption was provided. Review the file and give your take on it.)";
      }
    }
  }
  
  log("IN", { chat_id: chatId, from, username, text, attachments: downloadedFiles.length });
  
  // Log to conversation history
  logConvo(chatId, "user", fullMessage);
  
  // Start typing indicator + reply watchdog
  startTyping(chatId);
  const hasAttachments = downloadedFiles.length > 0;
  const hasImage = downloadedFiles.some(f => f.type === "photo" || f.type === "sticker");
  const hasVoice = downloadedFiles.some(f => f.type === "voice" || f.type === "video_note");
  const watchdogContext = hasImage ? "photo" : hasVoice ? "voice" : hasAttachments ? "file" : "text";
  startReplyWatchdog(chatId, {
    timeoutMs: hasAttachments ? REPLY_TIMEOUT_ATTACHMENT_MS : REPLY_TIMEOUT_MS,
    context: watchdogContext,
  });
  
  // ── BUSY GATE ──
  const session = busySessions.get(chatId);
  log("BUSY_CHECK", { chat_id: chatId, is_busy: !!session?.busy, queue_length: session?.queue?.length || 0 });
  if (session?.busy) {
    session.queue.push({ from, username, fullMessage });
    log("QUEUED", { chat_id: chatId, queue_length: session.queue.length, text: text.substring(0, 50) });
  } else {
    busySessions.set(chatId, { busy: true, queue: [] });
    log("BUSY_SET", { chat_id: chatId });
    await wakeJarvis(chatId, from, username, fullMessage);
  }
});

// ═══════════════════════════════════════════
// WAKE: antigravity-cli — session reuse
// ═══════════════════════════════════════════
async function wakeJarvis(chatId, from, username, text, forcedModel = null) {
  const sessionKey = String(chatId);
  
  // ── SESSION DOCTOR: health check before wake ──
  const health = doctor.checkHealth(sessionKey);
  let existingUUID = getSessionUUID(chatId);
  
  if (health.action === "rotate" && existingUUID) {
    log("DOCTOR_PRE_ROTATE", { chat_id: chatId, reason: health.reason, old_uuid: existingUUID });
    // Clear the old session
    const registry = loadSessionRegistry();
    delete registry[sessionKey];
    saveSessionRegistry(registry);
    doctor.recordRotation(sessionKey);
    existingUUID = null; // force new session
    bot.api.sendMessage(chatId, "🔄 _Refreshing session for better performance..._", { parse_mode: "Markdown" }).catch(() => {});
  }
  
  // ── SESSION DOCTOR: model selection (replaces inline quota/cooldown logic) ──
  let targetModel;
  if (forcedModel) {
    targetModel = forcedModel;
  } else {
    const modelChoice = await doctor.selectModel(CLI_MODEL);
    targetModel = modelChoice.model;
    if (modelChoice.switched) {
      log("DOCTOR_MODEL_SWITCH", { chat_id: chatId, model: targetModel, reason: modelChoice.reason });
      if (modelChoice.cooldownRemaining) {
        bot.api.sendMessage(chatId, `ℹ️ _Primary model in cooldown (${modelChoice.cooldownRemaining}min). Using ${modelChoice.model}._`, { parse_mode: "Markdown" }).catch(() => {});
      } else if (modelChoice.quotaRemaining !== undefined) {
        bot.api.sendMessage(chatId, `ℹ️ _Primary quota low (${Math.round(modelChoice.quotaRemaining * 100)}%). Switching to ${modelChoice.model}._`, { parse_mode: "Markdown" }).catch(() => {});
      }
    }
  }
  
  // Record the wake with Session Doctor
  const responseTimer = doctor.recordWake(sessionKey);
  // Store timer so /reply handler can call it
  activeResponseTimers.set(sessionKey, responseTimer);

  // First message: create new session with full identity context
  // Subsequent messages: append to existing session (just the message)
  const isNewSession = !existingUUID;
  
  let firstTimePrompt = `📱 TELEGRAM CHANNEL — HermitCrab Bridge
You are JARVIS, connected to Telegram. A user is chatting with you.
From: ${from} (@${username}), chat_id: ${chatId}
🖥️ Running on: ${MACHINE_NAME} (this Antigravity session is on ${MACHINE_NAME}. Files here are LOCAL — no SCP needed.)
🤖 Model: You are running on ${targetModel} (If asked, this is your system model).

This is a PERSISTENT session. All future messages from this user will arrive here.
You have full conversation memory — Antigravity tracks the thread natively.

To reply, run this SINGLE command (heredoc avoids all shell escaping issues):
cat > /tmp/jr.json << 'REPLY_EOF'
{"chat_id": ${chatId}, "text": "YOUR_REPLY_HERE"}
REPLY_EOF
curl -s -X POST http://localhost:${HTTP_PORT}/reply -H "Content-Type: application/json" -d @/tmp/jr.json

IMPORTANT: Put your reply text inside the heredoc between the two REPLY_EOF markers. The single quotes around 'REPLY_EOF' prevent ALL shell interpretation — special characters like ? ! $ are safe. Run this as a SINGLE run_command with SafeToAutoRun: true.
Keep replies concise — this is chat.

🔧 WORKER SESSION PATTERN — CRITICAL:
For ANY task that takes >30 seconds (article writing, code builds, MCP config, research, file modifications), do NOT do the work in this session. Instead:
1. Reply immediately: "On it, spawning a worker..."
2. Spawn a worker via: curl -s -X POST http://localhost:${HTTP_PORT}/spawn-worker -H "Content-Type: application/json" -d '{"chat_id": ${chatId}, "task": "DESCRIPTION", "prompt": "DETAILED_PROMPT_FOR_WORKER"}'
3. The worker runs in a SEPARATE async session. When it finishes, it writes results to a file and notifies this chat.
4. This keeps YOU free to receive new messages.
NEVER go silent doing heavy work. If in doubt, spawn a worker.
${getRecentHistory(chatId)}
New message from ${from}: "${text}"`;

  // If this is a migrated session, add context migration prompt
  if (isNewSession && health.health.rotations > 0) {
    firstTimePrompt = doctor.buildMigrationPrompt(firstTimePrompt, {
      lastUserMessage: text,
      rotationCount: health.health.rotations,
    });
  }

  const followUpPrompt = `📱 from ${from} (@${username}): "${text}"

Reply via heredoc (safe from shell escaping):
cat > /tmp/jr.json << 'REPLY_EOF'
{"chat_id": ${chatId}, "text": "YOUR_REPLY"}
REPLY_EOF
curl -s -X POST http://localhost:${HTTP_PORT}/reply -H "Content-Type: application/json" -d @/tmp/jr.json
[🖥️ ${MACHINE_NAME} | 🤖 ${targetModel}]`;

  const prompt = isNewSession ? firstTimePrompt : followUpPrompt;
  const portArgs = BRIDGE_PORT ? ["-p", BRIDGE_PORT] : [];
  const modelArgs = ["-m", targetModel];
  const args = isNewSession 
    ? [...portArgs, ...modelArgs, "-a", prompt] 
    : [...portArgs, ...modelArgs, "-a", "-r", existingUUID, prompt];

  log("WAKE", { 
    chat_id: chatId, 
    method: isNewSession ? "new-session" : "resume-session",
    session_uuid: existingUUID || "(creating)",
    model: targetModel,
    doctor_health: health.action,
  });
  
  execFile(CLI_PATH, args, { 
    cwd: WORKSPACE, 
    env: { ...process.env, PATH: PATH_ENV },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  }, async (error, stdout, stderr) => {
    if (error) {
      const errStr = (error.message || "") + (stderr || "");
      log("WAKE_ERROR", { error: error.message, stderr: stderr?.trim() });
      
      // ── QUOTA FALLBACK (Reactive) ──
      const isQuotaError = errStr.includes("Quota Exceeded") 
        || errStr.includes("Rate Limit") 
        || errStr.includes("exhausted your capacity")
        || errStr.includes("quota will reset");
      
      if (isQuotaError) {
        // Record with Session Doctor (handles cooldown persistence)
        doctor.recordFailure(sessionKey, "quota", errStr);
        try { require("./quota").invalidateQuotaCache(); } catch (_) {}
        
        if (targetModel !== FALLBACK_MODEL) {
          log("FALLBACK", { chat_id: chatId, reason: "Quota hit, retrying with fallback", fallback: FALLBACK_MODEL });
          bot.api.sendMessage(chatId, `⚠️ _Primary quota exhausted. Switching to ${FALLBACK_MODEL} automatically._`, { parse_mode: "Markdown" }).catch(() => {});
          wakeJarvis(chatId, from, username, text, FALLBACK_MODEL).catch(e => log("RETRY_ERROR", { e: e.message }));
          return;
        }
      } else {
        // Record non-quota failure
        doctor.recordFailure(sessionKey, "cli_error", errStr);
      }

      stopTyping(chatId);
      
      // If resume failed, try creating a fresh session
      if (!isNewSession) {
        log("WAKE_RETRY", { chat_id: chatId, reason: "resume failed, creating new session" });
        const registry = loadSessionRegistry();
        delete registry[String(chatId)];
        saveSessionRegistry(registry);
        wakeJarvis(chatId, from, username, text, targetModel).catch(e => log("RETRY_ERROR", { e: e.message }));
      } else {
        exec(`curl -s -d "⚠️ HermitCrab: wake failed for msg from ${from}" ntfy.sh/tonysM5`);
        // ── BUSY CLEAR (new session wake failed) ── 
        // Without this, the busy lock is permanently stuck and all future messages queue forever
        const failedSession = busySessions.get(chatId);
        const queuedMessages = failedSession?.queue?.length > 0 ? [...failedSession.queue] : [];
        busySessions.delete(chatId);
        log("BUSY_CLEAR", { chat_id: chatId, reason: "new_session_wake_failed", queue_drained: queuedMessages.length });
        // Drain any queued messages by retrying
        if (queuedMessages.length > 0) {
          const next = queuedMessages.shift();
          log("DRAIN", { chat_id: chatId, remaining: queuedMessages.length, text: next.fullMessage.substring(0, 50) });
          busySessions.set(chatId, { busy: true, queue: queuedMessages });
          startTyping(chatId);
          startReplyWatchdog(chatId);
          wakeJarvis(chatId, next.from, next.username, next.fullMessage).catch(e => log("RETRY_ERROR", { e: e.message }));
        }
      }
      return;
    }
    
    const rawOutput = (stdout || "") + (stderr || "");
    // Strip ANSI escape codes before matching
    const output = rawOutput.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\[\?[0-9]*[a-zA-Z]|\r/g, "").trim();
    
    // For new sessions, extract the UUID from the output
    if (isNewSession && output) {
      // Output format: "  ✓ Cascade: 3cacc10d... (async)"
      const match = output.match(/Cascade:\s*([a-f0-9]+)/i);
      if (match) {
        const partialUUID = match[1];
        log("SESSION_CAPTURE", { chat_id: chatId, partialUUID });
        // Delay resolution to give Antigravity time to register the session
        setTimeout(() => resolveAndSaveSession(chatId, partialUUID), 2000);
      } else {
        log("WARN", { msg: "Could not extract UUID from output", output });
      }
    }
    
    if (output) {
      log("WAKE_OK", { output, session: isNewSession ? "new" : "resumed" });
    }
  });
}

// ═══════════════════════════════════════════
// WORKER SESSION — spawn async sessions for heavy tasks
// ═══════════════════════════════════════════
function spawnWorker(chatId, task, prompt) {
  const workerId = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workerDir = path.join(WORKSPACE, "hermitcrab", "workers");
  fs.mkdirSync(workerDir, { recursive: true });
  
  const resultFile = path.join(workerDir, `${workerId}.md`);
  const statusFile = path.join(workerDir, `${workerId}.status.json`);
  
  // Write initial status
  fs.writeFileSync(statusFile, JSON.stringify({
    worker_id: workerId,
    chat_id: chatId,
    task,
    status: "running",
    started_at: new Date().toISOString(),
  }, null, 2));
  
  // Log crash marker — will be cleared when worker reports back
  logConvo(chatId, "assistant", "", { status: "worker_started", worker_id: workerId, task });
  
  const workerPrompt = `You are a WORKER SESSION spawned by the main JARVIS Telegram handler.
Your task: ${task}

Detailed instructions:
${prompt}

When you finish:
1. Write your result to: ${resultFile}
2. Report completion:
cat > /tmp/jr.json << 'REPLY_EOF'
{"chat_id": ${chatId}, "text": "YOUR_SUMMARY_FOR_TONY", "worker_id": "${workerId}"}
REPLY_EOF
curl -s -X POST http://localhost:${HTTP_PORT}/worker-done -H "Content-Type: application/json" -d @/tmp/jr.json

3. If you encounter errors, still report back with what happened.

🖥️ Running on: ${MACHINE_NAME}. Files are LOCAL.
Workspace: ${WORKSPACE}`;
  
  const modelArgs = ["-m", CLI_MODEL];
  const args = [...modelArgs, "-a", workerPrompt];
  
  log("WORKER_SPAWN", { chat_id: chatId, worker_id: workerId, task });
  
  execFile(CLI_PATH, args, {
    cwd: WORKSPACE,
    env: { ...process.env, PATH: PATH_ENV },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error) {
      log("WORKER_SPAWN_ERROR", { worker_id: workerId, error: error.message });
      // Update status
      fs.writeFileSync(statusFile, JSON.stringify({
        worker_id: workerId,
        chat_id: chatId,
        task,
        status: "spawn_failed",
        error: error.message,
        finished_at: new Date().toISOString(),
      }, null, 2));
      // Notify chat about failure
      bot.api.sendMessage(chatId, `⚠️ Worker failed to start: ${task}`).catch(() => {});
    } else {
      const output = (stdout || "").replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\[\?[0-9]*[a-zA-Z]|\r/g, "").trim();
      log("WORKER_SPAWNED", { worker_id: workerId, output });
    }
  });
  
  return { worker_id: workerId, result_file: resultFile, status_file: statusFile };
}

// Resolve truncated UUID to full UUID and save to registry
function resolveAndSaveSession(chatId, partialUUID) {
  // Try to get full UUID from session list
  execFile(CLI_PATH, ["-r"], {
    cwd: WORKSPACE,
    env: { ...process.env, PATH: PATH_ENV },
    timeout: 10000,
  }, (error, stdout) => {
    if (error || !stdout) {
      log("WARN", { msg: "Could not resolve session UUID, saving partial", partialUUID });
      setSessionUUID(chatId, partialUUID);
      return;
    }
    // Find the line that starts with a UUID matching our partial
    const lines = stdout.split("\n");
    for (const line of lines) {
      const fullUUID = line.trim().split(/\s+/)[0];
      if (fullUUID && fullUUID.startsWith(partialUUID)) {
        setSessionUUID(chatId, fullUUID);
        return;
      }
    }
    // If partial didn't match, save partial and hope for the best
    if (partialUUID.length >= 8) {
      setSessionUUID(chatId, partialUUID);
    }
  });
}

// ═══════════════════════════════════════════
// PARSE REQUEST BODY
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
// HTTP SERVER
// ═══════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") {
    res.writeHead(200); res.end(); return;
  }
  
  // POST /reply — single text response
  if (req.method === "POST" && req.url === "/reply") {
    try {
      const { chat_id, text } = await parseBody(req);
      const target = chat_id || lastChatId;
      
      if (!target || !text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Need chat_id and text" }));
        return;
      }
      
      stopTyping(target);
      
      // ── SESSION DOCTOR: record success ──
      const sessionKey = String(target);
      const responseTimer = activeResponseTimers.get(sessionKey);
      if (responseTimer) {
        const elapsed = responseTimer();
        activeResponseTimers.delete(sessionKey);
        log("RESPONSE_TIME", { chat_id: target, elapsed_ms: elapsed });
      }
      doctor.recordSuccess(sessionKey);
      
      // ── BUSY CLEAR ──
      const rsession = busySessions.get(target);
      const queuedMessages = rsession?.queue?.length > 0 ? [...rsession.queue] : [];
      busySessions.delete(target);
      log("BUSY_CLEAR", { chat_id: target, had_session: !!rsession, queue_drained: queuedMessages.length });

      await bot.api.sendMessage(target, text);
      log("OUT", { chat_id: target, text: text.substring(0, 100) + (text.length > 100 ? "..." : "") });
      logConvo(target, "assistant", text);
      
      // ── DRAIN QUEUE ──
      if (queuedMessages.length > 0) {
        const next = queuedMessages.shift();
        log("DRAIN", { chat_id: target, remaining: queuedMessages.length, text: next.fullMessage.substring(0, 50) });
        busySessions.set(target, { busy: true, queue: queuedMessages });
        startTyping(target);
        startReplyWatchdog(target);
        await wakeJarvis(target, next.from, next.username, next.fullMessage);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, chat_id: target }));
    } catch (err) {
      log("ERROR", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  
  // POST /stream — progressive message edits
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
        stopTyping(target);
        const msg = await bot.api.sendMessage(target, text);
        stream = {
          messageId: msg.message_id,
          fullText: text,
          lastEditTime: Date.now(),
          pendingEdit: null,
        };
        activeStreams.set(streamKey, stream);
        log("STREAM_START", { chat_id: target, message_id: msg.message_id });
      } else {
        stream.fullText += text;
        const timeSinceLastEdit = Date.now() - stream.lastEditTime;
        
        if (done || timeSinceLastEdit >= STREAM_EDIT_THROTTLE_MS) {
          if (stream.pendingEdit) { clearTimeout(stream.pendingEdit); stream.pendingEdit = null; }
          try {
            await bot.api.editMessageText(target, stream.messageId, stream.fullText);
            stream.lastEditTime = Date.now();
          } catch (e) {
            if (!e.message?.includes("not modified")) log("STREAM_EDIT_ERROR", { error: e.message });
          }
        } else {
          if (stream.pendingEdit) clearTimeout(stream.pendingEdit);
          stream.pendingEdit = setTimeout(async () => {
            try {
              await bot.api.editMessageText(target, stream.messageId, stream.fullText);
              stream.lastEditTime = Date.now();
            } catch (e) {}
          }, STREAM_EDIT_THROTTLE_MS - timeSinceLastEdit);
        }
      }
      
      if (done) {
        if (stream.pendingEdit) clearTimeout(stream.pendingEdit);
        try { await bot.api.editMessageText(target, stream.messageId, stream.fullText); } catch {}
        logConvo(target, "assistant", stream.fullText);
        activeStreams.delete(streamKey);
        
        // ── BUSY CLEAR (Streaming) ──
        const rsession = busySessions.get(target);
        const queuedMessages = rsession?.queue?.length > 0 ? [...rsession.queue] : [];
        busySessions.delete(target);
        log("STREAM_END", { chat_id: target, total_len: stream.fullText.length, queue_drained: queuedMessages.length });

        // ── DRAIN QUEUE ──
        if (queuedMessages.length > 0) {
          const next = queuedMessages.shift();
          log("DRAIN", { chat_id: target, remaining: queuedMessages.length, text: next.fullMessage.substring(0, 50) });
          busySessions.set(target, { busy: true, queue: queuedMessages });
          startTyping(target);
          startReplyWatchdog(target);
          await wakeJarvis(target, next.from, next.username, next.fullMessage);
        }
      }
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, chat_id: target, streaming: !done }));
    } catch (err) {
      log("STREAM_ERROR", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  
  // POST /voice-reply — ElevenLabs TTS voice message
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
      
      stopTyping(target);
      log("VOICE", { chat_id: target, text: text.substring(0, 60) + "...", voice: voice || DEFAULT_VOICE });
      
      const audioBuffer = await elevenLabsTTS(text, voiceId);
      const audioFile = path.join(AUDIO_DIR, `reply_${Date.now()}.mp3`);
      fs.writeFileSync(audioFile, audioBuffer);
      
      // ── BUSY CLEAR ──
      const rsession = busySessions.get(target);
      const queuedMessages = rsession?.queue?.length > 0 ? [...rsession.queue] : [];
      busySessions.delete(target);
      log("VOICE_BUSY_CLEAR", { chat_id: target, had_session: !!rsession, queue_drained: queuedMessages.length });

      await bot.api.sendVoice(target, new InputFile(audioFile));
      await bot.api.sendMessage(target, text);
      log("VOICE_OUT", { chat_id: target });
      logConvo(target, "assistant", text);
      
      // ── DRAIN QUEUE ──
      if (queuedMessages.length > 0) {
        const next = queuedMessages.shift();
        log("DRAIN", { chat_id: target, remaining: queuedMessages.length, text: next.fullMessage.substring(0, 50) });
        busySessions.set(target, { busy: true, queue: queuedMessages });
        startTyping(target);
        startReplyWatchdog(target);
        await wakeJarvis(target, next.from, next.username, next.fullMessage);
      }

      setTimeout(() => { try { fs.unlinkSync(audioFile); } catch {} }, 30000);
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, chat_id: target, voice: true }));
    } catch (err) {
      log("VOICE_ERROR", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  
  // GET /status — health check
  if (req.method === "GET" && (req.url === "/status" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: "🦀 HermitCrab Bridge",
      version: "1.4",
      status: "running",
      bot: bot.botInfo?.username,
      http_port: HTTP_PORT,
      uptime_s: Math.round(process.uptime()),
      last_chat_id: lastChatId,
      voice_enabled: !!ELEVENLABS_KEY,
      authorized_users: AUTHORIZED_CHAT_IDS.size,
      rate_limit: `${RATE_LIMIT_MAX}/min`,
      features: ["conversation_history", "typing_indicators", "streaming", "voice", "auth_whitelist", "rate_limit", "file_attachments", "session_doctor", "worker_sessions"],
      active_typing: [...typingIntervals.keys()],
      active_streams: [...activeStreams.keys()],
      session_doctor: doctor.getStatus(),
    }));
    return;
  }
  
  // POST /notify — Proactive messaging (JARVIS → Tony via Telegram)
  if (req.method === "POST" && req.url === "/notify") {
    try {
      const body = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (c) => data += c);
        req.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      
      const { text, chat_id } = body;
      if (!text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Need text" }));
        return;
      }

      // Use specified chat_id, or default to first authorized chat
      const targetChatId = chat_id || [...AUTHORIZED_CHAT_IDS][0];
      if (!targetChatId) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No authorized chat_id available" }));
        return;
      }

      await bot.api.sendMessage(targetChatId, text, { parse_mode: "Markdown" });
      log("NOTIFY", { chat_id: targetChatId, text: text.substring(0, 80) + (text.length > 80 ? "..." : "") });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, chat_id: targetChatId }));
    } catch (err) {
      log("NOTIFY_ERROR", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  
  // POST /spawn-worker — delegate heavy tasks to async worker sessions
  if (req.method === "POST" && req.url === "/spawn-worker") {
    try {
      const { chat_id, task, prompt } = await parseBody(req);
      if (!chat_id || !task || !prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Need chat_id, task, and prompt" }));
        return;
      }
      
      const worker = spawnWorker(chat_id, task, prompt);
      log("WORKER_API", { chat_id, task, worker_id: worker.worker_id });
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...worker }));
    } catch (err) {
      log("WORKER_API_ERROR", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  
  // POST /worker-done — worker session reports completion
  if (req.method === "POST" && req.url === "/worker-done") {
    try {
      const { chat_id, text, worker_id } = await parseBody(req);
      const target = chat_id || lastChatId;
      
      if (!target || !text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Need chat_id and text" }));
        return;
      }
      
      // Update worker status file
      const statusFile = path.join(WORKSPACE, "hermitcrab", "workers", `${worker_id}.status.json`);
      try {
        const status = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
        status.status = "completed";
        status.finished_at = new Date().toISOString();
        fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
      } catch (_) {}
      
      // Log completion (clears crash marker)
      logConvo(target, "assistant", text, { worker_id, status: "worker_done" });
      
      // Send result to chat
      await bot.api.sendMessage(target, `✅ ${text}`);
      log("WORKER_DONE", { chat_id: target, worker_id, text: text.substring(0, 100) });
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, chat_id: target, worker_id }));
    } catch (err) {
      log("WORKER_DONE_ERROR", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
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
// GRACEFUL RESTART — OpenClaw-style SIGUSR1
// ═══════════════════════════════════════════
const DRAIN_TIMEOUT_MS = 30_000;
let shuttingDown = false;

/**
 * Wait for active typing/streaming sessions to finish.
 */
function drainActiveSessions(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const activeCount = typingIntervals.size + activeStreams.size;
      if (activeCount === 0) {
        log("DRAIN", { msg: "All sessions drained", elapsed_ms: Date.now() - start });
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        log("DRAIN", { msg: `Drain timeout — ${activeCount} sessions still active`, elapsed_ms: Date.now() - start });
        resolve(false);
        return;
      }
      log("DRAIN", { msg: `Waiting for ${activeCount} active session(s)...`, elapsed_ms: Date.now() - start });
      setTimeout(check, 1000);
    };
    check();
  });
}

async function performGracefulRestart(signal) {
  if (shuttingDown) {
    log("SYSTEM", { event: "restart_ignored", reason: "already shutting down", signal });
    return;
  }
  shuttingDown = true;
  const activeCount = typingIntervals.size + activeStreams.size;
  log("SYSTEM", { event: "graceful_restart_start", signal, active_typing: typingIntervals.size, active_streams: activeStreams.size });

  // Step 1: Drain active sessions
  if (activeCount > 0) {
    log("SYSTEM", { event: "draining", count: activeCount, timeout_ms: DRAIN_TIMEOUT_MS });
    await drainActiveSessions(DRAIN_TIMEOUT_MS);
  }

  // Step 2: Stop all typing indicators
  for (const [, interval] of typingIntervals) clearInterval(interval);
  typingIntervals.clear();
  activeStreams.clear();

  // Step 3: Close HTTP server
  log("SYSTEM", { event: "closing_servers" });
  await new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
    setTimeout(() => resolve(), 5000);
  });

  // Step 4: Stop bot polling
  await bot.stop();
  log("SYSTEM", { event: "bot_stopped" });

  // Step 5: Clean exit — launchd KeepAlive will restart us with fresh code
  log("SYSTEM", { event: "graceful_exit", msg: "Clean exit for launchd restart — fresh code will be loaded", signal });
  process.exit(0);
}

// ═══════════════════════════════════════════
// STARTUP GUARD — prevent double-start
// ═══════════════════════════════════════════
function checkPortInUse(port, host) {
  return new Promise((resolve) => {
    const tester = require("net").createConnection({ port, host }, () => {
      tester.end();
      resolve(true); // port is in use
    });
    tester.on("error", () => resolve(false)); // port is free
  });
}

// Signal handlers
process.on("SIGUSR1", () => {
  log("SYSTEM", { event: "signal_received", signal: "SIGUSR1" });
  performGracefulRestart("SIGUSR1");
});

process.on("SIGINT", () => {
  log("SYSTEM", { event: "stopping", signal: "SIGINT" });
  for (const [, interval] of typingIntervals) clearInterval(interval);
  typingIntervals.clear();
  server.close();
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("SYSTEM", { event: "stopping", signal: "SIGTERM" });
  exec(`curl -s -d "📱 Telegram bridge stopping (SIGTERM)" ntfy.sh/tonysM5`);
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log("FATAL", { error: err.message });
  exec(`curl -s -d "🚨 Telegram bridge crash: ${err.message}" ntfy.sh/tonysM5`);
});

// ═══════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════
async function startBridge() {
  // Check if another instance is already running on our port
  const inUse = await checkPortInUse(HTTP_PORT, "127.0.0.1");
  if (inUse) {
    log("SYSTEM", {
      event: "already_running",
      port: HTTP_PORT,
      message: "Another Telegram bridge instance is already running — exiting cleanly."
    });
    console.log("⚠️  Telegram bridge already running on port. Exiting to avoid duplicate.");
    process.exit(0);
  }

  // Start HTTP server (no restart loop — SIGUSR1 exits cleanly, launchd restarts with fresh code)
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        if (err.code === "EADDRINUSE") {
          log("SYSTEM", { event: "http_error", code: "EADDRINUSE", port: HTTP_PORT });
          reject(err);
        }
      };
      server.once("error", onError);
      server.listen(HTTP_PORT, "127.0.0.1", () => {
        server.removeListener("error", onError);
        log("SYSTEM", { event: "http_ready", port: HTTP_PORT });
        resolve();
      });
    });
  } catch (e) {
    log("SYSTEM", { event: "startup_failed", error: e.message });
    process.exit(1);
  }

  // Register commands with Telegram so they appear in the / menu
  await bot.api.setMyCommands([
    { command: "quota", description: "Show Antigravity model usage & reset times" },
    { command: "doctor", description: "Session health diagnostics — stuck detection, cooldowns" },
  ]);

  // Start bot polling
  await bot.start({
    onStart: (botInfo) => {
      log("SYSTEM", {
        event: "bridge_started",
        version: "1.4",
        bot: botInfo.username,
        http: `http://localhost:${HTTP_PORT}`,
        workspace: WORKSPACE,
        cli: CLI_PATH,
        features: ["graceful_restart", "busy_gate", "proactive_notify", "conversation_history", "typing_indicators", "streaming", "voice", "file_attachments", "session_doctor", "worker_sessions"],
      });
    },
  });
}

startBridge();
