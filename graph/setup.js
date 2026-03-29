#!/usr/bin/env node
/**
 * 🦀📊 HermitCrab Graph Setup — One-time device code authentication
 * 
 * Run this once to authenticate with Microsoft Graph:
 *   node hermitcrab/graph/setup.js
 * 
 * After that, tokens auto-refresh and no interaction is needed.
 */

const { initDeviceCodeAuth, getAccessToken } = require("./auth");
const https = require("https");

async function graphGet(token, endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://graph.microsoft.com/v1.0${endpoint}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };
    const req = https.request(options, (res) => {
      let chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  // Step 1: Authenticate
  await initDeviceCodeAuth();

  // Step 2: Verify — test the token
  console.log("\n🧪 Verifying access...\n");
  const token = await getAccessToken();

  // Test: Who am I?
  const me = await graphGet(token, "/me");
  if (me.status === 200) {
    console.log(`✅ /me — ${me.data.displayName} (${me.data.userPrincipalName})`);
  } else {
    console.log(`❌ /me — ${me.status}: ${JSON.stringify(me.data)}`);
  }

  // Test: Calendar
  const cal = await graphGet(token, "/me/calendar");
  if (cal.status === 200) {
    console.log(`✅ Calendar — ${cal.data.name}`);
  } else {
    console.log(`⚠️  Calendar — ${cal.status} (may need Calendars.ReadWrite permission)`);
  }

  // Test: OneDrive
  const drive = await graphGet(token, "/me/drive");
  if (drive.status === 200) {
    console.log(`✅ OneDrive — ${drive.data.driveType} (${(drive.data.quota?.total / 1e9).toFixed(1)} GB)`);
  } else {
    console.log(`⚠️  OneDrive — ${drive.status} (may need Files.ReadWrite permission)`);
  }

  // Test: Planner
  const plans = await graphGet(token, "/me/planner/tasks?$top=1");
  if (plans.status === 200) {
    console.log(`✅ Planner — ${plans.data.value?.length ?? 0} tasks accessible`);
  } else {
    console.log(`⚠️  Planner — ${plans.status} (may need Tasks.ReadWrite permission)`);
  }

  console.log("\n🎉 Graph API setup complete! Mini can now use these capabilities.\n");
}

main().catch((err) => {
  console.error("❌ Setup failed:", err.message);
  process.exit(1);
});
