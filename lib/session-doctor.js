#!/usr/bin/env node
//
// 🩺 Session Doctor — Self-healing session management for HermitCrab bridges
//
// Closes the autonomy gap between Antigravity (human-in-the-loop) and OpenClaw (fully autonomous).
// Builds autonomy AROUND the Antigravity runtime.
//
// Features:
//   ✅ Stuck session detection — monitors response times, detects zombies
//   ✅ Auto-session rotation — if session is zombie, creates fresh one with context migration
//   ✅ Quota-aware routing — proactive model switching before user hits errors
//   ✅ Session health scoring — tracks success/failure rates per session
//   ✅ Cooldown persistence — survives bridge restarts
//

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

class SessionDoctor {
  constructor(options = {}) {
    this.workspace = options.workspace || process.cwd();
    this.cliPath = options.cliPath || path.join(process.env.HOME, ".local/bin/antigravity-cli");
    this.pathEnv = options.pathEnv || `${path.dirname(this.cliPath)}:${process.env.PATH}`;
    this.log = options.log || ((dir, data) => console.log(JSON.stringify({ direction: dir, ...data, ts: new Date().toISOString() })));
    
    // ── Health tracking ──
    this.sessionHealth = new Map(); // sessionKey → SessionHealthRecord
    
    // ── Config ──
    this.config = {
      // Stuck detection
      maxConsecutiveFailures: 3,       // failures before rotation
      stuckThresholdMs: 5 * 60 * 1000, // 5 min — if session hasn't responded in this time, it's suspect
      zombieThresholdMs: 10 * 60 * 1000, // 10 min — definitely zombie
      
      // Session rotation
      maxSessionAge: 24 * 60 * 60 * 1000, // 24 hours — rotate even if healthy (fresh start)
      
      // Quota management (cache handled by quota.js)
      quotaThreshold: 0.2,              // 20% remaining → switch
      premiumModelLabel: "Claude Opus 4.6 (Thinking)",
      fallbackModel: "gemini-3.1-pro",
      
      // Cooldown
      cooldownFile: path.join(this.workspace, "hermitcrab", "session-doctor-state.json"),
      
      ...options.config,
    };
    
    // Load persisted state
    this._loadState();
  }
  
  // ═══════════════════════════════════════════
  // SESSION HEALTH TRACKING
  // ═══════════════════════════════════════════
  
  /**
   * Get or create a health record for a session.
   */
  _getHealthRecord(sessionKey) {
    if (!this.sessionHealth.has(sessionKey)) {
      this.sessionHealth.set(sessionKey, {
        sessionKey,
        createdAt: Date.now(),
        lastSuccessAt: null,
        lastFailureAt: null,
        lastWakeAt: null,
        consecutiveFailures: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        totalWakes: 0,
        avgResponseMs: null,
        lastResponseMs: null,
        rotationCount: 0,     // how many times this chat has had its session rotated
        lastError: null,
      });
    }
    return this.sessionHealth.get(sessionKey);
  }
  
  /**
   * Record that we're about to wake a session.
   * Returns a timer function to call when the response arrives.
   */
  recordWake(sessionKey) {
    const record = this._getHealthRecord(sessionKey);
    record.lastWakeAt = Date.now();
    record.totalWakes++;
    
    // Return a timer function
    const startTime = Date.now();
    return () => {
      const elapsed = Date.now() - startTime;
      record.lastResponseMs = elapsed;
      if (record.avgResponseMs === null) {
        record.avgResponseMs = elapsed;
      } else {
        // Exponential moving average (α=0.3)
        record.avgResponseMs = record.avgResponseMs * 0.7 + elapsed * 0.3;
      }
      return elapsed;
    };
  }
  
  /**
   * Record a successful response from the session.
   */
  recordSuccess(sessionKey) {
    const record = this._getHealthRecord(sessionKey);
    record.lastSuccessAt = Date.now();
    record.consecutiveFailures = 0;
    record.totalSuccesses++;
    
    this.log("DOCTOR_OK", {
      session_key: sessionKey,
      consecutive_failures: 0,
      total: `${record.totalSuccesses}/${record.totalSuccesses + record.totalFailures}`,
      avg_response_ms: record.avgResponseMs ? Math.round(record.avgResponseMs) : null,
    });
  }
  
  /**
   * Record a failure from the session.
   * @param {string} errorType - 'timeout', 'quota', 'crash', 'cli_error', 'no_response'
   * @param {string} errorDetail - additional error info
   */
  recordFailure(sessionKey, errorType, errorDetail = "") {
    const record = this._getHealthRecord(sessionKey);
    record.lastFailureAt = Date.now();
    record.consecutiveFailures++;
    record.totalFailures++;
    record.lastError = { type: errorType, detail: errorDetail, at: Date.now() };
    
    this.log("DOCTOR_FAIL", {
      session_key: sessionKey,
      error_type: errorType,
      consecutive_failures: record.consecutiveFailures,
      threshold: this.config.maxConsecutiveFailures,
      detail: errorDetail.substring(0, 100),
    });
    
    // If this is a quota error, also set cooldown
    if (errorType === "quota") {
      this._handleQuotaError(errorDetail);
    }
    
    this._persistState();
  }
  
  /**
   * Check the health of a session and recommend an action.
   * 
   * @returns {{ action: 'proceed'|'rotate'|'warn', reason: string, health: object }}
   */
  checkHealth(sessionKey) {
    const record = this._getHealthRecord(sessionKey);
    const now = Date.now();
    
    // Check 1: Too many consecutive failures → rotate
    if (record.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      return {
        action: "rotate",
        reason: `${record.consecutiveFailures} consecutive failures (threshold: ${this.config.maxConsecutiveFailures})`,
        health: this._summarizeHealth(record),
      };
    }
    
    // Check 2: Session age — if older than 24h, suggest rotation
    if (record.createdAt && (now - record.createdAt) > this.config.maxSessionAge) {
      return {
        action: "rotate",
        reason: `Session is ${Math.round((now - record.createdAt) / 3600000)}h old (max: ${Math.round(this.config.maxSessionAge / 3600000)}h)`,
        health: this._summarizeHealth(record),
      };
    }
    
    // Check 3: Last wake was recent but no success → potentially stuck
    if (record.lastWakeAt && !record.lastSuccessAt && (now - record.lastWakeAt) > this.config.stuckThresholdMs) {
      return {
        action: "rotate",
        reason: `No response in ${Math.round((now - record.lastWakeAt) / 60000)} min since last wake`,
        health: this._summarizeHealth(record),
      };
    }
    
    // Check 4: Last success was long ago but we've been waking → zombie
    if (record.lastSuccessAt && record.lastWakeAt && 
        record.lastWakeAt > record.lastSuccessAt &&
        (now - record.lastSuccessAt) > this.config.zombieThresholdMs) {
      return {
        action: "rotate",
        reason: `Last success was ${Math.round((now - record.lastSuccessAt) / 60000)} min ago, woke since then but no response`,
        health: this._summarizeHealth(record),
      };
    }
    
    // Check 5: Warn if failure rate is high (>50% of last 10)
    const total = record.totalSuccesses + record.totalFailures;
    if (total >= 5 && record.totalFailures / total > 0.5) {
      return {
        action: "warn",
        reason: `High failure rate: ${record.totalFailures}/${total} (${Math.round(record.totalFailures / total * 100)}%)`,
        health: this._summarizeHealth(record),
      };
    }
    
    return {
      action: "proceed",
      reason: "healthy",
      health: this._summarizeHealth(record),
    };
  }
  
  /**
   * Mark a session as rotated (old session replaced with new one).
   */
  recordRotation(sessionKey) {
    const record = this._getHealthRecord(sessionKey);
    record.rotationCount++;
    // Reset health counters for the new session
    record.consecutiveFailures = 0;
    record.totalSuccesses = 0;
    record.totalFailures = 0;
    record.totalWakes = 0;
    record.lastSuccessAt = null;
    record.lastFailureAt = null;
    record.lastWakeAt = null;
    record.lastError = null;
    record.createdAt = Date.now();
    record.avgResponseMs = null;
    record.lastResponseMs = null;
    
    this.log("DOCTOR_ROTATE", {
      session_key: sessionKey,
      total_rotations: record.rotationCount,
    });
    
    this._persistState();
  }
  
  /**
   * Build a context migration prompt for a new session that replaces a rotated one.
   * This carries forward essential context so the new session isn't starting blind.
   */
  buildMigrationPrompt(originalPromptTemplate, extras = {}) {
    const lines = [
      "[Session Migration Notice]",
      "Your previous session became unresponsive and has been replaced with this fresh session.",
      "All your identity, memory, and context files are intact — read them as you normally would.",
      "Continue serving the user as if nothing happened.",
    ];
    
    if (extras.lastUserMessage) {
      lines.push(`\nThe user's most recent message was: "${extras.lastUserMessage}"`);
    }
    
    if (extras.rotationCount > 1) {
      lines.push(`\n⚠️ This is rotation #${extras.rotationCount}. If you're seeing this repeatedly, there may be a systemic issue. Mention this to the user.`);
    }
    
    return lines.join("\n") + "\n\n" + originalPromptTemplate;
  }
  
  // ═══════════════════════════════════════════
  // QUOTA-AWARE MODEL SELECTION
  // ═══════════════════════════════════════════
  
  /**
   * Select the best model to use, considering quotas and cooldowns.
   * 
   * @param {string} preferredModel - the model we'd like to use
   * @returns {Promise<{ model: string, reason: string, switched: boolean }>}
   */
  async selectModel(preferredModel) {
    // Check cooldown first (cheapest check)
    if (this._isCooldownActive(preferredModel)) {
      const remaining = Math.round((this._state.cooldown.expiresAt - Date.now()) / 60000);
      return {
        model: this.config.fallbackModel,
        reason: `cooldown_active (${remaining}min remaining)`,
        switched: true,
        cooldownRemaining: remaining,
      };
    }
    
    // Check quota API
    try {
      const quotas = await this._fetchQuotas();
      const remaining = quotas[this.config.premiumModelLabel];
      
      if (remaining !== undefined && remaining < this.config.quotaThreshold) {
        this.log("DOCTOR_QUOTA_LOW", {
          model: preferredModel,
          remaining: Math.round(remaining * 100) + "%",
          threshold: Math.round(this.config.quotaThreshold * 100) + "%",
        });
        return {
          model: this.config.fallbackModel,
          reason: `quota_low (${Math.round(remaining * 100)}% remaining)`,
          switched: true,
          quotaRemaining: remaining,
        };
      }
    } catch (e) {
      // Quota check failed — proceed with preferred model
      this.log("DOCTOR_QUOTA_ERR", { error: e.message });
    }
    
    return {
      model: preferredModel,
      reason: "healthy",
      switched: false,
    };
  }
  
  // ═══════════════════════════════════════════
  // PROACTIVE SESSION HEALTH MONITOR
  // Runs on interval, checks all tracked sessions
  // ═══════════════════════════════════════════
  
  /**
   * Start the background health monitor.
   * @param {function} onRotationNeeded - callback(sessionKey, health) when rotation is needed
   */
  startMonitor(onRotationNeeded, intervalMs = 60000) {
    if (this._monitorInterval) clearInterval(this._monitorInterval);
    
    this._monitorInterval = setInterval(() => {
      for (const [sessionKey, record] of this.sessionHealth) {
        const check = this.checkHealth(sessionKey);
        if (check.action === "rotate" && onRotationNeeded) {
          this.log("DOCTOR_MONITOR_ROTATE", { session_key: sessionKey, reason: check.reason });
          onRotationNeeded(sessionKey, check);
        }
      }
    }, intervalMs);
    
    this.log("DOCTOR_MONITOR_START", { interval_ms: intervalMs, tracked_sessions: this.sessionHealth.size });
  }
  
  stopMonitor() {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
      this._monitorInterval = null;
    }
  }
  
  // ═══════════════════════════════════════════
  // STATUS / DIAGNOSTICS
  // ═══════════════════════════════════════════
  
  /**
   * Get a diagnostic summary of all tracked sessions.
   */
  getStatus() {
    const sessions = [];
    for (const [key, record] of this.sessionHealth) {
      sessions.push(this._summarizeHealth(record));
    }
    
    return {
      tracked_sessions: sessions.length,
      cooldown: this._state.cooldown.active ? {
        model: this._state.cooldown.model,
        remaining_min: Math.round((this._state.cooldown.expiresAt - Date.now()) / 60000),
        label: this._state.cooldown.label,
      } : null,
      sessions,
    };
  }
  
  // ═══════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════
  
  _summarizeHealth(record) {
    const now = Date.now();
    return {
      session_key: record.sessionKey,
      age_min: record.createdAt ? Math.round((now - record.createdAt) / 60000) : null,
      consecutive_failures: record.consecutiveFailures,
      success_rate: (record.totalSuccesses + record.totalFailures) > 0
        ? Math.round(record.totalSuccesses / (record.totalSuccesses + record.totalFailures) * 100) + "%"
        : "n/a",
      total_wakes: record.totalWakes,
      avg_response_ms: record.avgResponseMs ? Math.round(record.avgResponseMs) : null,
      last_success_ago: record.lastSuccessAt ? Math.round((now - record.lastSuccessAt) / 60000) + "min" : "never",
      last_error: record.lastError?.type || null,
      rotations: record.rotationCount,
    };
  }
  
  _handleQuotaError(errorDetail) {
    // Parse cooldown duration from error message
    const match = errorDetail.match(/reset after (\d+)h(\d+)m(\d+)?s?/i);
    let durationMs, label;
    
    if (match) {
      const hours = parseInt(match[1]);
      const minutes = parseInt(match[2]);
      const seconds = parseInt(match[3] || 0);
      durationMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
      label = `${hours}h${minutes}m`;
    } else {
      // Fallback: 6 hours
      durationMs = 6 * 60 * 60 * 1000;
      label = "~6h (estimated)";
    }
    
    this._state.cooldown = {
      active: true,
      model: this.config.premiumModelLabel,
      expiresAt: Date.now() + durationMs,
      label,
    };
    
    this.log("DOCTOR_COOLDOWN_SET", { duration_ms: durationMs, label, expires_at: new Date(this._state.cooldown.expiresAt).toISOString() });
    this._persistState();
  }
  
  _isCooldownActive(model) {
    const cd = this._state.cooldown;
    if (!cd.active) return false;
    
    // Check if the requested model matches the cooled-down model
    // Match both the label and short name
    const modelLower = model.toLowerCase();
    const cdModelLower = (cd.model || "").toLowerCase();
    if (!cdModelLower.includes("claude") && !modelLower.includes("claude")) return false;
    if (cdModelLower.includes("claude") !== modelLower.includes("claude")) return false;
    
    if (Date.now() >= cd.expiresAt) {
      cd.active = false;
      this.log("DOCTOR_COOLDOWN_EXPIRED", { model: cd.model });
      this._persistState();
      return false;
    }
    
    return true;
  }
  
  async _fetchQuotas() {
    const quotaMod = require("../bridge/quota");
    return quotaMod.getCachedQuotaFractions("JARVIS");
  }
  
  _loadState() {
    this._state = {
      cooldown: { active: false, model: null, expiresAt: null, label: "" },
      lastSaved: null,
    };
    
    try {
      if (fs.existsSync(this.config.cooldownFile)) {
        const data = JSON.parse(fs.readFileSync(this.config.cooldownFile, "utf-8"));
        if (data.cooldown?.expiresAt && Date.now() < data.cooldown.expiresAt) {
          this._state.cooldown = { ...data.cooldown, active: true };
          this.log("DOCTOR_STATE_LOADED", { cooldown_remaining_min: Math.round((data.cooldown.expiresAt - Date.now()) / 60000) });
        }
      }
    } catch (e) {
      this.log("DOCTOR_STATE_LOAD_ERR", { error: e.message });
    }
  }
  
  _persistState() {
    try {
      this._state.lastSaved = new Date().toISOString();
      const dir = path.dirname(this.config.cooldownFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.config.cooldownFile, JSON.stringify(this._state, null, 2));
    } catch (e) {
      this.log("DOCTOR_STATE_SAVE_ERR", { error: e.message });
    }
  }
}

module.exports = SessionDoctor;
