const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

const workspace = '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/cody-workspace/x-article-2010751592346030461';
const htmlPath = path.join(workspace, 'part1-zh.html');
const outHtmlPath = path.join(workspace, 'part1-zh-composited.html');
const baseImageDir = workspace;
const outImageDir = path.join(workspace, 'composited_images');

if (!fs.existsSync(outImageDir)) {
    fs.mkdirSync(outImageDir, { recursive: true });
}

// Helper to wrap text into multiple lines if it exceeds maximum width
function wrapText(ctx, text, maxWidth) {
    let words = text.split(''); // For Chinese we generally split by char
    let lines = [];
    let currentLine = '';

    for (let char of words) {
        let testLine = currentLine + char;
        let metrics = ctx.measureText(testLine);
        if (metrics.width > maxWidth && currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = char;
        } else {
            currentLine = testLine;
        }
    }
    lines.push(currentLine);
    return lines;
}

// Generate image with dynamic wrapping and lower-third gradient blending
async function createVisual(text, imageFilename, outputName, isHeader, index = 0) {
    const inputImgPath = fs.existsSync(path.join(baseImageDir, imageFilename)) 
        ? path.join(baseImageDir, imageFilename) 
        : '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/weixin-sync/dummy.jpg';

    const image = await loadImage(inputImgPath);
    let width = image.width;
    let height = image.height;
    
    // Enforce minimum width
    if (width < 1000) {
        height = Math.floor(height * (1000 / width));
        width = 1000;
    }

    let canvasW = width;
    let canvasH = height;
    if (isHeader) {
        canvasH = Math.floor(width / 2.35); // 2.35:1 for headers
        if (canvasH > height) {
            canvasH = height;
            canvasW = Math.floor(height * 2.35);
        }
    } else {
        canvasH = Math.floor(width / 1.77); // 16:9 for inlines
        if (canvasH > height) {
            canvasH = height;
            canvasW = Math.floor(height * 1.77);
        }
    }

    const canvas = createCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d');

    const sx = Math.max(0, (image.width - canvasW) / 2);
    const sy = Math.max(0, (image.height - canvasH) / 2);
    ctx.drawImage(image, sx, sy, canvasW, canvasH, 0, 0, canvasW, canvasH);

    // Apply distinct color tint to prevent visual reuse for exactly 8 variations
    const hues = [0, 45, 90, 135, 180, 225, 270, 315];
    const tintColor = `hsla(${hues[index % 8]}, 60%, 20%, 0.8)`;
    ctx.fillStyle = tintColor;
    ctx.fillRect(0, 0, canvasW, canvasH);

    const gradient = ctx.createLinearGradient(0, canvasH * 0.4, 0, canvasH);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0.95)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvasW, canvasH);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Dynamic text
    const cleanText = text.replace(/<[^>]+>/g, ''); // strip inline HTML
    let fontSize = isHeader ? Math.floor(canvasW / 18) : Math.floor(canvasW / 24);
    ctx.font = `bold ${fontSize}px "PingFang SC, sans-serif"`;

    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 3;

    const lines = wrapText(ctx, cleanText, canvasW * 0.85);

    const lineHeight = fontSize * 1.4;
    const totalTextHeight = lines.length * lineHeight;
    let startY = canvasH - (totalTextHeight / 2) - (canvasH * 0.1); 

    for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], canvasW / 2, startY + (i * lineHeight));
    }

    const outputPath = path.join(outImageDir, outputName);
    fs.writeFileSync(outputPath, canvas.toBuffer('image/jpeg', { quality: 0.9 }));
    console.log(`Generated: ${outputPath}`);
    
    return outputPath;
}

// Extract headings directly from the HTML and modify the sequence
async function run() {
    let html = fs.readFileSync(htmlPath, 'utf8');
    
    // Find H1
    const h1Regex = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
    const h1Match = html.match(h1Regex);
    if (h1Match) {
       let h1Text = h1Match[1].trim();
       await createVisual(h1Text, 'image-1.jpg', 'header-main.jpg', true);
       
       let imgTag = `<div style="text-align: center; margin: 32px -24px; padding: 0"><img src="${path.join(outImageDir, 'header-main.jpg')}" style="max-width: 100%; height: auto; border-radius: 2px" /></div>`;
       
       html = html.replace(h1Match[0], h1Match[0] + '\n' + imgTag);
    }

    // Find all H2s
    let h2Regex = /(<h2[^>]*>)([\s\S]*?)(<\/h2>)/gi;
    let h2Matches = [...html.matchAll(h2Regex)];
    let count = 1;
    for (let match of h2Matches) {
        let fullH2 = match[0];
        let h2TextContent = match[2].trim().replace(/<span[^>]*>.*?<\/span>/i, '').trim(); 
        
        // Use 8 distinct images
        let imgName = `image-${(count % 8) + 1}.jpg`;
        let outName = `section-${count}.jpg`;
        await createVisual(h2TextContent, imgName, outName, false, count - 1);
        
        let imgTag = `\n<div style="text-align: center; margin: 32px -24px; padding: 0"><img src="${path.join(outImageDir, outName)}" style="max-width: 100%; height: auto; border-radius: 2px" /></div>\n`;
        html = html.replace(fullH2, fullH2 + imgTag);
        count++;
    }

    // Fix padding styling bug
    html = html.replace(/<br\s*\/?>\s*<ul/gi, '<ul');
    html = html.replace(/<\/ul>\s*<br\s*\/?>/gi, '</ul>');
    html = html.replace(/<br\s*\/?>\s*<li/gi, '<li');
    html = html.replace(/<\/li>\s*<br\s*\/?>/gi, '</li>');
    html = html.replace(/<ul/gi, '<ul style="margin: 0; padding-left: 15px;"');
    html = html.replace(/<li/gi, '<li style="margin: 0; padding-left: 15px;"');

    fs.writeFileSync(outHtmlPath, html);
    console.log(`HTML Composited into ${outHtmlPath}`);
}

run().catch(console.error);
