const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');

// 1. Load credentials from .env
const envPath = path.join(__dirname, '.env');
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

if (!APP_ID || !APP_SECRET) {
    console.error("Missing WEIXIN_APP_ID or WEIXIN_APP_SECRET in .env");
    process.exit(1);
}

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
        // Determine mime type based on extension
        const ext = path.extname(filePath).toLowerCase();
        let mime = 'image/jpeg';
        if (ext === '.png') mime = 'image/png';
        if (ext === '.gif') mime = 'image/gif';

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

async function main() {
    try {
        console.log("Exchanging credentials for access token...");
        const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APP_ID}&secret=${APP_SECRET}`;
        const tokenRes = await httpsGet(tokenUrl);

        if (!tokenRes.access_token) {
            console.error("Failed to get access token:", tokenRes);
            process.exit(1);
        }

        const accessToken = tokenRes.access_token;
        console.log("✅ Token received.");

        // 2. Read the final translation output
        const mdPath = '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/biology_wechat_draft.md';
        const mdContent = fs.readFileSync(mdPath, 'utf8');

        // Extract title
        const titleMatch = mdContent.match(/^#\s+(.*$)/m);
        const title = titleMatch ? titleMatch[1].trim() : "Biology Draft";

        // 3. Parse out the header image path (first image)
        const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        let match;
        const images = [];
        while ((match = imgRegex.exec(mdContent)) !== null) {
            images.push({
                fullMatch: match[0],
                alt: match[1],
                localPath: match[2]
            });
        }

        let headerImgPath = '';
        const thumbMatch = mdContent.match(/thumb_media_id:\s*"([^"]+)"/);
        
        if (thumbMatch) {
            headerImgPath = path.join('/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes', thumbMatch[1]);
        } else if (images.length > 0) {
            headerImgPath = images[0].localPath;
        } else {
            console.error("No images found in the document, and no thumb_media_id in frontmatter.");
            process.exit(1);
        }

        console.log(`Uploading header image: ${headerImgPath}`);
        
        const boundary = '----WebKitFormBoundary7MAbb7JmBAtPibq8';
        const materialUrl = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${accessToken}&type=image`;
        const headerRes = await uploadMaterial(materialUrl, boundary, headerImgPath, path.basename(headerImgPath));
        
        if (!headerRes.media_id) {
            console.error("Failed to upload header material:", headerRes);
            process.exit(1);
        }

        const thumbMediaId = headerRes.media_id;
        console.log("✅ Header uploaded. media_id:", thumbMediaId);

        // 4. Extract '核心摘要' as digest
        const digestRegex = /##\s*核心摘要[^\n]*\n+([\s\S]*?)\n+---/;
        const digestMatch = mdContent.match(digestRegex);
        let digest = digestMatch ? digestMatch[1].trim() : "为什么生物学是最困难的科学？";
        // Truncate to maximum 110 chars to avoid errcode 45004 'description size out of limit'
        if (digest.length > 110) {
            digest = digest.substring(0, 110) + '...';
        }
        console.log("✅ Digest extracted. Length:", digest.length);

        // 5. Construct HTML content
        let htmlContent = mdContent;

        // Upload inline images and replace URLs
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            console.log(`Uploading inline image ${img.localPath}`);
            const uploadImgUrl = `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${accessToken}`;
            const imgRes = await uploadMaterial(uploadImgUrl, boundary, img.localPath, path.basename(img.localPath));
            
            if (!imgRes.url) {
                console.error("Failed to upload inline image:", imgRes);
                continue;
            }
            // Replace with img tag
            htmlContent = htmlContent.replace(img.fullMatch, `<p style="text-align: center;"><img src="${imgRes.url}" alt="${img.alt}" style="max-width: 100%; height: auto;" /></p>`);
        }

        // Modify MD to HTML logic for rich rendering
        htmlContent = htmlContent
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color: #07C160; font-weight: bold;">$1</strong>')
            .replace(/^###\s+(.*$)/gm, '<h3 style="font-size: 18px; font-weight: bold; color: #333333; margin-top: 25px; margin-bottom: 12px; border-left: 4px solid #07C160; padding-left: 8px;">$1</h3>')
            .replace(/^##\s+(.*$)/gm, '<h2 style="font-size: 22px; font-weight: bold; color: #07C160; margin-top: 30px; margin-bottom: 15px; border-bottom: 2px solid #07C160; padding-bottom: 8px;">$1</h2>')
            .replace(/^#\s+(.*$)/gm, '<h1 style="font-size: 26px; font-weight: bold; color: #333333; text-align: center; margin-bottom: 20px;">$1</h1>')
            .replace(/^---$/gm, '<hr style="border: 0; border-top: 1px solid #E5E5E5; margin: 30px 0;"/>');

        // Wrap paragraphs in premium sections
        const lines = htmlContent.split('\n');
        let processedHtml = [];
        let inSection = false;
        
        // Start wrapper
        processedHtml.push('<section style="padding: 15px; background-color: #ffffff;">');
        
        for (let line of lines) {
            line = line.trim();
            if (line === '') {
                processedHtml.push('<br/>');
            } else if (line.startsWith('<h') || line.startsWith('<p ') || line.startsWith('<hr')) {
                processedHtml.push(line);
            } else if (line.indexOf('frontmatter') === -1 && line.indexOf('thumb_media_id') === -1 && line.indexOf('![') === -1) {
                // Ignore plain frontmatter leftovers
                processedHtml.push(`<p style="line-height: 1.8; font-size: 16px; color: #333333; margin-bottom: 15px; letter-spacing: 0.5px;">${line}</p>`);
            }
        }
        
        // End wrapper
        processedHtml.push('</section>');

        const finalHtml = processedHtml.join('\n');

        // 6. Push draft
        console.log("Pushing draft to WeChat...");
        const draftUrl = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${accessToken}`;
        
        const payload = {
            articles: [
                {
                    title: title,
                    author: "JARVIS",
                    digest: digest,
                    content: finalHtml,
                    thumb_media_id: thumbMediaId,
                    need_open_comment: 0,
                    only_fans_can_comment: 0
                }
            ]
        };

        const draftRes = await httpsPost(draftUrl, payload);
        console.log("Draft response:", draftRes);

        if (draftRes.errcode === 0 || !draftRes.errcode) { 
            console.log("✅ Draft successfully added.");
            
            // 7/8. Notify Tony via Telegram
            const replyPayload = {
                chat_id: 1495516896,
                text: "The full translated Biology piece has successfully been beamed securely to your WeChat Official Account drafts! Open your app to go review and publish the final product!"
            };
            
            const http = require('http');
            const req = http.request({
                hostname: 'localhost',
                port: 18791,
                path: '/reply',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            }, (res) => {
                console.log(`Notification sent, status: ${res.statusCode}`);
            });
            req.on('error', (e) => console.error("Notification error:", e));
            req.write(JSON.stringify(replyPayload));
            req.end();
            
        } else {
            console.error("❌ Failed to add draft.");
            process.exit(1);
        }

    } catch (e) {
        console.error("Exception:", e);
        process.exit(1);
    }
}

main();
