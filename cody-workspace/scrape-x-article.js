#!/usr/bin/env node
// Scrape full text + images of an X (Twitter) Article via cookie injection
// Usage: node scrape-x-article.js [url]
//        node scrape-x-article.js [url] --debug

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Load .env manually (no dependency needed)
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const authToken = envContent
  .split('\n')
  .find(line => line.startsWith('X_AUTH_TOKEN='))
  ?.split('=')[1]
  ?.trim();

if (!authToken || authToken === 'your_auth_token_here') {
  console.error('❌ Set X_AUTH_TOKEN in .env first');
  console.error('   Browser DevTools → Application → Cookies → x.com → auth_token');
  process.exit(1);
}

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TARGET_URL = args[0] || 'https://x.com/i/article/2037522452104847360';
const DEBUG = process.argv.includes('--debug');

// Download a file via https
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

(async () => {
  console.log(`🔗 Target: ${TARGET_URL}`);

  const articleId = TARGET_URL.match(/(?:article|status)\/(\d+)/)?.[1] || 'unknown';
  const outDir = path.join(__dirname, `x-article-${articleId}`);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  // Inject auth_token cookie
  await context.addCookies([
    {
      name: 'auth_token',
      value: authToken,
      domain: '.x.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    },
  ]);

  const page = await context.newPage();

  try {
    console.log('🌐 Navigating...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for content to fully render
    console.log('⏳ Waiting for article body to render...');
    await page.waitForTimeout(5000);

    // Scroll to bottom to trigger lazy-loaded content
    console.log('📜 Scrolling to load full content...');
    await autoScroll(page);
    await page.waitForTimeout(2000);

    if (DEBUG) {
      const debugPath = path.join(outDir, 'debug-screenshot.png');
      await page.screenshot({ path: debugPath, fullPage: true });
      console.log(`🔍 Debug screenshot: ${debugPath}`);
      const html = await page.content();
      fs.writeFileSync(path.join(outDir, 'debug-page.html'), html);
      console.log('🔍 Debug HTML: debug-page.html');
    }

    // ── Extract text + image URLs from the page ──
    const result = await page.evaluate(() => {
      function getStyle(el, prop) {
        return window.getComputedStyle(el)?.[prop] || '';
      }

      function isVisible(el) {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      function isBlock(el) {
        const display = getStyle(el, 'display');
        return ['block', 'flex', 'grid', 'list-item', 'table'].some(d => display.includes(d));
      }

      function walkToMarkdown(root) {
        const blocks = [];
        const images = [];
        let currentBlock = [];
        let imgIndex = 0;

        function flush() {
          const text = currentBlock.join('').trim();
          if (text) blocks.push(text);
          currentBlock = [];
        }

        function walk(node) {
          if (!node) return;
          // Skip invisible elements — but make an exception for <img> tags
          // because X hides the real <img> behind a background-image div
          if (node.nodeType === Node.ELEMENT_NODE && !isVisible(node)) {
            const tag = node.tagName?.toLowerCase();
            const src = node.getAttribute?.('src') || '';
            if (!(tag === 'img' && src.includes('pbs.twimg.com/media'))) return;
          }

          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (text.trim()) currentBlock.push(text);
            return;
          }

          if (node.nodeType !== Node.ELEMENT_NODE) return;

          const tag = node.tagName.toLowerCase();

          if (['script', 'style', 'svg', 'button', 'nav', 'header', 'footer', 'noscript'].includes(tag)) return;

          const testId = node.getAttribute('data-testid') || '';
          if (['followButton', 'unfollow', 'like', 'reply', 'retweet', 'share'].some(id => testId.includes(id))) return;

          if (tag === 'h1') { flush(); blocks.push(`# ${node.textContent.trim()}`); return; }
          if (tag === 'h2') { flush(); blocks.push(`## ${node.textContent.trim()}`); return; }
          if (tag === 'h3') { flush(); blocks.push(`### ${node.textContent.trim()}`); return; }
          if (tag === 'h4') { flush(); blocks.push(`#### ${node.textContent.trim()}`); return; }
          if (tag === 'blockquote') { flush(); blocks.push(`> ${node.textContent.trim()}`); return; }
          if (tag === 'hr') { flush(); blocks.push('---'); return; }
          if (tag === 'br') { currentBlock.push('\n'); return; }
          if (tag === 'li') { flush(); blocks.push(`- ${node.textContent.trim()}`); return; }

          if (tag === 'img') {
            const src = node.getAttribute('src') || '';
            const alt = node.getAttribute('alt') || '';
            // Only capture article content images (pbs.twimg.com/media), skip profile pics and emojis
            if (src.includes('pbs.twimg.com/media')) {
              imgIndex++;
              const filename = `image-${imgIndex}`;
              images.push({ src, alt, filename });
              flush();
              blocks.push(`![${alt || `Image ${imgIndex}`}](${filename})`);
            }
            return;
          }

          if (tag === 'a') {
            const href = node.getAttribute('href') || '';
            const text = node.textContent.trim();
            if (text && href && !href.startsWith('javascript:') && !href.startsWith('#')) {
              const fullHref = href.startsWith('/') ? `https://x.com${href}` : href;
              currentBlock.push(`[${text}](${fullHref})`);
            } else if (text) {
              currentBlock.push(text);
            }
            return;
          }

          if (isBlock(node) && tag !== 'span') {
            flush();
            for (const child of node.childNodes) {
              walk(child);
            }
            flush();
            return;
          }

          for (const child of node.childNodes) {
            walk(child);
          }
        }

        walk(root);
        flush();
        return { blocks, images };
      }

      // ── Collect all article images from the entire page ──
      // X hides <img> behind background-image divs, so query directly
      const allImages = [];
      document.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach((img, i) => {
        const src = img.getAttribute('src') || '';
        const alt = img.getAttribute('alt') || '';
        allImages.push({ src, alt, filename: `image-${i + 1}` });
      });

      // Try article selectors
      const selectors = [
        '[data-testid="article-body"]',
        '[data-testid="articleContent"]',
        'article[data-testid="article"]',
        'article',
        '[role="article"]',
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim().length > 200) {
          const { blocks } = walkToMarkdown(el);
          return { source: sel, blocks, images: allImages };
        }
      }

      const mainColumn = document.querySelector('[data-testid="primaryColumn"]')
        || document.querySelector('main')
        || document.querySelector('[role="main"]');

      if (mainColumn) {
        const { blocks } = walkToMarkdown(mainColumn);
        return { source: 'primaryColumn/main', blocks, images: allImages };
      }

      const root = document.querySelector('#react-root') || document.body;
      const { blocks } = walkToMarkdown(root);
      return { source: 'react-root/body', blocks, images: allImages };
    });

    // ── Post-process text blocks ──
    let blocks = result.blocks;
    blocks = blocks.filter((block, i) => i === 0 || block !== blocks[i - 1]);
    blocks = blocks.filter(block => {
      if (block.startsWith('#') || block.startsWith('>') || block.startsWith('-') || block.startsWith('---') || block.startsWith('![')) return true;
      if (/^(Follow|Following|Sign up|Log in|More|Search|Post|Repost|Like|Share|Bookmark|Copy link|Report)$/i.test(block)) return false;
      if (/^(View keyboard shortcuts|To view keyboard|Keyboard shortcuts)/i.test(block)) return false;
      if (/^\d+$/.test(block)) return false;
      if (/^@\w+$/.test(block)) return false;
      return block.length > 3;
    });

    const markdown = blocks.join('\n\n');

    if (!markdown || markdown.length < 100) {
      console.error('❌ Extracted text is too short — article may not have loaded.');
      console.error(`   Source: ${result.source}, Length: ${markdown.length}`);
      const debugPath = path.join(outDir, 'debug-screenshot.png');
      await page.screenshot({ path: debugPath, fullPage: true });
      console.error(`   Debug screenshot: ${debugPath}`);
      process.exit(1);
    }

    console.log(`✅ Extracted ${markdown.length} chars (${blocks.length} blocks) from "${result.source}"`);

    // ── Download images ──
    const images = result.images || [];
    if (images.length > 0) {
      console.log(`🖼️  Found ${images.length} image(s), downloading...`);
      for (const img of images) {
        // Request highest resolution version
        let url = img.src;
        // Upgrade to large size
        url = url.replace(/name=\w+/, 'name=large');
        // Determine extension from format param or URL
        const formatMatch = url.match(/format=(\w+)/);
        const ext = formatMatch ? formatMatch[1] : 'jpg';
        const filename = `${img.filename}.${ext}`;
        const destPath = path.join(outDir, filename);

        try {
          await downloadFile(url, destPath);
          const size = fs.statSync(destPath).size;
          console.log(`   ✅ ${filename} (${(size / 1024).toFixed(0)} KB)`);
          // Update the markdown reference with the actual filename
          const placeholder = `![${img.alt || `Image`}](${img.filename})`;
          // Find and replace in blocks (already joined, so replace in markdown)
        } catch (err) {
          console.error(`   ❌ Failed to download ${filename}: ${err.message}`);
        }
      }
    } else {
      console.log('🖼️  No article images found.');
    }

    // ── Build final markdown with correct image references ──
    let finalMarkdown = markdown;
    for (const img of images) {
      const formatMatch = img.src.match(/format=(\w+)/);
      const ext = formatMatch ? formatMatch[1] : 'jpg';
      const filename = `${img.filename}.${ext}`;
      // Replace bare filename placeholder with actual file
      finalMarkdown = finalMarkdown.replace(
        `(${img.filename})`,
        `(${filename})`
      );
    }

    const outFile = path.join(outDir, 'article.md');
    const output = `---
source: ${TARGET_URL}
scraped: ${new Date().toISOString()}
---

${finalMarkdown}
`;

    fs.writeFileSync(outFile, output);
    console.log(`📄 Saved: ${outFile}`);
    console.log(`📁 Output folder: ${outDir}`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    const debugPath = path.join(outDir, 'debug-screenshot.png');
    await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
    console.error(`   Debug screenshot: ${debugPath}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();

// Auto-scroll to load lazy content
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 150);
      setTimeout(() => { clearInterval(timer); resolve(); }, 15000);
    });
  });
}
