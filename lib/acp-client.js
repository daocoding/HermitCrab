#!/usr/bin/env node
/**
 * 🦀🔌 HermitCrab ACP Client — JSON-RPC over stdio to ACP agents
 * 
 * Manages long-running ACP agent subprocesses (e.g., claude-agent-acp).
 * Each session = one subprocess. Messages flow bidirectionally via JSON-RPC.
 * 
 * ACP Methods used:
 *   - session/new     → Start a new conversation
 *   - session/load    → Resume an existing conversation
 *   - session/update  → Notification from agent with streaming content
 * 
 * Reference: https://agentclientprotocol.com
 */

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const path = require("path");
const fs = require("fs");

class ACPClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.agentCommand - Path to ACP agent binary (e.g., "claude-agent-acp")
   * @param {string[]} [opts.agentArgs] - Additional args for the agent
   * @param {object} [opts.env] - Environment variables for the subprocess
   * @param {string} [opts.cwd] - Working directory for the subprocess
   * @param {function} [opts.log] - Logging function
   */
  constructor(opts) {
    super();
    this.agentCommand = opts.agentCommand;
    this.agentArgs = opts.agentArgs || [];
    this.env = opts.env || {};
    this.cwd = opts.cwd || process.cwd();
    this.log = opts.log || console.log;
    
    this.process = null;
    this.buffer = "";
    this.requestId = 0;
    this.pendingRequests = new Map(); // id → { resolve, reject, timeout }
    this.sessionId = null;
    this.alive = false;
    
    // Accumulated response text from session/update notifications
    this._responseChunks = [];
    this._responseResolve = null;
    this._responseTimeout = null;
  }

  /**
   * Spawn the ACP agent subprocess.
   * Must be called before sending any messages.
   */
  start() {
    if (this.process) {
      this.log("[ACP] Process already running");
      return;
    }

    const fullEnv = { ...process.env, ...this.env };
    
    this.log(`[ACP] Spawning: ${this.agentCommand} ${this.agentArgs.join(" ")}`);
    this.process = spawn(this.agentCommand, this.agentArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
      env: fullEnv,
    });

    this.alive = true;

    // Handle stdout — newline-delimited JSON-RPC messages
    this.process.stdout.on("data", (data) => {
      this.buffer += data.toString();
      this._processBuffer();
    });

    // Log stderr (agent diagnostics)
    this.process.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) this.log(`[ACP:stderr] ${msg}`);
    });

    this.process.on("exit", (code, signal) => {
      this.alive = false;
      this.log(`[ACP] Process exited: code=${code}, signal=${signal}`);
      this.emit("exit", { code, signal });
      
      // Reject any pending requests
      for (const [id, req] of this.pendingRequests) {
        clearTimeout(req.timeout);
        req.reject(new Error(`ACP process exited (code=${code})`));
      }
      this.pendingRequests.clear();
      this.process = null;
    });

    this.process.on("error", (err) => {
      this.alive = false;
      this.log(`[ACP] Process error: ${err.message}`);
      this.emit("error", err);
    });
  }

  /**
   * Process the newline-delimited JSON-RPC buffer.
   */
  _processBuffer() {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch (e) {
        this.log(`[ACP] Parse error: ${e.message} — line: ${trimmed.substring(0, 100)}`);
      }
    }
  }

  /**
   * Handle an incoming JSON-RPC message (response or notification).
   */
  _handleMessage(msg) {
    // JSON-RPC Response (has id)
    if ("id" in msg && msg.id !== null) {
      const req = this.pendingRequests.get(msg.id);
      if (req) {
        clearTimeout(req.timeout);
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          req.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          req.resolve(msg.result);
        }
      }
      return;
    }

    // JSON-RPC Notification (no id) — typically session/update
    if (msg.method === "session/update") {
      this._handleSessionUpdate(msg.params);
    } else if (msg.method) {
      this.log(`[ACP] Unhandled notification: ${msg.method}`);
      this.emit("notification", msg);
    }
  }

  /**
   * Handle session/update notifications from the agent.
   * These contain streaming message content, tool calls, etc.
   */
  _handleSessionUpdate(params) {
    if (!params) return;

    // The session/update contains the full or partial session state.
    // We're interested in the messages array — specifically assistant messages.
    const messages = params.messages || [];
    
    // Look for the latest assistant message content
    for (const message of messages) {
      if (message.role === "assistant" && message.content) {
        // Content can be a string or array of content blocks
        let text = "";
        if (typeof message.content === "string") {
          text = message.content;
        } else if (Array.isArray(message.content)) {
          text = message.content
            .filter(block => block.type === "text")
            .map(block => block.text)
            .join("");
        }
        if (text) {
          this._responseChunks = [text]; // Replace, don't append (full state updates)
        }
      }
    }

    // Check if the session is complete (status field)
    const status = params.status;
    if (status === "completed" || status === "stopped" || status === "error") {
      this.emit("session_complete", {
        status,
        text: this._responseChunks.join(""),
        sessionId: params.sessionId || this.sessionId,
      });
      
      if (this._responseResolve) {
        clearTimeout(this._responseTimeout);
        this._responseResolve({
          status,
          text: this._responseChunks.join(""),
          sessionId: params.sessionId || this.sessionId,
        });
        this._responseResolve = null;
      }
    }

    this.emit("update", params);
  }

  /**
   * Send a JSON-RPC request to the agent.
   * @returns {Promise<any>} The result from the agent
   */
  _sendRequest(method, params, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.alive) {
        reject(new Error("ACP process not running"));
        return;
      }

      const id = ++this.requestId;
      const msg = {
        jsonrpc: "2.0",
        id,
        method,
        params: params || {},
      };

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP request timeout (${method}, ${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      
      try {
        this.process.stdin.write(JSON.stringify(msg) + "\n");
      } catch (e) {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(new Error(`Failed to write to ACP stdin: ${e.message}`));
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  _sendNotification(method, params) {
    if (!this.process || !this.alive) return;
    
    const msg = {
      jsonrpc: "2.0",
      method,
      params: params || {},
    };

    try {
      this.process.stdin.write(JSON.stringify(msg) + "\n");
    } catch (e) {
      this.log(`[ACP] Failed to send notification: ${e.message}`);
    }
  }

  /**
   * Start a new ACP session.
   * @param {string} userMessage - The initial message from the user
   * @param {string} [systemPrompt] - Optional system prompt / persona
   * @param {number} [timeoutMs] - Response timeout (default: 2 minutes)
   * @returns {Promise<{text: string, sessionId: string, status: string}>}
   */
  async newSession(userMessage, systemPrompt, timeoutMs = 120000) {
    if (!this.alive) this.start();
    
    this._responseChunks = [];
    
    const params = {
      message: {
        role: "user",
        content: userMessage,
      },
    };

    if (systemPrompt) {
      params.systemPrompt = systemPrompt;
    }

    // Send session/new — this returns immediately with session info
    const result = await this._sendRequest("session/new", params, 30000);
    this.sessionId = result?.sessionId || result?.session_id;
    this.log(`[ACP] New session created: ${this.sessionId}`);

    // Wait for the agent to finish processing (session/update with completed status)
    return this._waitForCompletion(timeoutMs);
  }

  /**
   * Resume an existing session with a new message.
   * @param {string} sessionId - The session ID to resume
   * @param {string} userMessage - The follow-up message
   * @param {number} [timeoutMs] - Response timeout  
   * @returns {Promise<{text: string, sessionId: string, status: string}>}
   */
  async resumeSession(sessionId, userMessage, timeoutMs = 120000) {
    if (!this.alive) this.start();
    
    this._responseChunks = [];
    this.sessionId = sessionId;

    const params = {
      sessionId: sessionId,
      message: {
        role: "user",
        content: userMessage,
      },
    };

    // session/load to resume, then the message triggers processing
    const result = await this._sendRequest("session/load", params, 30000);
    
    // Wait for completion
    return this._waitForCompletion(timeoutMs);
  }

  /**
   * Wait for the session to complete (session/update with terminal status).
   */
  _waitForCompletion(timeoutMs) {
    return new Promise((resolve, reject) => {
      this._responseResolve = resolve;
      this._responseTimeout = setTimeout(() => {
        this._responseResolve = null;
        // Return whatever we have so far
        const partialText = this._responseChunks.join("");
        if (partialText) {
          resolve({
            status: "timeout",
            text: partialText,
            sessionId: this.sessionId,
          });
        } else {
          reject(new Error(`ACP response timeout (${timeoutMs}ms)`));
        }
      }, timeoutMs);
    });
  }

  /**
   * Gracefully stop the ACP process.
   */
  stop() {
    if (this.process) {
      this.log("[ACP] Stopping agent process");
      this.process.kill("SIGTERM");
      // Force kill after 5s
      setTimeout(() => {
        if (this.process) {
          this.process.kill("SIGKILL");
          this.process = null;
        }
      }, 5000);
    }
  }

  /**
   * Check if the agent process is alive.
   */
  isAlive() {
    return this.alive && this.process !== null;
  }
}

module.exports = ACPClient;
