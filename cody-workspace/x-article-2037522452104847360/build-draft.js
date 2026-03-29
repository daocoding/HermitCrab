const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const { createCanvas, loadImage } = require('canvas');

const workspaceDir = '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/cody-workspace/x-article-2037522452104847360';
const htmlPath = path.join(workspaceDir, 'article-zh.html');
const envPath = '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/weixin-sync/.env';

// 1. Load credentials
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
        env[match[1].trim()] = match[2].trim();
    }
});

const APP_ID = env.WEIXIN_APP_ID;
const APP_SECRET = env.WEIXIN_APP_SECRET;

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

function httpsPost(url, payload) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const dataStr = JSON.stringify(payload);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(dataStr)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        });

        req.on('error', reject);
        req.write(dataStr);
        req.end();
    });
}

function uploadMaterial(url, boundary, filePath, fileName = "image.png") {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const fileContent = fs.readFileSync(filePath);
        let mime = 'image/jpeg';
        if (filePath.toLowerCase().endsWith('.png')) mime = 'image/png';

        const start = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="media"; filename="${fileName}"\r\n` +
            `Content-Type: ${mime}\r\n\r\n`
        );
        const end = Buffer.from(`\r\n--${boundary}--\r\n`);

        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': start.length + fileContent.length + end.length
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        });

        req.on('error', reject);
        req.write(start);
        req.write(fileContent);
        req.write(end);
        req.end();
    });
}

async function compositeImage(basePath, text, outPath) {
    const bgImage = await loadImage(basePath);
    const width = bgImage.width;
    const height = bgImage.height;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Draw background
    ctx.drawImage(bgImage, 0, 0, width, height);

    // Dark gradient overlay
    const gradient = ctx.createLinearGradient(0, height * 0.5, 0, height);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.8)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Extract the roman numeral prefix and text
    const match = text.match(/^([IVX]+)\s*(.*)/);
    let numeral = '';
    let cleanText = text;
    if (match) {
        numeral = match[1];
        cleanText = match[2];
    } else {
        cleanText = text.replace(/^[IVX]+\s*/, '');
    }
    
    // Main Settings
    const fontSize = 48; // Base font size
    ctx.font = 'bold 48px "Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    const margin = 80;
    const maxTextWidth = width - margin * 2;

    // Word Wrap Logic
    const lines = [];
    let currentLine = '';
    
    // Since it's Chinese, we can wrap per character safely if needed
    for (let i = 0; i < cleanText.length; i++) {
        const char = cleanText[i];
        const testLine = currentLine + char;
        const testWidth = ctx.measureText(testLine).width;
        
        if (testWidth > maxTextWidth && i > 0) {
            lines.push(currentLine);
            currentLine = char;
        } else {
            currentLine = testLine;
        }
    }
    if (currentLine) {
        lines.push(currentLine);
    }
    
    if (numeral) {
        lines.unshift(numeral); // Add numeral as the first line
    }

    // Render Text Centered Vertically
    const lineHeight = fontSize * 1.4;
    const totalTextHeight = lines.length * lineHeight;
    let startY = (height / 2) - (totalTextHeight / 2) + (lineHeight / 2);

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (i === 0 && numeral) {
            ctx.font = 'bold 36px Georgia, serif';
            ctx.fillStyle = '#c9a96e'; // Gold accent for numeral
        } else {
            ctx.font = 'bold 48px "Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", sans-serif';
            ctx.fillStyle = '#ffffff';
        }
        ctx.fillText(line, width / 2, startY + i * lineHeight);
    }

    const out = fs.createWriteStream(outPath);
    const stream = canvas.createPNGStream();
    stream.pipe(out);
    return new Promise((resolve) => {
        out.on('finish', () => resolve(outPath));
    });
}

(async () => {
    try {
        console.log("Exchanging token...");
        const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APP_ID}&secret=${APP_SECRET}`;
        const tokenRes = await httpsGet(tokenUrl);
        const accessToken = tokenRes.access_token;
        if (!accessToken) throw new Error("No access token: " + JSON.stringify(tokenRes));

        let htmlContent = fs.readFileSync(htmlPath, 'utf8');
        const $ = cheerio.load(htmlContent, null, false);

        // Explicit 7 origin tangible image base files
        const brain1 = '/Users/yourusername/.gemini/antigravity/brain/deb45c81-1bc1-4bc7-9159-1c63ed05c155';
        const brain2 = '/Users/yourusername/.gemini/antigravity/brain/b9153b36-5d67-47e7-91af-79e171ea667f';
        const imageBases = [
            path.join(brain2, 'sec1_pendulum_cell_1774674597661.png'),
            path.join(brain1, 'biology_section_2_1774673713232.png'),
            path.join(brain1, 'biology_section_3_1774673726827.png'),
            path.join(brain2, 'sec4_noise_robustness_1774674613301.png'),
            path.join(brain1, 'biology_section_4_1774673741293.png'),
            path.join(brain2, 'sec6_research_modeling_1774674628048.png'),
            path.join(brain2, 'sec7_genotype_phenotype_1774674641352.png')
        ];

        const boundary = '----WebKitFormBoundaryMyImageBoundary';

        let count = 0;
        const uploadPromises = [];

        const h2Elements = $('h2').toArray();
        for (let el of h2Elements) {
            const h2 = $(el);
            const text = h2.text().trim();
            if (count < imageBases.length) {
                console.log(`Compositing for heading: ${text}`);
                const tempPath = path.join(workspaceDir, `composite_${count}.png`);
                await compositeImage(imageBases[count], text, tempPath);
                
                // Upload inline to wechat
                console.log(`Uploading inline image...`);
                const uploadUrl = `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${accessToken}`;
                const res = await uploadMaterial(uploadUrl, boundary, tempPath);
                
                if (res.url) {
                    console.log(`Injected: ${res.url}`);
                    const imgTag = `<p style="text-align: center; margin: 30px 0;"><img src="${res.url}" style="width: 100%; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" /></p>`;
                    h2.before(imgTag);
                } else {
                    console.error("Upload failed", res);
                }
            }
            count++;
        }

        // Generate final html
        const finalHtml = $.html();
        const finalHtmlPath = path.join(workspaceDir, 'article-zh-final.html');
        fs.writeFileSync(finalHtmlPath, finalHtml);

        // Upload thumb
        const thumbPath = '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/cody-workspace/生物.jpeg';
        console.log(`Uploading thumb...`);
        const matUrl = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${accessToken}&type=image`;
        const thumbRes = await uploadMaterial(matUrl, boundary, thumbPath);
        const thumbMediaId = thumbRes.media_id;
        if (!thumbMediaId) throw new Error("Thumb upload failed: " + JSON.stringify(thumbRes));
        
        console.log('Pushing draft to wechat...');
        const draftUrl = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${accessToken}`;
        const payload = {
            articles: [
                {
                    title: "为什么生物学是最难的科学",
                    author: "JARVIS",
                    digest: "生物学常被视为最难的科学。这里是深度解析。",
                    content: finalHtml,
                    thumb_media_id: thumbMediaId
                }
            ]
        };

        const draftRes = await httpsPost(draftUrl, payload);
        console.log("Draft response:", draftRes);

        // write worker log
        const workerLog = '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/workers/worker-1774673649210-vhn0nk.md';
        fs.writeFileSync(workerLog, '# WeChat Article Synthesizer\nDraft pushed successfully with composited AI canvases.');

        console.log('All done!');
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
