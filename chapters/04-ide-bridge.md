# Chapter 04: The IDE Bridge (Antigravity) 💻

When you are deep in code, you don't want to switch to a browser tab or Telegram. The core of HermitCrab is about bringing the AI to *where you are*.

## Bridging Claude Code
To get Claude (or Gemini) inside VSCode speaking seamlessly with your central orchestrator, we use an architecture pattern called the **Agent Client Protocol (ACP)** combined with local HTTP servers.

By writing a custom `antigravity-bridge-extension` in TypeScript, we inject an API into VSCode that exposes the editor’s internal state:
- What files are open?
- Where is the cursor currently blinking?
- What are the lint errors on the screen?

This allows HermitCrab running on your `M4` or `M5` machine to perform context-aware file edits autonomously.

**The Workflow:**
1. You say "Fix this bug" in Telegram while making coffee.
2. The Telegram Bridge sends it to the Orchestrator.
3. The Orchestrator pings the VSCode extension.
4. VSCode replies with the active file and lint errors.
5. HermitCrab fixes the code locally before you even get back to your desk!

*(See `antigravity-cli/` for the complete implementation of this bidirectional bridge!)*
