#!/usr/bin/env node
// Convert a Markdown article to WeChat-ready HTML (premium editorial style)
// Usage: node md-to-wechat.js <input.md> [output.html]

const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node md-to-wechat.js <input.md> [output.html]');
  process.exit(1);
}

const outputPath = process.argv[3] || inputPath.replace(/\.md$/, '.html');

// ── Premium editorial style ──
// Inspired by Nature, 得到, 少数派 — warm tones, generous whitespace, typographic hierarchy
const S = {
  // Outer wrapper — warm off-white background
  wrapper: [
    'max-width: 100%',
    'margin: 0 auto',
    'padding: 0',
    'background: #faf8f5',
    'font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Serif SC", "Source Han Serif CN", serif',
    'font-size: 17px',
    'line-height: 2',
    'color: #2c2c2c',
    'letter-spacing: 0.5px',
  ].join('; '),

  // Inner content column
  inner: [
    'max-width: 640px',
    'margin: 0 auto',
    'padding: 48px 24px 64px',
  ].join('; '),

  // Title
  h1: [
    'font-size: 28px',
    'font-weight: 900',
    'color: #1a1a1a',
    'text-align: center',
    'margin: 0 0 12px 0',
    'line-height: 1.5',
    'letter-spacing: 1px',
    'font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif',
  ].join('; '),

  // Subtitle / author
  subtitle: [
    'text-align: center',
    'font-size: 14px',
    'color: #999',
    'margin-bottom: 8px',
    'letter-spacing: 2px',
    'text-transform: uppercase',
  ].join('; '),

  // Decorative divider after title
  titleDivider: [
    'width: 40px',
    'height: 3px',
    'background: linear-gradient(90deg, #c9a96e, #e8d5b0)',
    'margin: 20px auto 40px',
    'border: none',
    'border-radius: 2px',
  ].join('; '),

  // Lead paragraph (first paragraph, slightly larger)
  pLead: [
    'margin: 0 0 24px 0',
    'text-align: justify',
    'font-size: 18px',
    'line-height: 2',
    'color: #333',
    'text-indent: 0',
  ].join('; '),

  // Section headings
  h2: [
    'font-size: 22px',
    'font-weight: 800',
    'color: #1a1a1a',
    'margin: 48px 0 6px 0',
    'padding: 0',
    'line-height: 1.5',
    'letter-spacing: 0.5px',
    'font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif',
  ].join('; '),

  // Gold accent bar under h2
  h2Bar: [
    'width: 28px',
    'height: 3px',
    'background: #c9a96e',
    'margin: 8px 0 20px 0',
    'border: none',
    'border-radius: 2px',
  ].join('; '),

  h3: [
    'font-size: 19px',
    'font-weight: 700',
    'color: #2c2c2c',
    'margin: 36px 0 14px 0',
    'line-height: 1.5',
    'font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
  ].join('; '),

  h4: [
    'font-size: 17px',
    'font-weight: 700',
    'color: #444',
    'margin: 28px 0 10px 0',
    'line-height: 1.5',
  ].join('; '),

  // Body paragraph
  p: [
    'margin: 0 0 20px 0',
    'text-align: justify',
    'font-size: 17px',
    'line-height: 2',
    'color: #2c2c2c',
  ].join('; '),

  // Blockquote — left gold bar, subtle background
  blockquote: [
    'margin: 24px 0',
    'padding: 16px 20px 16px 24px',
    'border-left: 3px solid #c9a96e',
    'background: rgba(201, 169, 110, 0.06)',
    'color: #555',
    'font-size: 16px',
    'line-height: 1.9',
    'border-radius: 0 6px 6px 0',
  ].join('; '),

  // Lists
  ul: [
    'margin: 16px 0 24px 0',
    'padding: 0 0 0 24px',
  ].join('; '),

  li: [
    'margin: 0 0 10px 0',
    'font-size: 17px',
    'line-height: 1.9',
    'color: #2c2c2c',
    'list-style-type: none',
    'position: relative',
    'padding-left: 16px',
  ].join('; '),

  // Bullet character (gold)
  liBullet: [
    'color: #c9a96e',
    'font-weight: bold',
    'margin-right: 8px',
  ].join('; '),

  // Horizontal rule — thin elegant line
  hr: [
    'border: none',
    'height: 1px',
    'background: linear-gradient(90deg, transparent, #d4c5a9, transparent)',
    'margin: 40px 0',
  ].join('; '),

  // Image container
  imgWrap: [
    'text-align: center',
    'margin: 32px -24px',
    'padding: 0',
  ].join('; '),

  img: [
    'max-width: 100%',
    'height: auto',
    'border-radius: 2px',
  ].join('; '),

  imgCaption: [
    'font-size: 13px',
    'color: #aaa',
    'margin-top: 10px',
    'text-align: center',
    'letter-spacing: 1px',
  ].join('; '),

  // Inline: bold — slightly darker
  strong: [
    'font-weight: 700',
    'color: #1a1a1a',
  ].join('; '),

  // Inline: English terms in parentheses — muted gold
  term: [
    'color: #a08850',
    'font-style: italic',
    'font-family: "Georgia", "Times New Roman", serif',
  ].join('; '),

  // Inline: links
  link: [
    'color: #a08850',
    'text-decoration: none',
    'border-bottom: 1px solid rgba(160, 136, 80, 0.3)',
  ].join('; '),

  // Inline code
  code: [
    'background: rgba(201, 169, 110, 0.1)',
    'padding: 2px 6px',
    'border-radius: 3px',
    'font-size: 15px',
    'color: #8a6d3b',
    'font-family: "SF Mono", "Fira Code", monospace',
  ].join('; '),

  // Image placeholder for JARVIS
  placeholder: [
    'text-align: center',
    'margin: 32px 0',
    'padding: 32px 24px',
    'background: rgba(201, 169, 110, 0.08)',
    'border: 1.5px dashed #c9a96e',
    'border-radius: 8px',
    'color: #a08850',
    'font-size: 14px',
    'letter-spacing: 1px',
  ].join('; '),

  // Footer
  footer: [
    'margin-top: 48px',
    'padding-top: 24px',
    'border-top: 1px solid #e8e0d0',
    'font-size: 13px',
    'color: #bbb',
    'text-align: center',
    'letter-spacing: 1px',
  ].join('; '),

  // Drop cap for first paragraph
  dropCap: [
    'float: left',
    'font-size: 52px',
    'line-height: 1',
    'padding: 0 10px 0 0',
    'margin-top: 4px',
    'color: #c9a96e',
    'font-weight: 900',
    'font-family: Georgia, "Noto Serif SC", serif',
  ].join('; '),

  // Section number (subtle, before h2 text)
  sectionNum: [
    'font-size: 13px',
    'color: #c9a96e',
    'letter-spacing: 3px',
    'display: block',
    'margin-bottom: 4px',
    'font-weight: 400',
    'font-family: Georgia, serif',
  ].join('; '),
};

// ── Parse markdown ──
const raw = fs.readFileSync(inputPath, 'utf8');
const content = raw.replace(/^---[\s\S]*?---\n*/, '');

const lines = content.split('\n');
const html = [];
let inList = false;
let isFirstParagraph = true;
let sectionCount = 0;
let afterH1 = false;

html.push(`<section style="${S.wrapper}">`);
html.push(`<section style="${S.inner}">`);

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();

  if (trimmed === '') {
    if (inList) { html.push('</ul>'); inList = false; }
    continue;
  }

  // H1 — title
  if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
    if (inList) { html.push('</ul>'); inList = false; }
    const titleText = inline(trimmed.slice(2));
    html.push(`<h1 style="${S.h1}">${titleText}</h1>`);
    html.push(`<div style="${S.titleDivider}"></div>`);
    afterH1 = true;
    isFirstParagraph = true;
    continue;
  }

  // H2 — with section number and gold bar
  if (trimmed.startsWith('## ') && !trimmed.startsWith('### ')) {
    if (inList) { html.push('</ul>'); inList = false; }
    sectionCount++;
    const sectionLabel = toRoman(sectionCount);
    html.push(`<h2 style="${S.h2}"><span style="${S.sectionNum}">${sectionLabel}</span>${inline(trimmed.slice(3))}</h2>`);
    html.push(`<div style="${S.h2Bar}"></div>`);
    isFirstParagraph = true;
    continue;
  }

  // H3
  if (trimmed.startsWith('### ') && !trimmed.startsWith('#### ')) {
    if (inList) { html.push('</ul>'); inList = false; }
    html.push(`<h3 style="${S.h3}">${inline(trimmed.slice(4))}</h3>`);
    isFirstParagraph = true;
    continue;
  }

  // H4
  if (trimmed.startsWith('#### ')) {
    if (inList) { html.push('</ul>'); inList = false; }
    html.push(`<h4 style="${S.h4}">${inline(trimmed.slice(5))}</h4>`);
    continue;
  }

  // HR
  if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
    if (inList) { html.push('</ul>'); inList = false; }
    html.push(`<hr style="${S.hr}" />`);
    continue;
  }

  // Blockquote
  if (trimmed.startsWith('> ')) {
    if (inList) { html.push('</ul>'); inList = false; }
    html.push(`<blockquote style="${S.blockquote}">${inline(trimmed.slice(2))}</blockquote>`);
    continue;
  }

  // Image
  const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (imgMatch) {
    if (inList) { html.push('</ul>'); inList = false; }
    const alt = imgMatch[1];
    const src = imgMatch[2];

    if (src.startsWith('/') || src.startsWith('./') || !src.startsWith('http')) {
      html.push(`<div style="${S.placeholder}">IMAGE PLACEHOLDER: ${alt || src}<br/><span style="font-size: 12px; color: #ccc;">${src}</span></div>`);
    } else {
      html.push(`<div style="${S.imgWrap}">`);
      html.push(`  <img src="${src}" alt="${alt}" style="${S.img}" />`);
      if (alt && alt !== 'Image') {
        html.push(`  <p style="${S.imgCaption}">${alt}</p>`);
      }
      html.push(`</div>`);
    }
    continue;
  }

  // List items
  if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
    if (!inList) { html.push(`<ul style="${S.ul}">`); inList = true; }
    html.push(`<li style="${S.li}"><span style="${S.liBullet}">·</span>${inline(trimmed.slice(2))}</li>`);
    continue;
  }

  // Numbered list
  const olMatch = trimmed.match(/^\d+\.\s+(.*)/);
  if (olMatch) {
    if (!inList) { html.push(`<ul style="${S.ul}">`); inList = true; }
    html.push(`<li style="${S.li}"><span style="${S.liBullet}">·</span>${inline(olMatch[1])}</li>`);
    continue;
  }

  // Paragraph — first one after heading gets drop cap treatment
  if (inList) { html.push('</ul>'); inList = false; }

  if (isFirstParagraph && trimmed.length > 40) {
    const firstChar = trimmed[0];
    const rest = trimmed.slice(1);
    html.push(`<p style="${S.pLead}"><span style="${S.dropCap}">${firstChar}</span>${inline(rest)}</p>`);
    isFirstParagraph = false;
  } else {
    html.push(`<p style="${S.p}">${inline(trimmed)}</p>`);
    isFirstParagraph = false;
  }
}

if (inList) html.push('</ul>');

// Footer
html.push(`<div style="${S.footer}">— END —</div>`);
html.push(`</section>`);
html.push(`</section>`);

// ── Inline formatting ──
function inline(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, `<strong style="${S.strong}">$1</strong>`)
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a style="${S.link}" href="$2">$1</a>`)
    .replace(/`([^`]+)`/g, `<code style="${S.code}">$1</code>`)
    // English terms in Chinese parentheses — elegant serif italic
    .replace(/（([A-Za-z][A-Za-z\s\-,.']+)）/g, `（<span style="${S.term}">$1</span>）`);
}

// Roman numerals for section labels
function toRoman(n) {
  const map = [[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
  let result = '';
  for (const [val, sym] of map) {
    while (n >= val) { result += sym; n -= val; }
  }
  return result;
}

// ── Write output ──
const finalHtml = html.join('\n');
fs.writeFileSync(outputPath, finalHtml);

console.log(`✅ WeChat HTML generated: ${outputPath}`);
console.log(`   ${finalHtml.length} chars, ${html.length} elements`);

// Metadata for JARVIS
const meta = {
  title: content.match(/^#\s+(.*)/m)?.[1]?.trim() || 'Untitled',
  source: raw.match(/source:\s*(.*)/)?.[1]?.trim() || '',
  htmlPath: path.resolve(outputPath),
  imagePlaceholders: (finalHtml.match(/IMAGE PLACEHOLDER/g) || []).length,
  charCount: finalHtml.length,
};

const metaPath = outputPath.replace(/\.html$/, '.meta.json');
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
console.log(`   Metadata: ${metaPath}`);
