#!/usr/bin/env node
/**
 * 🦀📊 HermitCrab Graph Auth — Token management for Microsoft Graph API
 * 
 * Supports:
 *   - Device code flow (initial auth)
 *   - Token caching to disk
 *   - Auto refresh using refresh_token
 *   - Concurrent-safe token access
 * 
 * Usage:
 *   const { getAccessToken, initDeviceCodeAuth } = require('./auth');
 *   
 *   // First time: interactive device code flow
 *   await initDeviceCodeAuth();
 *   
 *   // After that: auto-refreshing
 *   const token = await getAccessToken();
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const TENANT_ID = process.env.GRAPH_TENANT_ID || "5eb6506c-523d-4d8c-abd8-e247c483c80d";
const CLIENT_ID = process.env.GRAPH_CLIENT_ID || "888462f2-f034-4679-af50-8d83c9046ca1"; // Zen app
const TOKEN_FILE = process.env.GRAPH_TOKEN_FILE || path.join(__dirname, "tokens.json");
// Use .default to request all permissions configured in the app registration
// This avoids scope mismatch — Azure grants whatever the admin has approved
const SCOPES = "openid profile email offline_access https://graph.microsoft.com/.default";

// ═══════════════════════════════════════════
// HTTPS HELPERS
// ═══════════════════════════════════════════
function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : new URLSearchParams(body).toString();
    const options = {
      hostname,
      port: 443,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error(`JSON parse error: ${Buffer.concat(chunks).toString()}`));
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════
// TOKEN STORAGE
// ═══════════════════════════════════════════
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Failed to load tokens:", e.message);
  }
  return null;
}

function saveTokens(tokens) {
  const data = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
    scope: tokens.scope,
    saved_at: new Date().toISOString(),
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  return data;
}

// ═══════════════════════════════════════════
// DEVICE CODE FLOW — Interactive (run once)
// ═══════════════════════════════════════════
async function initDeviceCodeAuth() {
  console.log("\n🔐 Starting Microsoft Graph device code authentication...\n");

  // Step 1: Request device code
  const deviceCodeResponse = await httpsPost(
    "login.microsoftonline.com",
    `/${TENANT_ID}/oauth2/v2.0/devicecode`,
    {
      client_id: CLIENT_ID,
      scope: SCOPES,
    }
  );

  if (deviceCodeResponse.error) {
    throw new Error(`Device code request failed: ${deviceCodeResponse.error_description || deviceCodeResponse.error}`);
  }

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  📱 ACTION REQUIRED                                  ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Go to: https://microsoft.com/devicelogin`);
  console.log(`║  Enter code: ${deviceCodeResponse.user_code}`);
  console.log("╚══════════════════════════════════════════════════════╝\n");
  console.log(deviceCodeResponse.message);
  console.log("\nWaiting for you to authenticate...\n");

  // Step 2: Poll for token
  const interval = (deviceCodeResponse.interval || 5) * 1000;
  const expiresAt = Date.now() + (deviceCodeResponse.expires_in || 900) * 1000;

  while (Date.now() < expiresAt) {
    await sleep(interval);

    const tokenResponse = await httpsPost(
      "login.microsoftonline.com",
      `/${TENANT_ID}/oauth2/v2.0/token`,
      {
        client_id: CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCodeResponse.device_code,
      }
    );

    if (tokenResponse.access_token) {
      const saved = saveTokens(tokenResponse);
      console.log("✅ Authentication successful!");
      console.log(`   Token expires: ${new Date(saved.expires_at).toLocaleString()}`);
      console.log(`   Scopes: ${tokenResponse.scope}`);
      console.log(`   Saved to: ${TOKEN_FILE}\n`);
      return saved;
    }

    if (tokenResponse.error === "authorization_pending") {
      process.stdout.write(".");
      continue;
    }

    if (tokenResponse.error === "slow_down") {
      await sleep(5000); // Extra delay
      continue;
    }

    throw new Error(`Token polling failed: ${tokenResponse.error_description || tokenResponse.error}`);
  }

  throw new Error("Device code expired. Please try again.");
}

// ═══════════════════════════════════════════
// TOKEN REFRESH — Automatic
// ═══════════════════════════════════════════
async function refreshAccessToken(refreshToken) {
  const tokenResponse = await httpsPost(
    "login.microsoftonline.com",
    `/${TENANT_ID}/oauth2/v2.0/token`,
    {
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: SCOPES,
    }
  );

  if (tokenResponse.error) {
    throw new Error(`Token refresh failed: ${tokenResponse.error_description || tokenResponse.error}`);
  }

  return saveTokens(tokenResponse);
}

// ═══════════════════════════════════════════
// SELF-HEALING REAUTH — Mini requests device code via Teams
// ═══════════════════════════════════════════
let reauthInProgress = null; // Prevent concurrent reauth attempts

/**
 * Notify the user that re-authentication is needed.
 * Tries Teams bridge first, falls back to ntfy.sh.
 * Returns the device code response so the caller can poll.
 */
async function requestReauth() {
  if (reauthInProgress) {
    console.log("🔐 Re-auth already in progress, waiting...");
    return reauthInProgress;
  }

  reauthInProgress = (async () => {
    try {
      console.log("🔐 Graph token expired — initiating self-healing re-auth...");

      // Step 1: Get device code
      const deviceCodeResponse = await httpsPost(
        "login.microsoftonline.com",
        `/${TENANT_ID}/oauth2/v2.0/devicecode`,
        { client_id: CLIENT_ID, scope: SCOPES }
      );

      if (deviceCodeResponse.error) {
        throw new Error(`Device code request failed: ${deviceCodeResponse.error_description}`);
      }

      const userCode = deviceCodeResponse.user_code;
      const message = `🔐 **Graph API re-authentication needed**\n\n` +
        `My Graph token expired and I can't refresh it.\n\n` +
        `Please go to: https://microsoft.com/devicelogin\n` +
        `Enter code: **${userCode}**\n\n` +
        `I'll resume automatically once you complete this. ⏳`;

      // Step 2: Notify via all available channels
      await notifyUser(message, userCode);

      // Step 3: Poll for token completion
      const interval = (deviceCodeResponse.interval || 5) * 1000;
      const expiresAt = Date.now() + (deviceCodeResponse.expires_in || 900) * 1000;

      while (Date.now() < expiresAt) {
        await sleep(interval);

        const tokenResponse = await httpsPost(
          "login.microsoftonline.com",
          `/${TENANT_ID}/oauth2/v2.0/token`,
          {
            client_id: CLIENT_ID,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCodeResponse.device_code,
          }
        );

        if (tokenResponse.access_token) {
          const saved = saveTokens(tokenResponse);
          console.log("✅ Re-authentication successful!");
          
          // Notify success
          await notifyUser("✅ Graph API re-authenticated successfully! Resuming operations.", null);
          
          return saved;
        }

        if (tokenResponse.error === "authorization_pending") continue;
        if (tokenResponse.error === "slow_down") { await sleep(5000); continue; }
        
        throw new Error(`Reauth polling failed: ${tokenResponse.error_description}`);
      }

      throw new Error("Device code expired. Re-auth failed.");
    } finally {
      reauthInProgress = null;
    }
  })();

  return reauthInProgress;
}

/**
 * Send notification to Tony via available channels.
 * Priority: Teams bridge → ntfy.sh
 */
async function notifyUser(message, deviceCode) {
  const notifications = [];

  // Try Teams bridge (Mini's DM to Tony)
  try {
    const teamsReplyPort = process.env.TEAMS_REPLY_PORT || "18795";
    const notifyResult = await new Promise((resolve, reject) => {
      const http = require("http");
      const postData = JSON.stringify({
        type: "proactive",
        text: message,
      });
      const req = http.request({
        hostname: "127.0.0.1",
        port: parseInt(teamsReplyPort),
        path: "/notify",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      }, (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => resolve({ status: res.statusCode, data }));
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
      req.write(postData);
      req.end();
    });
    notifications.push(`Teams: ${notifyResult.status}`);
  } catch (e) {
    notifications.push(`Teams: failed (${e.message})`);
  }

  // Always also send via ntfy.sh as backup
  try {
    const ntfyMessage = deviceCode
      ? `🔐 Graph re-auth needed. Code: ${deviceCode}. Go to microsoft.com/devicelogin`
      : message;
    await httpsPost("ntfy.sh", "/tonysM5", ntfyMessage);
    notifications.push("ntfy: sent");
  } catch (e) {
    notifications.push(`ntfy: failed (${e.message})`);
  }

  console.log(`📢 Notifications: ${notifications.join(", ")}`);
}

// ═══════════════════════════════════════════
// GET ACCESS TOKEN — Main entry point (with self-healing)
// ═══════════════════════════════════════════
let cachedTokens = null;

async function getAccessToken() {
  // Try memory cache first
  if (cachedTokens && cachedTokens.expires_at > Date.now() + 60000) {
    return cachedTokens.access_token;
  }

  // Try disk cache
  const stored = loadTokens();
  if (!stored || !stored.refresh_token) {
    // No tokens at all — need initial setup
    throw new Error(
      "No Graph API tokens found. Run setup first:\n" +
      "  node hermitcrab/graph/setup.js"
    );
  }

  // Check if access token is still valid (with 60s buffer)
  if (stored.access_token && stored.expires_at > Date.now() + 60000) {
    cachedTokens = stored;
    return stored.access_token;
  }

  // Try to refresh
  try {
    console.log("🔄 Refreshing Graph API access token...");
    cachedTokens = await refreshAccessToken(stored.refresh_token);
    return cachedTokens.access_token;
  } catch (refreshError) {
    // Refresh failed — token expired beyond recovery
    console.error("⚠️ Token refresh failed:", refreshError.message);
    console.log("🔐 Attempting self-healing re-auth via device code flow...");
    
    // Self-heal: request new auth via Teams/ntfy
    const newTokens = await requestReauth();
    cachedTokens = newTokens;
    return cachedTokens.access_token;
  }
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════
module.exports = {
  initDeviceCodeAuth,
  getAccessToken,
  refreshAccessToken,
  requestReauth,
  loadTokens,
  TENANT_ID,
  CLIENT_ID,
  SCOPES,
};

