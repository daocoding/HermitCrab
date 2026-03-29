const fs = require('fs');
const path = require('path');
const https = require('https');

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

// Promisified https.get for convenience
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

// Promisified https.request (POST) for convenience
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

// Promisified multipart POST to upload material
function uploadMaterial(url, boundary, filePath) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const fileContent = fs.readFileSync(filePath);
        const start = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="media"; filename="dummy.jpg"\r\n` +
            `Content-Type: image/jpeg\r\n\r\n`
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

        console.log("Downloading a valid placeholder image (900x500)...");
        const dummyPath = path.join(__dirname, 'dummy.jpg');
        
        // Use native fetch to download a dummy image that's large enough for WeChat to crop
        let imgBuffer;
        if (typeof fetch !== 'undefined') {
            const res = await fetch('https://picsum.photos/900/500');
            const arrayBuffer = await res.arrayBuffer();
            imgBuffer = Buffer.from(arrayBuffer);
        } else {
            // Fallback just in case, though M4 should have native fetch
            throw new Error("Native fetch is required but not found.");
        }
        
        fs.writeFileSync(dummyPath, imgBuffer);

        const materialUrl = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${accessToken}&type=image`;
        const materialRes = await uploadMaterial(materialUrl, '----WebKitFormBoundary7MAbb7JmBAtPibq8', dummyPath);
        
        if (!materialRes.media_id) {
            console.error("Failed to upload material:", materialRes);
            process.exit(1);
        }

        const thumbMediaId = materialRes.media_id;
        console.log("✅ Material uploaded. media_id:", thumbMediaId);

        console.log("Pushing draft to WeChat...");
        const draftUrl = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${accessToken}`;
        
        const payload = {
            articles: [
                {
                    title: "Hello from Antigravity",
                    author: "Worker",
                    digest: "Test draft from worker.",
                    content: "Hello from Antigravity Worker!",
                    content_source_url: "https://example.com",
                    thumb_media_id: thumbMediaId,
                    need_open_comment: 0,
                    only_fans_can_comment: 0
                }
            ]
        };

        const draftRes = await httpsPost(draftUrl, payload);
        console.log("Draft response:", draftRes);

        if (draftRes.errcode === 0 || !draftRes.errcode) { // Sometimes 0 means success
            console.log("✅ Draft successfully added.");
        } else {
            console.error("❌ Failed to add draft.");
        }

    } catch (e) {
        console.error("Exception:", e);
    }
}

main();
