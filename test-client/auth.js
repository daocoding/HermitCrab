#!/usr/bin/env node
/**
 * 🔐 JARVIS Test Client — One-Time Authentication
 * 
 * Run this ONCE to create a Telegram session.
 * You'll need to enter the SMS code sent to your Google Voice number.
 * After auth, the session is saved to .session and never needs re-auth.
 * 
 * Usage: node auth.js
 */

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const fs = require("fs");
const path = require("path");

// Load env
require("dotenv").config({ path: path.join(__dirname, ".env") });

const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SESSION_FILE = path.join(__dirname, ".session");

async function main() {
  console.log("🔐 JARVIS Test Client — Telegram Authentication\n");

  // Check for existing session
  let sessionStr = "";
  if (fs.existsSync(SESSION_FILE)) {
    sessionStr = fs.readFileSync(SESSION_FILE, "utf-8").trim();
    console.log("📁 Found existing session file. Attempting to resume...\n");
  }

  const client = new TelegramClient(
    new StringSession(sessionStr),
    API_ID,
    API_HASH,
    { connectionRetries: 5 }
  );

  await client.start({
    phoneNumber: async () => await input.text("📱 Phone number (with country code): "),
    password: async () => await input.text("🔑 2FA password (if enabled): "),
    phoneCode: async () => await input.text("📨 SMS code from Google Voice: "),
    onError: (err) => console.error("❌ Auth error:", err.message),
  });

  // Save session
  const newSession = client.session.save();
  fs.writeFileSync(SESSION_FILE, newSession);

  console.log("\n✅ Authenticated successfully!");
  console.log(`📁 Session saved to: ${SESSION_FILE}`);

  // Verify — get own info
  const me = await client.getMe();
  console.log(`👤 Logged in as: ${me.firstName} ${me.lastName || ""} (@${me.username || "no username"})`);
  console.log(`🆔 User ID: ${me.id}`);
  console.log("\n💡 You can now run: node test-bridge.js");

  await client.disconnect();
}

main().catch(console.error);
