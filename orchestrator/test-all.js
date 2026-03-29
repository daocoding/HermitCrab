#!/usr/bin/env node
/**
 * 🧪 Orchestrator Test Runner — runs all three tiers
 * Usage: node test-all.js
 */

const { execSync } = require("child_process");
const path = require("path");

const DIR = __dirname;
const tests = [
  { name: "Unit Tests", file: "test-unit.js" },
  { name: "Integration Tests", file: "test-integration.js" },
  { name: "Smoke Tests", file: "test-smoke.js" },
];

let allPassed = true;

console.log("\n🦀🧪 Orchestrator Test Suite\n" + "═".repeat(50));

for (const t of tests) {
  console.log(`\n▶ Running ${t.name}...`);
  try {
    execSync(`node ${path.join(DIR, t.file)}`, {
      stdio: "inherit",
      cwd: DIR,
      timeout: 120000, // 2 min max per tier
    });
  } catch (e) {
    allPassed = false;
    console.log(`\n⚠️  ${t.name} had failures (exit code ${e.status})`);
  }
}

console.log("\n" + "═".repeat(50));
console.log(allPassed ? "✅ ALL TIERS PASSED" : "❌ SOME TIERS HAD FAILURES");
console.log("═".repeat(50) + "\n");

process.exit(allPassed ? 0 : 1);
