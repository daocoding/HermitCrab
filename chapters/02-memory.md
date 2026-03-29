# Chapter 02: Persistent Memory 🧠

> *Your AI should remember what you said on Telegram last Tuesday — even when you ask from your IDE on Friday.*

In Chapter 01, we stored conversation history in a JavaScript `Map`. That works until:
- You restart the bridge → **everything gone**
- You add a second channel → **each channel has its own memory**
- You want to search past conversations → **impossible**

This chapter builds a proper three-layer memory system that persists across restarts, channels, and time.

## The Three Layers

```
┌─────────────────────────────────────────────┐
│           Working Memory                    │  What's happening RIGHT NOW
│  "Tony is building auth service with        │  ← Updates every session
│   PostgreSQL. Deadline is Friday."          │
├─────────────────────────────────────────────┤
│           Episodic Memory                   │  What HAPPENED
│  2026-03-25: Decided PostgreSQL for auth    │  ← Append-only journal
│  2026-03-26: Deployed staging environment   │  
│  2026-03-27: Fixed token refresh bug        │
├─────────────────────────────────────────────┤
│           Semantic Memory                   │  What the AI KNOWS
│  [vector embeddings of all past context]    │  ← Searchable, grows over time
│  Query: "database for auth" → PostgreSQL    │
└─────────────────────────────────────────────┘
```

Each layer serves a different purpose. Together, they give your AI memory that feels natural.

## Layer 1: Working Memory — The Sticky Note

Working memory is what's *active right now*. Think of it as the sticky note on your monitor. It's small, always visible, and gets updated constantly.

Create `memory/working-memory.md`:

```markdown
# Working Memory
Last updated: 2026-03-28T22:00:00

## Active Tasks
- Building auth service with PostgreSQL
- Deadline: Friday March 29

## Recent Decisions
- Use JWT for session tokens (decided March 26)
- PostgreSQL over MongoDB for relational data needs

## Things to Surface
- Staging deploy needs SSL certificate
- Tony hasn't responded to the PR review from Alex
```

Your AI reads this file at the **start of every conversation** and includes it in the system prompt. This is how it "knows" what's going on without you re-explaining.

### Implementation

```javascript
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const MEMORY_DIR = join(process.cwd(), 'memory');
const WORKING_MEMORY_PATH = join(MEMORY_DIR, 'working-memory.md');

function loadWorkingMemory() {
  if (!existsSync(WORKING_MEMORY_PATH)) return '';
  return readFileSync(WORKING_MEMORY_PATH, 'utf-8');
}

function updateWorkingMemory(content) {
  const header = `# Working Memory\nLast updated: ${new Date().toISOString()}\n\n`;
  writeFileSync(WORKING_MEMORY_PATH, header + content, 'utf-8');
}
```

Inject it into your system prompt:

```javascript
const workingMemory = loadWorkingMemory();

const systemPrompt = `You are ${ASSISTANT_NAME}, a personal AI assistant.

## Current Context (Working Memory)
${workingMemory || 'No active context.'}

## Instructions
- Be concise and helpful
- Reference working memory when relevant
- If a significant decision is made or task status changes, 
  tell the user you'd like to update working memory
`;
```

**That's it.** A markdown file, read at startup, included in every prompt. Simple, debuggable, and incredibly effective.

## Layer 2: Episodic Memory — The Journal

Episodic memory records *what happened*. It's an append-only journal, organized by date.

Create `memory/journal/` with daily files:

```
memory/
  journal/
    2026-03-25.md
    2026-03-26.md
    2026-03-27.md
    2026-03-28.md
```

Each file looks like:

```markdown
# 2026-03-28

## 14:30 — Via Telegram
- Tony asked about database options for auth service
- Discussed PostgreSQL vs MongoDB tradeoffs
- **Decision**: PostgreSQL chosen for relational data needs

## 16:45 — Via IDE
- Helped design the database schema for users table
- Created migration file

## 22:00 — Via Telegram  
- Tony asked for a summary of today's work
- Updated working memory with current status
```

### Implementation

```javascript
import { appendFileSync, mkdirSync } from 'fs';

const JOURNAL_DIR = join(MEMORY_DIR, 'journal');

function logToJournal(channel, summary) {
  mkdirSync(JOURNAL_DIR, { recursive: true });
  
  const today = new Date().toISOString().split('T')[0];
  const time = new Date().toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  });
  const file = join(JOURNAL_DIR, `${today}.md`);
  
  const entry = `\n## ${time} — Via ${channel}\n${summary}\n`;
  
  // Create file with header if new
  if (!existsSync(file)) {
    writeFileSync(file, `# ${today}\n`);
  }
  
  appendFileSync(file, entry, 'utf-8');
}
```

### When to Log

Don't log every message — that's too noisy. Log **decisions and actions**:

```javascript
// After each AI response, ask the AI to summarize if needed
async function maybeLogConversation(channel, userMsg, aiResponse) {
  // Simple heuristic: log if the conversation seems significant
  const isSignificant = aiResponse.length > 200 
    || userMsg.includes('decide')
    || userMsg.includes('let\'s go with')
    || userMsg.includes('deploy')
    || userMsg.includes('create');
  
  if (isSignificant) {
    // Ask the AI to create a brief journal entry
    const summary = await ai.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: 'Summarize this exchange in 2-3 bullet points for a journal. Include any decisions made. Be concise.',
      messages: [
        { role: 'user', content: `User (${channel}): ${userMsg}` },
        { role: 'assistant', content: aiResponse }
      ],
    });
    
    logToJournal(channel, summary.content[0].text);
  }
}
```

## Layer 3: Semantic Memory — The Knowledge Base

This is the most powerful layer. It lets your AI **search** past context using natural language.

When you ask "what database did we decide on for auth?" — semantic memory finds the relevant journal entry from March 25 even though you never used the word "database" in that conversation.

### Option A: Simple (No External Dependencies)

For a lightweight start, use keyword-based search over your journal files:

```javascript
import { readdirSync } from 'fs';

function searchMemory(query, maxResults = 5) {
  const journalFiles = readdirSync(JOURNAL_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse(); // newest first
  
  const keywords = query.toLowerCase().split(/\s+/);
  const results = [];
  
  for (const file of journalFiles) {
    const content = readFileSync(join(JOURNAL_DIR, file), 'utf-8');
    const sections = content.split(/^## /m).filter(Boolean);
    
    for (const section of sections) {
      const score = keywords.reduce((acc, kw) => 
        acc + (section.toLowerCase().includes(kw) ? 1 : 0), 0
      );
      
      if (score > 0) {
        results.push({ 
          file, 
          section: section.trim().slice(0, 200), 
          score 
        });
      }
    }
  }
  
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
```

### Option B: Vector Search (Production-Grade)

For real semantic search, use embeddings. This finds conceptually related content even when the words don't match.

```bash
npm install @xenova/transformers  # Local embeddings, no API needed
```

```javascript
import { pipeline } from '@xenova/transformers';

let embedder;

async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline(
      'feature-extraction', 
      'Xenova/all-MiniLM-L6-v2'  // Small, fast, runs locally
    );
  }
  return embedder;
}

async function embed(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are already normalized
}

// Index all journal entries
async function buildIndex() {
  const index = [];
  const files = readdirSync(JOURNAL_DIR).filter(f => f.endsWith('.md'));
  
  for (const file of files) {
    const content = readFileSync(join(JOURNAL_DIR, file), 'utf-8');
    const sections = content.split(/^## /m).filter(Boolean);
    
    for (const section of sections) {
      const vector = await embed(section);
      index.push({ file, text: section.trim(), vector });
    }
  }
  
  // Save index for fast loading
  writeFileSync(
    join(MEMORY_DIR, 'index.json'),
    JSON.stringify(index.map(i => ({ ...i, vector: Array.from(i.vector) })))
  );
  
  return index;
}

// Search by meaning
async function semanticSearch(query, index, topK = 5) {
  const queryVector = await embed(query);
  
  return index
    .map(item => ({
      ...item,
      score: cosineSimilarity(queryVector, item.vector)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
```

## Putting It All Together

Update your bridge from Chapter 01 to use all three memory layers:

```javascript
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import Anthropic from '@anthropic-ai/sdk';

const ai = new Anthropic();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const CHANNEL = 'Telegram';

// Load memory at startup
const workingMemory = loadWorkingMemory();
console.log(`📝 Working memory loaded (${workingMemory.length} chars)`);

bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  await ctx.sendChatAction('typing');
  
  // Search past context for relevant memories
  const relevantMemories = searchMemory(userMessage, 3);
  const memoryContext = relevantMemories.length > 0
    ? relevantMemories.map(m => `[${m.file}] ${m.section}`).join('\n\n')
    : 'No relevant memories found.';
  
  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: `You are ${ASSISTANT_NAME}.

## Working Memory (Current State)
${workingMemory}

## Relevant Past Context  
${memoryContext}

## Instructions
- Reference past context naturally when relevant
- Don't say "according to my memory" — just know it
- If something important changes, suggest updating working memory`,
    messages: [{ role: 'user', content: userMessage }],
  });

  const aiResponse = response.content[0].text;
  await ctx.reply(aiResponse, { parse_mode: 'Markdown' });
  
  // Log significant exchanges
  await maybeLogConversation(CHANNEL, userMessage, aiResponse);
});

bot.launch();
```

## The Magic Moment

Once this is running, try this sequence:

**Monday, via Telegram:**
> "We decided to use PostgreSQL for the auth service"

**Thursday, via your IDE (or another channel):**
> "What database are we using for auth?"

Your AI will answer: **"PostgreSQL — we decided that on Monday."**

Not because it's magic. Because it searched your journal, found the entry from Monday, and included it in its context. It's just files and search — but to the user, it feels like genuine memory.

## File Structure After This Chapter

```
my-ai-assistant/
├── bridge.js              ← Updated with memory integration
├── memory/
│   ├── working-memory.md  ← Layer 1: Current state
│   ├── journal/           ← Layer 2: What happened
│   │   ├── 2026-03-25.md
│   │   ├── 2026-03-26.md
│   │   └── ...
│   └── index.json         ← Layer 3: Vector index (if using Option B)
├── .env
└── package.json
```

---

<div align="center">

**Your AI now remembers.** Time to give it a second home.

[← Chapter 01: First Bridge](01-first-bridge.md) · [**Chapter 03: Teams Bridge →**](03-teams-bridge.md)

</div>
