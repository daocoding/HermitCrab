#!/usr/bin/env node
/**
 * 🧪 Photo Test — Send a photo to @JarvisZhangBot and verify the response
 * 
 * Usage: node test-photo.js [path-to-image]
 * Default: uses the photo Tony sent earlier
 */

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { CustomFile } = require("telegram/client/uploads");
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SESSION_FILE = path.join(__dirname, ".session");
const BOT_USERNAME = process.env.JARVIS_BOT_USERNAME || "JarvisZhangBot";

// Use provided image or the test photo Tony sent earlier
const IMAGE_PATH = process.argv[2] || path.resolve(__dirname, "../uploads/1495516896/2026-03-22T20-36-45_photo_1774211804539.jpg");

const REPLY_TIMEOUT_MS = 200000; // 200s — generous for photo processing

async function main() {
  console.log("\n🧪 Photo Send Test\n");

  // Verify image exists
  if (!fs.existsSync(IMAGE_PATH)) {
    console.error(`❌ Image not found: ${IMAGE_PATH}`);
    process.exit(1);
  }
  const imageSize = fs.statSync(IMAGE_PATH).size;
  console.log(`  📷 Image: ${path.basename(IMAGE_PATH)} (${(imageSize / 1024).toFixed(1)} KB)`);

  // Connect
  const sessionStr = fs.readFileSync(SESSION_FILE, "utf-8").trim();
  const client = new TelegramClient(
    new StringSession(sessionStr),
    API_ID,
    API_HASH,
    { connectionRetries: 5 }
  );
  await client.connect();
  const me = await client.getMe();
  console.log(`  👤 Logged in as ${me.firstName} (@${me.username || "?"})`);

  // Resolve bot
  const bot = await client.getEntity(BOT_USERNAME);
  console.log(`  🤖 Target: @${BOT_USERNAME} (ID: ${bot.id})`);

  // Set up reply listener
  const replyPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.removeEventHandler(handler, new NewMessage({}));
      resolve({ text: null, elapsed: REPLY_TIMEOUT_MS });
    }, REPLY_TIMEOUT_MS);

    const startTime = Date.now();
    const handler = async (event) => {
      const msg = event.message;
      const senderId = (msg.senderId?.value || msg.senderId || "").toString();
      const botId = (bot.id?.value || bot.id || "").toString();
      if (senderId === botId) {
        clearTimeout(timer);
        client.removeEventHandler(handler, new NewMessage({}));
        resolve({ text: msg.text, elapsed: Date.now() - startTime });
      }
    };
    client.addEventHandler(handler, new NewMessage({}));
  });

  // Send the photo (no caption — this is what we're testing)
  console.log(`\n  📤 Sending photo with NO caption...`);
  const sendStart = Date.now();
  
  await client.sendFile(bot, {
    file: IMAGE_PATH,
    forceDocument: false, // send as photo, not document
  });
  
  console.log(`  ✅ Photo sent (${Date.now() - sendStart}ms)`);
  console.log(`  ⏳ Waiting for reply (timeout: ${REPLY_TIMEOUT_MS / 1000}s)...`);

  // Wait for reply
  const result = await replyPromise;

  if (result.text) {
    console.log(`\n  ✅ GOT REPLY! (${(result.elapsed / 1000).toFixed(1)}s)`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  ${result.text}`);
    console.log(`  ─────────────────────────────────`);
  } else {
    console.log(`\n  ❌ NO REPLY — timed out after ${REPLY_TIMEOUT_MS / 1000}s`);
  }

  await client.disconnect();
  console.log("\n  Done.\n");
  process.exit(result.text ? 0 : 1);
}

main().catch((e) => {
  console.error("💥 Fatal:", e.message);
  process.exit(1);
});
