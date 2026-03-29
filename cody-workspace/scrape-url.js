#!/usr/bin/env node
// Scrape full text from any public URL via Playwright
// Usage: node scrape-url.js <url> [output-dir]

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const url = process.argv[2];
if (!url) {
  console.error('Usage: node scrape-url.js <url> [output-dir]');
  process.exit(1);
}

const slug = url.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 80);
const outDir = process.argv[3] || path.join(__dirname, slug);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

(async () => {
  console.log(`🔗 ${url}`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('⏳ Waiting for content...');
  await page.waitForTimeout(3000);

  // Scroll to load lazy content
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 600);
        total += 600;
        if (total >= document.body.scrollHeight) { clearInterval(timer); window.scrollTo(0, 0); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(timer); resolve(); }, 20000);
    });
  });
  await page.waitForTimeout(2000);

  // Extract article content
  const result = await page.evaluate(() => {
    function walkToMarkdown(root) {
      const blocks = [];
      const images = [];
      let imgIdx = 0;

      function walk(node, depth) {
        if (!node || node.nodeType === Node.COMMENT_NODE) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent.trim();
          if (t) blocks.push({ type: 'text', value: t, depth });
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName.toLowerCase();
        if (['script', 'style', 'svg', 'nav', 'footer', 'noscript', 'button', 'form', 'input'].includes(tag)) return;

        const text = node.textContent?.trim();
        if (!text) return;

        if (tag === 'h1') { blocks.push({ type: 'h1', value: text }); return; }
        if (tag === 'h2') { blocks.push({ type: 'h2', value: text }); return; }
        if (tag === 'h3') { blocks.push({ type: 'h3', value: text }); return; }
        if (tag === 'h4') { blocks.push({ type: 'h4', value: text }); return; }
        if (tag === 'blockquote') { blocks.push({ type: 'quote', value: text }); return; }
        if (tag === 'hr') { blocks.push({ type: 'hr' }); return; }
        if (tag === 'li') { blocks.push({ type: 'li', value: text }); return; }
        if (tag === 'img') {
          const src = node.getAttribute('src') || '';
          const alt = node.getAttribute('alt') || '';
          if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo')) {
            imgIdx++;
            images.push({ src, alt, filename: `image-${imgIdx}` });
            blocks.push({ type: 'img', alt, filename: `image-${imgIdx}` });
          }
          return;
        }

        // For paragraph-level elements
        if (['p'].includes(tag)) {
          // Check for inline children (links, bold, etc.)
          let md = '';
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              md += child.textContent;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              const ctag = child.tagName.toLowerCase();
              const ctext = child.textContent?.trim();
              if (!ctext) continue;
              if (ctag === 'strong' || ctag === 'b') md += `**${ctext}**`;
              else if (ctag === 'em' || ctag === 'i') md += `*${ctext}*`;
              else if (ctag === 'a') {
                const href = child.getAttribute('href') || '';
                md += `[${ctext}](${href})`;
              }
              else if (ctag === 'code') md += `\`${ctext}\``;
              else md += ctext;
            }
          }
          if (md.trim()) blocks.push({ type: 'p', value: md.trim() });
          return;
        }

        // Container elements — recurse
        for (const child of node.childNodes) walk(child, depth + 1);
      }

      walk(root, 0);
      return { blocks, images };
    }

    // Try Substack-specific selectors first
    const selectors = [
      '.body.markup',           // Substack article body
      'article .post-content',  // Substack alt
      '.available-content',     // Substack paywall-free
      'article',
      '[role="article"]',
      'main',
      '.post-content',
      '.entry-content',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 500) {
        const { blocks, images } = walkToMarkdown(el);
        return { source: sel, blocks, images };
      }
    }

    // Fallback
    const main = document.querySelector('main') || document.body;
    const { blocks, images } = walkToMarkdown(main);
    return { source: 'fallback', blocks, images };
  });

  // Convert blocks to markdown
  const mdLines = [];
  const seen = new Set();

  for (const b of result.blocks) {
    // Deduplicate consecutive identical blocks
    const key = `${b.type}:${b.value || ''}`;
    if (b.type !== 'hr' && seen.has(key) && b.type === 'p') continue;

    switch (b.type) {
      case 'h1': mdLines.push(`# ${b.value}`); break;
      case 'h2': mdLines.push(`\n## ${b.value}\n`); break;
      case 'h3': mdLines.push(`\n### ${b.value}\n`); break;
      case 'h4': mdLines.push(`\n#### ${b.value}\n`); break;
      case 'quote': mdLines.push(`\n> ${b.value}\n`); break;
      case 'hr': mdLines.push('\n---\n'); break;
      case 'li': mdLines.push(`- ${b.value}`); break;
      case 'img': mdLines.push(`\n![${b.alt}](${b.filename})\n`); break;
      case 'p': mdLines.push(`${b.value}\n`); break;
      case 'text': mdLines.push(`${b.value}\n`); break;
    }
    seen.add(key);
  }

  const markdown = mdLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // Write markdown
  const mdPath = path.join(outDir, 'article.md');
  const output = `---\nsource: ${url}\nscraped: ${new Date().toISOString()}\n---\n\n${markdown}\n`;
  fs.writeFileSync(mdPath, output);

  console.log(`✅ ${markdown.length} chars, ${result.blocks.length} blocks from "${result.source}"`);
  console.log(`📄 ${mdPath}`);

  // Download images
  const images = result.images || [];
  if (images.length > 0) {
    console.log(`🖼️  ${images.length} image(s)`);
    const https = require('https');
    const http = require('http');
    for (const img of images) {
      try {
        const ext = img.src.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'jpg';
        const dest = path.join(outDir, `${img.filename}.${ext}`);
        await new Promise((resolve, reject) => {
          const mod = img.src.startsWith('https') ? https : http;
          mod.get(img.src, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              mod.get(res.headers.location, (res2) => {
                res2.pipe(fs.createWriteStream(dest)).on('finish', resolve);
              }).on('error', reject);
            } else {
              res.pipe(fs.createWriteStream(dest)).on('finish', resolve);
            }
          }).on('error', reject);
        });
        console.log(`   ✅ ${img.filename}.${ext}`);
      } catch (e) {
        console.log(`   ❌ ${img.filename}: ${e.message}`);
      }
    }
  }

  await browser.close();
})();
