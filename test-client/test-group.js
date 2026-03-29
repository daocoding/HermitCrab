#!/usr/bin/env node
/**
 * 🧪 HermitCrab Group Chat Test Harness — "Group 0 V2"
 * 
 * Tests Mini's behavior as a group conversation participant.
 * JARVIS (jarvis@becoach.ai) posts messages via Graph API to stimulate conversation.
 * Mini receives via Bot Framework webhook → responds via MiniH (Graph API) or bot.
 * JARVIS reads the group chat to evaluate Mini's response.
 * 
 * Architecture:
 *   ┌──────────────────────────────────────────────────────┐
 *   │                 "Group 0 V2" (Teams)                 │
 *   │                                                      │
 *   │  Tony (human)   BigH (Big's proxy)   JARVIS (tester) │
 *   │  MiniH (Mini's proxy)   apexmini (Mini's bot)       │
 *   └──────┬──────────────┬──────────────┬─────────┬──────┘
 *          │              │              │         │
 *      Graph API      Graph API    Bot Framework  Graph API
 *     (user@...)     (big@...)    (webhook)    (jarvis@becoach.ai)
 *          │              │              │         │
 *      Tony (human)   OpenClaw      HermitCrab    JARVIS
 *                     Gateway      Teams Bridge  (this script)
 *                                      │
 *                                 Antigravity CLI
 *                                      │
 *                                   Mini Agent
 *                                      │
 *                                  curl /reply → bridge → Bot sends message
 *                                  OR graph-client → MiniH posts via Graph API
 * 
 * IMPORTANT — Clean webhook flow:
 *   JARVIS is NOT in the bridge's self-skip list. When JARVIS posts via
 *   Graph API, Teams sends a webhook to Mini's bot → bridge wakes Mini.
 *   No activity injection needed — the natural Teams webhook does the job.
 * 
 * Test Flow:
 *   1. JARVIS reads current group state via Graph API
 *   2. JARVIS posts a stimulus message via Graph API (as jarvis@becoach.ai)
 *   3. Teams webhook triggers Mini's bridge → wakes Mini
 *   4. JARVIS polls for Mini's response (MiniH or bot)
 *   5. Evaluate: timing, channel used, relevance, behavior
 * 
 * Usage:
 *   node test-group.js                  # Full test suite
 *   node test-group.js --read-only      # Just read current state
 *   node test-group.js --scenario X     # Run specific scenario
 *   node test-group.js --verbose        # Show all payloads
 */

const path = require("path");
const http = require("http");
const crypto = require("crypto");

// ═══════════════════════════════════════════
// GRAPH API CLIENTS — two identities
// ═══════════════════════════════════════════
const graphDir = path.join(__dirname, "..", "graph");

// MiniH identity — for reading chat history (either identity works, but MiniH is already set up)
// Set token file to MiniH by default, JARVIS for sending
process.env.GRAPH_TOKEN_FILE = path.join(graphDir, "tokens-jarvis.json");
const graph = require(path.join(graphDir, "graph-client"));

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const args = process.argv.slice(2);
const READ_ONLY = args.includes("--read-only");
const VERBOSE = args.includes("--verbose");
const SCENARIO = args.find((a, i) => args[i - 1] === "--scenario") || null;

// Group 0 V2 identifiers
const GROUP_CHAT_ID = "19:4ec991c00ac44d8498c4b749915b5729@thread.v2";

// Participant identifiers
const PARTICIPANTS = {
  tony: {
    userId: "7ef7ddc0-7c11-48e6-ad05-bdcbed583fa9",
    displayName: "Tony",
    email: "user@apexfamilywealth.com",
    role: "human",
  },
  jarvis: {
    userId: "9b3d10fa-ca08-4009-b42d-f854fc4be876",
    displayName: "Jarvis",
    email: "Jarvis@becoach.ai",
    role: "tester",
  },
  miniH: {
    userId: "aff013c5-ea68-4813-a86c-87bda8a03d47",
    displayName: "MiniH",
    email: "mini@apexlearn.org",
    role: "agent-proxy",
    agent: "Mini (HermitCrab)",
  },
  bigH: {
    userId: "ec602c73-171a-4a79-ae2a-911cad634570",
    displayName: "BigH",
    email: "big@apexlearn.org",
    role: "agent-proxy",
    agent: "Big (OpenClaw)",
  },
  miniBot: {
    appId: "8064d4bb-dd2b-4069-81e4-002cd71d04da",
    displayName: "apexmini",
    role: "bot",
  },
};

// Bridge config (M4)
const BRIDGE_HOST = "YOUR_SERVER_IP";
const BRIDGE_PORT = 3979;
const SERVICE_URL = "https://smba.trafficmanager.net/amer/5eb6506c-523d-4d8c-abd8-e247c483c80d/";
const TENANT_ID = "5eb6506c-523d-4d8c-abd8-e247c483c80d";

// Timeouts
const RESPONSE_TIMEOUT_MS = 90000; // 90s to wait for Mini's response
const POLL_INTERVAL_MS = 3000;     // Poll every 3s

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════
function log(icon, msg) { console.log(`  ${icon} ${msg}`); }
function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

function identifySender(msg) {
  if (msg.from?.application) {
    const appId = msg.from.application.id;
    if (appId === PARTICIPANTS.miniBot.appId) return "miniBot";
    return `bot:${msg.from.application.displayName}`;
  }
  if (msg.from?.user) {
    const uid = msg.from.user.id;
    if (uid === PARTICIPANTS.tony.userId) return "tony";
    if (uid === PARTICIPANTS.jarvis.userId) return "jarvis";
    if (uid === PARTICIPANTS.miniH.userId) return "miniH";
    if (uid === PARTICIPANTS.bigH.userId) return "bigH";
    return `user:${msg.from.user.displayName}`;
  }
  return "unknown";
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, "").trim();
}

function timeDiff(isoA, isoB) {
  return Math.abs(new Date(isoA) - new Date(isoB));
}

// ═══════════════════════════════════════════
// GRAPH API OPERATIONS
// ═══════════════════════════════════════════

/** Read recent messages from Group 0 V2 (as JARVIS) */
async function readGroupMessages(count = 15) {
  const res = await graph.get(`/chats/${GROUP_CHAT_ID}/messages?$top=${count}`);
  if (!res.ok) throw new Error(`Failed to read messages: ${JSON.stringify(res.data)}`);
  return res.data.value || [];
}

/** Send a message to the group as JARVIS (jarvis@becoach.ai) — visible in chat */
async function sendAsJarvis(content, contentType = "text") {
  const res = await graph.post(`/chats/${GROUP_CHAT_ID}/messages`, {
    body: { contentType, content },
  });
  if (!res.ok) throw new Error(`Failed to send as Jarvis: ${JSON.stringify(res.data)}`);
  return res.data;
}

/**
 * Stimulate Mini: post as JARVIS (visible) + inject activity as Tony (triggers bridge).
 * JARVIS is in the self-skip list so its webhook echo gets dropped.
 * Tony's activity injection triggers the bridge → wakes Mini.
 */
async function stimulateAsJarvis(text) {
  const graphResult = await sendAsJarvis(text);
  const activityResult = await injectActivity(
    text,
    PARTICIPANTS.tony.displayName,
    PARTICIPANTS.tony.userId
  );
  return { graphResult, activityResult };
}

/** Inject a Bot Framework activity to the bridge (simulates a Teams message) */
function injectActivity(text, senderName, senderId) {
  return new Promise((resolve, reject) => {
    const activity = {
      type: "message",
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      channelId: "msteams",
      serviceUrl: SERVICE_URL,
      from: {
        id: senderId,
        name: senderName,
        aadObjectId: senderId,
      },
      conversation: {
        id: GROUP_CHAT_ID,
        tenantId: TENANT_ID,
        conversationType: "group",
      },
      recipient: {
        id: PARTICIPANTS.miniBot.appId,
        name: "apexmini",
      },
      text,
      textFormat: "plain",
      channelData: { tenant: { id: TENANT_ID } },
    };

    const data = JSON.stringify(activity);
    const req = http.request({
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: "/api/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

/**
 * Poll for a new message in the group after a given timestamp.
 * Looks for messages from MiniH, miniBot, or BigH.
 * Ignores messages from JARVIS itself.
 */
async function waitForResponse(afterTimestamp, fromWho = ["miniH", "miniBot"], timeoutMs = RESPONSE_TIMEOUT_MS) {
  const start = Date.now();
  const afterDate = new Date(afterTimestamp);
  
  log("⏳", `Waiting for response from [${fromWho.join(", ")}] (timeout: ${timeoutMs / 1000}s)...`);
  
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    
    try {
      const messages = await readGroupMessages(10);
      
      for (const msg of messages) {
        const msgDate = new Date(msg.createdDateTime);
        if (msgDate <= afterDate) continue; // Old message
        
        const sender = identifySender(msg);
        if (fromWho.includes(sender)) {
          const content = stripHtml(msg.body?.content || "");
          const latencyMs = msgDate - afterDate;
          return {
            sender,
            content,
            timestamp: msg.createdDateTime,
            latencyMs,
            raw: msg,
          };
        }
      }
    } catch (e) {
      if (VERBOSE) log("⚠️", `Poll error: ${e.message}`);
    }
    
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (VERBOSE && elapsed % 15 === 0) {
      log("⏳", `Still waiting... (${elapsed}s)`);
    }
  }
  
  return null; // Timeout
}

// ═══════════════════════════════════════════
// TEST SCENARIOS
// ═══════════════════════════════════════════
const results = [];

function recordResult(name, passed, detail = "") {
  results.push({ name, passed, detail });
  log(passed ? "✅" : "❌", `${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * S0: Read Group State
 * Display current conversation context
 */
async function scenarioReadState() {
  section("Scenario 0: Group State");
  
  const messages = await readGroupMessages(15);
  log("📊", `${messages.length} recent messages in Group 0 V2`);
  
  // Count by sender
  const bySender = {};
  for (const msg of messages) {
    const sender = identifySender(msg);
    bySender[sender] = (bySender[sender] || 0) + 1;
  }
  
  log("👥", `Participants: ${Object.entries(bySender).map(([k, v]) => `${k}(${v})`).join(", ")}`);
  
  // Show last 5 messages
  console.log();
  const recent = messages.slice(0, 5).reverse();
  for (const msg of recent) {
    const sender = identifySender(msg);
    const content = stripHtml(msg.body?.content || "").substring(0, 80);
    const time = new Date(msg.createdDateTime).toLocaleTimeString();
    const channel = msg.from?.application ? "🤖 bot" : "👤 graph";
    log("💬", `[${time}] ${sender} (${channel}): ${content}`);
  }
  
  recordResult("Group state readable", messages.length > 0, `${messages.length} messages`);
}

/**
 * S1: Direct Question from JARVIS
 * JARVIS posts via Graph API → Teams webhook triggers Mini's bridge.
 * Mini reads context, sees JARVIS's message, and responds.
 * Evaluates: did Mini respond? How fast? Which channel? Was it relevant?
 */
async function scenarioDirectQuestion() {
  section("Scenario 1: JARVIS Asks Mini Directly");
  
  const timestamp = new Date().toISOString();
  const testId = Date.now();
  const question = `[🧪 TEST-${testId}] Hey Mini, what's the current time?`;
  
  log("📤", `JARVIS asks: "${question}"`);
  
  try {
    const { graphResult, activityResult } = await stimulateAsJarvis(question);
    log("📬", `Graph: ${graphResult.id} | Inject: ${activityResult.status}`);
    
    // Wait for Mini's response (either as MiniH or bot)
    const response = await waitForResponse(timestamp, ["miniH", "miniBot"], RESPONSE_TIMEOUT_MS);
    
    if (response) {
      const channel = response.sender === "miniH" ? "Graph API (human-like)" : "Bot Framework";
      const latency = (response.latencyMs / 1000).toFixed(1);
      log("📥", `Response via ${channel} in ${latency}s: "${response.content.substring(0, 100)}..."`);
      
      recordResult("Direct question — got response", true, `${channel}, ${latency}s`);
      recordResult("Response latency", response.latencyMs < 60000, `${latency}s (target: <60s)`);
      recordResult("Preferred channel (MiniH)", response.sender === "miniH", 
        response.sender === "miniH" ? "✅ Graph API (human-like)" : "⚠️ Bot Framework (should use MiniH)");
      
      // Check relevance
      const content = response.content.toLowerCase();
      const hasContext = content.includes("time") || content.includes("test") || content.match(/\d{1,2}:\d{2}/);
      recordResult("Response relevance", hasContext, hasContext ? "on-topic" : "seems off-topic");
    } else {
      recordResult("Direct question — got response", false, "timeout (no reply in 90s)");
    }
  } catch (e) {
    recordResult("Direct question", false, e.message);
  }
}

/**
 * S2: JARVIS Greeting — casual message
 * Tests that Mini doesn't over-respond to casual/non-directed messages.
 */
async function scenarioCasualMessage() {
  section("Scenario 2: Casual Message (Non-Directed)");
  
  const timestamp = new Date().toISOString();
  const testId = Date.now();
  const casualMsg = `[🧪 TEST-${testId}] Just checking in on the group — how's everyone doing?`;
  
  log("📤", `JARVIS (casual): "${casualMsg}"`);
  
  try {
    await stimulateAsJarvis(casualMsg);
    
    // Short timeout — Mini should either respond briefly or stay silent
    const response = await waitForResponse(timestamp, ["miniH", "miniBot"], 30000);
    
    if (response) {
      const content = response.content;
      const isShort = content.length < 200;
      const channel = response.sender === "miniH" ? "Graph API" : "Bot";
      const latency = (response.latencyMs / 1000).toFixed(1);
      
      log("📥", `Mini responded (${channel}, ${latency}s): "${content.substring(0, 100)}..."`);
      recordResult("Casual message — response size", isShort, 
        isShort ? `concise (${content.length} chars)` : `too verbose (${content.length} chars)`);
    } else {
      log("📥", "Mini stayed silent (30s timeout)");
      recordResult("Casual message — appropriately quiet", true, "no response (acceptable)");
    }
  } catch (e) {
    recordResult("Casual message", false, e.message);
  }
}

/**
 * S3: NO_REPLY Verification
 * JARVIS sends a message, Mini should respond via MiniH (Graph API),
 * and the bot should NOT send a watchdog "⏳" message.
 */
async function scenarioNoReply() {
  section("Scenario 3: NO_REPLY + Watchdog Suppression");
  
  const timestamp = new Date().toISOString();
  const testId = Date.now();
  const msg = `[🧪 TEST-${testId}] Mini, what's 2+2? Quick test.`;
  
  log("📤", `JARVIS: "${msg}"`);
  
  try {
    await stimulateAsJarvis(msg);
    
    // Wait up to 4 minutes (watchdog fires at ~3 min)
    const responses = [];
    const start = Date.now();
    const maxWait = 240000; // 4 min
    
    while (Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      
      const messages = await readGroupMessages(10);
      for (const m of messages) {
        const msgDate = new Date(m.createdDateTime);
        if (msgDate <= new Date(timestamp)) continue;
        
        const sender = identifySender(m);
        if ((sender === "miniH" || sender === "miniBot") &&
            !responses.find(r => r.raw.id === m.id)) {
          responses.push({
            sender,
            content: stripHtml(m.body?.content || ""),
            timestamp: m.createdDateTime,
            raw: m,
          });
        }
      }
      
      // If we got a response and have waited past the watchdog window (3.5 min), we're done
      if (responses.length > 0 && Date.now() - start > 210000) break;
      
      // Short-circuit: if we got a MiniH response and no bot yet after 30s, check
      if (responses.length > 0 && responses[0].sender === "miniH" && Date.now() - start > 30000) {
        // Wait extra time to see if watchdog fires
        const elapsed = Math.round((Date.now() - start) / 1000);
        if (elapsed % 15 === 0) log("⏳", `MiniH responded, waiting for watchdog check... (${elapsed}s)`);
      }
    }
    
    // Analyze results
    const miniHResponse = responses.find(r => r.sender === "miniH");
    const botMessages = responses.filter(r => r.sender === "miniBot");
    const watchdogMsgs = botMessages.filter(r => r.content.includes("⏳") || r.content.includes("taking longer"));
    
    if (miniHResponse) {
      recordResult("Mini responded via MiniH", true, `"${miniHResponse.content.substring(0, 60)}"`);
    } else if (botMessages.length > 0) {
      recordResult("Mini responded via MiniH", false, "used Bot instead of MiniH");
    } else {
      recordResult("Mini responded", false, "no response");
    }
    
    recordResult("No watchdog ⏳ message", watchdogMsgs.length === 0, 
      watchdogMsgs.length === 0 ? "clean — NO_REPLY working" : `${watchdogMsgs.length} watchdog message(s) leaked`);
    
  } catch (e) {
    recordResult("NO_REPLY test", false, e.message);
  }
}

/**
 * S4: Multi-turn conversation — verify context retention
 * JARVIS sends two related messages. Mini's second response should reference the first.
 */
async function scenarioMultiTurn() {
  section("Scenario 4: Multi-Turn Context Retention");
  
  const testId = Date.now();
  const timestamp = new Date().toISOString();
  
  // Message 1
  const msg1 = `[🧪 TEST-${testId}] Hey Mini, I'm thinking about adding a feature called "Night Owl Mode" to our app`;
  log("📤", `JARVIS (1/2): "${msg1}"`);
  await stimulateAsJarvis(msg1);
  
  // Wait for first response
  const resp1 = await waitForResponse(timestamp, ["miniH", "miniBot"], RESPONSE_TIMEOUT_MS);
  if (!resp1) {
    recordResult("Multi-turn (response 1)", false, "no response to first message");
    return;
  }
  log("📥", `Mini (1/2): "${resp1.content.substring(0, 80)}..."`);
  recordResult("Multi-turn (response 1)", true, `${(resp1.latencyMs / 1000).toFixed(1)}s`);
  
  // Message 2 — references the first
  await new Promise(r => setTimeout(r, 5000));
  const ts2 = new Date().toISOString();
  const msg2 = `[🧪 TEST-${testId}] What are the pros and cons of that feature?`;
  log("📤", `JARVIS (2/2): "${msg2}"`);
  await stimulateAsJarvis(msg2);
  
  const resp2 = await waitForResponse(ts2, ["miniH", "miniBot"], RESPONSE_TIMEOUT_MS);
  if (!resp2) {
    recordResult("Multi-turn (response 2)", false, "no response to follow-up");
    return;
  }
  
  log("📥", `Mini (2/2): "${resp2.content.substring(0, 80)}..."`);
  
  // Check if response references "Night Owl" (context retention)
  const hasContext = resp2.content.toLowerCase().includes("night owl") || 
                     resp2.content.toLowerCase().includes("feature") ||
                     resp2.content.toLowerCase().includes("mode");
  recordResult("Multi-turn (context retained)", hasContext, 
    hasContext ? "referenced Night Owl/feature" : "lost context");
}

/**
 * S5: Behavior Profile — analyze Mini's response patterns
 * Reads recent history and scores Mini's participation quality.
 */
async function scenarioBehaviorProfile() {
  section("Scenario 5: Behavior Profile Analysis");
  
  const messages = await readGroupMessages(30);
  
  let stats = {
    totalMessages: messages.length,
    byJarvis: 0,
    byMiniH: 0,
    byMiniBot: 0,
    byTony: 0,
    byBigH: 0,
    miniChannels: { graph: 0, bot: 0 },
  };
  
  for (const msg of messages) {
    const sender = identifySender(msg);
    
    switch (sender) {
      case "tony": stats.byTony++; break;
      case "jarvis": stats.byJarvis++; break;
      case "miniH": 
        stats.byMiniH++; 
        stats.miniChannels.graph++;
        break;
      case "miniBot": 
        stats.byMiniBot++; 
        stats.miniChannels.bot++;
        break;
      case "bigH": stats.byBigH++; break;
    }
  }
  
  log("📊", `Message distribution (last ${messages.length}):`);
  log("  ", `Tony: ${stats.byTony} | JARVIS: ${stats.byJarvis} | BigH: ${stats.byBigH} | MiniH: ${stats.byMiniH} | MiniBOT: ${stats.byMiniBot}`);
  log("📡", `Mini's channel usage: Graph API: ${stats.miniChannels.graph} | Bot: ${stats.miniChannels.bot}`);
  
  // Score: MiniH should prefer Graph API over Bot for group chat
  const graphRatio = stats.miniChannels.graph / (stats.miniChannels.graph + stats.miniChannels.bot || 1);
  const prefersGraph = graphRatio >= 0.5;
  recordResult("Channel preference (Graph > Bot)", prefersGraph, 
    `${Math.round(graphRatio * 100)}% Graph API`);
  
  // Score: Mini shouldn't dominate the conversation
  const miniTotal = stats.byMiniH + stats.byMiniBot;
  const nonMini = stats.totalMessages - miniTotal;
  const talkRatio = miniTotal / (stats.totalMessages || 1);
  const notDominating = talkRatio <= 0.5;
  recordResult("Not dominating conversation", notDominating, 
    `${Math.round(talkRatio * 100)}% of messages are Mini's`);
  
  // Score: Watchdog messages (⏳) should not appear
  let watchdogCount = 0;
  for (const msg of messages) {
    if (identifySender(msg) === "miniBot") {
      const content = stripHtml(msg.body?.content || "");
      if (content.includes("⏳") || content.includes("taking longer")) {
        watchdogCount++;
      }
    }
  }
  recordResult("No watchdog spam", watchdogCount === 0, 
    watchdogCount === 0 ? "clean" : `${watchdogCount} watchdog message(s) in history`);
}

// ═══════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════
function printSummary() {
  section("📊 TEST SUMMARY");
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  for (const r of results) {
    log(r.passed ? "✅" : "❌", r.name + (r.detail ? ` (${r.detail})` : ""));
  }

  console.log(`\n  ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ""}`);
  console.log(`  ${failed === 0 ? "🎉 All tests passed!" : "⚠️  Some tests need attention."}\n`);
  return failed === 0;
}

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════
async function main() {
  console.log("\n🧪 HermitCrab Group Chat Test — \"Group 0 V2\"\n");
  log("💬", `Chat: ${GROUP_CHAT_ID}`);
  log("🎭", `Tester: JARVIS (jarvis@becoach.ai) via Graph API`);
  log("🎯", `Target: Mini → MiniH (optimal participant)`);
  log("🏢", `Bridge: ${BRIDGE_HOST}:${BRIDGE_PORT}`);
  
  // Verify JARVIS identity
  const me = await graph.get("/me?$select=displayName,mail");
  if (me.ok) {
    log("🔐", `Authenticated as: ${me.data.displayName} (${me.data.mail})`);
  } else {
    log("🔴", "Graph API authentication failed! Run: GRAPH_TOKEN_FILE=tokens-jarvis.json node graph/setup.js");
    process.exit(2);
  }
  
  // Always read state first
  await scenarioReadState();
  
  if (READ_ONLY) {
    printSummary();
    process.exit(0);
    return;
  }
  
  // Run selected or all scenarios
  if (SCENARIO) {
    switch (SCENARIO) {
      case "1": case "direct": await scenarioDirectQuestion(); break;
      case "2": case "casual": await scenarioCasualMessage(); break;
      case "3": case "noreply": await scenarioNoReply(); break;
      case "4": case "context": await scenarioMultiTurn(); break;
      case "5": case "profile": await scenarioBehaviorProfile(); break;
      default: log("❌", `Unknown scenario: ${SCENARIO}`); process.exit(1);
    }
  } else {
    // Default suite: read-only checks + direct question
    await scenarioBehaviorProfile();  // S5: Quick — analyze history
    await scenarioDirectQuestion();   // S1: Wait for Mini's response
    // S2-S4 are longer — run explicitly
    log("💡", "Run --scenario casual|noreply|context for extended tests");
  }
  
  const allPassed = printSummary();
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error("💥 Fatal:", e.message);
  if (VERBOSE) console.error(e.stack);
  process.exit(1);
});
