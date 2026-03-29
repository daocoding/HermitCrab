const fs = require('fs');
const path = require('path');
const https = require('https');

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
    const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APP_ID}&secret=${APP_SECRET}`;
    const tokenRes = await httpsGet(tokenUrl);
    const accessToken = tokenRes.access_token;

    const batchGetUrl = `https://api.weixin.qq.com/cgi-bin/draft/batchget?access_token=${accessToken}`;
    const draftsRes = await httpsPost(batchGetUrl, {
        offset: 0,
        count: 20,
        no_content: 0
    });

    if (draftsRes.item) {
        for (const item of draftsRes.item) {
            console.log(`Media ID: ${item.media_id}, Update Time: ${item.update_time}`);
            for (const article of item.content.news_item) {
                console.log(`  Title: ${article.title}`);
            }
        }
    } else {
        console.log("No drafts or error:", draftsRes);
    }
}
main();
