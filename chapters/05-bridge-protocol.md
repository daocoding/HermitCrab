# Chapter 05: The "One Shell" Bridge Protocol 🦀

The secret sauce to the HermitCrab multi-bridge system is **Standardized Messaging**.
No matter what platform the user is on (Teams, Telegram, CLI, or the browser), the Orchestrator expects a standard JSON payload.

## The Bridge Interface

```javascript
/* Every message hitting the Orchestrator MUST contain: */
{
    "channel_id": "telegram",         // The bridge type 
    "conversation_id": "abc-123",     // Unique session
    "who": "Tony",                    // Identity for Persona adjustment
    "text": "What did I say yesterday?",
    "attachments": []                 // Base64 images or files
}
```

This simple schema does three amazing things:
1. **Model Agnostic:** The Orchestrator can route the query to Gemini 1.5 Pro, Claude Opus, or GPT-4o based on current quotas.
2. **Channel Agnostic:** The agent doesn't care if it's returning HTML to Teams, or Markdown to Telegram.
3. **Session Handoff:** If you say "Generate my code" on Telegram, the IDE bridge will see `conversation_id`, look up your previous context, and inject the code perfectly into your editor.

By sticking to this protocol, adding Discord, Slack, or WhatsApp next week would only take 30 lines of code.
