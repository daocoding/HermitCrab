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

    ctx.drawImage(bgImage, 0, 0, width, height);

    // Dark gradient overlay on bottom half for text readability
    const gradient = ctx.createLinearGradient(0, height * 0.4, 0, height);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Process text
    let cleanText = text.replace(/^[IVXV]+\s*/, '').replace(/^"|"$|"$/g, '').trim();
    if (cleanText.startsWith('"最难的科学"')) {
        cleanText = cleanText.substring(0);
    }
    
    let fontSize = 60; // Max font size
    ctx.font = `600 ${fontSize}px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
    
    // Dynamic resizing and wrapping based on canvas width
    const maxWidth = width * 0.85; 
    let lines = [];
    
    while (fontSize > 16) {
        lines = [];
        let currentLine = '';
        const chars = cleanText.split('');
        for (let i = 0; i < chars.length; i++) {
            const testLine = currentLine + chars[i];
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && currentLine.length > 0) {
                lines.push(currentLine);
                currentLine = chars[i];
            } else {
                currentLine = testLine;
            }
        }
        lines.push(currentLine);
        
        // Let's settle for at most 2 lines, if possible.
        if (lines.length <= 2) {
            break;
        }
        fontSize -= 4;
        ctx.font = `600 ${fontSize}px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
    }

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    const lineHeight = fontSize * 1.4;
    let startY = height - (lines.length * lineHeight) / 2 - 30;

    for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], width / 2, startY + (i * lineHeight));
    }

    const out = fs.createWriteStream(outPath);
    const stream = canvas.createPNGStream();
    stream.pipe(out);
    return new Promise((resolve, reject) => {
        out.on('finish', () => resolve(outPath));
        out.on('error', reject);
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

        const imageBases = [
            '/Users/yourusername/.gemini/antigravity/brain/b9153b36-5d67-47e7-91af-79e171ea667f/sec1_pendulum_cell_1774674597661.png',
            '/Users/yourusername/.gemini/antigravity/brain/47b5fc95-00c8-41a6-af13-bd3ade6188d5/multiscale_emergent_base_1774672306299.png',
            '/Users/yourusername/.gemini/antigravity/brain/47b5fc95-00c8-41a6-af13-bd3ade6188d5/adaptation_plasticity_base_1774672321338.png',
            '/Users/yourusername/.gemini/antigravity/brain/b9153b36-5d67-47e7-91af-79e171ea667f/sec4_noise_robustness_1774674613301.png',
            '/Users/yourusername/.gemini/antigravity/brain/47b5fc95-00c8-41a6-af13-bd3ade6188d5/disease_multiscale_base_1774672334481.png',
            '/Users/yourusername/.gemini/antigravity/brain/b9153b36-5d67-47e7-91af-79e171ea667f/sec6_research_modeling_1774674628048.png',
            '/Users/yourusername/.gemini/antigravity/brain/b9153b36-5d67-47e7-91af-79e171ea667f/sec7_genotype_phenotype_1774674641352.png'
        ];

        const boundary = '----WebKitFormBoundaryMyImageBoundary';
        let count = 0;
        
        const h2Elements = $('h2').toArray();
        for (let el of h2Elements) {
            const h2 = $(el);
            let text = h2.text().trim();
            // Optional cleanup for roman numeral part if the CSS spans get mangled in generic text() method:
            text = text.replace(/^[IVX]+/, '').trim();

            if (count < imageBases.length) {
                console.log(`Compositing for heading ${count + 1}: ${text}`);
                const tempPath = path.join(workspaceDir, `composite_v2_${count}.png`);
                await compositeImage(imageBases[count], text, tempPath);
                
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
            } else {
                console.log(`Warning: more headings than base images! Heading ${count+1}: ${text}`);
            }
            count++;
        }

        const finalHtml = $.html();
        const finalHtmlPath = path.join(workspaceDir, 'article-zh-final-v2.html');
        fs.writeFileSync(finalHtmlPath, finalHtml);

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

    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
