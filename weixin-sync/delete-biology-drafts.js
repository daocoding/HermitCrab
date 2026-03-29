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
    console.log("Fetching token...");
    const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APP_ID}&secret=${APP_SECRET}`;
    const tokenRes = await httpsGet(tokenUrl);
    const accessToken = tokenRes.access_token;
    
    if (!accessToken) {
        console.error("Failed to get token", tokenRes);
        return;
    }

    console.log("Fetching drafts...");
    const batchGetUrl = `https://api.weixin.qq.com/cgi-bin/draft/batchget?access_token=${accessToken}`;
    const draftsRes = await httpsPost(batchGetUrl, {
        offset: 0,
        count: 20,
        no_content: 0
    });

    if (draftsRes.item) {
        let deletedCount = 0;
        for (const item of draftsRes.item) {
            let isBiology = false;
            let count = 0;
            // Check if any news in the draft matches "Biology" or "生物"
            for (const article of item.content.news_item) {
                if (article.title.toLowerCase().includes('biology') || 
                    article.title.toLowerCase().includes('生物') || 
                    article.title.toLowerCase().includes('why biology is the hardest science') ||
                    article.title.toLowerCase().includes('为什么生物学是最难的科学') ||
                    article.title.toLowerCase().includes('test')) {
                    isBiology = true;
                }
                count++;
            }
            // Delete if it's a biology draft or test stuff (maybe we should just be safe and output them first)
            console.log(`Media ID: ${item.media_id}, Update Time: ${item.update_time}, Is Biology/Test: ${isBiology}`);
            for (const article of item.content.news_item) {
                console.log(`  Title: ${article.title}`);
            }
            
            if (isBiology) {
                console.log(`==> Deleting draft ${item.media_id}...`);
                const delUrl = `https://api.weixin.qq.com/cgi-bin/draft/delete?access_token=${accessToken}`;
                const delRes = await httpsPost(delUrl, { media_id: item.media_id });
                console.log(`Delete response:`, delRes);
                deletedCount++;
            }
        }
        console.log(`Total deleted: ${deletedCount}`);
    } else {
        console.log("No drafts or error:", draftsRes);
    }
}
main();
