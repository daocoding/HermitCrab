#!/usr/bin/env node
/**
 * 🦀🌊 HermitCrab Claude Stream Client — session-resuming AI wrapper
 * 
 * Uses the @anthropic-ai/claude-agent-sdk to send messages to Claude Code,
 * with session persistence via resume. Each sendMessage() creates a fresh
 * query() but resumes the same session for conversation continuity.
 * 
 * This approach is simpler and more reliable than keeping a single generator
 * alive across messages — it mirrors how `claude --print --resume` works.
 */

const { EventEmitter } = require("events");

class ClaudeStreamClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.model] - Model (default: "sonnet")
   * @param {string} [opts.systemPrompt] - System prompt text
   * @param {string} [opts.sessionId] - Existing session ID to resume
   * @param {string} [opts.workspace] - Working directory
   * @param {string[]} [opts.addDirs] - Additional directories
   * @param {string} [opts.permissionMode] - Permission mode (default: "default")
   * @param {string[]} [opts.allowedTools] - Tool allowlist
   * @param {function} [opts.log] - Logging function
   */
  constructor(opts) {
    super();
    this.model = opts.model || "sonnet";
    this.systemPrompt = opts.systemPrompt || null;
    this.sessionId = opts.sessionId || null;
    this.workspace = opts.workspace || process.cwd();
    this.addDirs = opts.addDirs || [];
    this.permissionMode = opts.permissionMode || "default";
    this.allowedTools = opts.allowedTools || [];
    this.log = opts.log || console.log;

    this._sdk = null;
    this._alive = true; // Consider "alive" as long as the client object exists
    this._startedAt = Date.now();
    this._messageCount = 0;
    this._lastCostUsd = 0;
    this._busy = false; // Whether a message is currently being processed
  }

  _loadSdk() {
    if (!this._sdk) {
      this._sdk = require("@anthropic-ai/claude-agent-sdk");
    }
    return this._sdk;
  }

  /**
   * Send a user message and wait for the complete response.
   * Creates a fresh query() per message, resuming the session.
   * 
   * @param {string} message - The user's message
   * @param {number} [timeoutMs=180000] - Timeout in ms
   * @returns {Promise<{text: string, sessionId: string, costUsd: number, model: string, status: string}>}
   */
  async sendMessage(message, timeoutMs = 180000) {
    if (this._busy) {
      throw new Error("A message is already being processed");
    }

    this._busy = true;
    this._messageCount++;

    const sdk = this._loadSdk();

    const options = {
      model: this.model,
      permissionMode: this.permissionMode,
      cwd: this.workspace,
    };

    if (this.systemPrompt) options.systemPrompt = this.systemPrompt;
    if (this.addDirs.length > 0) options.additionalDirectories = this.addDirs;
    if (this.allowedTools.length > 0) options.allowedTools = this.allowedTools;
    if (this.sessionId) options.resume = this.sessionId;

    this.log(`[ClaudeStream] Sending message #${this._messageCount} (session=${this.sessionId || "new"}, model=${this.model})`);

    try {
      const queryGen = sdk.query({ prompt: message, options });

      let resultText = "";
      let resultSessionId = this.sessionId;
      let resultCost = 0;
      let resultStatus = "completed";

      // Set up timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Claude response timeout (${timeoutMs}ms)`)), timeoutMs);
      });

      const processPromise = (async () => {
        for await (const msg of queryGen) {
          if (msg.type === "system" && msg.subtype === "init") {
            if (msg.session_id) {
              resultSessionId = msg.session_id;
              if (msg.session_id !== this.sessionId) {
                this.sessionId = msg.session_id;
                this.emit("session_id", msg.session_id);
                this.log(`[ClaudeStream] Session ID: ${msg.session_id}`);
              }
            }
          } else if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                resultText += block.text;
                this.emit("delta", block.text);
              }
            }
          } else if (msg.type === "result") {
            resultSessionId = msg.session_id || resultSessionId;
            resultText = msg.result || resultText;
            resultCost = msg.total_cost_usd || 0;
            resultStatus = msg.subtype === "success" ? "completed" : msg.subtype;

            if (resultSessionId && resultSessionId !== this.sessionId) {
              this.sessionId = resultSessionId;
              this.emit("session_id", resultSessionId);
            }

            this._lastCostUsd = resultCost;
          }
        }

        return {
          text: resultText,
          sessionId: resultSessionId,
          costUsd: resultCost,
          model: this.model,
          status: resultStatus,
        };
      })();

      const result = await Promise.race([processPromise, timeoutPromise]);
      
      this.log(`[ClaudeStream] Response: ${result.text?.length || 0} chars, $${result.costUsd}, status=${result.status}`);
      return result;

    } catch (err) {
      this.log(`[ClaudeStream] Error: ${err.message}`);
      throw err;
    } finally {
      this._busy = false;
    }
  }

  /**
   * Convenience: start is a no-op since we create per-message queries.
   * Exists for API compatibility with the bridge code.
   */
  async start() {
    this._alive = true;
    this.log("[ClaudeStream] Client ready (per-message query mode)");
    return this.sessionId;
  }

  stop() {
    this.log("[ClaudeStream] Client stopped");
    this._alive = false;
    this.emit("exit", { reason: "stopped" });
  }

  isAlive() {
    return this._alive && !this._busy; // Alive and not stuck
  }

  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      alive: this._alive,
      messageCount: this._messageCount,
      startedAt: this._startedAt,
      uptime: Date.now() - this._startedAt,
      model: this.model,
      lastCostUsd: this._lastCostUsd,
      busy: this._busy,
    };
  }
}

module.exports = ClaudeStreamClient;
