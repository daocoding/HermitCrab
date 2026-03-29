# 🦀 HermitCrab — Progress Log

## Session: 2026-03-16

### What We Accomplished

1. **OpenClaw Architecture Study** — Deep dive into the 35MB codebase. Analyzed Gateway, channels, agent runtime, session management. Produced comprehensive blueprint at `~/.gemini/antigravity/brain/368d5be2-*/openclaw_architecture_study.md`

2. **Founding Philosophy** — Documented in `context/hermitcrab-philosophy.md`:
   - Agent first, body later (vs OpenClaw's infrastructure-first)
   - ONE brain, not two — Gateway routes messages, does NOT think
   - Perpetual Identity — workspace is the soul, conversations are moments of consciousness

3. **POC: Telegram Bridge** ✅ **PROVEN**
   - Built `hermitcrab/bridge/bridge.js` (v1) — 100-line dumb pipe
   - Telegram bot: **@JarvisZhangBot** (token: stored in bridge command history)
   - Tony's Telegram: chat_id `1495516896`, username `@taoisdao`
   - Successfully sent AND received messages between Telegram and THIS Antigravity session
   - No API key, no second brain — pure stdin/stdout pipe with JARVIS as the brain

4. **Bridge v2** — `hermitcrab/bridge/bridge-v2.js`
   - Added HTTP server on `localhost:18790` for reply endpoint
   - Added `antigravity chat` wake-up mechanism
   - Added inbox file logging (`hermitcrab/inbox/`)

### What's Working
- ✅ Bridge receives Telegram messages
- ✅ Bridge sends replies to Telegram (both stdin and HTTP methods)
- ✅ `antigravity chat --reuse-window` injects into active conversation (confirmed once)
- ✅ HTTP reply endpoint (`POST http://localhost:18790/reply`)

### Current Blocker: Wake-Up Mechanism
- `antigravity chat --reuse-window` — worked once (injected into this session), but didn't trigger a new AI turn
- `antigravity chat` (no flags) — exits cleanly but nothing visible appeared
- `open antigravity://chat?prompt=...` — no visible effect
- **Need to re-test**: may have been a timing/state issue

### Next Steps to Try
1. Re-test `antigravity chat --reuse-window` in a fresh state
2. Try `antigravity chat --new-window` to force a separate window
3. Investigate if Antigravity has a REST API or extension API for chat
4. Alternative: polling-based approach (JARVIS periodically checks inbox file)
5. Alternative: ntfy notification + manual response flow as fallback

### Files Created
```
hermitcrab/
├── bridge/
│   ├── package.json
│   ├── node_modules/   (grammy installed)
│   ├── bridge.js       (v1 — stdin/stdout pipe, WORKING)
│   └── bridge-v2.js    (v2 — HTTP + wake-up, PARTIALLY WORKING)
└── inbox/
    └── 1495516896.jsonl (Tony's messages)
```

### Key Constants
- Bot username: @JarvisZhangBot
- Tony's chat_id: 1495516896
- Tony's Telegram: @taoisdao
- HTTP port: 18790
- Workspace: /Users/tony/Library/CloudStorage/OneDrive-ApexLearn/JARVIS
