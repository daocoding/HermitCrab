/**
 * 🧠 Conversation Memory — shared across all HermitCrab bridges
 * 
 * Reads recent conversation history from JSONL logs and formats it 
 * for injection into new session prompts, ensuring continuity across
 * session rotations.
 * 
 * PHILOSOPHY: Be generous. Both Antigravity and Claude Code will 
 * compact/summarize their context windows automatically when they 
 * get too large. Our job is to RELOAD everything on session creation
 * and let the AI handle compaction. Don't pre-optimize.
 */

const fs = require("fs");

/**
 * Read the last N exchanges from a conversation log file.
 * Returns a formatted string suitable for injecting into a new session prompt.
 * 
 * Defaults are intentionally generous — the AI runtime handles compaction.
 * With 50 entries at 500 chars each, worst case is ~25K chars (~6K tokens),
 * well within the context window of any modern model.
 * 
 * @param {string} filePath - Absolute path to the JSONL conversation log
 * @param {object} [opts] - Options
 * @param {number} [opts.maxEntries=50] - Max number of entries to include
 * @param {number} [opts.maxCharsPerEntry=500] - Max chars per message before truncation
 * @param {function} [opts.log] - Optional logger function(direction, data)
 * @returns {string} Formatted history string, or "" if no history
 */
function getRecentHistory(filePath, opts = {}) {
  const maxEntries = opts.maxEntries || 50;
  const maxCharsPerEntry = opts.maxCharsPerEntry || 500;
  const logFn = opts.log || (() => {});

  try {
    if (!fs.existsSync(filePath)) return "";

    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) return "";

    const lines = content.split("\n").filter(l => l.trim());
    const recent = lines.slice(-maxEntries);

    if (recent.length === 0) return "";

    const formatted = recent.map(line => {
      try {
        const entry = JSON.parse(line);
        const role = entry.role === "user" ? "👤 User" : "🤖 Assistant";
        let text = entry.text || "";
        // Truncate only truly massive messages (code dumps, etc.)
        if (text.length > maxCharsPerEntry) {
          text = text.substring(0, maxCharsPerEntry) + "…";
        }
        // Include timestamp for temporal awareness
        const ts = entry.ts ? ` (${entry.ts.substring(0, 16)})` : "";
        return `${role}${ts}: ${text}`;
      } catch { return null; }
    }).filter(Boolean).join("\n");

    if (!formatted) return "";

    const totalMsgs = lines.length;
    const showing = recent.length;
    const header = totalMsgs > showing
      ? `--- Conversation history (last ${showing} of ${totalMsgs} messages) ---`
      : `--- Full conversation history (${showing} messages) ---`;

    return `\n\n${header}\n${formatted}\n--- End of history ---\n`;
  } catch (err) {
    logFn("HISTORY_ERROR", { file: filePath, error: err.message });
    return "";
  }
}

module.exports = { getRecentHistory };
