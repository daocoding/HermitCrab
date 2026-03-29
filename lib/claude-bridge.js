#!/usr/bin/env node
/**
 * 🦀🌉 ClaudeBridge v1 — ACP Agent Lifecycle Manager (SDK-based)
 *
 * Uses @anthropic-ai/claude-agent-sdk in-process to manage persistent
 * Claude Code agent sessions. One session per thread-per-agent (v1).
 *
 * Architecture:
 *   Teams message → teams-bridge.js (routing)
 *     → ClaudeBridge (this module)
 *       → sdk.query() with resume for session persistence
 *       → stream response → forward to Teams via Graph API
 *
 * Design locked 2026-03-27 by Cody, Big, and JARVIS in Group 0.
 *
 * Key decisions:
 *   - SDK in-process, not subprocess (claude --print doesn't speak ACP)
 *   - Session persistence via sdk.query({ options: { resume: sessionId } })
 *   - One session per thread-per-agent (v1), multiplexing (v2)
 *   - Out-of-band cancel via AbortController
 *   - Crash recovery: detect error → new session → re-queue
 */

const { EventEmitter } = require("events");

// ═══════════════════════════════════════════
// ClaudeBridgeSession — Persistent SDK-based agent session
// ═══════════════════════════════════════════
class ClaudeBridgeSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.sessionKey - Unique key (conversationId::agentKey)
   * @param {string} [opts.model] - Model (default: "opus")
   * @param {string} [opts.systemPrompt] - Persona/system prompt
   * @param {string} [opts.cwd] - Working directory
   * @param {string[]} [opts.addDirs] - Additional directories
   * @param {string} [opts.permissionMode] - Permission mode
   * @param {string[]} [opts.allowedTools] - Tool allowlist
   * @param {function} [opts.log] - Logger
   */
  constructor(opts) {
    super();
    this.sessionKey = opts.sessionKey;
    this.model = opts.model || "opus";
    this.systemPrompt = opts.systemPrompt || null;
    this.cwd = opts.cwd || process.cwd();
    this.addDirs = opts.addDirs || [];
    this.permissionMode = opts.permissionMode || "default";
    this.allowedTools = opts.allowedTools || [];
    this.log = opts.log || console.log;

    this.sessionId = null;
    this._sdk = null;
    this._busy = false;
    this._abortController = null;

    // Stats
    this.turnsCompleted = 0;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.lastCostUsd = 0;
    this.totalCostUsd = 0;
  }

  _loadSdk() {
    if (!this._sdk) {
      this._sdk = require("@anthropic-ai/claude-agent-sdk");
    }
    return this._sdk;
  }

  /**
   * Run a turn — send message, wait for complete response.
   * Uses sdk.query() with resume for session persistence.
   * @param {string} userMessage
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=180000]
   * @returns {Promise<{text: string, sessionId: string, status: string, costUsd: number, toolCalls: Array}>}
   */
  async runTurn(userMessage, opts = {}) {
    const timeoutMs = opts.timeoutMs || 180000;

    if (this._busy) {
      throw new Error("Turn already in progress — cancel first or wait");
    }

    this._busy = true;
    this._abortController = new AbortController();
    this.lastActivity = Date.now();

    const sdk = this._loadSdk();

    const options = {
      model: this.model,
      cwd: this.cwd,
      permissionMode: this.permissionMode,
    };

    if (this.systemPrompt) options.systemPrompt = this.systemPrompt;
    if (this.addDirs.length > 0) options.additionalDirectories = this.addDirs;
    if (this.allowedTools.length > 0) options.allowedTools = this.allowedTools;
    if (this.sessionId) options.resume = this.sessionId;

    this.log(`[CB:${this.sessionKey}] Turn start (session=${this.sessionId || "new"}, model=${this.model})`);

    try {
      const queryGen = sdk.query({ prompt: userMessage, options });

      let resultText = "";
      let resultSessionId = this.sessionId;
      let resultCost = 0;
      let resultStatus = "completed";
      const toolCalls = [];

      // Timeout race
      const timeoutPromise = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Turn timeout (${timeoutMs}ms)`)), timeoutMs);
        // Clear timeout if abort fires first
        this._abortController.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      });

      // Abort race
      const abortPromise = new Promise((resolve) => {
        this._abortController.signal.addEventListener("abort", () => {
          resolve({ text: resultText, sessionId: resultSessionId, status: "cancelled", costUsd: resultCost, toolCalls });
        }, { once: true });
      });

      const processPromise = (async () => {
        for await (const msg of queryGen) {
          // Check abort between messages
          if (this._abortController.signal.aborted) break;

          if (msg.type === "system" && msg.subtype === "init") {
            if (msg.session_id) {
              resultSessionId = msg.session_id;
              if (msg.session_id !== this.sessionId) {
                this.sessionId = msg.session_id;
                this.log(`[CB:${this.sessionKey}] Session ID: ${msg.session_id}`);
              }
            }
          } else if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                resultText += block.text;
                this.emit("delta", { text: block.text, sessionKey: this.sessionKey });
              }
              if (block.type === "tool_use") {
                toolCalls.push({ id: block.id, name: block.name, input: block.input });
                this.emit("tool_call", { tool: block, sessionKey: this.sessionKey });
              }
            }
          } else if (msg.type === "result") {
            resultSessionId = msg.session_id || resultSessionId;
            resultText = msg.result || resultText;
            resultCost = msg.total_cost_usd || 0;
            resultStatus = msg.subtype === "success" ? "completed" : msg.subtype;

            if (resultSessionId && resultSessionId !== this.sessionId) {
              this.sessionId = resultSessionId;
            }
          }
        }

        return { text: resultText, sessionId: resultSessionId, status: resultStatus, costUsd: resultCost, toolCalls };
      })();

      const result = await Promise.race([processPromise, timeoutPromise, abortPromise]);

      this.turnsCompleted++;
      this.lastCostUsd = result.costUsd || 0;
      this.totalCostUsd += this.lastCostUsd;
      this.lastActivity = Date.now();

      this.log(`[CB:${this.sessionKey}] Turn done: ${result.text?.length || 0} chars, $${result.costUsd}, status=${result.status}`);
      this.emit("turn_complete", { ...result, sessionKey: this.sessionKey });

      return result;

    } catch (err) {
      this.log(`[CB:${this.sessionKey}] Turn error: ${err.message}`);
      throw err;
    } finally {
      this._busy = false;
      this._abortController = null;
    }
  }

  /**
   * Cancel the current turn — out-of-band via AbortController.
   * @param {string} [reason]
   */
  cancelTurn(reason = "user_interrupt") {
    if (!this._busy || !this._abortController) {
      this.log(`[CB:${this.sessionKey}] No active turn to cancel`);
      return;
    }
    this.log(`[CB:${this.sessionKey}] Cancelling turn: ${reason}`);
    this._abortController.abort(reason);
  }

  /**
   * Reset session — force next turn to create a fresh session.
   */
  resetSession() {
    this.log(`[CB:${this.sessionKey}] Session reset (was: ${this.sessionId})`);
    this.sessionId = null;
  }

  isBusy() { return this._busy; }

  getInfo() {
    return {
      sessionKey: this.sessionKey,
      sessionId: this.sessionId,
      busy: this._busy,
      turnsCompleted: this.turnsCompleted,
      uptimeMs: Date.now() - this.createdAt,
      lastActivity: this.lastActivity,
      totalCostUsd: this.totalCostUsd,
      model: this.model,
    };
  }
}

// ═══════════════════════════════════════════
// ClaudeBridge — Session Pool & Lifecycle Manager
// ═══════════════════════════════════════════
class ClaudeBridge extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.model] - Default model
   * @param {string} [opts.cwd] - Default working directory
   * @param {string[]} [opts.addDirs] - Default additional directories
   * @param {string} [opts.permissionMode] - Default permission mode
   * @param {string[]} [opts.allowedTools] - Default tool allowlist
   * @param {number} [opts.maxRetries=2] - Max retries on session failure
   * @param {number} [opts.defaultTimeout=180000] - Default turn timeout
   * @param {function} [opts.log] - Logger
   */
  constructor(opts = {}) {
    super();
    this.defaultModel = opts.model || "opus";
    this.defaultCwd = opts.cwd || process.cwd();
    this.defaultAddDirs = opts.addDirs || [];
    this.defaultPermissionMode = opts.permissionMode || "default";
    this.defaultAllowedTools = opts.allowedTools || [];
    this.maxRetries = opts.maxRetries || 2;
    this.defaultTimeout = opts.defaultTimeout || 180000;
    this.log = opts.log || console.log;

    /** @type {Map<string, ClaudeBridgeSession>} */
    this.sessions = new Map();
  }

  /**
   * Get or create a session for a session key.
   * @param {string} sessionKey
   * @param {object} [sessionOpts] - Override session options
   * @returns {ClaudeBridgeSession}
   */
  getSession(sessionKey, sessionOpts = {}) {
    let session = this.sessions.get(sessionKey);
    if (session) return session;

    session = new ClaudeBridgeSession({
      sessionKey,
      model: sessionOpts.model || this.defaultModel,
      systemPrompt: sessionOpts.systemPrompt || null,
      cwd: sessionOpts.cwd || this.defaultCwd,
      addDirs: sessionOpts.addDirs || this.defaultAddDirs,
      permissionMode: sessionOpts.permissionMode || this.defaultPermissionMode,
      allowedTools: sessionOpts.allowedTools || this.defaultAllowedTools,
      log: this.log,
    });

    // Bubble events
    session.on("delta", (data) => this.emit("delta", data));
    session.on("tool_call", (data) => this.emit("tool_call", data));
    session.on("turn_complete", (data) => this.emit("turn_complete", data));

    this.sessions.set(sessionKey, session);
    return session;
  }

  /**
   * Run a turn on a session. Creates session if needed.
   * Handles retries with session reset on failure.
   * @param {string} sessionKey
   * @param {string} userMessage
   * @param {object} [opts]
   * @returns {Promise<{text: string, sessionId: string, status: string, costUsd: number, toolCalls: Array}>}
   */
  async runTurn(sessionKey, userMessage, opts = {}) {
    const session = this.getSession(sessionKey, opts);
    const timeoutMs = opts.timeoutMs || this.defaultTimeout;

    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.log(`[CB] Retry ${attempt}/${this.maxRetries} for ${sessionKey} (resetting session)`);
          session.resetSession();
          // Backoff
          await new Promise(r => setTimeout(r, [1000, 3000][attempt - 1] || 3000));
        }

        return await session.runTurn(userMessage, { timeoutMs });
      } catch (err) {
        lastError = err;
        this.log(`[CB] Turn failed for ${sessionKey}: ${err.message}`);

        // If session-related error, retry with fresh session
        const isSessionError = err.message.includes("not found")
          || err.message.includes("Cannot resume")
          || err.message.includes("invalid session");

        if (!isSessionError && attempt > 0) {
          // Non-session errors don't benefit from retry
          break;
        }
      }
    }

    this.emit("session_failed", { sessionKey, error: lastError?.message, retries: this.maxRetries });
    throw lastError;
  }

  /**
   * Cancel the active turn on a session.
   */
  cancelTurn(sessionKey, reason = "user_interrupt") {
    const session = this.sessions.get(sessionKey);
    if (session) session.cancelTurn(reason);
  }

  /**
   * Remove a session from the pool.
   */
  removeSession(sessionKey) {
    const session = this.sessions.get(sessionKey);
    if (session && session.isBusy()) {
      session.cancelTurn("session_removed");
    }
    this.sessions.delete(sessionKey);
  }

  /**
   * Shutdown all sessions.
   */
  async shutdown() {
    this.log(`[CB] Shutting down ${this.sessions.size} sessions`);
    for (const [key, session] of this.sessions) {
      if (session.isBusy()) session.cancelTurn("shutdown");
    }
    this.sessions.clear();
    this.log("[CB] All sessions shut down");
  }

  /**
   * Get status of all sessions.
   */
  status() {
    const sessions = {};
    for (const [key, session] of this.sessions) {
      sessions[key] = session.getInfo();
    }
    return {
      sessionCount: this.sessions.size,
      sessions,
    };
  }
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════
module.exports = {
  ClaudeBridge,
  ClaudeBridgeSession,
};
