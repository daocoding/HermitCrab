#!/usr/bin/env node
/**
 * 🦀📊 HermitCrab Graph CLI — Command-line interface for Microsoft Graph
 * 
 * Usage:
 *   node graph-cli.js <command> [args...]
 * 
 * Commands:
 *   me                          — Show current user profile
 *   calendar [days]             — Show upcoming events (default: 7 days)
 *   today                       — Show today's events
 *   files [path]                — List OneDrive files
 *   search-files <query>        — Search OneDrive
 *   upload <folder> <file>      — Upload a file to OneDrive
 *   sites [query]               — List SharePoint sites
 *   tasks                       — List Planner tasks
 *   mail [count]                — List recent emails
 *   send-mail <to> <subject>    — Send email (reads body from stdin)
 *   chats                       — List Teams chats
 *   users [query]               — List/search users
 *   presence <userId>           — Get user presence
 *   raw <method> <endpoint>     — Raw Graph API call
 */

const graph = require("./graph-client");

const [,, cmd, ...args] = process.argv;

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function formatSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function printResult(res) {
  if (!res.ok) {
    console.error(`❌ Error (${res.status}): ${res.error}`);
    process.exit(1);
  }
  return res.data;
}

async function main() {
  if (!cmd) {
    console.log("Usage: graph-cli.js <command> [args...]");
    console.log("Commands: me, calendar, today, files, search-files, upload, sites, tasks, mail, send-mail, chats, users, presence, raw");
    process.exit(0);
  }

  switch (cmd) {
    case "me": {
      const data = printResult(await graph.getMe());
      console.log(`👤 ${data.displayName}`);
      console.log(`   Email: ${data.mail || data.userPrincipalName}`);
      console.log(`   Title: ${data.jobTitle || "—"}`);
      console.log(`   ID: ${data.id}`);
      break;
    }

    case "calendar": {
      const days = parseInt(args[0] || "7", 10);
      const data = printResult(await graph.getUpcomingEvents(days));
      const events = data.value || [];
      if (events.length === 0) {
        console.log(`📅 No events in the next ${days} days`);
        break;
      }
      console.log(`📅 ${events.length} events in the next ${days} days:\n`);
      for (const e of events) {
        const start = formatDate(e.start?.dateTime + "Z");
        const end = formatDate(e.end?.dateTime + "Z");
        const loc = e.location?.displayName ? ` 📍 ${e.location.displayName}` : "";
        const online = e.isOnlineMeeting ? " 💻" : "";
        console.log(`  ${start} → ${end}`);
        console.log(`    ${e.subject}${loc}${online}`);
        if (e.bodyPreview) console.log(`    ${e.bodyPreview.slice(0, 100)}`);
        console.log();
      }
      break;
    }

    case "today": {
      const data = printResult(await graph.getTodaysEvents());
      const events = data.value || [];
      if (events.length === 0) {
        console.log("📅 No events today!");
        break;
      }
      console.log(`📅 ${events.length} events today:\n`);
      for (const e of events) {
        const start = new Date(e.start?.dateTime + "Z").toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        const end = new Date(e.end?.dateTime + "Z").toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        const online = e.isOnlineMeeting ? " 💻" : "";
        console.log(`  ${start}–${end}  ${e.subject}${online}`);
      }
      break;
    }

    case "files": {
      const folderPath = args[0] || "/";
      const data = printResult(await graph.listOneDriveFiles(folderPath));
      const items = data.value || [];
      console.log(`📁 ${items.length} items in ${folderPath}:\n`);
      for (const item of items) {
        const icon = item.folder ? "📁" : "📄";
        const size = item.folder ? `${item.folder.childCount} items` : formatSize(item.size);
        console.log(`  ${icon} ${item.name}  (${size})`);
      }
      break;
    }

    case "search-files": {
      const query = args.join(" ");
      if (!query) { console.error("Usage: search-files <query>"); process.exit(1); }
      const data = printResult(await graph.searchFiles(query));
      const items = data.value || [];
      console.log(`🔍 ${items.length} results for "${query}":\n`);
      for (const item of items) {
        console.log(`  📄 ${item.name}  (${formatSize(item.size)})`);
        console.log(`     ${item.webUrl}`);
      }
      break;
    }

    case "sites": {
      const query = args.join(" ");
      const data = printResult(await graph.listSites(query));
      const sites = data.value || [];
      console.log(`🏢 ${sites.length} SharePoint sites:\n`);
      for (const s of sites) {
        console.log(`  ${s.displayName || s.name}`);
        console.log(`    ${s.webUrl}`);
      }
      break;
    }

    case "tasks": {
      const data = printResult(await graph.getMyTasks());
      const tasks = data.value || [];
      console.log(`✅ ${tasks.length} Planner tasks:\n`);
      for (const t of tasks) {
        const done = t.percentComplete === 100 ? "✅" : "⬜";
        console.log(`  ${done} ${t.title}`);
        if (t.dueDateTime) console.log(`     Due: ${formatDate(t.dueDateTime)}`);
      }
      break;
    }

    case "mail": {
      const count = parseInt(args[0] || "10", 10);
      const data = printResult(await graph.getRecentMail(count));
      const msgs = data.value || [];
      console.log(`📧 ${msgs.length} recent emails:\n`);
      for (const m of msgs) {
        const read = m.isRead ? "  " : "🔵";
        const from = m.from?.emailAddress?.name || m.from?.emailAddress?.address || "?";
        const time = formatDate(m.receivedDateTime);
        console.log(`  ${read} ${m.subject}`);
        console.log(`     From: ${from} | ${time}`);
        if (m.bodyPreview) console.log(`     ${m.bodyPreview.slice(0, 80)}`);
        console.log();
      }
      break;
    }

    case "chats": {
      const data = printResult(await graph.listChats());
      const chats = data.value || [];
      console.log(`💬 ${chats.length} Teams chats:\n`);
      for (const c of chats) {
        const label = c.topic || c.chatType;
        console.log(`  ${c.chatType === "oneOnOne" ? "👤" : "👥"} ${label}`);
        console.log(`     ID: ${c.id}`);
        console.log(`     Updated: ${formatDate(c.lastUpdatedDateTime)}`);
      }
      break;
    }

    case "users": {
      const query = args.join(" ");
      const data = query
        ? printResult(await graph.searchUsers(query))
        : printResult(await graph.listUsers());
      const users = data.value || [];
      console.log(`👥 ${users.length} users${query ? ` matching "${query}"` : ""}:\n`);
      for (const u of users) {
        console.log(`  ${u.displayName}  <${u.mail || u.userPrincipalName}>`);
        if (u.jobTitle) console.log(`    ${u.jobTitle}`);
      }
      break;
    }

    case "presence": {
      const userId = args[0];
      if (!userId) { console.error("Usage: presence <userId>"); process.exit(1); }
      const data = printResult(await graph.getPresence(userId));
      const p = data.value?.[0] || data;
      console.log(`🟢 ${p.availability} — ${p.activity}`);
      break;
    }

    case "raw": {
      const method = (args[0] || "GET").toUpperCase();
      const endpoint = args[1];
      if (!endpoint) { console.error("Usage: raw <GET|POST|PATCH|DELETE> <endpoint>"); process.exit(1); }
      const res = await graph.graphRequest(method, endpoint);
      console.log(JSON.stringify(res.data, null, 2));
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      console.log("Commands: me, calendar, today, files, search-files, upload, sites, tasks, mail, send-mail, chats, users, presence, raw");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
