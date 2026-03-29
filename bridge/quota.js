/**
 * 📊 Quota Module — Antigravity model usage & reset times
 * 
 * Extracted from bridge.js for testability.
 * Discovers the Language Server process, calls GetUserStatus RPC,
 * and formats the response into a Telegram-friendly message.
 */

const http = require("http");
const https = require("https");
const { exec } = require("child_process");

// ═══════════════════════════════════════════
// PURE FUNCTIONS (easily unit-testable)
// ═══════════════════════════════════════════

/**
 * Parse LS process line to extract PID and CSRF token.
 * @param {string} psLine - A single line from `ps -eo pid,args` output
 * @returns {{ pid: string, csrfToken: string } | null}
 */
function parseLSProcessLine(psLine) {
  if (!psLine || !psLine.trim()) return null;
  
  const csrfMatch = psLine.match(/--csrf_token\s+(\S+)/);
  if (!csrfMatch) return null;
  
  const pid = psLine.trim().split(/\s+/)[0];
  if (!pid || isNaN(parseInt(pid))) return null;
  
  return { pid, csrfToken: csrfMatch[1] };
}

/**
 * Select the best LS process line from multiple candidates.
 * Prefers JARVIS workspace, falls back to the first line.
 * @param {string[]} lines - Lines from ps output
 * @param {string} [preferWorkspace="JARVIS"] - Workspace hint to prefer
 * @returns {string | null}
 */
function selectBestLSLine(lines, preferWorkspace = "JARVIS") {
  if (!lines || lines.length === 0) return null;
  return lines.find(l => l.includes(preferWorkspace)) || lines[0];
}

/**
 * Parse lsof output to extract listening ports.
 * @param {string} lsofOutput - Output from `lsof -i -P -n`
 * @returns {number[]}
 */
function parseLsofPorts(lsofOutput) {
  if (!lsofOutput) return [];
  const matches = [...lsofOutput.matchAll(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/g)];
  return matches.map(m => parseInt(m[1]));
}

/**
 * Extract quota-relevant data from the raw GetUserStatus RPC response.
 * @param {object} rpcResponse - Raw response from GetUserStatus RPC
 * @returns {{ models: object[], tier: string, userName: string, email: string }}
 */
function extractQuotaData(rpcResponse) {
  const us = rpcResponse?.userStatus || {};
  return {
    models: us?.cascadeModelConfigData?.clientModelConfigs || [],
    tier: us?.userTier?.name || us?.planStatus?.planInfo?.teamsTier || "Unknown",
    userName: us?.name || "",
    email: us?.email || "",
  };
}

/**
 * Render a progress bar string.
 * @param {number} fraction - 0.0 to 1.0
 * @returns {string}
 */
function renderBar(fraction) {
  const pct = Math.round(fraction * 100);
  const filled = Math.round(fraction * 10);
  const empty = 10 - filled;
  const emoji = pct > 50 ? "🟢" : pct > 20 ? "🟡" : "🔴";
  return `${emoji} ${"█".repeat(filled)}${"░".repeat(empty)} ${pct}%`;
}

/**
 * Format time remaining until reset.
 * @param {string} isoStr - ISO 8601 reset time
 * @param {Date} [now] - Current time (injectable for testing)
 * @returns {string}
 */
function timeUntilReset(isoStr, now = new Date()) {
  const reset = new Date(isoStr);
  const diffMs = reset - now;
  if (diffMs <= 0) return "resetting now";
  const hrs = Math.floor(diffMs / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
}

/**
 * Format reset time as a readable local time string.
 * @param {string} isoStr - ISO 8601 reset time
 * @returns {string} e.g. "9:38 PM" or "1:02 AM"
 */
function formatResetTime(isoStr) {
  const reset = new Date(isoStr);
  return reset.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/**
 * Format the full quota message for Telegram.
 * @param {object} quotaData - Output from extractQuotaData()
 * @param {string} machineName - Machine identity string
 * @param {Date} [now] - Current time (injectable for testing)
 * @returns {string}
 */
function formatQuotaMessage(quotaData, machineName, now = new Date()) {
  let msg = `📊 *Antigravity Quota* — ${quotaData.tier}\n🖥️ ${machineName} · ${quotaData.userName}\n\n`;
  
  for (const m of quotaData.models) {
    if (!m.quotaInfo) continue;
    const frac = m.quotaInfo.remainingFraction ?? 1;
    const reset = m.quotaInfo.resetTime;
    const label = m.label.replace(/\(Thinking\)/g, "").trim();
    msg += `*${label}*\n${renderBar(frac)}  ↻ ${timeUntilReset(reset, now)}\n\n`;
  }
  
  return msg;
}


// ═══════════════════════════════════════════
// I/O FUNCTIONS (need integration tests)
// ═══════════════════════════════════════════

/**
 * Discover the Language Server process and extract connection info.
 * @param {string} [preferWorkspace="JARVIS"] - Workspace to prefer
 * @returns {Promise<{ ports: number[], csrfToken: string }>}
 */
function discoverLS(preferWorkspace = "JARVIS") {
  return new Promise((resolve, reject) => {
    exec(
      'ps -eo pid,args 2>/dev/null | grep language_server | grep csrf_token | grep -v grep',
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => {
        if (err) return reject(new Error("No Language Server found"));
        const lines = stdout.split('\n').filter(l => l.trim());
        const bestLine = selectBestLSLine(lines, preferWorkspace);
        if (!bestLine) return reject(new Error("No LS process found"));
        
        const parsed = parseLSProcessLine(bestLine);
        if (!parsed) return reject(new Error("Could not parse LS process line"));
        
        // Find ConnectRPC ports via lsof
        exec(
          `/usr/sbin/lsof -i -P -n -p ${parsed.pid} 2>/dev/null | grep LISTEN`,
          { encoding: 'utf8', timeout: 5000 },
          (err2, lsofOut) => {
            if (err2) return reject(new Error("lsof failed"));
            const ports = parseLsofPorts(lsofOut);
            if (ports.length === 0) return reject(new Error("No LS ports found"));
            resolve({ ports, csrfToken: parsed.csrfToken });
          }
        );
      }
    );
  });
}

/**
 * Call GetUserStatus RPC on a single port.
 * @param {number} port - Port to connect to
 * @param {boolean} useTls - Whether to use HTTPS
 * @param {string} csrfToken - CSRF token for authentication
 * @returns {Promise<object>}
 */
function callGetUserStatus(port, useTls, csrfToken) {
  return new Promise((resolve, reject) => {
    const httpMod = useTls ? https : http;
    const body = JSON.stringify({});
    const req = httpMod.request({
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-codeium-csrf-token': csrfToken,
      },
      rejectUnauthorized: false,
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Bad JSON: ${data.substring(0, 100)}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 100)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Try all discovered ports with HTTP and HTTPS until one works.
 * @param {number[]} ports - Ports to try
 * @param {string} csrfToken - CSRF token
 * @returns {Promise<object>}
 */
async function fetchUserStatus(ports, csrfToken) {
  for (const port of ports) {
    for (const tls of [false, true]) {
      try {
        return await callGetUserStatus(port, tls, csrfToken);
      } catch { /* try next */ }
    }
  }
  throw new Error("All LS ports failed");
}

/**
 * Full quota fetch: discover LS → call RPC → extract data.
 * @param {string} [preferWorkspace="JARVIS"]
 * @returns {Promise<object>} - Output from extractQuotaData()
 */
async function getQuotaData(preferWorkspace = "JARVIS") {
  const lsInfo = await discoverLS(preferWorkspace);
  const rpcResponse = await fetchUserStatus(lsInfo.ports, lsInfo.csrfToken);
  return extractQuotaData(rpcResponse);
}


// ═══════════════════════════════════════════
// CACHED QUOTA FRACTIONS — single source of truth
// All bridges and session-doctor share this cache.
// ═══════════════════════════════════════════
let _cachedFractions = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get quota fractions for all models, with shared in-memory cache.
 * Returns { "Claude Opus 4.6 (Thinking)": 0.85, "Gemini 3.1 Pro (High)": 1.0, ... }
 * 
 * @param {string} [preferWorkspace="JARVIS"] - Workspace hint for LS discovery
 * @returns {Promise<Object<string, number>>}
 */
async function getCachedQuotaFractions(preferWorkspace = "JARVIS") {
  const now = Date.now();
  if (_cachedFractions && (now - _cachedAt < CACHE_TTL_MS)) {
    return _cachedFractions;
  }

  const data = await getQuotaData(preferWorkspace);
  const fractions = {};
  for (const m of data.models) {
    if (m.label && m.quotaInfo && m.quotaInfo.remainingFraction !== undefined) {
      fractions[m.label] = m.quotaInfo.remainingFraction;
    }
  }
  _cachedFractions = fractions;
  _cachedAt = now;
  return fractions;
}

/** Manually invalidate the quota cache (e.g. after a quota error is detected). */
function invalidateQuotaCache() {
  _cachedFractions = null;
  _cachedAt = 0;
}

module.exports = {
  // Pure functions (unit-testable)
  parseLSProcessLine,
  selectBestLSLine,
  parseLsofPorts,
  extractQuotaData,
  renderBar,
  timeUntilReset,
  formatResetTime,
  formatQuotaMessage,
  // I/O functions (integration-testable)
  discoverLS,
  callGetUserStatus,
  fetchUserStatus,
  getQuotaData,
  // Cached quota — single source of truth for all consumers
  getCachedQuotaFractions,
  invalidateQuotaCache,
};
