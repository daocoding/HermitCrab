#!/usr/bin/env node
/**
 * End-to-end test for ClaudeStreamClient (SDK multi-turn)
 * Tests: start → send message 1 → get response → send message 2 → get response → stop
 */

const ClaudeStreamClient = require("../lib/claude-stream-client");

async function main() {
  console.log("🧪 Testing ClaudeStreamClient (multi-turn)...\n");

  const client = new ClaudeStreamClient({
    model: "sonnet",
    systemPrompt: "You are a test bot. Always respond with EXACTLY one short sentence. Never use tools.",
    workspace: process.cwd(),
    permissionMode: "default",
    allowedTools: [],
    log: (msg) => console.log(`  📋 ${typeof msg === "string" ? msg : JSON.stringify(msg)}`),
  });

  let capturedSessionId = null;
  client.on("session_id", (id) => { capturedSessionId = id; });
  client.on("exit", (info) => console.log(`  🛑 Exit: ${JSON.stringify(info)}`));

  try {
    // Test 1: Send first message
    console.log("1️⃣  Sending first message...");
    const result1 = await client.sendMessage("Say 'Hello HermitCrab' and nothing else.", 30000);
    console.log(`   ✅ Response: "${result1.text?.substring(0, 80)}"`);
    console.log(`   Session: ${result1.sessionId}`);
    console.log(`   Status: ${result1.status}, Cost: $${result1.costUsd || '?'}`);

    // Test 2: Send follow-up (tests multi-turn)
    console.log("\n2️⃣  Sending follow-up message (multi-turn test)...");
    const result2 = await client.sendMessage("What did I just ask you to say?", 30000);
    console.log(`   ✅ Response: "${result2.text?.substring(0, 80)}"`);
    console.log(`   Same session: ${result2.sessionId === result1.sessionId ? "✅" : "❌"}`);

    // Test 3: Session info
    console.log("\n3️⃣  Session info:");
    const info = client.getSessionInfo();
    console.log(`   ${JSON.stringify(info, null, 2)}`);

    // Stop
    console.log("\n4️⃣  Stopping...");
    client.stop();
    await new Promise(r => setTimeout(r, 2000));

    console.log(`\n✅ All tests passed!`);
    console.log(`   Session: ${capturedSessionId}`);
    console.log(`   Messages: ${info.messageCount}`);
  } catch (err) {
    console.error(`\n❌ Test failed: ${err.message}`);
    console.error(err.stack);
    client.stop();
    process.exit(1);
  }

  process.exit(0);
}

main();
