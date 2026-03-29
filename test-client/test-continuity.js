#!/usr/bin/env node
/**
 * 🧪 Continuity Test — Send a text message to @JarvisZhangBot and verify it remembers history.
 * 
 * Usage: node test-continuity.js ["message"]
 */

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SESSION_FILE = path.join(__dirname, ".session");
const BOT_USERNAME = process.env.JARVIS_BOT_USERNAME || "JarvisZhangBot";
const MESSAGE = process.argv[2] || "Do you remember what photos I sent you earlier today?";
const REPLY_TIMEOUT_MS = 120000;

async function main() {
  console.log("\n🧪 Continuity Test\n");
  console.log(`  💬 Message: "${MESSAGE}"`);

  const sessionStr = fs.readFileSync(SESSION_FILE, "utf-8").trim();
  const client = new TelegramClient(
    new StringSession(sessionStr),
    API_ID, API_HASH,
    { connectionRetries: 5 }
  );
  await client.connect();
  const me = await client.getMe();
  console.log(`  👤 Logged in as ${me.firstName} (@${me.username || "?"})`);

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

  // Send message
  console.log(`\n  📤 Sending...`);
  const sendStart = Date.now();
  await client.sendMessage(bot, { message: MESSAGE });
  console.log(`  ✅ Sent (${Date.now() - sendStart}ms)`);
  console.log(`  ⏳ Waiting for reply (timeout: ${REPLY_TIMEOUT_MS / 1000}s)...\n`);

  const result = await replyPromise;

  if (result.text) {
    console.log(`  ✅ GOT REPLY! (${(result.elapsed / 1000).toFixed(1)}s)`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  ${result.text}`);
    console.log(`  ─────────────────────────────────`);
  } else {
    console.log(`  ❌ NO REPLY — timed out after ${REPLY_TIMEOUT_MS / 1000}s`);
  }

  await client.disconnect();
  console.log("\n  Done.\n");
  process.exit(result.text ? 0 : 1);
}

main().catch((e) => {
  console.error("💥 Fatal:", e.message);
  process.exit(1);
});
