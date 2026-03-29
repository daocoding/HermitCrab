# Chapter 03: The Teams Bridge 💼

If you use Microsoft Teams at work, you'll know that integrating bots requires jumping through a few more hoops than Telegram. But once running, it provides a native enterprise interface for your AI brain.

## 1. Register an Azure Bot
1. Go to the Azure Portal and create a new **Azure Bot**.
2. Generate an App Password (Client Secret) — keep this safe!
3. Add the **Microsoft Teams** channel.
4. Set your messaging endpoint to `https://your-domain.ngrok-free.app/api/messages`.

## 2. Bootstrapping the Bot Framework server
We use the `botbuilder` package. This creates a lightweight HTTP server listening for incoming Webhook actions from Azure. 

```javascript
const { BotFrameworkAdapter } = require('botbuilder');
const restify = require('restify');

// ... Setup adapter with you APP_ID and APP_PASSWORD ...

const server = restify.createServer();
server.post('/api/messages', (req, res) => {
    adapter.processActivity(req, res, async (context) => {
        if (context.activity.type === 'message') {
            const userQuery = context.activity.text;
            
            // 🦀 Pass to Orchestrator Core!
            const reply = await queryLLM(userQuery);
            await context.sendActivity(reply);
        }
    });
});
```

*(See `teams-bridge/` inside HermitCrab for the full enterprise-ready implementation with typing indicators and graph API hooks!)*
