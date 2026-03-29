#!/bin/bash
# Content pipeline: URL → scrape → translate → WeChat HTML
# Usage: ./pipeline.sh <url> [--parts N] [--x]
#   --x       Use X Article scraper (requires auth_token in .env)
#   --parts N Split into N parts for WeChat (default: auto based on length)
#
# Runs on M4 or M5. Spawns Cody (claude --print) for translation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_CLI="${CLAUDE_CLI:-claude}"
MODEL="${CLAUDE_MODEL:-sonnet}"

URL="${1:?Usage: ./pipeline.sh <url> [--parts N] [--x]}"
shift

# Parse flags
USE_X_SCRAPER=false
NUM_PARTS=0  # 0 = auto
while [[ $# -gt 0 ]]; do
  case "$1" in
    --x) USE_X_SCRAPER=true; shift ;;
    --parts) NUM_PARTS="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

echo "🔗 URL: $URL"

# ── Step 1: Scrape ──
echo "📥 Step 1: Scraping..."
if $USE_X_SCRAPER; then
  node "$SCRIPT_DIR/scrape-x-article.js" "$URL"
  # scrape-x-article.js creates x-article-{id}/ folder if article, but what if it's status?
  # x-article handles folder creation, but pipeline needs to know where it is.
  # Let's fix the grep to find status or article
  ARTICLE_ID=$(echo "$URL" | grep -oE '(status|article)/[0-9]*' | cut -d/ -f2 || echo "unknown")
  OUT_DIR="$SCRIPT_DIR/x-article-$ARTICLE_ID"
else
  node "$SCRIPT_DIR/scrape-url.js" "$URL"
  # scrape-url.js creates a slug-based folder
  SLUG=$(echo "$URL" | sed 's|https\?://||' | sed 's|[^a-zA-Z0-9]|-|g' | sed 's|-\+|-|g' | cut -c1-80)
  OUT_DIR="$SCRIPT_DIR/$SLUG"
fi

ARTICLE="$OUT_DIR/article.md"
if [ ! -f "$ARTICLE" ]; then
  echo "❌ Scraping failed — no article.md found"
  exit 1
fi

CHAR_COUNT=$(wc -c < "$ARTICLE")
echo "✅ Scraped: $CHAR_COUNT chars → $ARTICLE"

# ── Step 2: Determine split ──
if [ "$NUM_PARTS" -eq 0 ]; then
  # Auto: split if >60K chars (translates to ~8K+ Chinese chars per part)
  if [ "$CHAR_COUNT" -gt 100000 ]; then
    NUM_PARTS=3
  elif [ "$CHAR_COUNT" -gt 60000 ]; then
    NUM_PARTS=2
  else
    NUM_PARTS=1
  fi
fi

echo "📄 Splitting into $NUM_PARTS part(s)"

# ── Step 3: Split + Translate ──
TOTAL_LINES=$(wc -l < "$ARTICLE")
# Skip frontmatter (first 4 lines typically)
CONTENT_START=5
CONTENT_LINES=$((TOTAL_LINES - CONTENT_START + 1))
LINES_PER_PART=$((CONTENT_LINES / NUM_PARTS))

PIDS=()
PARTS=()

for i in $(seq 1 "$NUM_PARTS"); do
  START=$((CONTENT_START + (i - 1) * LINES_PER_PART))
  if [ "$i" -eq "$NUM_PARTS" ]; then
    END=$TOTAL_LINES
  else
    END=$((CONTENT_START + i * LINES_PER_PART - 1))
  fi

  PART_EN="$OUT_DIR/part${i}-en.md"
  PART_ZH="$OUT_DIR/part${i}-zh.md"
  sed -n "${START},${END}p" "$ARTICLE" > "$PART_EN"
  PARTS+=("$i")

  echo "🌐 Translating part $i ($START-$END)..."

  # Build part label
  if [ "$NUM_PARTS" -eq 1 ]; then
    PART_LABEL=""
  elif [ "$NUM_PARTS" -eq 2 ]; then
    [ "$i" -eq 1 ] && PART_LABEL="（上）" || PART_LABEL="（下）"
  else
    case $i in
      1) PART_LABEL="（上）" ;;
      2) PART_LABEL="（中）" ;;
      3) PART_LABEL="（下）" ;;
      *) PART_LABEL="（$i）" ;;
    esac
  fi

  # Spawn Cody for translation
  PROMPT="Read the file at $PART_EN

Translate the ENTIRE text into Simplified Chinese. Rules:
1. Keep the original Markdown structure (headings, paragraphs, bold, italic, lists)
2. Translate naturally and fluently — conversational but thoughtful Chinese
3. This is Part $i${PART_LABEL} of a ${NUM_PARTS}-part series
4. Keep proper nouns in English where natural
5. Remove any promotional/subscription CTAs
6. Do NOT summarize — translate every paragraph

Write the translated result to: $PART_ZH"

  $CLAUDE_CLI --print --model "$MODEL" "$PROMPT" > /dev/null 2>&1 &
  PIDS+=($!)
done

# Wait for all translation jobs
echo "⏳ Waiting for ${#PIDS[@]} translation job(s)..."
FAIL=0
for pid in "${PIDS[@]}"; do
  if ! wait "$pid"; then
    echo "❌ Translation job $pid failed"
    FAIL=1
  fi
done

if [ "$FAIL" -eq 1 ]; then
  echo "❌ Some translations failed"
  exit 1
fi

echo "✅ All translations complete"

# ── Step 4: Generate WeChat HTML ──
echo "🎨 Generating WeChat HTML..."
for i in "${PARTS[@]}"; do
  PART_ZH="$OUT_DIR/part${i}-zh.md"
  if [ -f "$PART_ZH" ]; then
    node "$SCRIPT_DIR/md-to-wechat.js" "$PART_ZH"
  else
    echo "⚠️  part${i}-zh.md not found — translation may have failed"
  fi
done

# ── Done ──
echo ""
echo "═══════════════════════════════════════"
echo "✅ Pipeline complete!"
echo "📁 Output: $OUT_DIR"
echo ""
ls -la "$OUT_DIR"/*.html "$OUT_DIR"/*.md 2>/dev/null | awk '{print "   " $NF " (" $5 " bytes)"}'
echo "═══════════════════════════════════════"
