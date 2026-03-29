#!/usr/bin/env node
/**
 * 🦀🏢 HermitCrab Teams Bridge — Option B (Full Bot via M365 Agents SDK)
 * 
 * Features:
 *   ✅ DM and Channel support via Azure Bot Service
 *   ✅ Async responses — no 30s timeout
 *   ✅ Session persistence — one JARVIS session per Teams user/channel
 *   ✅ Conversation history logging
 *   ✅ Security — authorized tenant + optional user whitelist
 *   ✅ Same bridge pattern as Telegram bridge
 * 
 * Architecture:
 *   Teams → Azure Bot Service → POST /api/messages → this bridge
 *   → antigravity-cli (spawns JARVIS session)
 *   → JARVIS responds via curl POST /reply → bridge → Bot Service → Teams
 * 
 * The bridge is a DUMB PIPE + ALARM CLOCK. It does not think.
 * JARVIS (inside Antigravity) is the ONLY brain.
 */

const http = require("http");
const { execFile, exec, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const SessionDoctor = require("../lib/session-doctor");
const { getRecentHistory: _getHistory } = require("../lib/convo-memory");
// Lazy-loaded: ClaudeStreamClient requires @anthropic-ai/claude-agent-sdk
// which may not be installed on all machines (e.g., M4). Defer to avoid crash.
let ClaudeStreamClient = null;
function getClaudeStreamClient() {
  if (!ClaudeStreamClient) {
    try {
      ClaudeStreamClient = require("../lib/claude-stream-client");
    } catch (e) {
      console.error("[BRIDGE] ClaudeStreamClient unavailable:", e.message);
      return null;
    }
  }
  return ClaudeStreamClient;
}

// ClaudeBridge — persistent ACP worker lifecycle manager (v1)
// Lazy-initialized after config constants are defined.
const { ClaudeBridge, isTerminalActive } = require("../lib/claude-bridge");
let claudeBridge = null;
function initClaudeBridge() {
  if (claudeBridge) return claudeBridge;
  try {
    claudeBridge = new ClaudeBridge({
      command: CLAUDE_CLI_PATH,
      cwd: WORKSPACE,
      env: { PATH: `${path.dirname(CLAUDE_CLI_PATH)}:${PATH_ENV}` },
      maxRespawns: 3,
      defaultTimeout: 180000,
      log: (msg) => log("CLAUDE_BRIDGE", { detail: msg }),
    });
    claudeBridge.on("turn_complete", (data) => {
      log("CB_TURN_COMPLETE", { sessionKey: data.sessionKey, status: data.status, chars: data.text?.length || 0, recovered: data.recovered || false });
    });
    claudeBridge.on("worker_failed", (data) => {
      log("CB_WORKER_FAILED", { sessionKey: data.sessionKey, respawns: data.respawns, error: data.error });
    });
    console.log("[BRIDGE] ClaudeBridge initialized");
  } catch (e) {
    console.error("[BRIDGE] ClaudeBridge init failed:", e.message);
  }
  return claudeBridge;
}

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const MICROSOFT_APP_ID = process.env.MICROSOFT_APP_ID || "";
const MICROSOFT_APP_PASSWORD = process.env.MICROSOFT_APP_PASSWORD || "";
const HTTP_PORT = parseInt(process.env.TEAMS_BRIDGE_PORT || "3979", 10);
const REPLY_PORT = parseInt(process.env.TEAMS_REPLY_PORT || "18792", 10);
const WORKSPACE = process.env.HERMITCRAB_WORKSPACE || path.resolve(__dirname, "../..");
const CLI_PATH = process.env.ANTIGRAVITY_CLI || path.join(process.env.HOME, ".local/bin/antigravity-cli");
const BRIDGE_PORT = process.env.ANTIGRAVITY_BRIDGE_PORT || ""; // -p flag for antigravity-cli
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI || "/opt/homebrew/bin/claude"; // Claude Code CLI for Cody
const CLI_MODEL = process.env.HERMITCRAB_MODEL || "gemini-3.1-pro"; // -m flag for antigravity-cli
const CONVO_DIR = path.join(WORKSPACE, "hermitcrab", "teams-conversations");
const UPLOAD_DIR = path.join(WORKSPACE, "hermitcrab", "teams-uploads");
const SESSION_REGISTRY = path.join(WORKSPACE, "hermitcrab", "teams-sessions.json");
const PATH_ENV = `${path.dirname(CLI_PATH)}:${process.env.PATH}`;
const CLAUDE_FALLBACK_MODEL = process.env.CLAUDE_FALLBACK_MODEL || "sonnet"; // Model for fallback sessions
const CLAUDE_FALLBACK_SESSION_FILE = path.join(WORKSPACE, "hermitcrab", "claude-fallback-sessions.json");

// ── SESSION DOCTOR — self-healing session management ──
const doctor = new SessionDoctor({
  workspace: WORKSPACE,
  cliPath: CLI_PATH,
  pathEnv: `${path.dirname(CLI_PATH)}:${process.env.PATH}`,
  log,
  config: {
    cooldownFile: path.join(WORKSPACE, "hermitcrab", "teams-doctor-state.json"),
  },
});
const activeResponseTimers = new Map(); // sessionKey → timer function from Session Doctor

// Machine identity — so the agent always knows which physical machine it's on
const MACHINE_NAME = (() => {
  try { return execSync("scutil --get ComputerName", { encoding: "utf-8" }).trim(); }
  catch { return os.hostname(); }
})();
console.log(`Machine identity: ${MACHINE_NAME}`);

// ═══════════════════════════════════════════
// MULTI-AGENT CONFIG — one bot, many agents
// Each agent needs: persona file, Graph token, self-skip IDs
// Mini is the default handler; others wake on @mention
// ═══════════════════════════════════════════
const AGENTS = {
  mini: {
    name: "Mini",
    isDefault: true, // wakes for ALL messages
    triggers: null, // default = always
    personaFile: path.join(WORKSPACE, "hermitcrab", "personas", "mini.md"),
    graphTokenFile: path.join(WORKSPACE, "hermitcrab", "graph", "tokens.json"), // MiniH (mini@apexlearn.org)
    selfSkipNames: ["minih"],
    selfSkipIds: [
      "29:1uk7ZXsqdg14ywy7MnjF4AtTnRlfGCb9hK8OUxlL9me6I7VskpZpcZe1nHjPcprnqKCywWYv7gx2MALXpOQxlXw", // MiniH Bot Framework ID
    ],
  },
  jarvis: {
    name: "JARVIS",
    isDefault: false,
    triggers: ["jarvis"], // wake when mentioned
    personaFile: path.join(WORKSPACE, "GEMINI.md"),
    graphTokenFile: path.join(WORKSPACE, "hermitcrab", "graph", "tokens-jarvis.json"),
    selfSkipNames: ["jarvis"],
    selfSkipIds: [
      "29:1O4-fwG6GdmiRkffW8MH57Tdnw0W-nMnzJ4D5nBJFf8EaqLuJ-f2m8GRaT9U8bqrl4tbWZAs-RJXRKBtgdOjMJA", // Jarvis Bot Framework ID
    ],
  },
  cody: {
    name: "Cody",
    isDefault: false,
    triggers: ["cody"], // wake when mentioned
    personaFile: path.join(WORKSPACE, "hermitcrab", "personas", "cody.md"),
    graphTokenFile: path.join(WORKSPACE, "hermitcrab", "graph", "tokens-cody.json"), // CodyH (cody@apexlearn.org)
    selfSkipNames: ["codyh", "cody"],
    selfSkipIds: [
      "29:1aPTwl-8Jh7VqbEmrDLg3hKeRA06UUVUFrRxSH8ESM5NHlrZ9NSBEgBYx-vjdAQe7GNQZo8P3tBds2gwkcWlEvQ", // CodyH Bot Framework ID
    ],
    engine: "claude", // Flag: uses ClaudeBridge (ACP) instead of Antigravity
    workspace: path.join(WORKSPACE, "hermitcrab", "cody-workspace"), // CLAUDE.md lives here
    useBridge: true, // Route through ClaudeBridge instead of execFile
  },
};

// Load all agent personas at startup
for (const [key, agent] of Object.entries(AGENTS)) {
  try {
    if (fs.existsSync(agent.personaFile)) {
      agent.personaText = fs.readFileSync(agent.personaFile, "utf-8").trim();
      console.log(`Loaded persona: ${agent.name} (${agent.personaFile})`);
    } else {
      agent.personaText = "";
      console.log(`No persona file found for ${agent.name} at ${agent.personaFile}`);
    }
  } catch (e) {
    agent.personaText = "";
    console.log(`Failed to load persona for ${agent.name}: ${e.message}`);
  }
}

// Build combined self-skip sets from all agents
const ALL_SELF_SKIP_IDS = new Set();
const ALL_SELF_SKIP_NAMES = new Set();
for (const agent of Object.values(AGENTS)) {
  agent.selfSkipIds.forEach(id => ALL_SELF_SKIP_IDS.add(id));
  agent.selfSkipNames.forEach(n => ALL_SELF_SKIP_NAMES.add(n));
}

// Helper: find which agent a self-skip sender belongs to
function findAgentBySender(senderName, senderId) {
  const nameLower = senderName.toLowerCase();
  for (const [key, agent] of Object.entries(AGENTS)) {
    if (agent.selfSkipIds.includes(senderId) || agent.selfSkipNames.includes(nameLower)) {
      return key;
    }
  }
  return null;
}

// Inclusive triggers — phrases that wake ALL agents
const INCLUSIVE_TRIGGERS = [
  "all of you", "both of you", "everyone", "each of you", "all agents",
  "both agents", "y'all", "你们", "大家", "所有人",
  "i want to hear from", "i need all", "what does everyone think",
];

// ═══════════════════════════════════════════
// GROUP CHAT RESTRAINT — Mini shouldn't respond to every message
// In group chats, default agent only responds when:
//   1. Directly @mentioned or name called ("Mini", "mini")
//   2. Message is a direct question (short + question mark)
//   3. Conversation mode is active (debate/discussion)
//   4. Message is a reply/follow-up to Mini's last message
// In DMs (1:1), always respond.
// ═══════════════════════════════════════════
const GROUP_CHAT_PATTERN = /^19:.*@thread/; // Teams group chat conversation IDs
const lastResponder = new Map(); // conversationId → agentKey (who spoke last)

// Known agent groups — groups WHERE diagnostic messages (⏳/🔄) are acceptable.
// All other group chats get SILENT failure + private notification to Tony.
const KNOWN_AGENT_GROUPS = new Set([
  "19:4ec991c00ac44d8498c4b749915b5729@thread.v2", // Group 0 (Tony, Mini, Jarvis, BigH)
]);

function isKnownAgentGroup(conversationId) {
  // DMs are always okay for diagnostics
  if (!GROUP_CHAT_PATTERN.test(conversationId)) return true;
  // Check if the group is in our known list
  return KNOWN_AGENT_GROUPS.has(conversationId);
}

function shouldDefaultAgentRespond(agentKey, text, conversationId) {
  // Always respond in DMs (non-group conversations)
  if (!GROUP_CHAT_PATTERN.test(conversationId)) return true;

  // Always respond if conversation mode is active (debate/discussion)
  if (activeConvModes.has(conversationId)) return true;

  const textLower = text.toLowerCase();
  const agent = AGENTS[agentKey];
  const agentName = (agent?.name || "").toLowerCase();

  // Respond if agent is mentioned by name
  if (agentName && textLower.includes(agentName)) return true;

  // Respond if it looks like a direct question (has ? and is reasonably short)
  const hasQuestion = text.includes("?") || text.includes("？");
  const isShortEnough = text.length < 500; // not a long paste/doc
  if (hasQuestion && isShortEnough) return true;

  // Respond if the last message in this conversation was from this agent
  // (likely a follow-up to something Mini said)
  if (lastResponder.get(conversationId) === agentKey) return true;

  // Respond to commands/instructions directed at the room
  const commandPatterns = [
    /^(please |can you |could you |help |tell |show |explain |check |find |look |search |read |write )/i,
    /^(do |make |create |build |fix |update |set |get |send |run )/i,
    /^(what |where |when |who |how |why |is |are |was |were |do |does |did |can |could |will |would |should )/i,
    /^(hey |hi |hello |yo )/i,
  ];
  if (commandPatterns.some(p => p.test(text.trim()))) return true;

  // Otherwise, stay quiet
  log("RESTRAINT", { agent: agentKey, conversation_id: conversationId, reason: "group chat — no trigger detected", text: text.substring(0, 80) });
  return false;
}

// Helper: determine which agents should wake for a message
function routeMessage(text, conversationId) {
  const textLower = text.toLowerCase();
  const targets = [];

  // Check inclusive triggers first — wake ALL agents
  const isInclusive = INCLUSIVE_TRIGGERS.some(t => textLower.includes(t));
  if (isInclusive) {
    return Object.keys(AGENTS); // everyone wakes
  }

  for (const [key, agent] of Object.entries(AGENTS)) {
    if (agent.isDefault) {
      // In group chats, apply restraint filter
      if (shouldDefaultAgentRespond(key, text, conversationId)) {
        targets.push(key);
      }
    } else if (agent.triggers && agent.triggers.some(t => textLower.includes(t))) {
      targets.push(key);
    }
  }
  return targets;
}

// Backward compat: default persona for existing code
const PERSONA_NAME = "mini";
const PERSONA_TEXT = AGENTS.mini.personaText || "";

// ═══════════════════════════════════════════
// INBOUND DEBOUNCE — batch rapid-fire messages (OpenClaw pattern)
// When users send "Hey" + "can you" + "check the API?" quickly,
// wait 2s for more messages then flush as a single combined prompt.
// ═══════════════════════════════════════════
const DEBOUNCE_MS = 2000; // 2 second debounce window
const debounceTimers = new Map(); // conversationId → { timer, messages: [] }

function debounceInbound(conversationId, messageData, onFlush) {
  let entry = debounceTimers.get(conversationId);
  if (!entry) {
    entry = { timer: null, messages: [] };
    debounceTimers.set(conversationId, entry);
  }
  entry.messages.push(messageData);

  // Reset the timer
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    const batch = entry.messages;
    debounceTimers.delete(conversationId);
    if (batch.length > 1) {
      log("DEBOUNCE_FLUSH", { conversation_id: conversationId, count: batch.length, messages: batch.map(m => m.text.substring(0, 40)) });
    }
    onFlush(batch);
  }, DEBOUNCE_MS);
}

// ═══════════════════════════════════════════
// MESSAGE ENVELOPE — context-rich message formatting (OpenClaw pattern)
// Format: [Teams Tony +3m Wed 2026-03-18 19:30 EDT] message text
// Gives agents timestamp, elapsed time, weekday (models are bad at deriving DOW)
// ═══════════════════════════════════════════
const lastMessageTime = new Map(); // conversationId → Date

function formatEnvelope(senderName, text, conversationId) {
  const now = new Date();
  const lastTime = lastMessageTime.get(conversationId);
  lastMessageTime.set(conversationId, now);

  // Elapsed since last message
  let elapsed = "";
  if (lastTime) {
    const diffMs = now - lastTime;
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) elapsed = "+<1m";
    else if (diffMin < 60) elapsed = `+${diffMin}m`;
    else elapsed = `+${Math.round(diffMin / 60)}h`;
  }

  // Weekday + timestamp
  const weekday = now.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });
  const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/New_York" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" });

  return `[Teams ${senderName} ${elapsed} ${weekday} ${dateStr} ${timeStr} EDT] ${text}`;
}

// ═══════════════════════════════════════════
// CONVERSATION MODE — sustained multi-agent dialogues
// When Tony says "debate 50 rounds", the bridge:
// 1. Tracks round count per participant
// 2. Detects stalls (no response within timeout)
// 3. Auto-nudges stalled external participants
// 4. Stops when target rounds reached
//
// Key insight: BigH runs on OpenClaw (external system).
// Our bridge only controls Mini/Jarvis. BigH picks up messages
// independently. When he stalls, we nudge via Graph API (human account).
//
// KEY INSIGHT: Big's OpenClaw activates when "Big" is mentioned
// in a Graph API message from a human account. Bot Framework messages
// (from apexmini) won't trigger Big. Nudges MUST go through Graph API.
// ═══════════════════════════════════════════
const activeConvModes = new Map(); // conversationId → ConvModeState

const CONV_MODE_STALL_MS = 90000; // 90s — if no response, nudge
const CONV_MODE_MAX_NUDGES = 3; // max nudges via Graph API before pausing

// ── Graph API posting: send as a human user (MiniH by default) ──
const GRAPH_DIR = path.join(WORKSPACE, "hermitcrab", "graph");
const GRAPH_CLIENT_PATH = path.join(GRAPH_DIR, "graph-client.js");

async function postViaGraphAPI(conversationId, text, tokenFile) {
  // Default to MiniH's token (mini@apexlearn.org)
  const tf = tokenFile || AGENTS.mini.graphTokenFile;
  return new Promise((resolve, reject) => {
    const script = `
      process.env.GRAPH_TOKEN_FILE = ${JSON.stringify(tf)};
      const graph = require(${JSON.stringify(GRAPH_CLIENT_PATH)});
      graph.post('/chats/${conversationId}/messages', { 
        body: { contentType: 'text', content: ${JSON.stringify(text)} }
      }).then(r => {
        console.log(r.ok ? 'sent' : 'error:' + JSON.stringify(r.data));
        process.exit(r.ok ? 0 : 1);
      }).catch(e => { console.error(e.message); process.exit(1); });
    `;
    execFile("node", ["-e", script], {
      cwd: WORKSPACE,
      env: { ...process.env, PATH: PATH_ENV },
      timeout: 15000,
    }, (error, stdout, stderr) => {
      if (error) {
        log("GRAPH_POST_ERROR", { error: error.message, stderr });
        reject(error);
      } else {
        log("GRAPH_POST_OK", { conversation_id: conversationId, text: text.substring(0, 80) });
        resolve(stdout.trim());
      }
    });
  });
}

// ── /debate command parser (explicit trigger only) ──
// /debate 10 mini big → start 10-round conv mode with Mini and Big
// /debate stop|end   → end current conv mode
// /debate status      → show current conv mode state
const DEBATE_CMD_PATTERN = /^\/debate\s+(.+)/i;

function parseDebateCommand(text) {
  const match = text.trim().match(DEBATE_CMD_PATTERN);
  if (!match) return null;

  const args = match[1].trim().toLowerCase();

  // /debate stop or /debate end
  if (args === "stop" || args === "end") {
    return { action: "stop" };
  }

  // /debate status
  if (args === "status") {
    return { action: "status" };
  }

  // /debate 10 mini big  or  /debate 10 (defaults to mini + big)
  const roundMatch = args.match(/(\d+)\s*(.*)/);
  if (roundMatch) {
    const rounds = parseInt(roundMatch[1], 10);
    const participantStr = roundMatch[2].trim();
    const participants = [];

    if (participantStr) {
      if (participantStr.includes("mini")) participants.push("MiniH");
      if (participantStr.includes("big")) participants.push("BigH");
      if (participantStr.includes("jarvis")) participants.push("Jarvis");
      if (participantStr.includes("cody")) participants.push("CodyH");
    }

    // Default to MiniH + BigH if no participants specified or < 2
    if (participants.length < 2) {
      if (!participants.includes("MiniH")) participants.push("MiniH");
      if (!participants.includes("BigH")) participants.push("BigH");
    }

    return { action: "start", rounds, participants };
  }

  return null;
}

// Auto-detect debate intent from natural language (requires confirmation)
const CONV_MODE_PATTERNS = [
  /(\d+)\s*rounds?\b/i,
  /debate\s+(\d+)/i,
  /discuss\s+(\d+)/i,
];

function detectDebateIntent(text) {
  // Don't match /debate commands (those are explicit)
  if (text.trim().startsWith("/debate")) return null;
  for (const pattern of CONV_MODE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

// Pending debate confirmations — waiting for user to confirm via button
const pendingDebateConfirm = new Map(); // conversationId → { rounds, participants, serviceUrl, expiresAt }

function startConvMode(conversationId, targetRounds, topic, participants, serviceUrl) {
  // participants: array of display names (e.g. ["MiniH", "BigH"]) — preserve casing!
  const displayNames = new Map(); // lowercase → original casing
  for (const p of participants) {
    displayNames.set(p.toLowerCase(), p);
  }

  const state = {
    conversationId,
    targetRounds,
    topic,
    participants: new Set(participants.map(p => p.toLowerCase())), // lowercase for matching
    displayNames, // lowercase → original for display
    rounds: new Map(), // lowercase name → count
    totalExchanges: 0,
    lastSpeaker: null,
    lastMessage: null, // store last message content for context in nudges
    lastActivityTime: Date.now(),
    stallTimer: null,
    nudgeCount: 0,
    serviceUrl,
    active: true,
  };

  // Initialize round counters
  for (const p of state.participants) {
    state.rounds.set(p, 0);
  }

  activeConvModes.set(conversationId, state);
  resetStallTimer(conversationId);
  log("CONV_MODE_START", { conversation_id: conversationId, target_rounds: targetRounds, participants: [...displayNames.values()] });
  return state;
}

function recordConvModeActivity(conversationId, speakerName, messageText) {
  const state = activeConvModes.get(conversationId);
  if (!state || !state.active) return null;

  const speaker = speakerName.toLowerCase();
  if (!state.participants.has(speaker)) return state; // not a tracked participant

  // Update display name if we see the actual casing
  if (!state.displayNames.has(speaker)) {
    state.displayNames.set(speaker, speakerName);
  }

  state.rounds.set(speaker, (state.rounds.get(speaker) || 0) + 1);
  state.totalExchanges++;
  state.lastSpeaker = speaker;
  state.lastMessage = messageText ? messageText.substring(0, 300) : null;
  state.lastActivityTime = Date.now();
  state.nudgeCount = 0; // reset nudge counter on activity

  // Check if target reached
  const minRounds = Math.min(...[...state.rounds.values()]);
  const roundsDisplay = {};
  for (const [k, v] of state.rounds) {
    roundsDisplay[state.displayNames.get(k) || k] = v;
  }
  log("CONV_MODE_ROUND", {
    conversation_id: conversationId,
    speaker: state.displayNames.get(speaker) || speaker,
    rounds: roundsDisplay,
    total: state.totalExchanges,
    min_rounds: minRounds,
    target: state.targetRounds
  });

  if (minRounds >= state.targetRounds) {
    endConvMode(conversationId, "target_reached");
    return null; // signal completion
  }

  resetStallTimer(conversationId);
  return state;
}

function resetStallTimer(conversationId) {
  const state = activeConvModes.get(conversationId);
  if (!state || !state.active) return;

  if (state.stallTimer) clearTimeout(state.stallTimer);
  state.stallTimer = setTimeout(() => {
    handleConvModeStall(conversationId);
  }, CONV_MODE_STALL_MS);
}

async function handleConvModeStall(conversationId) {
  const state = activeConvModes.get(conversationId);
  if (!state || !state.active) return;

  // Who hasn't spoken? The person who HASN'T spoken most recently is the stalled one.
  const lastSpeaker = state.lastSpeaker;
  const stalledParticipants = [...state.participants]
    .filter(p => p !== lastSpeaker)
    .map(p => state.displayNames.get(p) || p); // use proper display names

  // Map display names to trigger names (BigH → Big, MiniH → Mini)
  // Big's OpenClaw activates on "Big", not "BigH"
  const triggerNames = stalledParticipants.map(p => p.replace(/H$/i, ""));

  const lastSpeakerDisplay = state.displayNames.get(lastSpeaker) || lastSpeaker;

  state.nudgeCount++;

  if (state.nudgeCount > CONV_MODE_MAX_NUDGES) {
    const roundsDisplay = {};
    for (const [k, v] of state.rounds) {
      roundsDisplay[state.displayNames.get(k) || k] = v;
    }
    endConvMode(conversationId, "max_nudges_exceeded");
    try {
      await postViaGraphAPI(conversationId,
        `⏸️ Conversation paused — ${triggerNames.join(", ")} didn't respond after ${CONV_MODE_MAX_NUDGES} nudges. Rounds completed: ${JSON.stringify(roundsDisplay)}/${state.targetRounds}`);
    } catch (_) { }
    return;
  }

  log("CONV_MODE_STALL", {
    conversation_id: conversationId,
    stalled: stalledParticipants,
    trigger_names: triggerNames,
    nudge_count: state.nudgeCount,
    last_speaker: lastSpeakerDisplay
  });

  // Build context from last message (only if it's real content, not a nudge)
  const currentRound = Math.min(...[...state.rounds.values()]) + 1;
  const isLastMsgNudge = state.lastMessage && /your turn!.*Round \d+/i.test(state.lastMessage);
  let lastMessageContext = "";
  if (state.lastMessage && !isLastMsgNudge) {
    const preview = state.lastMessage.substring(0, 200) + (state.lastMessage.length > 200 ? "..." : "");
    lastMessageContext = `\n\n${lastSpeakerDisplay} said:\n> ${preview}`;
  }

  // Split stalled participants into OUR agents vs EXTERNAL participants
  // Our agents: wake directly via bridge (no self-nudge)
  // External: nudge via Graph API (e.g., BigH on OpenClaw)
  const ownAgentNames = new Set(Object.values(AGENTS).map(a => a.name.toLowerCase()));
  const externalStalled = [];
  const internalStalled = [];

  for (const displayName of stalledParticipants) {
    const baseName = displayName.replace(/H$/i, "").toLowerCase();
    if (ownAgentNames.has(baseName)) {
      internalStalled.push(displayName);
    } else {
      externalStalled.push(displayName);
    }
  }

  // Wake our own agents directly — compose a proper conversation prompt
  for (const displayName of internalStalled) {
    const baseName = displayName.replace(/H$/i, "").toLowerCase();
    const agentKey = Object.keys(AGENTS).find(k => AGENTS[k].name.toLowerCase() === baseName);
    if (agentKey) {
      const wakeText = `[Conversation Mode — it's your turn to respond, Round ${currentRound}/${state.targetRounds}]${lastMessageContext}\n\nContinue the conversation. Respond with your perspective.`;
      log("CONV_MODE_WAKE_INTERNAL", { agent: agentKey, conversation_id: conversationId, round: currentRound });
      const sKey = sessionKey(conversationId, agentKey);
      busySessions.set(sKey, { busy: true, queue: [] });
      startTyping(state.serviceUrl, conversationId);
      startReplyWatchdog(sKey, state.serviceUrl);
      await wakeAgent(agentKey, conversationId, lastSpeakerDisplay, wakeText, state.serviceUrl);
    }
  }

  // Nudge external participants via Graph API (e.g., BigH needs to see his name to activate)
  if (externalStalled.length > 0) {
    const externalTriggerNames = externalStalled.map(p => p.replace(/H$/i, ""));
    let nudgeText = `${externalTriggerNames.join(", ")}, your turn! Round ${currentRound}/${state.targetRounds}.${lastMessageContext}`;

    try {
      await postViaGraphAPI(conversationId, nudgeText);
    } catch (e) {
      log("CONV_MODE_NUDGE_ERROR", { error: e.message });
      try { await sendToTeams(state.serviceUrl, conversationId, nudgeText); } catch (_) { }
    }
  }

  resetStallTimer(conversationId);
}

function endConvMode(conversationId, reason) {
  const state = activeConvModes.get(conversationId);
  if (!state) return;

  if (state.stallTimer) clearTimeout(state.stallTimer);
  state.active = false;
  activeConvModes.delete(conversationId);

  const roundsDisplay = {};
  for (const [k, v] of state.rounds) {
    roundsDisplay[state.displayNames.get(k) || k] = v;
  }
  log("CONV_MODE_END", {
    conversation_id: conversationId,
    reason,
    rounds: roundsDisplay,
    total_exchanges: state.totalExchanges
  });

  if (reason === "target_reached") {
    postViaGraphAPI(conversationId,
      `🏁 Conversation complete! ${state.targetRounds} rounds reached. Final count: ${JSON.stringify(roundsDisplay)}`
    ).catch(() => { });
  }
}

// Security
const AUTHORIZED_TENANT_ID = process.env.AUTHORIZED_TENANT_ID || ""; // ApexLearn tenant
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "15", 10);
const rateLimitMap = new Map();

// ── QUOTA & FALLBACK STRATEGY ──
// SessionDoctor handles proactive quota checks via quota.js (LS RPC).
// These constants are used by the reactive fallback path (catch-block).
const FALLBACK_MODEL = "gemini-3.1-pro";

// ═══════════════════════════════════════════
// ANTIGRAVITY HEALTH MONITOR — Phase 1
// Probes the Antigravity IDE via CLI to detect crashes.
// Caches result for 30s to avoid hammering the CLI.
// ═══════════════════════════════════════════
let antigravityHealthCache = { alive: null, lastCheck: 0, error: null, consecutiveFailures: 0 };
const AG_HEALTH_CACHE_MS = 30000; // cache health for 30s
const AG_HEALTH_TIMEOUT_MS = 5000; // 5s timeout for health check

async function isAntigravityAlive() {
  const now = Date.now();
  if (antigravityHealthCache.alive !== null && (now - antigravityHealthCache.lastCheck) < AG_HEALTH_CACHE_MS) {
    return antigravityHealthCache;
  }

  return new Promise((resolve) => {
    const portArgs = BRIDGE_PORT ? ["-p", BRIDGE_PORT] : [];
    execFile(CLI_PATH, [...portArgs, "server", "status"], {
      timeout: AG_HEALTH_TIMEOUT_MS,
      env: { ...process.env, PATH: PATH_ENV },
    }, (error, stdout, stderr) => {
      if (error) {
        antigravityHealthCache.consecutiveFailures++;
        antigravityHealthCache.alive = false;
        antigravityHealthCache.lastCheck = now;
        antigravityHealthCache.error = error.message;
        log("AG_HEALTH_DOWN", { error: error.message, failures: antigravityHealthCache.consecutiveFailures });
        resolve(antigravityHealthCache);
      } else {
        if (antigravityHealthCache.consecutiveFailures > 0) {
          log("AG_HEALTH_RECOVERED", { after_failures: antigravityHealthCache.consecutiveFailures });
        }
        antigravityHealthCache.consecutiveFailures = 0;
        antigravityHealthCache.alive = true;
        antigravityHealthCache.lastCheck = now;
        antigravityHealthCache.error = null;
        resolve(antigravityHealthCache);
      }
    });
  });
}

// ═══════════════════════════════════════════
// CLAUDE STREAM FALLBACK POOL — Phase 3
// Persistent Claude Code sessions for each agent.
// Each agent gets a long-lived subprocess that survives
// across multiple messages. If it dies, it auto-respawns.
// ═══════════════════════════════════════════
const claudeFallbackPool = new Map(); // agentKey → ClaudeStreamClient
const claudeFallbackSessions = (() => {
  try {
    if (fs.existsSync(CLAUDE_FALLBACK_SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(CLAUDE_FALLBACK_SESSION_FILE, "utf-8"));
    }
  } catch (e) {
    log("FALLBACK_SESSION_LOAD_ERROR", { error: e.message });
  }
  return {};
})();

function saveFallbackSessions() {
  try {
    fs.writeFileSync(CLAUDE_FALLBACK_SESSION_FILE, JSON.stringify(claudeFallbackSessions, null, 2));
  } catch (e) {
    log("FALLBACK_SESSION_SAVE_ERROR", { error: e.message });
  }
}

function getOrCreateFallbackClient(agentKey) {
  let client = claudeFallbackPool.get(agentKey);
  if (client && client.isAlive()) {
    return client;
  }

  const agent = AGENTS[agentKey];
  if (!agent) return null;

  // Write the agent's persona to a temp file for --system-prompt-file
  const tmpDir = path.join(os.tmpdir(), "hermitcrab-fallback");
  fs.mkdirSync(tmpDir, { recursive: true });
  const personaFile = path.join(tmpDir, `persona-${agentKey}.txt`);

  const systemPrompt = [
    agent.personaText || "",
    "",
    "--- FALLBACK MODE ---",
    `You are ${agent.name}, running in FALLBACK MODE via Claude Code because Antigravity is temporarily unavailable.`,
    `You are connected to Microsoft Teams via the HermitCrab bridge.`,
    `🖥️ Running on: ${MACHINE_NAME}`,
    "",
    "IMPORTANT: Respond directly with your message text. Do NOT run any Graph API commands or curl commands.",
    "The bridge will post your response to Teams automatically.",
    "Keep responses concise — this is workplace chat.",
    "--- END FALLBACK MODE ---",
  ].filter(line => line !== undefined).join("\n");
  fs.writeFileSync(personaFile, systemPrompt);

  // Resume existing session if we have one
  const existingSessionId = claudeFallbackSessions[agentKey]?.sessionId || null;

  const CSC = getClaudeStreamClient();
  if (!CSC) {
    log("FALLBACK_UNAVAILABLE", { agent: agentKey, reason: "ClaudeStreamClient module not installed" });
    return null;
  }

  client = new CSC({
    workspace: agent.workspace || WORKSPACE,
    model: CLAUDE_FALLBACK_MODEL,
    systemPrompt: systemPrompt,
    sessionId: existingSessionId,
    addDirs: agent.workspace && agent.workspace !== WORKSPACE ? [WORKSPACE] : [],
    permissionMode: "default",
    allowedTools: ["Read", "Bash(git log:*)", "Bash(cat:*)", "Bash(ls:*)", "Bash(find:*)", "Bash(grep:*)"],
    log,
  });

  // Track session ID when captured
  client.on("session_id", (sessionId) => {
    claudeFallbackSessions[agentKey] = {
      sessionId,
      lastActive: new Date().toISOString(),
      agentName: agent.name,
    };
    saveFallbackSessions();
    log("FALLBACK_SESSION_CAPTURED", { agent: agentKey, session_id: sessionId });
  });

  client.on("exit", ({ code, signal }) => {
    log("FALLBACK_PROCESS_EXIT", { agent: agentKey, code, signal });
    claudeFallbackPool.delete(agentKey);
  });

  claudeFallbackPool.set(agentKey, client);
  log("FALLBACK_CLIENT_CREATED", { agent: agentKey, model: CLAUDE_FALLBACK_MODEL, session_id: existingSessionId || "(new)" });
  return client;
}

/**
 * Wake an agent via Claude Code fallback (persistent stream session).
 * Used when Antigravity is down or its CLI fails.
 */
async function wakeAgentFallback(agentKey, conversationId, senderName, text, serviceUrl) {
  const agent = AGENTS[agentKey];
  if (!agent) { log("FALLBACK_WAKE_ERROR", { error: `Unknown agent: ${agentKey}` }); return; }

  const sKey = sessionKey(conversationId, agentKey);

  log("FALLBACK_WAKE", { agent: agentKey, conversation_id: conversationId, sender: senderName });

  // Get or create a persistent Claude stream client for this agent
  const client = getOrCreateFallbackClient(agentKey);
  if (!client) {
    log("FALLBACK_NO_CLIENT", { agent: agentKey });
    if (isKnownAgentGroup(conversationId)) {
      sendToTeams(serviceUrl, conversationId, `⚠️ ${agent.name} is unavailable (both Antigravity and fallback failed).`).catch(() => {});
    }
    return;
  }

  // Build the message with context
  const historyBlock = getRecentHistory(conversationId);
  const envelope = formatEnvelope(senderName, text, conversationId);
  const fullMessage = historyBlock
    ? `${historyBlock}\n${envelope}`
    : envelope;

  try {
    startTyping(serviceUrl, conversationId);
    startReplyWatchdog(sKey, serviceUrl);

    const result = await client.sendMessage(fullMessage, 120000);

    if (result.text) {
      await humanDelay();
      await postViaGraphAPI(conversationId, result.text, agent.graphTokenFile);
      log("FALLBACK_WAKE_OK", {
        agent: agentKey,
        conversation_id: conversationId,
        response_length: result.text.length,
        session_id: result.sessionId || "unknown",
        status: result.status,
        cost_usd: result.costUsd,
      });
      lastResponder.set(conversationId, agentKey);
    } else {
      log("FALLBACK_WAKE_EMPTY", { agent: agentKey });
    }
  } catch (fallbackError) {
    log("FALLBACK_WAKE_ERROR", { agent: agentKey, error: fallbackError.message });

    // Stream client died — remove it so next attempt creates a fresh one
    claudeFallbackPool.delete(agentKey);

    exec(`curl -s -d "⚠️ ${agent.name} fallback also failed: ${fallbackError.message.substring(0, 80)}" ntfy.sh/tonysM5`);
    if (isKnownAgentGroup(conversationId)) {
      sendToTeams(serviceUrl, conversationId, `⚠️ ${agent.name} is unavailable right now (Antigravity down + fallback failed). Try again shortly.`).catch(() => {});
    }
  } finally {
    disarmWatchdog(sKey);
    sealTyping(conversationId);
    const session = busySessions.get(sKey);
    const queued = session?.queue || [];
    busySessions.delete(sKey);
    if (queued.length > 0) {
      drainCollect(agentKey, conversationId, queued, serviceUrl);
    }
  }
}

// ═══════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════
if (!MICROSOFT_APP_ID || !MICROSOFT_APP_PASSWORD) {
  console.error("Error: MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD are required.");
  console.error("Set these from your Azure AD Bot registration.");
  process.exit(1);
}

fs.mkdirSync(CONVO_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ═══════════════════════════════════════════
// BOT FRAMEWORK AUTH — validate incoming JWT
// ═══════════════════════════════════════════
const https = require("https");

// Cache for OpenID metadata + signing keys
let signingKeysCache = null;
let signingKeysCacheExpiry = 0;

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// Get an app-only token to send proactive messages
let appTokenCache = null;
let appTokenExpiry = 0;

async function getAppToken() {
  if (appTokenCache && Date.now() < appTokenExpiry) return appTokenCache;

  // Try multiple token endpoints — tenant-specific first, then multi-tenant fallback
  const tokenPaths = [
    AUTHORIZED_TENANT_ID ? `/${AUTHORIZED_TENANT_ID}/oauth2/v2.0/token` : null,
    "/botframework.com/oauth2/v2.0/token",
  ].filter(Boolean);

  let lastError = null;
  for (const tokenPath of tokenPaths) {
    try {
      const token = await requestToken(tokenPath);
      if (token) return token;
    } catch (e) {
      lastError = e;
      log("TOKEN_RETRY", { path: tokenPath, error: e.message });
    }
  }
  throw lastError || new Error("Failed to get app token");
}

function requestToken(tokenPath) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: MICROSOFT_APP_ID,
      client_secret: MICROSOFT_APP_PASSWORD,
      scope: "https://api.botframework.com/.default"
    }).toString();

    const req = https.request({
      hostname: "login.microsoftonline.com",
      path: tokenPath,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            appTokenCache = json.access_token;
            appTokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
            log("TOKEN_OK", { path: tokenPath });
            resolve(appTokenCache);
          } else {
            reject(new Error(`Token response: ${JSON.stringify(json)}`));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════
// ADAPTIVE CARD — quick-reply buttons
// ═══════════════════════════════════════════
// Pattern: [buttons: Yes | No | Maybe]
// Extracts buttons and renders an Adaptive Card with tappable actions
function parseButtons(text) {
  const match = text.match(/\[buttons:\s*(.+?)\]/i);
  if (!match) return null;
  const labels = match[1].split("|").map(s => s.trim()).filter(Boolean);
  if (labels.length === 0) return null;
  const cleanText = text.replace(/\[buttons:\s*.+?\]/i, "").trim();
  return { cleanText, labels };
}

function buildAdaptiveCard(text, buttonLabels) {
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.3",
        body: [{
          type: "TextBlock",
          text: text,
          wrap: true,
          size: "Default"
        }],
        actions: buttonLabels.map(label => ({
          type: "Action.Submit",
          title: label,
          data: { quickReply: label }
        }))
      }
    }]
  };
}

// Track sent card activity IDs for updates
const sentCards = new Map(); // conversationId -> { activityId, originalText }

// Message deduplication (Teams can deliver the same message twice in group chats)
const recentActivityIds = new Map(); // activityId -> timestamp

// Busy tracking — prevent session contention
const busySessions = new Map(); // sessionKey (conversationId or conversationId::agent) -> { busy: true, queue: [] }

// Clean text for Teams — strip any HTML tags, keep pure markdown
// (Bot Framework only supports textFormat: markdown, plain, xml — NOT html)
function cleanForTeams(text) {
  if (!/<[a-z][\s\S]*>/i.test(text)) return text; // No HTML tags, pass through

  let clean = text;
  // Convert common HTML to markdown equivalents
  clean = clean.replace(/<br\s*\/?>/gi, "\n");
  clean = clean.replace(/<b>([\s\S]*?)<\/b>/gi, "**$1**");
  clean = clean.replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**");
  clean = clean.replace(/<i>([\s\S]*?)<\/i>/gi, "*$1*");
  clean = clean.replace(/<em>([\s\S]*?)<\/em>/gi, "*$1*");
  clean = clean.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  clean = clean.replace(/<pre>([\s\S]*?)<\/pre>/gi, "```\n$1\n```");
  clean = clean.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  clean = clean.replace(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, "**$1**\n");
  clean = clean.replace(/<li>([\s\S]*?)<\/li>/gi, "• $1\n");
  clean = clean.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n");
  clean = clean.replace(/<[^>]+>/g, ""); // Strip all remaining HTML tags
  clean = clean.replace(/\n{3,}/g, "\n\n");
  return clean.trim();
}

// Ensure serviceUrl ends with / so relative URL construction preserves the base path
function normalizeServiceUrl(sUrl) {
  return sUrl.endsWith('/') ? sUrl : sUrl + '/';
}

// Send a message back to Teams via Bot Framework REST API
async function sendToTeams(serviceUrl, conversationId, text) {
  const token = await getAppToken();
  const url = new URL(`v3/conversations/${conversationId}/activities`, normalizeServiceUrl(serviceUrl));

  // Check for button pattern
  const parsed = parseButtons(text);
  let payload;
  if (parsed) {
    payload = buildAdaptiveCard(parsed.cleanText, parsed.labels);
    log("CARD", { buttons: parsed.labels, text: parsed.cleanText.substring(0, 60) });
  } else {
    // Strip any HTML, keep pure markdown for Teams rendering
    const cleanText = cleanForTeams(text);
    payload = { type: "message", textFormat: "markdown", text: cleanText };
  }

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const result = JSON.parse(data || "{}");
          // Store card activity ID for later updates
          if (parsed && result.id) {
            sentCards.set(conversationId, { activityId: result.id, originalText: parsed.cleanText });
            log("CARD_STORED", { activityId: result.id });
          }
          resolve(result);
        } else {
          reject(new Error(`Bot Framework API ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Update an existing activity (used to replace cards after button click)
async function updateActivity(serviceUrl, conversationId, activityId, newPayload) {
  try {
    const token = await getAppToken();
    const url = new URL(`v3/conversations/${conversationId}/activities/${activityId}`, normalizeServiceUrl(serviceUrl));
    const body = JSON.stringify(newPayload);

    log("UPDATE_CARD", { activityId, conversationId: conversationId.substring(0, 20) });

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log("UPDATE_OK", { activityId });
        } else {
          log("UPDATE_FAIL", { status: res.statusCode, body: data.substring(0, 200) });
        }
      });
    });
    req.on("error", (e) => log("UPDATE_ERR", { error: e.message }));
    req.write(body);
    req.end();
  } catch (e) { log("UPDATE_ERR", { error: e.message }); }
}

// Send typing indicator to Teams
async function sendTyping(serviceUrl, conversationId) {
  try {
    const token = await getAppToken();
    const url = new URL(`v3/conversations/${conversationId}/activities`, normalizeServiceUrl(serviceUrl));

    const body = JSON.stringify({ type: "typing" });

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, () => { });
    req.on("error", () => { });
    req.write(body);
    req.end();
  } catch (_) { }
}

// ═══════════════════════════════════════════
// TYPING STATE MACHINE (OpenClaw pattern)
// States: inactive → active → sealed
// - active: keepalive loop sends typing every 3s
// - sealed: once stopped, late callbacks can't restart it
// - TTL: auto-stops after 2 minutes even if run hangs
// - Two-phase: markRunComplete → markDispatchIdle → stop
// ═══════════════════════════════════════════
const typingStates = new Map(); // conversationId → { state, interval, ttlTimer, serviceUrl }
const TYPING_TTL_MS = 2 * 60 * 1000; // 2 minute TTL — auto-stop if run hangs
const TYPING_KEEPALIVE_MS = 3000; // Teams typing lasts ~3s, send every 3s

function startTyping(serviceUrl, conversationId) {
  const existing = typingStates.get(conversationId);
  // If sealed, don't restart — that conversation's typing phase is over
  if (existing?.state === "sealed") {
    log("TYPING_BLOCKED", { conversation_id: conversationId, reason: "sealed" });
    return;
  }
  // If already active, just keep going
  if (existing?.state === "active") return;

  // Start fresh
  sendTyping(serviceUrl, conversationId);
  const interval = setInterval(() => {
    sendTyping(serviceUrl, conversationId);
  }, TYPING_KEEPALIVE_MS);

  // TTL: auto-stop after 2 minutes no matter what
  const ttlTimer = setTimeout(() => {
    log("TYPING_TTL", { conversation_id: conversationId, reason: "TTL expired after 2 min" });
    sealTyping(conversationId);
  }, TYPING_TTL_MS);

  typingStates.set(conversationId, { state: "active", interval, ttlTimer, serviceUrl });
}

function stopTyping(conversationId) {
  const entry = typingStates.get(conversationId);
  if (!entry) return;
  if (entry.interval) clearInterval(entry.interval);
  if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
  typingStates.delete(conversationId);
  log("TYPING_STOP", { conversation_id: conversationId, reason: "all agents done" });
}

function sealTyping(conversationId) {
  // Stop the indicator AND prevent any late restart
  const entry = typingStates.get(conversationId);
  if (entry?.interval) clearInterval(entry.interval);
  if (entry?.ttlTimer) clearTimeout(entry.ttlTimer);
  typingStates.set(conversationId, { state: "sealed", interval: null, ttlTimer: null, serviceUrl: entry?.serviceUrl });
  log("TYPING_SEALED", { conversation_id: conversationId });
  // Auto-unseal after 10s (allow new conversations to start typing again)
  setTimeout(() => {
    const current = typingStates.get(conversationId);
    if (current?.state === "sealed") {
      typingStates.delete(conversationId);
    }
  }, 10000);
}

// ═══════════════════════════════════════════
// REPLY WATCHDOG — armable, touchable (OpenClaw pattern)
// - arm(): start watching for stalls
// - touch(): reset timer on partial progress (streaming, tool output)
// - disarm(): reply arrived, stop watching
// ═══════════════════════════════════════════
const replyWatchdogs = new Map();
const REPLY_TIMEOUT_MS = 180000; // 3 minutes
const interruptedSessions = new Set(); // track sessions that were intentionally interrupted (suppress ⏳)

function startReplyWatchdog(sKey, serviceUrl) {
  const existing = replyWatchdogs.get(sKey);
  if (existing) clearTimeout(existing.timer);

  const createTimer = () => setTimeout(async () => {
    replyWatchdogs.delete(sKey);
    // Extract conversationId from session key
    const conversationId = sKey.includes("::") ? sKey.split("::")[0] : sKey;
    log("WATCHDOG", { conversation_id: conversationId, session_key: sKey, action: "timeout", seconds: REPLY_TIMEOUT_MS / 1000 });
    sealTyping(conversationId); // seal, don't just stop

    // Record failure with Session Doctor
    doctor.recordFailure(sKey, "timeout", "Watchdog fired — no reply within " + (REPLY_TIMEOUT_MS / 1000) + "s");

    // Check if doctor recommends rotation
    const health = doctor.checkHealth(sKey);

    // Determine if this is a group where we can show diagnostic messages
    const canShowDiagnostics = isKnownAgentGroup(conversationId);

    // Suppress ⏳ message if this session was intentionally interrupted (it's being re-woken)
    if (!interruptedSessions.has(sKey)) {
      // AUTO-HEALING PATCH: Aggressively purge locked session ID from cache on timeout 
      // instead of conditionally waiting for doctor.checkHealth(sKey) to recommend rotation.
      log("WATCHDOG_ROTATE", { session_key: sKey, reason: "forced_timeout_purge_auto_healing" });
      const registry = loadSessionRegistry();
      delete registry[sKey];
      saveSessionRegistry(registry);
      doctor.recordRotation(sKey);

      if (canShowDiagnostics) {
        // Known agent groups + DMs: show diagnostic message
        try {
          const msg = health.action === "rotate"
            ? "🔄 Session was unresponsive — refreshed. Send your message again."
            : "⏳ That's taking longer than expected. I'm still working on it — you can send another message in the meantime.";
          await sendToTeams(serviceUrl, conversationId, msg);
        } catch (_) { }
      } else {
        // Unknown groups: SILENT failure — notify Tony privately instead
        log("WATCHDOG_SILENT", { conversation_id: conversationId, reason: "not a known agent group — suppressing diagnostic message" });
        exec(`curl -s -d "⏳ Teams watchdog: session ${sKey.substring(0, 30)}... timed out in external group. Doctor: ${health.action}" ntfy.sh/tonysM5`);
      }
    } else {
      log("WATCHDOG", { conversation_id: conversationId, session_key: sKey, action: "suppressed_post_interrupt" });
      interruptedSessions.delete(sKey);
    }
    busySessions.delete(sKey);
    log("WATCHDOG", { conversation_id: conversationId, action: "busy_cleared", doctor_action: health.action, silent: !canShowDiagnostics });
  }, REPLY_TIMEOUT_MS);

  replyWatchdogs.set(sKey, { timer: createTimer(), serviceUrl, createTimer });
}

// Touch: reset the watchdog timer (called on partial progress)
function touchWatchdog(sessionKey) {
  const existing = replyWatchdogs.get(sessionKey);
  if (!existing) return;
  clearTimeout(existing.timer);
  existing.timer = existing.createTimer();
  log("WATCHDOG_TOUCH", { session_key: sessionKey });
}

function disarmWatchdog(sessionKey) {
  const existing = replyWatchdogs.get(sessionKey);
  if (existing) {
    clearTimeout(existing.timer);
    replyWatchdogs.delete(sessionKey);
  }
  interruptedSessions.delete(sessionKey); // cleanup
}

// ═══════════════════════════════════════════
// HUMAN-LIKE DELAY (OpenClaw pattern)
// Random pause before sending reply — instant responses feel robotic
// ═══════════════════════════════════════════
const HUMAN_DELAY_MIN_MS = 500;
const HUMAN_DELAY_MAX_MS = 1500;

function humanDelay() {
  const ms = Math.floor(Math.random() * (HUMAN_DELAY_MAX_MS - HUMAN_DELAY_MIN_MS + 1)) + HUMAN_DELAY_MIN_MS;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════
// COLLECT QUEUE DRAIN (OpenClaw pattern)
// When agent finishes, ALL queued messages are batched into ONE prompt.
// Much smarter than one-at-a-time drain — agent sees full picture.
//
// Format:
//   [Queued messages while you were busy]
//   ---
//   Queued #1
//   [Teams Tony +3m Wed 03/18/2026 19:30 EDT] Hey check the API
//   ---
//   Queued #2
//   [Teams Tony +5m Wed 03/18/2026 19:32 EDT] Actually found it
// ═══════════════════════════════════════════
async function drainCollect(agentKey, conversationId, queuedMessages, serviceUrl) {
  if (!queuedMessages || queuedMessages.length === 0) return;

  // ── GROUP CHAT RESTRAINT: filter queued messages before waking ──
  // The queue collects ALL messages while the agent was busy, but not all
  // of them warrant a response (e.g. BigH replies that don't mention Mini).
  // Apply the same restraint filter that inbound messages go through.
  const agent = AGENTS[agentKey];
  if (agent?.isDefault && GROUP_CHAT_PATTERN.test(conversationId)) {
    // Extract raw text from the last queued message (most recent = most relevant)
    // The fullMessage is envelope-formatted, extract the text after the ] bracket
    const lastMsg = queuedMessages[queuedMessages.length - 1];
    const rawText = lastMsg.fullMessage.replace(/^\[.*?\]\s*/, ""); // strip envelope

    if (!shouldDefaultAgentRespond(agentKey, rawText, conversationId)) {
      log("COLLECT_DRAIN_RESTRAINED", {
        agent: agentKey,
        conversation_id: conversationId,
        count: queuedMessages.length,
        messages: queuedMessages.map(m => m.fullMessage.substring(0, 40)),
        reason: "group chat restraint — queued messages don't warrant response"
      });
      return; // drop silently — don't wake the agent
    }
  }

  // Batch ALL queued messages into one prompt
  const batchedParts = queuedMessages.map((msg, i) => {
    return `Queued #${i + 1}\n${msg.fullMessage}`;
  });

  const collectPrompt = `[Queued messages while you were busy]\n---\n${batchedParts.join("\n---\n")}`;
  const senderName = queuedMessages[queuedMessages.length - 1].senderName; // use latest sender

  log("COLLECT_DRAIN", {
    agent: agentKey,
    conversation_id: conversationId,
    count: queuedMessages.length,
    messages: queuedMessages.map(m => m.fullMessage.substring(0, 40))
  });

  const sKey = sessionKey(conversationId, agentKey);
  busySessions.set(sKey, { busy: true, queue: [] }); // busy again, empty queue
  startTyping(serviceUrl, conversationId);
  startReplyWatchdog(sKey, serviceUrl);
  if (agent?.engine === "claude") {
    await wakeAgentClaude(agentKey, conversationId, senderName, collectPrompt, serviceUrl);
  } else {
    await wakeAgent(agentKey, conversationId, senderName, collectPrompt, serviceUrl);
  }
}

// ═══════════════════════════════════════════
// SESSION REGISTRY — one session per conversation per agent
// Stores { uuid, serviceUrl } per sessionKey (conversationId or conversationId::agent)
// Backward compat: old format was just a string UUID
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

function getSessionEntry(conversationId) {
  const registry = loadSessionRegistry();
  const entry = registry[conversationId];
  if (!entry) return null;
  // Backward compat: old format was just a UUID string
  if (typeof entry === "string") return { uuid: entry, serviceUrl: null };
  return entry;
}

function getSessionUUID(conversationId) {
  const entry = getSessionEntry(conversationId);
  return entry?.uuid || null;
}

function getPersistedServiceUrl(conversationId) {
  const entry = getSessionEntry(conversationId);
  return entry?.serviceUrl || null;
}

function setSessionUUID(conversationId, uuid) {
  const registry = loadSessionRegistry();
  const existing = registry[conversationId];
  const serviceUrl = (typeof existing === "object" && existing?.serviceUrl) || null;
  registry[conversationId] = { uuid, serviceUrl };
  saveSessionRegistry(registry);
  log("SESSION", { conversation_id: conversationId, uuid, event: "registered" });
}

function setServiceUrl(conversationId, serviceUrl) {
  const registry = loadSessionRegistry();
  const existing = registry[conversationId];
  if (typeof existing === "object") {
    existing.serviceUrl = serviceUrl;
    registry[conversationId] = existing;
  } else if (typeof existing === "string") {
    registry[conversationId] = { uuid: existing, serviceUrl };
  } else {
    registry[conversationId] = { uuid: null, serviceUrl };
  }
  saveSessionRegistry(registry);
}

// ═══════════════════════════════════════════
// CONVERSATION LOG
// ═══════════════════════════════════════════
function convoPath(conversationId) {
  // Sanitize conversationId for filename
  const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 80);
  return path.join(CONVO_DIR, `${safe}.jsonl`);
}

function logConvo(conversationId, role, text, agentKey) {
  // Include session_id for NuMem session differentiation
  const sKey = agentKey ? sessionKey(conversationId, agentKey) : conversationId;
  const sessionId = getSessionUUID(sKey) || null;
  const entry = { role, text, ts: new Date().toISOString(), session_id: sessionId };
  if (agentKey) entry.agent = agentKey;
  fs.appendFileSync(convoPath(conversationId), JSON.stringify(entry) + "\n");
}

/** Convenience wrapper — reads history for a conversationId using its convo file path */
function getRecentHistory(conversationId) {
  return _getHistory(convoPath(conversationId), { log });
}

// ═══════════════════════════════════════════
// LOG
// ═══════════════════════════════════════════
function log(direction, data) {
  const entry = { direction, ...data, ts: new Date().toISOString() };
  console.log(JSON.stringify(entry));
}

// ═══════════════════════════════════════════
// FILE ATTACHMENT DOWNLOAD
// ═══════════════════════════════════════════
async function downloadAttachment(attachment, conversationId) {
  const contentUrl = attachment.contentUrl || attachment.content?.downloadUrl;
  if (!contentUrl) {
    log("ATTACH_SKIP", { name: attachment.name, reason: "no download URL" });
    return null;
  }

  const filename = attachment.name || `attachment_${Date.now()}`;
  // Create a subfolder per conversation to avoid name collisions
  const safeConvoId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 40);
  const destDir = path.join(UPLOAD_DIR, safeConvoId);
  fs.mkdirSync(destDir, { recursive: true });

  // Add timestamp prefix to avoid overwrites
  const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
  const destPath = path.join(destDir, `${ts}_${filename}`);

  try {
    const token = await getAppToken();
    const url = new URL(contentUrl);
    const isTeamsCdn = url.hostname.includes("microsoft") ||
      url.hostname.includes("sharepoint") ||
      url.hostname.includes("teams") ||
      url.hostname.includes("trafficmanager") ||
      url.hostname.includes("skype");

    const headers = {};
    if (isTeamsCdn) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    return await new Promise((resolve, reject) => {
      const protocol = url.protocol === "https:" ? https : http;
      protocol.get(contentUrl, { headers }, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          protocol.get(res.headers.location, { headers }, (res2) => {
            const fileStream = fs.createWriteStream(destPath);
            res2.pipe(fileStream);
            fileStream.on("finish", () => {
              fileStream.close();
              log("ATTACH_OK", { name: filename, path: destPath, size: fs.statSync(destPath).size });
              resolve({ name: filename, path: destPath, contentType: attachment.contentType });
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
          log("ATTACH_OK", { name: filename, path: destPath, size: fs.statSync(destPath).size });
          resolve({ name: filename, path: destPath, contentType: attachment.contentType });
        });
        fileStream.on("error", reject);
      }).on("error", reject);
    });
  } catch (err) {
    log("ATTACH_ERROR", { name: filename, error: err.message });
    return null;
  }
}

async function processAttachments(attachments, conversationId) {
  if (!attachments || attachments.length === 0) return [];

  // Filter out inline @mention cards and other non-file attachments
  const fileAttachments = attachments.filter(a => {
    const ct = (a.contentType || "").toLowerCase();
    // Skip adaptive cards, hero cards, @mentions
    if (ct.includes("card") || ct.includes("entity")) return false;
    return true;
  });

  if (fileAttachments.length === 0) return [];

  const results = [];
  for (const att of fileAttachments) {
    const result = await downloadAttachment(att, conversationId);
    if (result) results.push(result);
  }
  return results;
}

// ═══════════════════════════════════════════
// PENDING REPLIES — stores conversation context for async replies
// ═══════════════════════════════════════════
const pendingReplies = new Map(); // replyKey -> { serviceUrl, conversationId }

// ═══════════════════════════════════════════
// WAKE AGENT VIA CLAUDE BRIDGE — persistent ACP worker path
// Used for agents with useBridge: true (currently Cody).
// Replaces execFile-per-message with persistent stdio workers.
// ═══════════════════════════════════════════
async function wakeAgentViaBridge(agentKey, conversationId, senderName, text, serviceUrl) {
  const agent = AGENTS[agentKey];
  const sKey = sessionKey(conversationId, agentKey);

  // Sentinel check — if terminal is active, skip silently
  if (isTerminalActive()) {
    log("CB_SENTINEL_SKIP", { agent: agentKey, conversation_id: conversationId, reason: "terminal active" });
    return;
  }

  log("CB_WAKE", { agent: agentKey, conversation_id: conversationId, session_key: sKey, sender: senderName });

  // Build prompt — include Graph API reply instructions
  const graphDir = path.join(WORKSPACE, "hermitcrab", "graph");
  const personaBlock = agent.personaText
    ? `\n--- IDENTITY ---\n${agent.personaText}\n--- END IDENTITY ---\n`
    : "";

  const replyInstruction = `To reply, post to the Teams group chat via Graph API (this makes the message appear as YOU, not the bot):
GRAPH_TOKEN_FILE="${agent.graphTokenFile}" node -e "require('${graphDir}/graph-client').post('/chats/${conversationId}/messages', { body: { contentType: 'text', content: process.argv[1] }}).then(r => console.log(r.ok ? 'sent' : 'error'))" "YOUR_REPLY_HERE"

Replace YOUR_REPLY_HERE with your response. You MUST run this command or the user won't see your response.
After sending, notify the bridge so it clears your busy state:
curl -s -X POST http://localhost:${REPLY_PORT}/reply -H "Content-Type: application/json" -d '{"conversation_id": "${conversationId}", "text": "NO_REPLY", "agent": "${agentKey}"}'`;

  const prompt = `🏢 TEAMS CHANNEL — HermitCrab Bridge (ClaudeBridge ACP Worker)
${personaBlock}You are ${agent.name}, connected to Microsoft Teams via a persistent ACP session.
From: ${senderName}, conversation: ${conversationId}
🖥️ Running on: ${MACHINE_NAME}

This is a PERSISTENT ACP session. Your stdio pipe stays open between messages.
You have full conversation memory within this worker session.

${replyInstruction}
${getRecentHistory(conversationId)}
New message from ${senderName}: "${text}"`;

  // Set busy state
  pendingReplies.set(conversationId, { serviceUrl, conversationId });
  setServiceUrl(sKey, serviceUrl);
  busySessions.set(sKey, { busy: true, queue: [] });
  log("BUSY_SET", { agent: agentKey, conversation_id: conversationId, session_key: sKey });

  try {
    const result = await initClaudeBridge().runTurn(sKey, prompt, {
      cwd: agent.workspace || WORKSPACE,
      args: [
        "--print",
        "--output-format", "text",
        "--model", "opus",
        "--permission-mode", "default",
        "--allowedTools", "Read,Write,Edit,Bash,Glob,Grep",
      ],
      systemPrompt: agent.personaText || null,
      timeoutMs: 180000,
    });

    if (result.status === "skipped") {
      log("CB_SKIPPED", { agent: agentKey, reason: result.reason });
      clearBusy(sKey, agentKey, conversationId);
      return;
    }

    if (result.status === "completed" && result.text) {
      log("CB_WAKE_OK", { agent: agentKey, session_id: result.sessionId, chars: result.text.length, status: result.status });
      // The agent should have already posted via Graph API as part of its turn.
      // If the turn output contains text but no Graph post was made, post it ourselves.
      // (This is a safety net — the prompt instructs the agent to post via Graph.)
    } else if (result.status === "timeout") {
      log("CB_TIMEOUT", { agent: agentKey, session_key: sKey, partial_chars: result.text?.length || 0 });
      if (isKnownAgentGroup(conversationId)) {
        sendToTeams(serviceUrl, conversationId, `⏳ ${agent.name} timed out. Try again.`).catch(() => {});
      }
    } else if (result.status === "error") {
      log("CB_ERROR", { agent: agentKey, session_key: sKey });
      if (isKnownAgentGroup(conversationId)) {
        sendToTeams(serviceUrl, conversationId, `⚠️ ${agent.name} encountered an error. Try again.`).catch(() => {});
      }
    }
  } catch (err) {
    log("CB_WAKE_ERROR", { agent: agentKey, error: err.message });
    if (isKnownAgentGroup(conversationId)) {
      sendToTeams(serviceUrl, conversationId, `⚠️ ${agent.name} is having trouble right now. Try again in a moment.`).catch(() => {});
    }
  } finally {
    busySessions.delete(sKey);
    log("BUSY_CLEAR", { agent: agentKey, conversation_id: conversationId, session_key: sKey });
    stopTyping(conversationId);
  }
}

// ═══════════════════════════════════════════
// WAKE AGENT — multi-agent aware
// sessionKey = conversationId for default agent, conversationId::agentName for others
// ═══════════════════════════════════════════
function sessionKey(conversationId, agentKey) {
  const agent = AGENTS[agentKey];
  return agent?.isDefault ? conversationId : `${conversationId}::${agentKey}`;
}

async function wakeAgent(agentKey, conversationId, senderName, text, serviceUrl, forcedModel = null) {
  const agent = AGENTS[agentKey];
  if (!agent) { log("WAKE_ERROR", { error: `Unknown agent: ${agentKey}` }); return; }

  // ── CLAUDE BRIDGE PATH — persistent ACP worker for Cody ──
  if (agent.useBridge && initClaudeBridge()) {
    return wakeAgentViaBridge(agentKey, conversationId, senderName, text, serviceUrl);
  }

  // ── ANTIGRAVITY HEALTH GATE — check before trying CLI (Phase 1) ──
  // Skip for agents that use Claude engine natively (e.g., Cody)
  if (agent.engine !== "claude") {
    const agHealth = await isAntigravityAlive();
    if (!agHealth.alive) {
      log("AG_DOWN_FALLBACK", { agent: agentKey, conversation_id: conversationId, failures: agHealth.consecutiveFailures });
      // Route to Claude Code fallback instead
      return wakeAgentFallback(agentKey, conversationId, senderName, text, serviceUrl);
    }
  }

  const sKey = sessionKey(conversationId, agentKey);

  // ── SESSION DOCTOR: health check before wake ──
  const health = doctor.checkHealth(sKey);
  let existingUUID = getSessionUUID(sKey);

  if (health.action === "rotate" && existingUUID) {
    log("DOCTOR_PRE_ROTATE", { agent: agentKey, conversation_id: conversationId, reason: health.reason, old_uuid: existingUUID });
    const registry = loadSessionRegistry();
    delete registry[sKey];
    saveSessionRegistry(registry);
    doctor.recordRotation(sKey);
    existingUUID = null; // force new session
  }

  const isNewSession = !existingUUID;

  // ── SESSION DOCTOR: model selection (replaces inline quota logic) ──
  let targetModel;
  if (forcedModel) {
    targetModel = forcedModel;
  } else {
    const modelChoice = await doctor.selectModel(CLI_MODEL);
    targetModel = modelChoice.model;
    if (modelChoice.switched) {
      log("DOCTOR_MODEL_SWITCH", { agent: agentKey, conversation_id: conversationId, model: targetModel, reason: modelChoice.reason });
      if (modelChoice.quotaRemaining !== undefined && isKnownAgentGroup(conversationId)) {
        sendToTeams(serviceUrl, conversationId, `ℹ️ _Premium quota low (${Math.round(modelChoice.quotaRemaining * 100)}%). Using ${modelChoice.model}._`).catch(() => { });
      }
    }
  }

  // Record the wake with Session Doctor
  const responseTimer = doctor.recordWake(sKey);
  activeResponseTimers.set(sKey, responseTimer);

  // Store reply context so the HTTP reply endpoint can send back to Teams
  pendingReplies.set(conversationId, { serviceUrl, conversationId });
  setServiceUrl(sKey, serviceUrl);

  const personaBlock = agent.personaText
    ? `\n--- IDENTITY ---\n${agent.personaText}\n--- END IDENTITY ---\n`
    : "";

  // ALL agents reply via Graph API — unified pattern, no conflicts
  // Each agent posts as their own Teams user account (human-like, no bot badge)
  const graphDir = path.join(WORKSPACE, "hermitcrab", "graph");
  const replyInstruction = `To reply, post to the Teams group chat via Graph API (this makes the message appear as YOU, not the bot):
GRAPH_TOKEN_FILE="${agent.graphTokenFile}" node -e "require('${graphDir}/graph-client').post('/chats/${conversationId}/messages', { body: { contentType: 'text', content: process.argv[1] }}).then(r => console.log(r.ok ? 'sent' : 'error'))" "YOUR_REPLY_HERE"

Replace YOUR_REPLY_HERE with your response. You MUST run this command or the user won't see your response.
After sending, notify the bridge so it clears your busy state:
curl -s -X POST http://localhost:${REPLY_PORT}/reply -H "Content-Type: application/json" -d '{"conversation_id": "${conversationId}", "text": "NO_REPLY", "agent": "${agentKey}"}'`;
  const followUpReplyInstruction = `Reply via Graph API:
GRAPH_TOKEN_FILE="${agent.graphTokenFile}" node -e "require('${graphDir}/graph-client').post('/chats/${conversationId}/messages', { body: { contentType: 'text', content: process.argv[1] }}).then(r => console.log(r.ok ? 'sent' : 'error'))" "YOUR_REPLY"
Then notify bridge: curl -s -X POST http://localhost:${REPLY_PORT}/reply -H "Content-Type: application/json" -d '{"conversation_id": "${conversationId}", "text": "NO_REPLY", "agent": "${agentKey}"}'`;

  let firstTimePrompt = `🏢 TEAMS CHANNEL — HermitCrab Bridge
${personaBlock}You are ${agent.name}, connected to Microsoft Teams. A user is chatting with you.
From: ${senderName}, conversation: ${conversationId}
🖥️ Running on: ${MACHINE_NAME} (this Antigravity session is on ${MACHINE_NAME}. Files here are LOCAL — no SCP needed.)

This is a PERSISTENT session. All future messages from this user will arrive here.
You have full conversation memory — Antigravity tracks the thread natively.

${replyInstruction}
${getRecentHistory(conversationId)}
New message from ${senderName}: "${text}"`;

  // If this is a migrated session, add context migration prompt
  if (isNewSession && health.health.rotations > 0) {
    firstTimePrompt = doctor.buildMigrationPrompt(firstTimePrompt, {
      lastUserMessage: text,
      rotationCount: health.health.rotations,
    });
  }

  const followUpPrompt = `🏢 from ${senderName}: "${text}"

${followUpReplyInstruction}\n[🖥️ ${MACHINE_NAME}]`;

  const prompt = isNewSession ? firstTimePrompt : followUpPrompt;
  const portArgs = BRIDGE_PORT ? ["-p", BRIDGE_PORT] : [];
  const modelArgs = ["-m", targetModel];
  const args = isNewSession
    ? [...portArgs, ...modelArgs, "-a", prompt]
    : [...portArgs, ...modelArgs, "-a", "-r", existingUUID, prompt];

  log("WAKE", {
    agent: agentKey,
    conversation_id: conversationId,
    session_key: sKey,
    method: isNewSession ? "new-session" : "resume-session",
    session_uuid: existingUUID || "(creating)",
    sender: senderName,
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
      log("WAKE_ERROR", { agent: agentKey, error: error.message, stderr: stderr?.trim() });

      // ── QUOTA FALLBACK (Reactive) ──
      const isQuotaError = errStr.includes("Quota Exceeded")
        || errStr.includes("Rate Limit")
        || errStr.includes("exhausted your capacity")
        || errStr.includes("quota will reset");

      if (isQuotaError) {
        doctor.recordFailure(sKey, "quota", errStr);
        try { require("../bridge/quota").invalidateQuotaCache(); } catch (_) { }
        if (targetModel !== FALLBACK_MODEL) {
          log("FALLBACK", { agent: agentKey, conversation_id: conversationId, reason: "Quota hit, retrying with fallback", fallback: FALLBACK_MODEL });
          if (isKnownAgentGroup(conversationId)) {
            sendToTeams(serviceUrl, conversationId, `⚠️ _Premium quota exhausted. Switching to ${FALLBACK_MODEL}._`).catch(() => { });
          }
          await wakeAgent(agentKey, conversationId, senderName, text, serviceUrl, FALLBACK_MODEL).catch(e => log("RETRY_ERROR", { e: e.message }));
          return;
        }
      } else {
        doctor.recordFailure(sKey, "cli_error", errStr);
      }

      stopTyping(conversationId);

      // If resume failed, try creating a fresh session
      if (!isNewSession) {
        log("WAKE_RETRY", { agent: agentKey, conversation_id: conversationId, reason: "resume failed, creating new session" });
        const registry = loadSessionRegistry();
        delete registry[sKey];
        saveSessionRegistry(registry);
        wakeAgent(agentKey, conversationId, senderName, text, serviceUrl, targetModel).catch(e => log("RETRY_ERROR", { e: e.message }));
      } else {
        // New session also failed — try Claude Code fallback before giving up
        log("AG_CLI_FAIL_FALLBACK", { agent: agentKey, conversation_id: conversationId, error: errStr.substring(0, 200) });
        // Invalidate health cache so next message goes straight to fallback
        antigravityHealthCache.alive = false;
        antigravityHealthCache.consecutiveFailures++;
        antigravityHealthCache.lastCheck = Date.now();
        antigravityHealthCache.error = "CLI exec failed";
        wakeAgentFallback(agentKey, conversationId, senderName, text, serviceUrl).catch(e => {
          log("FALLBACK_LAST_RESORT_FAIL", { agent: agentKey, error: e.message });
          exec(`curl -s -d "⚠️ HermitCrab Teams: ${agent.name} wake failed (both AG + fallback) for msg from ${senderName}" ntfy.sh/tonysM5`);
          if (isKnownAgentGroup(conversationId)) {
            sendToTeams(serviceUrl, conversationId, `⚠️ ${agent.name} is having trouble thinking right now. Try again in a moment.`)
              .catch(err => log("REPLY_ERROR", { error: err.message }));
          }
        });
      }
      return;
    }

    const rawOutput = (stdout || "") + (stderr || "");
    const output = rawOutput.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\[\?[0-9]*[a-zA-Z]|\r/g, "").trim();

    // Extract UUID from new session
    if (isNewSession && output) {
      const match = output.match(/Cascade:\s*([a-f0-9]+)/i);
      if (match) {
        const partialUUID = match[1];
        log("SESSION_CAPTURE", { agent: agentKey, conversation_id: conversationId, partialUUID });
        setTimeout(() => resolveAndSaveSession(sKey, partialUUID), 2000);
      }
    }

    if (output) {
      log("WAKE_OK", { agent: agentKey, output, session: isNewSession ? "new" : "resumed" });
    }
  });
}

// Backward compat wrapper
async function wakeJarvis(conversationId, senderName, text, serviceUrl, forcedModel = null) {
  return wakeAgent("mini", conversationId, senderName, text, serviceUrl, forcedModel);
}

// ═══════════════════════════════════════════
// WAKE AGENT (CLAUDE) — Cody's wake function
// Uses Claude CLI --print mode with session persistence.
// Bridge captures stdout and posts via Graph API as CodyH.
//
// 3-Part Architecture (designed 2026-03-22):
//   Part 1: Session ID persistence (agentName→sessionId, disk-backed)
//   Part 2: Health check + respawn (probe before send, auto-recover)
//   Part 3: Alert-on-failure (N retries, exponential backoff, escalation)
// ═══════════════════════════════════════════
const CLAUDE_SESSION_REGISTRY = path.join(WORKSPACE, "hermitcrab", "claude-sessions.json");
const CLAUDE_RESPAWN_MAX = 3;                       // max respawn attempts before alerting
const CLAUDE_RESPAWN_BACKOFF = [2000, 5000, 10000];  // exponential backoff (ms)
const CLAUDE_PROBE_TIMEOUT = 10000;                  // 10s timeout for health probe

// ── Part 1: Session ID Persistence ──
function loadClaudeSessions() {
  try {
    if (fs.existsSync(CLAUDE_SESSION_REGISTRY)) {
      return JSON.parse(fs.readFileSync(CLAUDE_SESSION_REGISTRY, "utf-8"));
    }
  } catch (e) {
    log("CLAUDE_SESSION_LOAD_ERROR", { error: e.message });
  }
  return {};
}

function saveClaudeSessions(registry) {
  fs.writeFileSync(CLAUDE_SESSION_REGISTRY, JSON.stringify(registry, null, 2));
}

function getClaudeSessionId(sKey) {
  const registry = loadClaudeSessions();
  return registry[sKey]?.sessionId || null;
}

function setClaudeSessionId(sKey, sessionId) {
  const registry = loadClaudeSessions();
  registry[sKey] = {
    sessionId,
    lastActive: new Date().toISOString(),
  };
  saveClaudeSessions(registry);
  log("CLAUDE_SESSION_SAVED", { key: sKey, session_id: sessionId });
}

function clearClaudeSessionId(sKey) {
  const registry = loadClaudeSessions();
  const old = registry[sKey]?.sessionId;
  delete registry[sKey];
  saveClaudeSessions(registry);
  log("CLAUDE_SESSION_CLEARED", { key: sKey, old_session_id: old });
}

// Extract session ID from Claude CLI stderr output
// Claude CLI outputs session info in various formats — try them all
function extractClaudeSessionId(stderr) {
  if (!stderr) return null;
  // Try multiple patterns — Claude CLI format may vary
  const patterns = [
    /session[:\s]+([a-f0-9-]{36})/i,
    /Session ID[:\s]+([a-f0-9-]{36})/i,
    /session_id["':\s]+([a-f0-9-]{36})/i,
    /Resuming session[:\s]+([a-f0-9-]{36})/i,
    /Created session[:\s]+([a-f0-9-]{36})/i,
    // Fallback: any UUID-shaped string on its own line
    /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/mi,
  ];
  for (const pattern of patterns) {
    const match = stderr.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ── Part 2: Health Check + Respawn ──
// Probes a Claude session with a lightweight --resume to check if it's alive.
// Returns: { alive: true } or { alive: false, error: string }
async function probeClaudeSession(sessionId, agentKey) {
  const agent = AGENTS[agentKey];
  if (!agent || !sessionId) return { alive: false, error: "no session" };

  return new Promise((resolve) => {
    const probeArgs = [
      "--print",
      "--output-format", "text",
      "--resume", sessionId,
      "--model", "sonnet",
      "--max-budget-usd", "0.001", // minimize cost — just a ping
      "--", "ping",               // minimal probe message
    ];

    const timeoutTimer = setTimeout(() => {
      resolve({ alive: false, error: "probe timeout" });
    }, CLAUDE_PROBE_TIMEOUT);

    execFile(CLAUDE_CLI_PATH, probeArgs, {
      cwd: agent.workspace || WORKSPACE,
      env: { ...process.env, PATH: `${path.dirname(CLAUDE_CLI_PATH)}:${PATH_ENV}` },
      timeout: CLAUDE_PROBE_TIMEOUT,
      maxBuffer: 1024 * 64, // small buffer for probe
    }, (error, stdout, stderr) => {
      clearTimeout(timeoutTimer);
      if (error) {
        const errStr = (error.message || "") + (stderr || "");
        // Session-specific errors that indicate the session is dead
        const isDead = errStr.includes("not found")
          || errStr.includes("invalid session")
          || errStr.includes("does not exist")
          || errStr.includes("Cannot resume")
          || errStr.includes("No session found")
          || error.killed; // timeout kill

        log("CLAUDE_PROBE", { session_id: sessionId, alive: !isDead, error: errStr.substring(0, 200) });
        resolve({ alive: !isDead, error: errStr.substring(0, 200) });
      } else {
        log("CLAUDE_PROBE", { session_id: sessionId, alive: true });
        resolve({ alive: true });
      }
    });
  });
}

// Respawn a Claude session from scratch using the agent's workspace.
// CLAUDE.md auto-loads, giving the agent its soul back.
// Returns: new sessionId or null on failure.
async function respawnClaudeSession(agentKey, sKey) {
  const agent = AGENTS[agentKey];
  if (!agent) return null;

  log("CLAUDE_RESPAWN", { agent: agentKey, key: sKey });

  // Clear the dead session
  clearClaudeSessionId(sKey);

  // Spawn a fresh session with a "wake up" prompt so it initializes
  const sessionName = `teams-${sKey.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 20)}`;
  const wakePrompt = `You are ${agent.name}, reconnecting to Microsoft Teams via HermitCrab bridge after a session restart. Read your CLAUDE.md and context files to restore your memory. Reply with a brief acknowledgment.`;

  const args = [
    "--print",
    "--output-format", "json",
    "--model", "opus",
    "--name", sessionName,
    "--permission-mode", "default",
    "--allowedTools", "Read,Bash(git log:*),Bash(cat:*),Bash(ls:*),Bash(find:*),Bash(grep:*)",
    "--", wakePrompt,
  ];

  // Add access to full workspace if agent has its own subdirectory
  if (agent.workspace && agent.workspace !== WORKSPACE) {
    args.splice(args.indexOf("--"), 0, "--add-dir", WORKSPACE);
  }

  return new Promise((resolve) => {
    execFile(CLAUDE_CLI_PATH, args, {
      cwd: agent.workspace || WORKSPACE,
      env: { ...process.env, PATH: `${path.dirname(CLAUDE_CLI_PATH)}:${PATH_ENV}` },
      timeout: 60000,  // 60s timeout for respawn
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        log("CLAUDE_RESPAWN_ERROR", { agent: agentKey, error: error.message, stderr: stderr?.trim() });
        resolve(null);
        return;
      }

      // Extract session ID from the freshly created session
      let newSessionId = null;
      try {
        const jsonStr = (stdout || "").trim().split("\n").filter(l => l.startsWith("{")).pop();
        if (jsonStr) {
          const payload = JSON.parse(jsonStr);
          if (payload.session_id) newSessionId = payload.session_id;
        }
      } catch (e) {
        // Fall back or fail
      }

      if (newSessionId) {
        setClaudeSessionId(sKey, newSessionId);
        log("CLAUDE_RESPAWN_OK", { agent: agentKey, new_session_id: newSessionId });
        resolve(newSessionId);
      } else {
        log("CLAUDE_RESPAWN_NO_ID", { agent: agentKey, stderr: (stderr || "").substring(0, 300), stdout: (stdout || "").substring(0, 300) });
        resolve(null);
      }
    });
  });
}

// ── Part 3: Alert-on-Failure ──
// Attempts to recover a dead session with exponential backoff.
// If all attempts fail, posts an alert to Teams.
async function recoverClaudeSession(agentKey, sKey, conversationId, serviceUrl) {
  for (let attempt = 0; attempt < CLAUDE_RESPAWN_MAX; attempt++) {
    const backoffMs = CLAUDE_RESPAWN_BACKOFF[attempt] || CLAUDE_RESPAWN_BACKOFF[CLAUDE_RESPAWN_BACKOFF.length - 1];

    log("CLAUDE_RECOVER", { agent: agentKey, attempt: attempt + 1, max: CLAUDE_RESPAWN_MAX, backoff_ms: backoffMs });

    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

    const newSessionId = await respawnClaudeSession(agentKey, sKey);
    if (newSessionId) {
      log("CLAUDE_RECOVER_OK", { agent: agentKey, session_id: newSessionId, attempt: attempt + 1 });
      return newSessionId;
    }
  }

  // All attempts failed — escalate
  log("CLAUDE_RECOVER_FAILED", { agent: agentKey, key: sKey, attempts: CLAUDE_RESPAWN_MAX });

  // Alert via ntfy (always)
  exec(`curl -s -d "🚨 ${AGENTS[agentKey]?.name || agentKey} session recovery FAILED after ${CLAUDE_RESPAWN_MAX} attempts. Manual intervention needed." ntfy.sh/tonysM5`);

  // Alert in Teams (if safe to)
  if (isKnownAgentGroup(conversationId)) {
    try {
      await postViaGraphAPI(conversationId,
        `🚨 ${AGENTS[agentKey]?.name || agentKey} session failed to recover after ${CLAUDE_RESPAWN_MAX} attempts. @Jarvis or @Mini — manual check needed.`,
        AGENTS.mini.graphTokenFile // Post as Mini (neutral reporter)
      );
    } catch (e) {
      log("CLAUDE_ALERT_ERROR", { error: e.message });
    }
  }

  return null;
}

// ── Main Wake Function ──
async function wakeAgentClaude(agentKey, conversationId, senderName, text, serviceUrl) {
  const agent = AGENTS[agentKey];
  if (!agent) { log("WAKE_CLAUDE_ERROR", { error: `Unknown agent: ${agentKey}` }); return; }

  const sKey = sessionKey(conversationId, agentKey);
  let existingSessionId = getClaudeSessionId(sKey);

  // ── Part 2: Health check before sending ──
  if (existingSessionId) {
    log("CLAUDE_HEALTH_CHECK", { agent: agentKey, session_id: existingSessionId });
    const probeResult = await probeClaudeSession(existingSessionId, agentKey);

    if (!probeResult.alive) {
      log("CLAUDE_SESSION_DEAD", { agent: agentKey, session_id: existingSessionId, error: probeResult.error });

      // ── Part 3: Attempt recovery with backoff ──
      const recovered = await recoverClaudeSession(agentKey, sKey, conversationId, serviceUrl);
      if (recovered) {
        existingSessionId = recovered;
      } else {
        // Recovery fully failed — bail out
        stopTyping(conversationId);
        busySessions.delete(sKey);
        disarmWatchdog(sKey);
        return;
      }
    }
  }

  const isNewSession = !existingSessionId;

  // Build system prompt from persona
  const systemPrompt = [
    agent.personaText || "",
    `You are ${agent.name}, connected to Microsoft Teams via HermitCrab bridge.`,
    `From: ${senderName}, conversation: ${conversationId}`,
    `🖥️ Running on: ${MACHINE_NAME}`,
    `IMPORTANT: Respond directly with your message. Do NOT try to run any Graph API commands or curl commands. The bridge will post your response to Teams automatically.`,
    `Keep your response concise — this is a workplace chat, not an essay.`,
  ].filter(Boolean).join("\n");

  // Write system prompt to temp file to avoid arg-length/escaping issues
  const tmpDir = path.join(os.tmpdir(), "hermitcrab-claude");
  fs.mkdirSync(tmpDir, { recursive: true });
  const systemPromptFile = path.join(tmpDir, `sysprompt-${sKey.replace(/[^a-zA-Z0-9]/g, "_")}.txt`);
  fs.writeFileSync(systemPromptFile, systemPrompt);

  // Build Claude CLI args
  const args = [
    "--print",                         // non-interactive, stdout output
    "--output-format", "json",         // explicit json for session_id
    "--model", agent.model || "opus",  // Use configured model or fallback
    "--system-prompt-file", systemPromptFile,
  ];

  // Session persistence
  if (!isNewSession) {
    args.push("--resume", existingSessionId);
  } else {
    // Generate a deterministic-ish session name for easy identification
    const sessionName = `teams-${conversationId.substring(0, 12)}`;
    args.push("--name", sessionName);
  }

  // Give access to the full JARVIS workspace tree (cwd may be agent-specific for CLAUDE.md)
  if (agent.workspace && agent.workspace !== WORKSPACE) {
    args.push("--add-dir", WORKSPACE);
  }

  // Tool permissions — allow read-only tools for safety in Teams context
  args.push("--permission-mode", "default");
  args.push("--allowedTools", "Read,Bash(git log:*),Bash(cat:*),Bash(ls:*),Bash(find:*),Bash(grep:*)");

  // Add the user message as the prompt argument
  // For new sessions, prepend conversation history for continuity
  const historyBlock = isNewSession ? getRecentHistory(conversationId) : "";
  const fullPrompt = historyBlock
    ? `${historyBlock}\nNew message from ${senderName}: "${text}"`
    : text;
  args.push("--", fullPrompt);

  log("WAKE_CLAUDE", {
    agent: agentKey,
    conversation_id: conversationId,
    session_key: sKey,
    method: isNewSession ? "new-session" : "resume-session",
    session_id: existingSessionId || "(creating)",
    sender: senderName,
  });

  // Set reply context
  pendingReplies.set(conversationId, { serviceUrl, conversationId });
  setServiceUrl(sKey, serviceUrl);

  execFile(CLAUDE_CLI_PATH, args, {
    cwd: agent.workspace || WORKSPACE, // Use agent-specific workspace if set (for CLAUDE.md discovery)
    env: { ...process.env, PATH: `${path.dirname(CLAUDE_CLI_PATH)}:${PATH_ENV}` },
    timeout: 120000,  // 2 minute timeout
    maxBuffer: 1024 * 1024 * 5, // 5MB buffer for large responses
  }, async (error, stdout, stderr) => {
    if (error) {
      const errStr = (error.message || "") + (stderr || "");
      log("WAKE_CLAUDE_ERROR", { agent: agentKey, error: error.message, stderr: stderr?.trim() });

      // Check if this is a dead session error (resume failed)
      const isSessionDead = errStr.includes("not found")
        || errStr.includes("invalid session")
        || errStr.includes("Cannot resume")
        || errStr.includes("No session found");

      if (isSessionDead && !isNewSession) {
        // Session died mid-flight — clear and retry with fresh session
        log("CLAUDE_SESSION_DIED_MIDFLIGHT", { agent: agentKey, session_id: existingSessionId });
        clearClaudeSessionId(sKey);

        // Retry once with fresh session (don't recurse deeply)
        try {
          await wakeAgentClaude(agentKey, conversationId, senderName, text, serviceUrl);
        } catch (retryError) {
          log("CLAUDE_RETRY_ERROR", { error: retryError.message });
        }
        return;
      }

      stopTyping(conversationId);
      busySessions.delete(sKey);
      disarmWatchdog(sKey);

      // Notify Tony privately
      exec(`curl -s -d "⚠️ ${agent.name} wake failed: ${error.message.substring(0, 100)}" ntfy.sh/tonysM5`);
      if (isKnownAgentGroup(conversationId)) {
        sendToTeams(serviceUrl, conversationId, `⚠️ ${agent.name} is having trouble right now. Try again in a moment.`)
          .catch(e => log("REPLY_ERROR", { error: e.message }));
      }
      return;
    }

    // ── Part 1: Capture and persist session ID ──
    // Output format is JSON, extract session ID and message from stdout payload
    let capturedId = null;
    let responseText = (stdout || "").trim();
    
    try {
      const jsonStr = responseText.split("\n").filter(l => l.startsWith("{")).pop();
      if (jsonStr) {
        const payload = JSON.parse(jsonStr);
        if (payload.result) responseText = payload.result;
        if (payload.session_id) capturedId = payload.session_id;
      }
    } catch (e) {
      log("CLAUDE_JSON_PARSE_ERROR", { error: e.message, snippet: responseText.substring(0, 100) });
    }

    if (!responseText) {
      log("WAKE_CLAUDE_EMPTY", { agent: agentKey, stderr: stderr?.trim() });
      busySessions.delete(sKey);
      disarmWatchdog(sKey);
      stopTyping(conversationId);
      return;
    }

    if (capturedId) {
      if (isNewSession || capturedId !== existingSessionId) {
        setClaudeSessionId(sKey, capturedId);
        log("CLAUDE_SESSION_CAPTURE", { session_id: capturedId, key: sKey, was_new: isNewSession });
      }
      // Update lastActive timestamp even on resume
      const registry = loadClaudeSessions();
      if (registry[sKey]) {
        registry[sKey].lastActive = new Date().toISOString();
        saveClaudeSessions(registry);
      }
    }

    // Post response via Graph API as the agent's Teams user
    try {
      await humanDelay();
      await postViaGraphAPI(conversationId, responseText, agent.graphTokenFile);
      log("WAKE_CLAUDE_OK", {
        agent: agentKey,
        conversation_id: conversationId,
        response_length: responseText.length,
        session: isNewSession ? "new" : "resumed",
        session_id: capturedId || existingSessionId || "unknown",
      });
      lastResponder.set(conversationId, agentKey);
    } catch (graphError) {
      log("CLAUDE_GRAPH_ERROR", { error: graphError.message, response: responseText.substring(0, 200) });
      // Fallback: try Bot Framework response
      try {
        await sendToTeams(serviceUrl, conversationId, `**${agent.name}**: ${responseText}`);
      } catch (_) { }
    }

    // Clear busy state and drain queue
    disarmWatchdog(sKey);
    sealTyping(conversationId);
    const session = busySessions.get(sKey);
    const queued = session?.queue || [];
    busySessions.delete(sKey);

    if (queued.length > 0) {
      drainCollect(agentKey, conversationId, queued, serviceUrl);
    }
  });
}

// Resolve truncated UUID to full UUID
function resolveAndSaveSession(conversationId, partialUUID) {
  execFile(CLI_PATH, ["-r"], {
    cwd: WORKSPACE,
    env: { ...process.env, PATH: PATH_ENV },
    timeout: 10000,
  }, (error, stdout) => {
    if (error || !stdout) {
      setSessionUUID(conversationId, partialUUID);
      return;
    }
    const lines = stdout.split("\n");
    for (const line of lines) {
      const fullUUID = line.trim().split(/\s+/)[0];
      if (fullUUID && fullUUID.startsWith(partialUUID)) {
        setSessionUUID(conversationId, fullUUID);
        return;
      }
    }
    if (partialUUID.length >= 8) {
      setSessionUUID(conversationId, partialUUID);
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
// HTTP SERVER — two jobs:
// 1. POST /api/messages — receive from Azure Bot Service
// 2. POST /reply — receive from JARVIS (sends back to Teams)
// ═══════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200); res.end(); return;
  }

  // ── Bot Framework incoming messages ──
  if (req.method === "POST" && req.url === "/api/messages") {
    try {
      const activity = await parseBody(req);

      log("RAW_ACTIVITY", { type: activity.type, has_text: !!activity.text, has_attachments: !!activity.attachments, from_id: activity.from?.id, from_name: activity.from?.name });

      // Acknowledge immediately — async response via /reply
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "accepted" }));

      // Only handle message activities
      if (activity.type !== "message") {
        log("ACTIVITY", { type: activity.type, conversation_id: activity.conversation?.id });
        return;
      }

      // Skip messages from any registered agent's echo (prevents loops)
      // Each agent only skips its OWN echo. Peer agents are treated as normal senders.
      const senderId = activity.from?.id || "";
      const senderName_ = (activity.from?.name || "").toLowerCase();
      if (senderId === MICROSOFT_APP_ID || senderId.includes(MICROSOFT_APP_ID) || ALL_SELF_SKIP_IDS.has(senderId) || ALL_SELF_SKIP_NAMES.has(senderName_)) {
        const ownerAgent = findAgentBySender(senderName_, senderId);
        log("SELF_SKIP", { sender: activity.from?.name, sender_id: senderId, agent: ownerAgent, reason: "agent echo detected" });

        // ── Auto-NO_REPLY: agent posted via Graph API → clear that agent's busy session ──
        const conversationId = activity.conversation?.id;
        if (ownerAgent && conversationId) {
          const sKey = sessionKey(conversationId, ownerAgent);
          if (busySessions.has(sKey)) {
            const wd = replyWatchdogs.get(sKey);
            if (wd) { clearTimeout(wd.timer); replyWatchdogs.delete(sKey); }
            const session = busySessions.get(sKey);
            const queuedMessages = session?.queue?.length > 0 ? [...session.queue] : [];
            busySessions.delete(sKey);
            log("AUTO_NO_REPLY", { agent: ownerAgent, conversation_id: conversationId, session_key: sKey, queue_drained: queuedMessages.length, reason: `${AGENTS[ownerAgent]?.name} echo detected — session auto-cleared` });

            // Track that this agent was the last to speak in this conversation
            lastResponder.set(conversationId, ownerAgent);

            // Only stop typing when NO agents are still busy for this conversation
            const anyStillBusy = Object.keys(AGENTS).some(k => busySessions.has(sessionKey(conversationId, k)));
            if (!anyStillBusy) {
              stopTyping(conversationId);
              log("TYPING_STOP", { conversation_id: conversationId, reason: "all agents done" });
            } else {
              log("TYPING_CONTINUE", { conversation_id: conversationId, reason: "other agents still busy" });
            }

            // Collect drain any queued messages
            if (queuedMessages.length > 0) {
              const serviceUrl = activity.serviceUrl || getPersistedServiceUrl(conversationId);
              if (serviceUrl) {
                drainCollect(ownerAgent, conversationId, queuedMessages, serviceUrl).catch(e =>
                  log("COLLECT_DRAIN_ERROR", { agent: ownerAgent, error: e.message }));
              }
            }
          }

          // ── Conversation Mode: record this agent's speaking turn ──
          // BUT skip nudge messages (infrastructure, not content)
          if (activeConvModes.has(conversationId)) {
            const messageBody = (activity.text || "").substring(0, 300);
            const isNudge = /your turn!.*Round \d+/i.test(messageBody) || /\u23f8\ufe0f Conversation paused/i.test(messageBody) || /\ud83c\udfc1 Conversation complete/i.test(messageBody);
            if (!isNudge) {
              const agentDisplayName = AGENTS[ownerAgent]?.name === "Mini" ? "MiniH" : AGENTS[ownerAgent]?.name || activity.from?.name;
              recordConvModeActivity(conversationId, agentDisplayName, messageBody);
            } else {
              log("CONV_MODE_NUDGE_SKIP", { conversation_id: conversationId, agent: ownerAgent, reason: "nudge echo not counted as speaking turn" });
            }
          }
        }
        return;
      }

      // Deduplicate — Teams can deliver the same message twice in group chats
      const activityId = activity.id;
      if (activityId && recentActivityIds.has(activityId)) {
        log("DEDUP", { activityId, reason: "duplicate message skipped" });
        return;
      }
      if (activityId) {
        recentActivityIds.set(activityId, Date.now());
        // Prune old entries (keep last 5 minutes)
        if (recentActivityIds.size > 100) {
          const cutoff = Date.now() - 300000;
          for (const [id, ts] of recentActivityIds) {
            if (ts < cutoff) recentActivityIds.delete(id);
          }
        }
      }

      const conversationId = activity.conversation?.id;
      const senderName = activity.from?.name || "Unknown";
      const serviceUrl = activity.serviceUrl;

      // Handle button clicks (Action.Submit sends value, not text)
      let text = activity.text || "";
      if (!text && activity.value?.quickReply) {
        text = activity.value.quickReply;
        log("BUTTON_CLICK", { value: text, sender: senderName });

        // Update the original card to show the selection
        const cardInfo = sentCards.get(conversationId);
        if (cardInfo?.activityId) {
          updateActivity(serviceUrl, conversationId, cardInfo.activityId, {
            type: "message",
            id: cardInfo.activityId,
            attachments: [{
              contentType: "application/vnd.microsoft.card.adaptive",
              content: {
                "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                type: "AdaptiveCard",
                version: "1.3",
                body: [
                  { type: "TextBlock", text: cardInfo.originalText, wrap: true, size: "Default" },
                  { type: "TextBlock", text: `✅ ${text}`, wrap: true, color: "Good", weight: "Bolder", spacing: "Small" }
                ]
              }
            }]
          });
          sentCards.delete(conversationId);
        }
      }

      // Strip bot @mention from message text
      const cleanText = text.replace(/<at>.*?<\/at>/g, "").trim();

      // Process file attachments
      const downloadedFiles = await processAttachments(activity.attachments, conversationId);

      if (!cleanText && downloadedFiles.length === 0) {
        log("SKIP_EMPTY", { message: "No text and no file attachments found after filtering" });
        return;
      }

      // Tenant check (optional but recommended)
      if (AUTHORIZED_TENANT_ID && activity.conversation?.tenantId !== AUTHORIZED_TENANT_ID) {
        log("BLOCKED", { tenant: activity.conversation?.tenantId, sender: senderName });
        await sendToTeams(serviceUrl, conversationId, "⛔ Unauthorized tenant. Access denied.");
        return;
      }

      // Rate limit
      const now = Date.now();
      let bucket = rateLimitMap.get(conversationId);
      if (!bucket || now > bucket.resetAt) {
        bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
        rateLimitMap.set(conversationId, bucket);
      }
      bucket.count++;
      if (bucket.count > RATE_LIMIT_MAX) {
        log("RATE_LIMITED", { conversation_id: conversationId, sender: senderName });
        await sendToTeams(serviceUrl, conversationId, "⏳ Slow down — too many messages.");
        return;
      }

      // Build message with attachment info
      let fullMessage = cleanText || "";
      if (downloadedFiles.length > 0) {
        const fileList = downloadedFiles.map(f => `  📎 ${f.name} → ${f.path} (${f.contentType})`).join("\n");
        fullMessage += `${cleanText ? "\n\n" : ""}[Attached files]\n${fileList}\nYou can read these files from the paths above.`;
      }

      log("IN", { conversation_id: conversationId, sender: senderName, text: cleanText, attachments: downloadedFiles.length });
      logConvo(conversationId, "user", fullMessage);

      // ── Debate confirmation: check if user is confirming a pending debate ──
      const pendingConfirm = pendingDebateConfirm.get(conversationId);
      if (pendingConfirm && Date.now() < pendingConfirm.expiresAt) {
        const response = cleanText.toLowerCase().trim();
        if (response === "yes" || response === "go" || response === "y" || response === "start") {
          pendingDebateConfirm.delete(conversationId);
          startConvMode(conversationId, pendingConfirm.rounds, "", pendingConfirm.participants, serviceUrl);
          const names = pendingConfirm.participants.map(p => p.replace(/H$/i, "")).join(" vs ");
          log("DEBATE_CONFIRMED", { rounds: pendingConfirm.rounds, participants: pendingConfirm.participants });
          // Confirm via MiniH and wake first agent
          await postViaGraphAPI(conversationId, `🏁 Debate started: ${pendingConfirm.rounds} rounds — ${names}. Use /debate stop to end.`);
          const firstAgent = pendingConfirm.participants[0];
          const baseName = firstAgent.replace(/H$/i, "").toLowerCase();
          const agentKey = Object.keys(AGENTS).find(k => AGENTS[k].name.toLowerCase() === baseName);
          if (agentKey) {
            const sKey = sessionKey(conversationId, agentKey);
            busySessions.set(sKey, { busy: true, queue: [] });
            startTyping(serviceUrl, conversationId);
            startReplyWatchdog(sKey, serviceUrl);
            await wakeAgent(agentKey, conversationId, senderName, `[Debate Mode — Round 1/${pendingConfirm.rounds}] You are starting this debate. Present your opening perspective.`, serviceUrl);
          }
          return;
        } else if (response === "no" || response === "n" || response === "cancel") {
          pendingDebateConfirm.delete(conversationId);
          await postViaGraphAPI(conversationId, "👍 Debate cancelled.");
          log("DEBATE_CANCELLED", { conversationId });
          return;
        }
        // If not a yes/no response, clear the pending and continue as normal message
        pendingDebateConfirm.delete(conversationId);
      }

      // ── /debate command: explicit conversation mode trigger ──
      // Alpha Gate: all debate starts require confirmation (HermitCrab philosophy)
      const debateCmd = parseDebateCommand(cleanText);
      if (debateCmd) {
        if (debateCmd.action === "start" && !activeConvModes.has(conversationId)) {
          const names = debateCmd.participants.map(p => p.replace(/H$/i, "")).join(" vs ");
          // Alpha Gate: store pending confirmation instead of starting immediately
          pendingDebateConfirm.set(conversationId, {
            rounds: debateCmd.rounds,
            participants: debateCmd.participants,
            serviceUrl,
            expiresAt: Date.now() + 120000
          });
          await postViaGraphAPI(conversationId, `🎯 Ready to start: ${debateCmd.rounds} rounds, ${names}.\n\n🧪 ALPHA FEATURE — Bot2Bot conversation mode is experimental and may behave unexpectedly.\n\nReply "Yes" to confirm, or "No" to cancel.`);
          log("DEBATE_CMD", { action: "confirm_gate", rounds: debateCmd.rounds, participants: debateCmd.participants });
          return; // wait for confirmation
        } else if (debateCmd.action === "stop") {
          if (activeConvModes.has(conversationId)) {
            endConvMode(conversationId, "manual_stop");
            await postViaGraphAPI(conversationId, `⏹️ Debate ended by ${senderName}.`);
          } else {
            await postViaGraphAPI(conversationId, `ℹ️ No active debate to stop.`);
          }
          log("DEBATE_CMD", { action: "stop" });
          return;
        } else if (debateCmd.action === "status") {
          const state = activeConvModes.get(conversationId);
          if (state) {
            const roundsDisplay = {};
            for (const [k, v] of state.rounds) {
              roundsDisplay[state.displayNames.get(k) || k] = v;
            }
            await postViaGraphAPI(conversationId, `📊 Debate status: ${JSON.stringify(roundsDisplay)} / ${state.targetRounds} rounds. Nudges: ${state.nudgeCount}`);
          } else {
            await postViaGraphAPI(conversationId, `ℹ️ No active debate.`);
          }
          return;
        } else if (debateCmd.action === "start" && activeConvModes.has(conversationId)) {
          await postViaGraphAPI(conversationId, `⚠️ Debate already active. Use /debate stop first.`);
          return;
        }
      }

      // ── Auto-detect debate intent from natural language → ask MiniH to confirm ──
      if (!activeConvModes.has(conversationId) && !pendingDebateConfirm.has(conversationId)) {
        const detectedRounds = detectDebateIntent(fullMessage);
        if (detectedRounds) {
          // Extract participants from the message
          const textLower = fullMessage.toLowerCase();
          const participants = [];
          if (textLower.includes("mini")) participants.push("MiniH");
          if (textLower.includes("big")) participants.push("BigH");
          if (textLower.includes("jarvis")) participants.push("Jarvis");
          if (participants.length < 2) {
            if (!participants.includes("MiniH")) participants.push("MiniH");
            if (!participants.includes("BigH")) participants.push("BigH");
          }
          const names = participants.map(p => p.replace(/H$/i, "")).join(" vs ");

          // Store pending confirmation (expires in 2 min)
          pendingDebateConfirm.set(conversationId, {
            rounds: detectedRounds,
            participants,
            serviceUrl,
            expiresAt: Date.now() + 120000
          });

          // MiniH asks for confirmation via Graph API
          await postViaGraphAPI(conversationId, `🎯 I detected a debate request: ${detectedRounds} rounds, ${names}. Want me to set it up?\n\n🧪 ALPHA FEATURE — Bot2Bot conversation mode is experimental and may behave unexpectedly.\n\nReply "Yes" to start, or "No" to cancel.`);
          log("DEBATE_DETECT", { rounds: detectedRounds, participants, reason: "auto-detected, awaiting confirmation" });
          // Don't return — let the message still route to agents normally
        }
      }

      // ── Conversation Mode: record non-agent speaking turn ──
      if (activeConvModes.has(conversationId)) {
        recordConvModeActivity(conversationId, senderName, fullMessage);
      }

      // ── Debounce: batch rapid-fire messages, then route ──
      debounceInbound(conversationId, { senderName, text: fullMessage, serviceUrl }, async (batch) => {
        // Format with envelope (timestamp, elapsed, weekday)
        const envelopedMessages = batch.map(m => formatEnvelope(m.senderName, m.text, conversationId));
        const combinedMessage = envelopedMessages.join("\n");
        const primarySender = batch[batch.length - 1].senderName; // latest sender
        const primaryServiceUrl = batch[batch.length - 1].serviceUrl;

        // Start typing indicator
        startTyping(primaryServiceUrl, conversationId);

        // ── Multi-agent routing: determine which agents to wake ──
        const targetAgents = routeMessage(combinedMessage, conversationId);
        log("ROUTE", { conversation_id: conversationId, targets: targetAgents, batched: batch.length, text: combinedMessage.substring(0, 80) });

        // If no agents triggered, skip (restraint mode)
        if (targetAgents.length === 0) {
          log("RESTRAINT_SKIP", { conversation_id: conversationId, text: combinedMessage.substring(0, 80), reason: "no agents triggered" });
          stopTyping(conversationId);
          return;
        }

        for (const agentKey of targetAgents) {
          const sKey = sessionKey(conversationId, agentKey);
          const agentSession = busySessions.get(sKey);

          log("BUSY_CHECK", { agent: agentKey, conversation_id: conversationId, session_key: sKey, is_busy: !!agentSession?.busy, queue_length: agentSession?.queue?.length || 0 });

          if (agentSession?.busy) {
            const isGroupChat = GROUP_CHAT_PATTERN.test(conversationId);

            if (isGroupChat) {
              // ── GROUP CHAT: Collect mode ──
              // Don't interrupt — other people's messages shouldn't kill the agent's response.
              // Queue the message and deliver it after the agent finishes.
              agentSession.queue.push({ senderName: primarySender, fullMessage: combinedMessage, serviceUrl: primaryServiceUrl });
              log("COLLECT_QUEUE", { agent: agentKey, conversation_id: conversationId, queue_length: agentSession.queue.length, sender: primarySender, reason: "group chat — collect mode" });
            } else {
              // ── DM: Interrupt + re-wake ──
              // User's new message supersedes the old one. Kill current work, restart with latest.
              const existingUUID = getSessionUUID(sKey);
              if (existingUUID) {
                log("INTERRUPT", { agent: agentKey, conversation_id: conversationId, text: combinedMessage.substring(0, 60), reason: "DM — interrupt + re-wake" });

                // Mark as intentionally interrupted so watchdog suppresses ⏳
                interruptedSessions.add(sKey);

                // Kill any in-flight CLI processes for this session
                // (antigravity-cli -a is fire-and-forget, we can't kill it directly,
                //  but we disarm the watchdog and re-wake cleanly)
                disarmWatchdog(sKey);

                // Re-wake with the new message
                busySessions.set(sKey, { busy: true, queue: [] });
                startReplyWatchdog(sKey, primaryServiceUrl);
                const agnt = AGENTS[agentKey];
                if (agnt?.engine === "claude") {
                  await wakeAgentClaude(agentKey, conversationId, primarySender, combinedMessage, primaryServiceUrl);
                } else {
                  await wakeAgent(agentKey, conversationId, primarySender, combinedMessage, primaryServiceUrl);
                }
                log("INTERRUPT_REWAKE", { agent: agentKey, conversation_id: conversationId });
              } else {
                agentSession.queue.push({ senderName: primarySender, fullMessage: combinedMessage, serviceUrl: primaryServiceUrl });
                log("QUEUED", { agent: agentKey, conversation_id: conversationId, queue_length: agentSession.queue.length, reason: "no UUID yet" });
              }
            }
          } else {
            busySessions.set(sKey, { busy: true, queue: [] });
            log("BUSY_SET", { agent: agentKey, conversation_id: conversationId, session_key: sKey });
            startReplyWatchdog(sKey, primaryServiceUrl);
            // Dispatch to the right engine
            const agent = AGENTS[agentKey];
            if (agent?.engine === "claude") {
              await wakeAgentClaude(agentKey, conversationId, primarySender, combinedMessage, primaryServiceUrl);
            } else {
              await wakeAgent(agentKey, conversationId, primarySender, combinedMessage, primaryServiceUrl);
            }
          }
        }
      });

    } catch (err) {
      log("ERROR", { error: err.message });
      if (!res.writableEnded) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  // ── Agent reply endpoint (called via curl from agent sessions — only used for DM/bot replies) ──
  if (req.method === "POST" && req.url === "/reply") {
    try {
      const { conversation_id, text, agent: agentField } = await parseBody(req);

      if (!conversation_id || !text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Need conversation_id and text" }));
        return;
      }

      const agentKey = agentField || Object.keys(AGENTS).find(k => AGENTS[k].isDefault) || "mini";
      const sKey = sessionKey(conversation_id, agentKey);

      let replyCtx = pendingReplies.get(conversation_id);
      if (!replyCtx) {
        // Fallback: try persisted serviceUrl from disk (survives bridge restarts)
        const persistedUrl = getPersistedServiceUrl(conversation_id);
        if (persistedUrl) {
          log("RECOVER", { msg: "Recovered serviceUrl from disk (main server)", conversation_id });
          replyCtx = { serviceUrl: persistedUrl, conversationId: conversation_id };
          pendingReplies.set(conversation_id, replyCtx);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No pending reply context for this conversation" }));
          return;
        }
      }

      // ── SESSION DOCTOR: record success ──
      const responseTimer = activeResponseTimers.get(sKey);
      if (responseTimer) {
        const elapsed = responseTimer();
        activeResponseTimers.delete(sKey);
        log("RESPONSE_TIME", { agent: agentKey, conversation_id, elapsed_ms: elapsed });
      }
      doctor.recordSuccess(sKey);

      // Clear busy state
      const rsession = busySessions.get(sKey);
      const queuedMessages = rsession?.queue?.length > 0 ? [...rsession.queue] : [];
      busySessions.delete(sKey);
      log("BUSY_CLEAR", { agent: agentKey, conversation_id, session_key: sKey, had_session: !!rsession, queue_drained: queuedMessages.length });

      // Track that this agent was the last to speak
      lastResponder.set(conversation_id, agentKey);

      // Only stop typing when NO agents are still busy
      const anyStillBusy = Object.keys(AGENTS).some(k => busySessions.has(sessionKey(conversation_id, k)));
      if (!anyStillBusy) {
        stopTyping(conversation_id);
      }

      // Human-like delay before sending (OpenClaw pattern)
      await humanDelay();

      // Now send the reply to Teams
      await sendToTeams(replyCtx.serviceUrl, replyCtx.conversationId, text);

      log("OUT", {
        agent: agentKey,
        conversation_id,
        text: text.substring(0, 100) + (text.length > 100 ? "..." : "")
      });
      logConvo(conversation_id, "assistant", text, agentKey);

      // Collect drain — batch ALL queued messages into one prompt (OpenClaw pattern)
      if (queuedMessages.length > 0) {
        const serviceUrl = replyCtx.serviceUrl;
        await drainCollect(agentKey, conversation_id, queuedMessages, serviceUrl);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, agent: agentKey, conversation_id }));
    } catch (err) {
      log("REPLY_ERROR", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Health check ──
  if (req.method === "GET" && (req.url === "/health" || req.url === "/status")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    // Check Antigravity health for status report
    const agStatus = await isAntigravityAlive();
    const fallbackStatus = {};
    for (const [key, client] of claudeFallbackPool) {
      fallbackStatus[key] = client.getSessionInfo();
    }
    res.end(JSON.stringify({
      status: "ok",
      bridge: "teams",
      version: "1.5",
      app_id: MICROSOFT_APP_ID.substring(0, 8) + "...",
      reply_port: REPLY_PORT,
      workspace: WORKSPACE,
      cli: CLI_PATH,
      features: ["session_doctor", "collect_queue", "typing_sm", "watchdog_touch", "human_delay", "debounce", "envelope", "graph_api", "multi_agent", "claude_fallback"],
      antigravity_health: {
        alive: agStatus.alive,
        consecutive_failures: agStatus.consecutiveFailures,
        last_check: agStatus.lastCheck ? new Date(agStatus.lastCheck).toISOString() : null,
        error: agStatus.error,
      },
      claude_fallback_pool: fallbackStatus,
      claude_bridge: claudeBridge ? claudeBridge.status() : null,
      session_doctor: doctor.getStatus(),
    }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ═══════════════════════════════════════════
// REPLY SERVER (separate port for JARVIS curl)
// ═══════════════════════════════════════════
const replyServer = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/reply") {
    try {
      const { conversation_id, text, agent: agentField } = await parseBody(req);

      if (!conversation_id || !text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Need conversation_id and text" }));
        return;
      }

      // ── NO_REPLY: Agent responded via Graph API, just clear that agent's busy session ──
      // Multi-agent aware: accepts optional `agent` field to clear the right session.
      if (text === "NO_REPLY") {
        const agentKey = agentField || Object.keys(AGENTS).find(k => AGENTS[k].isDefault) || "mini";
        const sKey = sessionKey(conversation_id, agentKey);

        disarmWatchdog(sKey);

        // ── SESSION DOCTOR: record success (NO_REPLY = agent responded via Graph API) ──
        const responseTimer = activeResponseTimers.get(sKey);
        if (responseTimer) {
          const elapsed = responseTimer();
          activeResponseTimers.delete(sKey);
          log("RESPONSE_TIME", { agent: agentKey, conversation_id, elapsed_ms: elapsed, via: "graph_api" });
        }
        doctor.recordSuccess(sKey);

        const rsession = busySessions.get(sKey);
        const queuedMessages = rsession?.queue?.length > 0 ? [...rsession.queue] : [];
        busySessions.delete(sKey);
        log("NO_REPLY", { agent: agentKey, conversation_id, session_key: sKey, had_session: !!rsession, queue_drained: queuedMessages.length, reason: "agent replied via Graph API" });

        // Only stop typing when NO agents are still busy for this conversation
        const anyStillBusy = Object.keys(AGENTS).some(k => busySessions.has(sessionKey(conversation_id, k)));
        if (!anyStillBusy) {
          stopTyping(conversation_id);
        }

        // Collect drain — batch ALL queued messages into one prompt (OpenClaw pattern)
        if (queuedMessages.length > 0) {
          const serviceUrl = pendingReplies.get(conversation_id)?.serviceUrl || getPersistedServiceUrl(conversation_id);
          if (serviceUrl) {
            await drainCollect(agentKey, conversation_id, queuedMessages, serviceUrl);
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, no_reply: true, agent: agentKey }));
        return;
      }

      let replyCtx = pendingReplies.get(conversation_id);
      if (!replyCtx) {
        // Fallback: try persisted serviceUrl from disk (survives bridge restarts)
        const persistedUrl = getPersistedServiceUrl(conversation_id);
        if (persistedUrl) {
          log("RECOVER", { msg: "Recovered serviceUrl from disk", conversation_id });
          replyCtx = { serviceUrl: persistedUrl, conversationId: conversation_id };
          pendingReplies.set(conversation_id, replyCtx); // cache for future replies
        } else {
          log("WARN", { msg: "No reply context found (in-memory or on disk)", conversation_id });
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No reply context — Teams conversation expired" }));
          return;
        }
      }

      // Use agent key from the request (reply server always has agentField from NO_REPLY path above)
      const replyAgentKey = agentField || Object.keys(AGENTS).find(k => AGENTS[k].isDefault) || "mini";
      const replySKey = sessionKey(conversation_id, replyAgentKey);

      // Clear busy state
      const rsession = busySessions.get(replySKey);
      const queuedMessages = rsession?.queue?.length > 0 ? [...rsession.queue] : [];
      busySessions.delete(replySKey);
      log("BUSY_CLEAR", { agent: replyAgentKey, conversation_id, session_key: replySKey, had_session: !!rsession, queue_drained: queuedMessages.length, server: "reply" });

      // Cancel watchdog — reply arrived
      disarmWatchdog(replySKey);

      // Only stop typing when NO agents are still busy
      const anyStillBusy2 = Object.keys(AGENTS).some(k => busySessions.has(sessionKey(conversation_id, k)));
      if (!anyStillBusy2) {
        stopTyping(conversation_id);
      }

      // Human-like delay before sending (OpenClaw pattern)
      await humanDelay();

      await sendToTeams(replyCtx.serviceUrl, replyCtx.conversationId, text);

      log("OUT", {
        agent: replyAgentKey,
        conversation_id,
        text: text.substring(0, 100) + (text.length > 100 ? "..." : "")
      });
      logConvo(conversation_id, "assistant", text, replyAgentKey);

      // Collect drain — batch ALL queued messages into one prompt (OpenClaw pattern)
      if (queuedMessages.length > 0) {
        const serviceUrl = replyCtx.serviceUrl;
        await drainCollect(replyAgentKey, conversation_id, queuedMessages, serviceUrl);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, agent: replyAgentKey }));
    } catch (err) {
      log("REPLY_ERROR", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── POST /notify — Proactive messaging (Mini → Tony via Teams) ──
  if (req.method === "POST" && req.url === "/notify") {
    try {
      const { text, conversation_id } = await parseBody(req);

      if (!text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Need text" }));
        return;
      }

      // Find a conversation to send to
      let targetConvoId = conversation_id;
      let serviceUrl = null;

      if (targetConvoId) {
        // Specific conversation requested
        serviceUrl = getPersistedServiceUrl(targetConvoId);
      }

      if (!serviceUrl) {
        // No specific target or unknown conversation — find any known conversation
        const registry = loadSessionRegistry();
        for (const [convoId, entry] of Object.entries(registry)) {
          const url = typeof entry === "object" ? entry.serviceUrl : null;
          if (url) {
            targetConvoId = convoId;
            serviceUrl = url;
            break;
          }
        }
      }

      if (!serviceUrl || !targetConvoId) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "No known conversation to send to. Mini needs to receive at least one message from Teams first."
        }));
        return;
      }

      await sendToTeams(serviceUrl, targetConvoId, text);
      log("NOTIFY", { conversation_id: targetConvoId, text: text.substring(0, 80) + (text.length > 80 ? "..." : "") });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, conversation_id: targetConvoId }));
    } catch (err) {
      log("NOTIFY_ERROR", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Health/Status check on reply server ──
  if (req.method === "GET" && (req.url === "/status" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      bridge: "teams",
      server: "reply",
      version: "1.0",
      reply_port: REPLY_PORT,
    }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

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

// ═══════════════════════════════════════════
// GRACEFUL RESTART — OpenClaw-style SIGUSR1
// ═══════════════════════════════════════════
const DRAIN_TIMEOUT_MS = 30_000;
let shuttingDown = false;

/**
 * Wait for all busy sessions to finish (up to timeout).
 * Returns true if all drained, false if timed out.
 */
function drainActiveSessions(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const activeCount = busySessions.size;
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

/**
 * Close an HTTP server gracefully.
 */
function closeServer(srv) {
  return new Promise((resolve) => {
    if (!srv || !srv.listening) {
      resolve();
      return;
    }
    srv.close(() => resolve());
    // Force-close after 5s if connections linger
    setTimeout(() => resolve(), 5000);
  });
}

async function performGracefulRestart(signal) {
  if (shuttingDown) {
    log("SYSTEM", { event: "restart_ignored", reason: "already shutting down", signal });
    return;
  }
  shuttingDown = true;
  log("SYSTEM", { event: "graceful_restart_start", signal, active_sessions: busySessions.size });

  // Step 1: Drain active sessions (give them time to finish)
  if (busySessions.size > 0) {
    log("SYSTEM", { event: "draining", count: busySessions.size, timeout_ms: DRAIN_TIMEOUT_MS });
    await drainActiveSessions(DRAIN_TIMEOUT_MS);
  }

  // Step 2: Stop all watchdogs and typing indicators
  for (const [convId, watchdog] of replyWatchdogs.entries()) {
    clearTimeout(watchdog.timer);
    replyWatchdogs.delete(convId);
  }
  for (const [convId, entry] of typingStates.entries()) {
    if (entry.interval) clearInterval(entry.interval);
    if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
    typingStates.delete(convId);
  }

  // Step 2.5: Shut down ClaudeBridge workers
  if (claudeBridge) {
    log("SYSTEM", { event: "claude_bridge_shutdown", workers: claudeBridge.workers.size });
    await claudeBridge.shutdown();
  }

  // Step 3: Close both HTTP servers
  log("SYSTEM", { event: "closing_servers" });
  await Promise.all([closeServer(server), closeServer(replyServer)]);

  // Step 4: Clean exit — launchd KeepAlive will restart us with fresh code
  // This is intentional: process.exit ensures the new process loads updated
  // files from disk. In-process restart would keep stale code in memory.
  log("SYSTEM", { event: "graceful_exit", msg: "Clean exit for launchd restart — fresh code will be loaded", signal });
  process.exit(0);
}

// Signal handlers
process.on("SIGUSR1", () => {
  log("SYSTEM", { event: "signal_received", signal: "SIGUSR1" });
  performGracefulRestart("SIGUSR1");
});

process.on("SIGTERM", () => {
  log("SYSTEM", { event: "signal_received", signal: "SIGTERM" });
  log("SYSTEM", { event: "stopping" });
  exec(`curl -s -d "🏢 Teams bridge stopping (SIGTERM)" ntfy.sh/tonysM5`);
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log("FATAL", { error: err.message, stack: err.stack });
  exec(`curl -s -d "🚨 Teams bridge crash: ${err.message}" ntfy.sh/tonysM5`);
});

// ═══════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════
async function startBridge() {
  // Check if another instance is already running on our ports
  const mainInUse = await checkPortInUse(HTTP_PORT, "0.0.0.0");
  const replyInUse = await checkPortInUse(REPLY_PORT, "127.0.0.1");

  if (mainInUse || replyInUse) {
    log("SYSTEM", {
      event: "already_running",
      main_port_busy: mainInUse,
      reply_port_busy: replyInUse,
      message: "Another Teams bridge instance is already running — exiting cleanly."
    });
    console.log("⚠️  Teams bridge already running on port(s). Exiting to avoid duplicate.");
    process.exit(0);
  }

  // Start servers (no restart loop — SIGUSR1 exits cleanly, launchd restarts with fresh code)
  server.listen(HTTP_PORT, "0.0.0.0", () => {
    log("SYSTEM", { event: "teams_bridge_ready", port: HTTP_PORT });

    replyServer.listen(REPLY_PORT, "127.0.0.1", () => {
      log("SYSTEM", {
        event: "teams_bridge_started",
        version: "1.3",
        bot_framework_port: HTTP_PORT,
        reply_port: REPLY_PORT,
        app_id: MICROSOFT_APP_ID.substring(0, 8) + "...",
        workspace: WORKSPACE,
        cli: CLI_PATH,
        features: ["graceful_restart", "proactive_notify", "dedup", "busy_gate", "watchdog", "session_doctor"],
      });

      console.log(`
╔══════════════════════════════════════════════════════╗
║  🦀🏢 HermitCrab Teams Bridge  v1.3                  ║
║                                                      ║
║  Bot Framework: http://0.0.0.0:${HTTP_PORT}              ║
║  Reply endpoint: http://127.0.0.1:${REPLY_PORT}          ║
║  App ID: ${MICROSOFT_APP_ID.substring(0, 8)}...                       ║
║  Graceful restart: kill -USR1 ${process.pid}                ║
║                                                      ║
║  Messaging endpoint for Azure Bot:                   ║
║  https://<your-funnel>/api/messages                  ║
╚══════════════════════════════════════════════════════╝
      `);
    });
  });
}

startBridge();

