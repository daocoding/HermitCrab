#!/usr/bin/env node
/**
 * HermitCrab Teams Bridge — UX Experience Test
 * 
 * Answers: "What does the human SEE and FEEL?"
 * 
 * Produces a timeline for each test showing exactly what appears
 * in the Teams UI, with timing, identity, and experience metrics.
 * 
 * Usage: node test-bridge.js [--host YOUR_SERVER_IP] [--test 1,2,3]
 */

const http = require("http");
const path = require("path");
const { execSync } = require("child_process");

// ── Config ──
const BRIDGE_HOST = process.argv.includes("--host") 
  ? process.argv[process.argv.indexOf("--host") + 1] 
  : "YOUR_SERVER_IP";
const BRIDGE_PORT = 3979;
const CHAT_ID = "19:4ec991c00ac44d8498c4b749915b5729@thread.v2";
const TENANT = "5eb6506c-523d-4d8c-abd8-e247c483c80d";
const TONY_ID = "7ef7ddc0-7c11-48e6-ad05-bdcbed583fa9";
const BOT_ID = "8064d4bb-dd2b-4069-81e4-002cd71d04da";
const GRAPH_DIR = path.join(__dirname, "..", "graph");
const GRAPH_TOKEN_FILE = path.join(GRAPH_DIR, "tokens-jarvis.json");

const selectedTests = process.argv.includes("--test")
  ? process.argv[process.argv.indexOf("--test") + 1].split(",").map(Number)
  : null;

process.env.GRAPH_TOKEN_FILE = GRAPH_TOKEN_FILE;
const graph = require(path.join(GRAPH_DIR, "graph-client"));

// ── Helpers ──
function inject(text) {
  return new Promise((resolve, reject) => {
    const activity = JSON.stringify({
      type: "message", text,
      from: { id: TONY_ID, name: "Tony", aadObjectId: TONY_ID },
      conversation: { id: CHAT_ID, tenantId: TENANT, conversationType: "group" },
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      recipient: { id: BOT_ID, name: "apexmini" },
      channelData: { tenant: { id: TENANT } },
    });
    const req = http.request({
      hostname: BRIDGE_HOST, port: BRIDGE_PORT,
      path: "/api/messages", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(activity) },
    }, (res) => resolve(res.statusCode));
    req.on("error", reject);
    req.write(activity);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getNewMessages(since) {
  const res = await graph.get(`/chats/${CHAT_ID}/messages?$top=15`);
  if (!res.ok) return [];
  return (res.data.value || [])
    .filter(m => new Date(m.createdDateTime) > since)
    .map(m => ({
      who: m.from?.user?.displayName || m.from?.application?.displayName || "?",
      text: (m.body?.content || "").replace(/<[^>]+>/g, "").trim(),
      isBot: !!m.from?.application,
      time: new Date(m.createdDateTime),
    }))
    .reverse();
}

function getBridgeLogs(since) {
  try {
    const cmd = `ssh -o ConnectTimeout=5 user@${BRIDGE_HOST} "cat /Users/yourusername/Library/Logs/HermitCrab/teams-bridge.log"`;
    const output = execSync(cmd, { maxBuffer: 10 * 1024 * 1024, encoding: "utf8" });
    return output.split("\n")
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(entry => entry && entry.ts && new Date(entry.ts) > since);
  } catch (e) {
    return [];
  }
}

// ── UX Timeline Builder ──
// Reconstructs what the human sees, moment by moment
function buildUXTimeline(sentTime, messages, logs) {
  const timeline = [];
  const t0 = sentTime.getTime();
  const fmt = (ms) => `T+${(ms / 1000).toFixed(1)}s`;
  
  // 1. Typing indicator starts (from logs)
  const typingStarts = logs.filter(l => l.direction === "TYPING_API_CALL" || l.direction === "BUSY_SET");
  if (typingStarts.length > 0) {
    const first = new Date(typingStarts[0].ts).getTime();
    timeline.push({ t: first - t0, event: "⌨️  Typing indicator appears", who: "apexmini (bot)" });
  }
  
  // 2. Each message that arrives (what user sees in chat)
  for (const msg of messages) {
    const t = msg.time.getTime() - t0;
    const badge = msg.isBot ? "🤖 BOT" : "👤 USER";
    timeline.push({ t, event: `💬 "${msg.text.substring(0, 100)}"`, who: `${badge} ${msg.who}` });
  }
  
  // 3. Typing indicator stops (from logs)
  const typingStops = logs.filter(l => l.direction === "TYPING_STOP");
  for (const stop of typingStops) {
    const t = new Date(stop.ts).getTime() - t0;
    timeline.push({ t, event: "⌨️  Typing indicator stops", who: stop.reason || "" });
  }
  
  // 4. Typing continues (JARVIS done, Mini still going)
  const typingContinues = logs.filter(l => l.direction === "TYPING_CONTINUE");
  for (const cont of typingContinues) {
    const t = new Date(cont.ts).getTime() - t0;
    timeline.push({ t, event: "⌨️  Typing persists (another agent still working)", who: cont.reason || "" });
  }
  
  // 5. Watchdog messages (bad UX)
  const watchdogs = logs.filter(l => l.direction === "WATCHDOG" && l.action === "timeout");
  for (const wd of watchdogs) {
    const t = new Date(wd.ts).getTime() - t0;
    timeline.push({ t, event: "⏳ WATCHDOG: 'Taking longer than expected...'", who: "apexmini (bot)" });
  }
  
  // 6. Debounce batching (invisible to user but affects latency)
  const debounce = logs.filter(l => l.direction === "DEBOUNCE_FLUSH");
  for (const d of debounce) {
    const t = new Date(d.ts).getTime() - t0;
    timeline.push({ t, event: `🔄 Debounce: ${d.count} messages batched (user doesn't see this)`, who: "bridge" });
  }
  
  // 7. Errors (user sees nothing but something broke)
  const errors = logs.filter(l => l.direction === "ERROR" || l.direction === "REPLY_ERROR");
  for (const e of errors) {
    const t = new Date(e.ts).getTime() - t0;
    timeline.push({ t, event: `🚨 ERROR: ${e.error || "unknown"}`, who: "bridge (invisible to user)" });
  }
  
  // Sort by time
  timeline.sort((a, b) => a.t - b.t);
  return timeline;
}

// ── UX Scorecard ──
function scoreUX(sentTime, messages, logs, expectations) {
  const t0 = sentTime.getTime();
  const issues = [];
  const metrics = {};
  
  // Time to first response
  const replies = messages.filter(m => !m.isBot && m.who !== "Tony");
  if (replies.length > 0) {
    metrics.timeToFirstReply = ((replies[0].time.getTime() - t0) / 1000).toFixed(1) + "s";
  } else {
    metrics.timeToFirstReply = "NO REPLY";
    issues.push("😤 User sent a message and got NOTHING back");
  }
  
  // Time to all replies
  if (replies.length > 0) {
    metrics.timeToAllReplies = ((replies[replies.length - 1].time.getTime() - t0) / 1000).toFixed(1) + "s";
  }
  
  // Expected responders
  if (expectations.respondents) {
    for (const expected of expectations.respondents) {
      if (!replies.find(r => r.who === expected)) {
        issues.push(`😕 User expected ${expected} to respond — but got nothing from them`);
      }
    }
    // Unexpected responders
    for (const reply of replies) {
      if (!expectations.respondents.includes(reply.who)) {
        issues.push(`🤔 ${reply.who} responded but wasn't expected`);
      }
    }
  }
  
  // Bot badge visible?
  const botMessages = messages.filter(m => m.isBot);
  const botReplies = botMessages.filter(m => m.who !== "Tony");
  if (botReplies.length > 0) {
    issues.push(`🤖 Bot badge visible: "${botReplies.map(m => m.who).join(", ")}" appeared as a bot, not a person`);
  }
  
  // Watchdog message visible?
  const watchdogs = logs.filter(l => l.direction === "WATCHDOG" && l.action === "timeout");
  if (watchdogs.length > 0) {
    issues.push("⏳ User saw '⏳ Taking longer than expected...' — looks broken");
  }
  
  // Errors in pipeline
  const errors = logs.filter(l => l.direction === "ERROR" || l.direction === "REPLY_ERROR");
  if (errors.length > 0) {
    issues.push(`🚨 ${errors.length} pipeline error(s): ${errors.map(e => e.error).join("; ")}`);
  }
  
  // Typing lifecycle
  const typingStops = logs.filter(l => l.direction === "TYPING_STOP");
  if (typingStops.length === 0 && replies.length > 0) {
    issues.push("⌨️ Typing indicator may be stuck — never saw TYPING_STOP");
  }
  
  // Session cleanup
  if (expectations.respondents) {
    for (const agent of expectations.agents || []) {
      const cleared = logs.find(l => 
        (l.direction === "AUTO_NO_REPLY" || l.direction === "NO_REPLY") && l.agent === agent
      );
      if (!cleared) {
        issues.push(`🔒 Session for "${agent}" was never cleared — may block future messages`);
      }
    }
  }
  
  // Overall feel
  const firstReplyMs = replies.length > 0 ? replies[0].time.getTime() - t0 : Infinity;
  if (firstReplyMs < 5000) metrics.feel = "⚡ Instant";
  else if (firstReplyMs < 15000) metrics.feel = "👍 Quick";
  else if (firstReplyMs < 30000) metrics.feel = "🤔 Noticeable wait";
  else if (firstReplyMs < 60000) metrics.feel = "😐 Slow";
  else metrics.feel = "😤 Too slow";
  
  return { metrics, issues, passed: issues.length === 0 };
}

// ── Tests (UX-focused) ──
const tests = [
  {
    id: 1,
    name: "User asks Mini a simple question",
    scenario: "Tony types 'Mini, what is 1+1?' in Group 0 V2",
    expectations: { respondents: ["MiniH"], agents: ["mini"] },
    run: async function() {
      const sendTime = new Date();
      await inject("Mini, what is 1+1?");
      
      for (let i = 0; i < 25; i++) {
        await sleep(3000);
        const msgs = await getNewMessages(sendTime);
        if (msgs.find(m => m.who === "MiniH")) { await sleep(5000); break; }
      }
      
      const messages = await getNewMessages(sendTime);
      const logs = getBridgeLogs(sendTime);
      return { sendTime, messages, logs };
    },
  },
  {
    id: 2,
    name: "User asks everyone a question",
    scenario: "Tony types 'Hey everyone, say your name' — expects both Mini and JARVIS",
    expectations: { respondents: ["MiniH", "Jarvis"], agents: ["mini", "jarvis"] },
    run: async function() {
      const sendTime = new Date();
      await inject("Hey everyone, say your name in one word");
      
      let miniDone = false, jarvisDone = false;
      for (let i = 0; i < 35; i++) {
        await sleep(3000);
        const msgs = await getNewMessages(sendTime);
        if (msgs.find(m => m.who === "MiniH")) miniDone = true;
        if (msgs.find(m => m.who === "Jarvis")) jarvisDone = true;
        if (miniDone && jarvisDone) { await sleep(5000); break; }
      }
      
      const messages = await getNewMessages(sendTime);
      const logs = getBridgeLogs(sendTime);
      return { sendTime, messages, logs };
    },
  },
  {
    id: 3,
    name: "User types multiple messages quickly",
    scenario: "Tony types 'Hey' → 'can you' → 'tell me 3+3?' within 1.5 seconds",
    expectations: { respondents: ["MiniH"], agents: ["mini"] },
    run: async function() {
      const sendTime = new Date();
      await inject("Hey");
      await sleep(500);
      await inject("can you");
      await sleep(500);
      await inject("tell me what is 3+3?");
      
      for (let i = 0; i < 25; i++) {
        await sleep(3000);
        const msgs = await getNewMessages(sendTime);
        if (msgs.find(m => m.who === "MiniH")) { await sleep(5000); break; }
      }
      
      const messages = await getNewMessages(sendTime);
      const logs = getBridgeLogs(sendTime);
      return { sendTime, messages, logs };
    },
  },
  {
    id: 4,
    name: "User asks JARVIS directly",
    scenario: "Tony types 'Jarvis, say pong' — expects JARVIS (and Mini may also respond)",
    expectations: { respondents: ["Jarvis"], agents: ["jarvis", "mini"] },
    run: async function() {
      const sendTime = new Date();
      await inject("Jarvis, say pong");
      
      for (let i = 0; i < 25; i++) {
        await sleep(3000);
        const msgs = await getNewMessages(sendTime);
        if (msgs.find(m => m.who === "Jarvis")) { await sleep(5000); break; }
      }
      
      const messages = await getNewMessages(sendTime);
      const logs = getBridgeLogs(sendTime);
      return { sendTime, messages, logs };
    },
  },
];

// ── Runner ──
async function main() {
  console.log("\n🦀 HermitCrab Teams Bridge — UX Experience Test");
  console.log("━".repeat(60));
  console.log("Goal: What does the HUMAN see and feel?\n");
  
  // Health check
  try {
    const h = await new Promise((resolve, reject) => {
      http.get(`http://${BRIDGE_HOST}:${BRIDGE_PORT}/health`, res => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => resolve(JSON.parse(d)));
      }).on("error", reject);
    });
    console.log(`✅ Bridge: ${BRIDGE_HOST}:${BRIDGE_PORT} (reply: ${h.reply_port})\n`);
  } catch {
    console.log("❌ Bridge unreachable — aborting\n");
    process.exit(1);
  }
  
  const runTests = selectedTests 
    ? tests.filter(t => selectedTests.includes(t.id))
    : tests;
  
  const allResults = [];
  
  for (const test of runTests) {
    console.log(`┌─ TEST ${test.id}: ${test.name}`);
    console.log(`│  Scenario: ${test.scenario}`);
    console.log("│");
    
    try {
      const { sendTime, messages, logs } = await test.run();
      
      // Build UX timeline
      const timeline = buildUXTimeline(sendTime, messages, logs);
      console.log("│  📋 What the user sees:");
      for (const entry of timeline) {
        const tStr = `T+${(entry.t / 1000).toFixed(1)}s`.padEnd(9);
        console.log(`│    ${tStr} ${entry.event}`);
        if (entry.who) console.log(`│             └─ ${entry.who}`);
      }
      
      // Score UX
      const score = scoreUX(sendTime, messages, logs, test.expectations);
      console.log("│");
      console.log("│  📊 Experience:");
      console.log(`│    First reply: ${score.metrics.timeToFirstReply}`);
      if (score.metrics.timeToAllReplies) {
        console.log(`│    All replies: ${score.metrics.timeToAllReplies}`);
      }
      console.log(`│    Feel: ${score.metrics.feel}`);
      
      if (score.issues.length > 0) {
        console.log("│");
        console.log("│  ⚠️  UX Issues:");
        for (const issue of score.issues) {
          console.log(`│    ${issue}`);
        }
      }
      
      console.log("│");
      console.log(`└─ ${score.passed ? "✅ PASS" : "❌ FAIL"}`);
      console.log();
      
      allResults.push({ id: test.id, name: test.name, ...score });
      
      // Settle between tests
      await sleep(5000);
      
    } catch (e) {
      console.log(`│  🚨 Error: ${e.message}`);
      console.log("└─ ❌ ERROR\n");
      allResults.push({ id: test.id, name: test.name, passed: false, issues: [e.message], metrics: {} });
    }
  }
  
  // Summary
  console.log("━".repeat(60));
  console.log("UX SUMMARY");
  console.log("━".repeat(60));
  const passed = allResults.filter(r => r.passed).length;
  for (const r of allResults) {
    const feel = r.metrics?.feel || "—";
    const time = r.metrics?.timeToFirstReply || "—";
    console.log(`  ${r.passed ? "✅" : "❌"} TEST ${r.id}: ${r.name}`);
    console.log(`     ${feel} (${time})`);
    if (r.issues?.length > 0) {
      for (const issue of r.issues) console.log(`     ${issue}`);
    }
  }
  console.log(`\n  ${passed}/${allResults.length} passed — ${passed === allResults.length ? "🎉 Clean experience!" : "🔧 Issues to fix"}`);
  console.log("━".repeat(60));
  
  process.exit(passed === allResults.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
