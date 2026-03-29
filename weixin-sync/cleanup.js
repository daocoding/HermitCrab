const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

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

        console.log("Fetching drafts...");
        const batchGetUrl = `https://api.weixin.qq.com/cgi-bin/draft/batchget?access_token=${accessToken}`;
        const draftsRes = await httpsPost(batchGetUrl, {
            offset: 0,
            count: 20,
            no_content: 0
        });

        if (!draftsRes.item) {
            console.error("Failed to fetch drafts (or no drafts):", draftsRes);
        }

        const targets = [];
        if (draftsRes.item) {
            for (const item of draftsRes.item) {
                let match = false;
                for (const article of item.content.news_item) {
                    if (article.title.includes('Hello from Antigravity') || article.content.includes('Hello from Antigravity')) {
                        match = true;
                        break;
                    }
                }
                if (match) {
                    targets.push(item.media_id);
                }
            }
        }

        console.log(`Found ${targets.length} target(s) to delete.`);

        const deleteUrl = `https://api.weixin.qq.com/cgi-bin/draft/delete?access_token=${accessToken}`;
        let deletedCount = 0;
        for (const mediaId of targets) {
            console.log(`Deleting media_id: ${mediaId}`);
            const deleteRes = await httpsPost(deleteUrl, { media_id: mediaId });
            if (deleteRes.errcode === 0) {
                console.log(`✅ Deleted successfully.`);
                deletedCount++;
            } else {
                console.error(`❌ Failed to delete:`, deleteRes);
            }
        }

        const notifyPayload = {
            chat_id: 1495516896,
            text: `Draft Box Sanitization Complete. Removed ${deletedCount} 'Hello from Antigravity' draft(s).`
        };

        console.log("Notifying localhost:18791/reply...");
        await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: 'localhost',
                port: 18791,
                path: '/reply',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    console.log("Notified localhost:18791/reply", data);
                    resolve();
                });
            });
            req.on('error', reject);
            req.write(JSON.stringify(notifyPayload));
            req.end();
        });

    } catch (e) {
        console.error("Exception:", e);
        process.exit(1);
    }
}

main();
