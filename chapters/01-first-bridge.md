# Chapter 01: Your First Bridge — Telegram 🚀

> *15 minutes to a working AI assistant on Telegram.*

By the end of this chapter, you'll have a Telegram bot powered by any LLM that you can message from your phone. This is the foundation everything else builds on.

## What You'll Build

```
Your Phone (Telegram)          Your Machine
┌──────────────┐              ┌───────────────────┐
│              │   message    │                   │
│  "Hey, what  │ ──────────▶ │   Telegram Bridge  │
│   is MCP?"   │              │        │          │
│              │   response   │        ▼          │
│  "MCP is the │ ◀────────── │   AI Brain (LLM)  │
│   Model      │              │        │          │
│   Context    │              │        ▼          │
│   Protocol…" │              │   Memory System   │
│              │              │                   │
└──────────────┘              └───────────────────┘
```

## Prerequisites

- **Node.js 20+** — `node --version`
- **A Telegram account** — you probably have one
- **An LLM API key** — Claude (Anthropic), GPT (OpenAI), or Gemini (Google)

## Step 1: Create Your Telegram Bot

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`
3. Choose a name (e.g., "My AI Assistant")
4. Choose a username (e.g., `my_ai_assistant_bot`)
5. Save the **API token** — you'll need it

```
BotFather: Done! Your bot is created.
Token: 7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Step 2: Project Setup

```bash
mkdir my-ai-assistant && cd my-ai-assistant
npm init -y
npm install @anthropic-ai/sdk telegraf dotenv
```

> 💡 We use `telegraf` for Telegram (lightweight, well-maintained) and `@anthropic-ai/sdk` for Claude. 
> Swap for `openai` or `@google/generative-ai` if you prefer a different LLM.

Create your environment file:

```bash
cat > .env << 'EOF'
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_here

# AI Provider (choose one)
ANTHROPIC_API_KEY=your_anthropic_key_here
# OPENAI_API_KEY=your_openai_key_here

# Assistant Config
ASSISTANT_NAME=Jarvis
ALLOWED_USERS=your_telegram_user_id
EOF
```

> 🔒 **Security**: `ALLOWED_USERS` restricts who can talk to your bot. 
> Get your user ID by messaging `@userinfobot` on Telegram.

## Step 3: The Bridge

Create `bridge.js`:

```javascript
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import Anthropic from '@anthropic-ai/sdk';

// ── Configuration ──────────────────────────────────
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Assistant';
const ALLOWED_USERS = new Set(
  (process.env.ALLOWED_USERS || '').split(',').map(id => parseInt(id.trim()))
);

// ── AI Brain ───────────────────────────────────────
const ai = new Anthropic();

async function think(userMessage, conversationHistory) {
  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: `You are ${ASSISTANT_NAME}, a helpful personal AI assistant. 
Be concise, friendly, and proactive. If you notice something the user 
might need, mention it.`,
    messages: conversationHistory.concat([
      { role: 'user', content: userMessage }
    ]),
  });

  return response.content[0].text;
}

// ── Memory (Simple but Effective) ──────────────────
// Each user gets their own conversation history
const memory = new Map();

function getHistory(userId) {
  if (!memory.has(userId)) {
    memory.set(userId, []);
  }
  return memory.get(userId);
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  
  // Keep last 20 exchanges to manage token usage
  if (history.length > 40) {
    history.splice(0, 2); // Remove oldest pair
  }
}

// ── Telegram Bridge ────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Security: only respond to allowed users
bot.use((ctx, next) => {
  if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(ctx.from?.id)) {
    return; // Silently ignore unauthorized users
  }
  return next();
});

// Handle text messages
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const userMessage = ctx.message.text;
  
  // Show "typing..." indicator
  await ctx.sendChatAction('typing');
  
  try {
    const history = getHistory(userId);
    const response = await think(userMessage, history);
    
    // Save to memory
    addToHistory(userId, 'user', userMessage);
    addToHistory(userId, 'assistant', response);
    
    // Send response (handle Telegram's 4096 char limit)
    if (response.length <= 4096) {
      await ctx.reply(response, { parse_mode: 'Markdown' });
    } else {
      // Split long responses
      for (let i = 0; i < response.length; i += 4096) {
        await ctx.reply(response.slice(i, i + 4096));
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
    await ctx.reply('⚠️ Something went wrong. I\'ll be back in a moment.');
  }
});

// ── Start ──────────────────────────────────────────
bot.launch();
console.log(`✅ ${ASSISTANT_NAME} is alive on Telegram`);
console.log(`   Allowed users: ${[...ALLOWED_USERS].join(', ') || 'everyone'}`);

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```

## Step 4: Run It

```bash
node bridge.js
```

```
✅ Jarvis is alive on Telegram
   Allowed users: 12345678
```

**Open Telegram, find your bot, and send a message.** 🎉

## What Just Happened?

You built the simplest possible version of the architecture:

```
Channel (Telegram) → Bridge (telegraf) → Brain (Claude) → Memory (in-process Map)
```

It's primitive — memory is lost on restart, there's only one channel, no orchestrator. But it **works**, and everything we build from here is an evolution of this same pattern.

## What's Missing (And Where We Fix It)

| Limitation | Chapter |
|-----------|---------|
| Memory dies on restart | [Chapter 02: Persistent Memory](02-memory.md) |
| Only one channel | [Chapter 03: Teams Bridge](03-teams-bridge.md) |
| Can't do things proactively | [Chapter 06: The Orchestrator](06-orchestrator.md) |
| Crashes = game over | [Chapter 07: Self-Healing](07-self-healing.md) |
| Runs on one machine only | [Chapter 09: Multi-Machine](09-multi-machine.md) |

## Challenge: Make It Yours

Before moving on, try these modifications:

- [ ] Change the system prompt to give your AI a personality
- [ ] Add `/start` and `/help` command handlers
- [ ] Support image messages (use `ctx.message.photo`)
- [ ] Add a `/forget` command that clears conversation history

---

<div align="center">

**Your AI assistant is alive.** Time to give it a real memory.

[← Chapter 00: Philosophy](00-philosophy.md) · [**Chapter 02: Persistent Memory →**](02-memory.md)

</div>
