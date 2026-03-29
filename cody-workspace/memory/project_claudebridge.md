---
name: ClaudeBridge design intent
description: Tony wants a ClaudeBridge component for HermitCrab that manages Claude Code agent lifecycle via ACP, inspired by OpenClaw's acpx pattern
type: project
---

Tony wants to build a **ClaudeBridge** layer for HermitCrab, inspired by how OpenClaw's acpx plugin manages Claude Code via ACP.

**Why:** Current bridges shell out to antigravity-cli per-message with no lifecycle management. Session IDs are tracked manually in state.json. No ability to steer, cancel, or cleanly tear down running agents.

**How to apply:** When working on bridge/orchestrator code, design toward a centralized ACP session manager (ClaudeBridge) that owns spawning, thread binding, session persistence, and teardown — rather than adding more execFile calls.
