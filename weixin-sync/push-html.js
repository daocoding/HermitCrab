const fs = require('fs');
const path = require('path');
const https = require('https');
const { marked } = require('marked');
const cheerio = require('cheerio');

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
        if (digest.length > 110) {
            digest = digest.substring(0, 110) + '...';
        }
        console.log("✅ Digest extracted. Length:", digest.length);

        // 5. Construct HTML content
        let updatedMdContent = mdContent;

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
            // Replace with img tag wrapped in p to avoid breaking layout
            updatedMdContent = updatedMdContent.replace(img.fullMatch, `<br/><p style="text-align: center;"><img src="${imgRes.url}" alt="${img.alt}" style="max-width: 100%; height: auto;" /></p><br/>`);
        }

        // Now parse with marked instead of naive replace
        const rawHtml = marked.parse(updatedMdContent);

        // Now manipulate with cheerio to explicitly inject robust inline styles
        const $ = cheerio.load(rawHtml, null, false);
        const styleStr = 'line-height:1.75; font-size:16px; margin-bottom:20px;';
        
        $('p, h1, h2, table').each(function() {
            let existingStyle = $(this).attr('style') || '';
            // If there's an existing style, append
            if (existingStyle && !existingStyle.endsWith(';')) existingStyle += '; ';
            existingStyle += styleStr;
            $(this).attr('style', existingStyle);
        });

        const finalHtml = $.html();

        // 6. Push draft
        console.log("Pushing inline styled HTML draft to WeChat...");
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
            console.log("✅ Draft successfully added with inline styles.");
            
            // Write success to worker output
            const fsOutput = require('fs');
            fsOutput.writeFileSync('/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/workers/worker-1774672629945-6mvnfp.md', '# WeChat Inline HTML Fixer\nDraft pushed successfully utilizing marked + cheerio parser. Inline styles applied.');

            /*
            const replyPayload = {
                chat_id: 1495516896,
                text: "WeChat Inline HTML Fixer has completed processing the biology article. The new robust inline-styled draft has been synced to your WeChat Official Account drafts securely. Check out how it looks!",
                worker_id: "worker-1774672629945-6mvnfp"
            };
            
            const http = require('http');
            const req = http.request({
                hostname: 'localhost',
                port: 18791,
                path: '/worker-done',
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
            */
            
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
