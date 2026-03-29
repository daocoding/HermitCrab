#!/usr/bin/env node
/**
 * 📊 Quota Module Tests — Unit + Integration
 * 
 * Run: node quota.test.js
 * 
 * Unit tests: always run, no external deps
 * Integration tests: only run when a Language Server is present
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseLSProcessLine,
  selectBestLSLine,
  parseLsofPorts,
  extractQuotaData,
  renderBar,
  timeUntilReset,
  formatResetTime,
  formatQuotaMessage,
  discoverLS,
  callGetUserStatus,
  fetchUserStatus,
  getQuotaData,
} = require("./quota");

// ═══════════════════════════════════════════
// UNIT TESTS — Pure functions, no I/O
// ═══════════════════════════════════════════

describe("parseLSProcessLine", () => {
  it("extracts PID and CSRF token from a standard ps line", () => {
    const line = "  992 /Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --enable_lsp --csrf_token 42f0ad6b-f721-4c6e-9a8c-64583b5bbb06 --extension_server_port 49199 --random_port --workspace_id file_Users_tony_Library_CloudStorage_OneDrive_ApexLearn_JARVIS";
    const result = parseLSProcessLine(line);
    assert.deepStrictEqual(result, {
      pid: "992",
      csrfToken: "42f0ad6b-f721-4c6e-9a8c-64583b5bbb06",
    });
  });

  it("returns null for empty input", () => {
    assert.strictEqual(parseLSProcessLine(""), null);
    assert.strictEqual(parseLSProcessLine(null), null);
    assert.strictEqual(parseLSProcessLine(undefined), null);
  });

  it("returns null when no csrf_token flag present", () => {
    const line = "992 /path/to/language_server --enable_lsp --random_port";
    assert.strictEqual(parseLSProcessLine(line), null);
  });

  it("handles lines with extra whitespace", () => {
    const line = "   1234   /path/to/language_server --csrf_token abc-123-def   ";
    const result = parseLSProcessLine(line);
    assert.deepStrictEqual(result, { pid: "1234", csrfToken: "abc-123-def" });
  });
});

describe("selectBestLSLine", () => {
  const lines = [
    "992 language_server --workspace_id file_Users_tony_JARVIS",
    "1911 language_server --workspace_id file_Users_tony_openclaw_Dao",
    "1833 language_server --workspace_id file_Users_tony_playground",
  ];

  it("prefers the line matching the workspace hint", () => {
    assert.ok(selectBestLSLine(lines, "JARVIS").includes("JARVIS"));
  });

  it("falls back to first line when no match", () => {
    assert.strictEqual(selectBestLSLine(lines, "nonexistent"), lines[0]);
  });

  it("returns null for empty array", () => {
    assert.strictEqual(selectBestLSLine([]), null);
    assert.strictEqual(selectBestLSLine(null), null);
  });

  it("returns first line when no workspace hint given", () => {
    assert.strictEqual(selectBestLSLine(lines, "nonexistent"), lines[0]);
  });
});

describe("parseLsofPorts", () => {
  it("extracts multiple 127.0.0.1 LISTEN ports", () => {
    const output = `language_   992 tony    4u     IPv4 0xa9cc   TCP 127.0.0.1:49201 (LISTEN)
language_   992 tony    5u     IPv4 0x7608   TCP 127.0.0.1:49202 (LISTEN)
language_   992 tony   23u     IPv4 0x2c2c   TCP 127.0.0.1:49210 (LISTEN)`;
    assert.deepStrictEqual(parseLsofPorts(output), [49201, 49202, 49210]);
  });

  it("ignores non-127.0.0.1 addresses", () => {
    const output = `rapportd    606 tony   10u     IPv4 0x837f   TCP *:49156 (LISTEN)
language_   992 tony    4u     IPv4 0xa9cc   TCP 127.0.0.1:49201 (LISTEN)`;
    assert.deepStrictEqual(parseLsofPorts(output), [49201]);
  });

  it("ignores ESTABLISHED connections", () => {
    const output = `language_   992 tony    4u     IPv4 0xa9cc   TCP 127.0.0.1:49201 (ESTABLISHED)
language_   992 tony    5u     IPv4 0x7608   TCP 127.0.0.1:49202 (LISTEN)`;
    assert.deepStrictEqual(parseLsofPorts(output), [49202]);
  });

  it("returns empty array for null/empty input", () => {
    assert.deepStrictEqual(parseLsofPorts(""), []);
    assert.deepStrictEqual(parseLsofPorts(null), []);
  });
});

describe("extractQuotaData", () => {
  // Real response structure from GetUserStatus RPC (captured from actual M4 LS)
  const realResponse = {
    userStatus: {
      name: "Tony Zhang",
      email: "sofuser@gmail.com",
      planStatus: {
        planInfo: { teamsTier: "TEAMS_TIER_PRO", planName: "Pro" },
      },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: "Gemini 3.1 Pro (Low)",
            quotaInfo: { remainingFraction: 1, resetTime: "2026-03-20T05:57:12Z" },
          },
          {
            label: "Claude Sonnet 4.6 (Thinking)",
            quotaInfo: { remainingFraction: 0.6, resetTime: "2026-03-19T22:38:03Z" },
          },
          {
            label: "Claude Opus 4.6 (Thinking)",
            quotaInfo: { remainingFraction: 0.6, resetTime: "2026-03-19T22:38:03Z" },
          },
        ],
      },
      userTier: { name: "Google AI Ultra" },
    },
  };

  it("extracts models from cascadeModelConfigData.clientModelConfigs", () => {
    const result = extractQuotaData(realResponse);
    assert.strictEqual(result.models.length, 3);
    assert.strictEqual(result.models[0].label, "Gemini 3.1 Pro (Low)");
  });

  it("prefers userTier.name for tier", () => {
    const result = extractQuotaData(realResponse);
    assert.strictEqual(result.tier, "Google AI Ultra");
  });

  it("falls back to planStatus.planInfo.teamsTier when userTier is absent", () => {
    const noUserTier = {
      userStatus: {
        name: "Test",
        planStatus: { planInfo: { teamsTier: "TEAMS_TIER_PRO" } },
        cascadeModelConfigData: { clientModelConfigs: [] },
      },
    };
    assert.strictEqual(extractQuotaData(noUserTier).tier, "TEAMS_TIER_PRO");
  });

  it("returns 'Unknown' tier when neither is present", () => {
    assert.strictEqual(extractQuotaData({}).tier, "Unknown");
  });

  it("handles null/undefined input gracefully", () => {
    const result = extractQuotaData(null);
    assert.deepStrictEqual(result.models, []);
    assert.strictEqual(result.tier, "Unknown");
    assert.strictEqual(result.userName, "");
  });

  // ❌ This is the bug we shipped — wrong path would return empty
  it("does NOT extract from agentConfig.chatModelConfigs (wrong path)", () => {
    const wrongStructure = {
      userStatus: {
        agentConfig: {
          chatModelConfigs: [{ label: "Wrong Path Model" }],
        },
      },
    };
    const result = extractQuotaData(wrongStructure);
    assert.strictEqual(result.models.length, 0, "Should NOT find models at agentConfig.chatModelConfigs");
  });
});

describe("renderBar", () => {
  it("shows green for > 50%", () => {
    assert.ok(renderBar(0.8).startsWith("🟢"));
    assert.ok(renderBar(0.8).includes("80%"));
  });

  it("shows yellow for 21-50%", () => {
    assert.ok(renderBar(0.3).startsWith("🟡"));
    assert.ok(renderBar(0.3).includes("30%"));
  });

  it("shows red for <= 20%", () => {
    assert.ok(renderBar(0.1).startsWith("🔴"));
    assert.ok(renderBar(0.1).includes("10%"));
  });

  it("handles boundary at exactly 0%", () => {
    const bar = renderBar(0);
    assert.ok(bar.includes("0%"));
    assert.ok(bar.startsWith("🔴"));
  });

  it("handles boundary at exactly 100%", () => {
    const bar = renderBar(1);
    assert.ok(bar.includes("100%"));
    assert.ok(bar.startsWith("🟢"));
  });

  it("bar length is always 10 characters (filled + empty)", () => {
    for (const frac of [0, 0.1, 0.3, 0.5, 0.7, 1.0]) {
      const bar = renderBar(frac);
      const blocks = (bar.match(/[█░]/g) || []).length;
      assert.strictEqual(blocks, 10, `Bar for ${frac} should have 10 blocks, got ${blocks}`);
    }
  });
});

describe("timeUntilReset", () => {
  const now = new Date("2026-03-19T22:00:00Z");

  it("formats hours and minutes", () => {
    assert.strictEqual(timeUntilReset("2026-03-20T01:30:00Z", now), "3h 30m");
  });

  it("formats minutes only when < 1 hour", () => {
    assert.strictEqual(timeUntilReset("2026-03-19T22:45:00Z", now), "45m");
  });

  it("returns 'resetting now' for past times", () => {
    assert.strictEqual(timeUntilReset("2026-03-19T21:00:00Z", now), "resetting now");
  });

  it("returns 'resetting now' for exact current time", () => {
    assert.strictEqual(timeUntilReset("2026-03-19T22:00:00Z", now), "resetting now");
  });

  it("handles zero minutes correctly", () => {
    assert.strictEqual(timeUntilReset("2026-03-20T00:00:00Z", now), "2h 0m");
  });
});

describe("formatResetTime", () => {
  it("formats UTC time to local 12h format", () => {
    const result = formatResetTime("2026-03-20T03:38:03Z");
    // Result depends on local timezone, but should have AM/PM
    assert.ok(/\d{1,2}:\d{2}\s*(AM|PM)/i.test(result), `Expected 12h format, got: ${result}`);
  });

  it("handles midnight boundary", () => {
    const result = formatResetTime("2026-03-20T05:00:00Z");
    assert.ok(/\d{1,2}:\d{2}\s*(AM|PM)/i.test(result));
  });
});

describe("formatQuotaMessage", () => {
  const now = new Date("2026-03-19T22:00:00Z");
  const quotaData = {
    tier: "Google AI Ultra",
    userName: "Tony Zhang",
    models: [
      { label: "Claude Sonnet 4.6 (Thinking)", quotaInfo: { remainingFraction: 0.6, resetTime: "2026-03-19T22:38:03Z" } },
      { label: "Gemini 3.1 Pro (High)", quotaInfo: { remainingFraction: 1.0, resetTime: "2026-03-20T05:43:53Z" } },
      { label: "Model Without Quota" }, // no quotaInfo
    ],
  };

  it("includes tier and machine name in header", () => {
    const msg = formatQuotaMessage(quotaData, "Mac-Mini", now);
    assert.ok(msg.includes("Google AI Ultra"));
    assert.ok(msg.includes("Mac-Mini"));
    assert.ok(msg.includes("Tony Zhang"));
  });

  it("strips (Thinking) from model labels", () => {
    const msg = formatQuotaMessage(quotaData, "Mac-Mini", now);
    assert.ok(msg.includes("Claude Sonnet 4.6"));
    assert.ok(!msg.includes("(Thinking)"));
  });

  it("skips models without quotaInfo", () => {
    const msg = formatQuotaMessage(quotaData, "Mac-Mini", now);
    assert.ok(!msg.includes("Model Without Quota"));
  });

  it("shows correct percentage and time", () => {
    const msg = formatQuotaMessage(quotaData, "Mac-Mini", now);
    assert.ok(msg.includes("60%"), "Should show 60% for Claude");
    assert.ok(msg.includes("100%"), "Should show 100% for Gemini");
    assert.ok(msg.includes("38m"), "Should show ~38m for Claude reset");
  });

  it("uses Markdown bold for model names", () => {
    const msg = formatQuotaMessage(quotaData, "Mac-Mini", now);
    assert.ok(msg.includes("*Claude Sonnet 4.6*"));
    assert.ok(msg.includes("*Gemini 3.1 Pro (High)*"));
  });
});


// ═══════════════════════════════════════════
// INTEGRATION TESTS — require running LS
// ═══════════════════════════════════════════

describe("Integration: LS Discovery", () => {
  let lsAvailable = false;

  before(async () => {
    try {
      await discoverLS();
      lsAvailable = true;
    } catch {
      console.log("  ⏭️  No Language Server running — skipping integration tests");
    }
  });

  it("discovers LS process with valid ports and CSRF token", async (t) => {
    if (!lsAvailable) return t.skip("No LS running");
    const info = await discoverLS();
    assert.ok(Array.isArray(info.ports), "ports should be an array");
    assert.ok(info.ports.length > 0, "should find at least one port");
    assert.ok(info.csrfToken, "CSRF token should be non-empty");
    assert.ok(info.csrfToken.includes("-"), "CSRF token should be UUID-like");
    for (const p of info.ports) {
      assert.ok(p > 0 && p < 65536, `Port ${p} should be valid`);
    }
  });

  it("at least one port responds to GetUserStatus RPC", async (t) => {
    if (!lsAvailable) return t.skip("No LS running");
    const info = await discoverLS();
    const response = await fetchUserStatus(info.ports, info.csrfToken);
    assert.ok(response, "Should get a response");
    assert.ok(response.userStatus, "Response should have userStatus");
  });

  it("RPC response has expected structure with quotaInfo", async (t) => {
    if (!lsAvailable) return t.skip("No LS running");
    const info = await discoverLS();
    const response = await fetchUserStatus(info.ports, info.csrfToken);
    
    const us = response.userStatus;
    assert.ok(us.name, "Should have user name");
    assert.ok(us.cascadeModelConfigData, "Should have cascadeModelConfigData");
    assert.ok(us.cascadeModelConfigData.clientModelConfigs, "Should have clientModelConfigs");
    
    const models = us.cascadeModelConfigData.clientModelConfigs;
    assert.ok(models.length > 0, "Should have at least one model");
    
    // Verify at least one model has quotaInfo
    const withQuota = models.filter(m => m.quotaInfo);
    assert.ok(withQuota.length > 0, "At least one model should have quotaInfo");
    
    const firstQuota = withQuota[0].quotaInfo;
    assert.ok(typeof firstQuota.remainingFraction === "number", "remainingFraction should be a number");
    assert.ok(firstQuota.remainingFraction >= 0, "remainingFraction should be >= 0");
    assert.ok(firstQuota.remainingFraction <= 1, "remainingFraction should be <= 1");
    assert.ok(firstQuota.resetTime, "Should have resetTime");
    assert.ok(!isNaN(new Date(firstQuota.resetTime).getTime()), "resetTime should be valid ISO date");
  });

  it("getQuotaData returns complete formatted data", async (t) => {
    if (!lsAvailable) return t.skip("No LS running");
    const data = await getQuotaData();
    assert.ok(data.models.length > 0, "Should have models");
    assert.ok(data.tier !== "Unknown", "Should resolve a real tier");
    assert.ok(data.userName, "Should have user name");
  });

  it("formatQuotaMessage produces valid Telegram output", async (t) => {
    if (!lsAvailable) return t.skip("No LS running");
    const data = await getQuotaData();
    const msg = formatQuotaMessage(data, "TestMachine");
    
    assert.ok(msg.startsWith("📊"), "Should start with chart emoji");
    assert.ok(msg.includes("TestMachine"), "Should include machine name");
    assert.ok(msg.includes("%"), "Should include percentages");
    assert.ok(msg.includes("↻"), "Should include reset time indicators");
    
    // Verify no (Thinking) leaked through
    assert.ok(!msg.includes("(Thinking)"), "Should strip (Thinking) suffix");
  });

  it("quota reset times are in the future (data freshness check)", async (t) => {
    if (!lsAvailable) return t.skip("No LS running");
    const data = await getQuotaData();
    const now = new Date();
    const modelsWithQuota = data.models.filter(m => m.quotaInfo?.resetTime);
    
    // At least some reset times should be in the future
    // (if ALL are in the past, the data is stale)
    const futureResets = modelsWithQuota.filter(m => new Date(m.quotaInfo.resetTime) > now);
    assert.ok(
      futureResets.length > 0,
      `At least one model should have a future reset time (got ${futureResets.length}/${modelsWithQuota.length} in future). ` +
      `If all are past, the LS cache may be stale.`
    );
  });

  it("models with same quota pool show identical fractions", async (t) => {
    if (!lsAvailable) return t.skip("No LS running");
    const data = await getQuotaData();
    
    // Claude Sonnet and Opus share the same quota pool — their fractions should match
    const claudeModels = data.models.filter(m => m.label?.includes("Claude") && m.quotaInfo);
    if (claudeModels.length >= 2) {
      const fractions = claudeModels.map(m => m.quotaInfo.remainingFraction);
      const allSame = fractions.every(f => f === fractions[0]);
      assert.ok(allSame, `Claude models should share quota pool but got different fractions: ${fractions.join(", ")}`);
    }
  });
});

describe("Integration: Error Handling", () => {
  it("callGetUserStatus rejects on wrong port", async () => {
    await assert.rejects(
      () => callGetUserStatus(1, false, "fake-token"),
      { message: /ECONNREFUSED|timeout|ECONNRESET/ }
    );
  });

  it("fetchUserStatus throws when all ports fail", async () => {
    await assert.rejects(
      () => fetchUserStatus([1, 2, 3], "fake-token"),
      { message: "All LS ports failed" }
    );
  });
});
