<div align="center">

<img src="assets/hero.png" alt="Build Your Own AI Assistant" width="600">

# 🦀 Build Your Own AI Assistant

### One brain. Every channel. Runs while you sleep.

**A complete, battle-tested blueprint for building a personal AI assistant that lives across Telegram, Teams, your IDE, and any channel you want — with persistent memory, autonomous operations, and self-healing infrastructure.**

*This isn't theory. This system has been running in production for months.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Stars](https://img.shields.io/github/stars/daocoding/build-your-own-ai-assistant?style=social)](https://github.com/daocoding/build-your-own-ai-assistant)

**[English](#-why-build-your-own)** · **[中文](#-为什么要自己构建)**

</div>

---

## The Problem

You use ChatGPT at work. Claude in your IDE. A different bot on Telegram. Maybe Siri for timers.

**None of them know each other.** None of them remember what you said yesterday. None of them can do things while you sleep.

What if you had **one AI assistant** that:

- 💬 Lives on **every channel** you use — Telegram, Teams, Slack, IDE, SMS
- 🧠 **Remembers everything** across all channels — persistent memory, semantic search
- 🌙 **Works while you sleep** — runs overnight tasks, monitors systems, sends morning reports
- 🏥 **Heals itself** — crashes? restarts automatically. Network down? retries gracefully
- 🔒 **Runs on YOUR machines** — no cloud dependency, your data stays yours
- 👥 **Supports multiple AI agents** — add specialized assistants that share the same infrastructure

**This guide shows you exactly how to build it.**

---

## What You'll Build

<table>
<tr>
<td width="50%">

### 🌐 Multi-Channel Access
Message your AI from anywhere. Same brain, same memory, different interfaces.

```
You (Telegram, 2:30 AM):
  "Research competitor pricing and have
   a summary ready by morning"

AI (Teams, 8:00 AM):  
  "Good morning. Here's the competitor
   analysis you requested last night..."
```

</td>
<td width="50%">

### 🧠 Persistent Memory
Your AI remembers context across channels and sessions. No more re-explaining.

```
You (IDE, Monday):
  "We decided to use PostgreSQL for
   the new auth service"

You (Telegram, Thursday):
  "What database did we pick for auth?"

AI: "PostgreSQL — we decided Monday.
     Want me to set up the schema?"
```

</td>
</tr>
<tr>
<td width="50%">

### 🌙 Autonomous Operations
Your AI works while you sleep. Scheduled tasks, monitoring, proactive alerts.

```
[3:00 AM] Orchestrator: Running health check...
[3:01 AM] ✅ All services healthy
[3:30 AM] Orchestrator: Running QMD embedding...
[3:45 AM] ✅ 960 new documents indexed
[6:00 AM] → Push notification:
  "Morning, Tony. All systems green.
   960 docs indexed overnight. 
   3 new emails need attention."
```

</td>
<td width="50%">

### 🏥 Self-Healing
Three-tier resilience. Your AI survives crashes, network failures, and reboots.

```
[2:17 AM] Bridge process crashed (OOM)
[2:17 AM] launchd: Restarting bridge...
[2:18 AM] Bridge: Reconnected ✅
[2:18 AM] Bridge: Recovered session state ✅
[2:18 AM] → No messages lost. No human needed.
```

</td>
</tr>
</table>

---

## Architecture: One Shell, Many Crabs 🦀

> *A hermit crab carries its home everywhere. When it outgrows one shell, it finds a new one — but it's still the same crab.*

Your AI is the crab. The channels are the shells.

```
                    ┌─────────────┐
                    │  Telegram   │──── Bridge ────┐
                    └─────────────┘                │
                    ┌─────────────┐                │     ┌──────────────────┐
                    │   Teams     │──── Bridge ────┼────▶│   🧠 AI Brain    │
                    └─────────────┘                │     │                  │
                    ┌─────────────┐                │     │  ┌────────────┐  │
                    │    IDE      │──── Bridge ────┤     │  │  Memory    │  │
                    └─────────────┘                │     │  │  System    │  │
                    ┌─────────────┐                │     │  └────────────┘  │
                    │  SMS/Web    │──── Bridge ────┘     │                  │
                    └─────────────┘                      │  ┌────────────┐  │
                                                         │  │Orchestrator│  │
                    ┌─────────────┐                      │  │  (cron)    │  │
                    │  Always-On  │◀═══ Tailscale ══════▶│  └────────────┘  │
                    │   Server    │      Mesh            └──────────────────┘
                    └─────────────┘                      ┌──────────────────┐
                                                         │  Mobile Laptop   │
                                                         └──────────────────┘
```

### Core Components

| Component | What It Does | Tech |
|-----------|-------------|------|
| **Bridge** | Translates between a channel (Telegram, Teams, etc.) and the AI brain | Node.js |
| **Brain** | The LLM that processes your requests — any provider works | Claude, GPT, Gemini, local |
| **Memory System** | Persistent knowledge across all sessions and channels | Vector DB + flat files |
| **Orchestrator** | Runs scheduled tasks, health checks, autonomous operations | Node.js + cron |
| **Mesh Network** | Connects your machines securely, wherever they are | Tailscale |

---

## Chapters

> Each chapter is self-contained. You can build the full system or pick the pieces you need.

### Part I: Foundation

| # | Chapter | What You'll Build | Time |
|---|---------|-------------------|------|
| 00 | [**Philosophy**](chapters/00-philosophy.md) | Understanding the "One Shell, Many Crabs" architecture | 15 min |
| 01 | [**Your First Bridge**](chapters/01-first-bridge.md) | A working Telegram bot that talks to an LLM | 1 hour |
| 02 | [**Persistent Memory**](chapters/02-memory.md) | Working memory + semantic search across sessions | 2 hours |

### Part II: Multi-Channel

| # | Chapter | What You'll Build | Time |
|---|---------|-------------------|------|
| 03 | [**Teams Bridge**](chapters/03-teams-bridge.md) | Enterprise channel — Microsoft Teams or Slack integration | 2 hours |
| 04 | [**IDE Bridge**](chapters/04-ide-bridge.md) | Control your AI from VS Code / Cursor / Antigravity | 2 hours |
| 05 | [**The Bridge Protocol**](chapters/05-bridge-protocol.md) | Build a bridge for ANY channel in 30 minutes | 1 hour |

### Part III: Autonomy

| # | Chapter | What You'll Build | Time |
|---|---------|-------------------|------|
| 06 | [**The Orchestrator**](chapters/06-orchestrator.md) | Task scheduler with three-tier heartbeat system | 2 hours |
| 07 | [**Self-Healing**](chapters/07-self-healing.md) | launchd/systemd auto-restart, graceful recovery, SIGUSR1 | 1 hour |
| 08 | [**Overnight Operations**](chapters/08-overnight.md) | Tasks that run while you sleep — monitoring, indexing, reports | 1 hour |

### Part IV: Scale

| # | Chapter | What You'll Build | Time |
|---|---------|-------------------|------|
| 09 | [**Multi-Machine**](chapters/09-multi-machine.md) | Always-on server + mobile laptop with Tailscale mesh | 1 hour |
| 10 | [**Multiple Agents**](chapters/10-multi-agent.md) | Add specialized AI agents that share the same infrastructure | 2 hours |
| 11 | [**Security & Secrets**](chapters/11-security.md) | Token management, permission boundaries, audit logging | 1 hour |

### Appendix

| Chapter | Topic |
|---------|-------|
| [**MCP Servers**](chapters/appendix-mcp.md) | Extending your AI's capabilities with Model Context Protocol |
| [**Deployment Recipes**](chapters/appendix-deploy.md) | macOS (launchd), Linux (systemd), Docker, Raspberry Pi |
| [**Troubleshooting**](chapters/appendix-troubleshooting.md) | Common pitfalls and how to debug them |

---

## Quick Start

> Get a working AI assistant on Telegram in 15 minutes.

```bash
# Clone this repo
git clone https://github.com/daocoding/build-your-own-ai-assistant.git
cd build-your-own-ai-assistant

# Install dependencies
npm install

# Configure your AI provider and Telegram token
cp .env.example .env
# Edit .env with your API keys

# Start your first bridge
npm run bridge:telegram
```

```
✅ Bridge connected to Telegram
✅ AI Brain initialized (Claude 4 Opus)
✅ Memory system loaded (0 memories)

🦀 Your AI assistant is alive. Message it on Telegram.
```

**→ Now read [Chapter 00: Philosophy](chapters/00-philosophy.md) to understand the full architecture.**

---

## Born from Production

This isn't a weekend prototype. This architecture has been running **24/7 in production** since early 2026, handling:

- **2 machines** — always-on Mac Mini (server) + MacBook (mobile)
- **3 channels** — Telegram, Microsoft Teams, IDE (simultaneously)
- **2 AI agents** — each with distinct personality and capabilities
- **Autonomous overnight operations** — embedding, monitoring, morning reports
- **Zero-downtime deployments** — SIGUSR1 graceful restart pattern
- **Self-healing** — 99.9% uptime with zero human intervention for crashes

The system evolved through months of real daily use — not theory, not a demo. Every pattern in this guide was battle-tested, broken, fixed, and hardened through actual production incidents.

---

## Who Is This For?

| You Are | This Gives You |
|---------|---------------|
| **A developer** who uses AI daily but is frustrated by fragmented tools | A single AI that follows you everywhere |
| **A tinkerer** who wants to truly own and customize their AI experience | A complete blueprint you can extend infinitely |
| **A team lead** exploring AI agent infrastructure | Production-proven patterns for multi-agent systems |
| **A privacy-conscious user** who doesn't want everything in the cloud | A fully self-hosted architecture |
| **A student** learning about distributed systems | A real-world case study with working code |

---

## Compared to Alternatives

This project occupies a specific niche: **a self-hosted, multi-channel AI assistant with autonomous capabilities**. Here's how it compares honestly to tools you might already use.

| Feature | HermitCrab | CrewAI / LangGraph | ChatGPT / Claude Pro | Claude Code / Cursor |
|---------|:---:|:---:|:---:|:---:|
| Multi-channel (Telegram + Teams + IDE + ...) | ✅ | ❌ single runtime | ❌ web/app only | ❌ IDE only |
| Persistent memory across channels | ✅ | ⚠️ within workflow | ⚠️ per-conversation | ⚠️ per-project |
| Autonomous operations (overnight tasks) | ✅ | ✅ | ❌ | ❌ |
| Self-healing infrastructure | ⚠️ basic¹ | ❌ | N/A (managed) | N/A (managed) |
| Multi-machine mesh | ✅ | ❌ | N/A | ❌ |
| Multiple AI agents on same infra | ✅ | ✅ | ❌ | ⚠️ subagents |
| Fully self-hosted | ✅ | ✅ | ❌ | ⚠️ CLI is local, LLM is cloud |
| Any LLM provider | ✅ | ✅ | ❌ locked in | ❌ locked in |
| Setup complexity | 🔴 high | 🟡 medium | 🟢 zero | 🟢 low |
| Production-tested | ✅ months | ✅ | ✅ | ✅ |
| Enterprise-grade reliability | ❌² | ❌ | ✅ | ✅ |

<sup>¹ Watchdog + launchd auto-restart. Handles common failures but not battle-hardened at scale — expect to debug edge cases (port conflicts, OneDrive sync races, stale PID files).</sup>

<sup>² This is a personal infrastructure project, not enterprise software. It runs great for a single user or small team, but it doesn't have the monitoring, alerting, or redundancy of managed services.</sup>

**When to use HermitCrab:**
- You want a **single AI brain** that follows you across every channel
- You need **autonomous overnight operations** (monitoring, indexing, reports)
- You care about **data sovereignty** and self-hosting
- You enjoy building and tinkering with infrastructure

**When to use something else:**
- You just want to chat with an AI → **ChatGPT or Claude Pro**
- You need a coding assistant → **Claude Code or Cursor**
- You're building multi-agent workflows for a product → **CrewAI or LangGraph**
- You need enterprise reliability with zero maintenance → **Managed AI services**

---

## Star History

<!-- Replace with actual star history once live -->
> ⭐ If you find this useful, please star this repo — it helps others discover it.

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- 🐛 Found a bug? [Open an issue](https://github.com/daocoding/build-your-own-ai-assistant/issues)
- 💡 Have an idea? [Start a discussion](https://github.com/daocoding/build-your-own-ai-assistant/discussions)
- 🌐 Help translate? We're building bilingual (EN/中文) content
- 📝 Improve docs? Every typo fix matters

---

## License

MIT — do whatever you want with it.

---

<div align="center">

### Built with 🦀 by developers who got tired of having 5 different AI assistants that don't talk to each other.

**[Start Building →](chapters/00-philosophy.md)**

</div>
