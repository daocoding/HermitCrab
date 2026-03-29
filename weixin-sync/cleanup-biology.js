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
    try {
        console.log("Exchanging credentials for access token...");
        const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APP_ID}&secret=${APP_SECRET}`;
        const tokenRes = await httpsGet(tokenUrl);
        const accessToken = tokenRes.access_token;
        console.log("✅ Token received.");

        console.log("Fetching drafts...");
        const batchGetUrl = `https://api.weixin.qq.com/cgi-bin/draft/batchget?access_token=${accessToken}`;
        const draftsRes = await httpsPost(batchGetUrl, {
            offset: 0,
            count: 20,
            no_content: 0
        });

        let biologyDrafts = [];
        if (draftsRes.item) {
            for (const item of draftsRes.item) {
                let match = false;
                for (const article of item.content.news_item) {
                    if (article.title.includes('生物学')) {
                        match = true;
                        break;
                    }
                }
                if (match) {
                    biologyDrafts.push(item);
                }
            }
        }

        biologyDrafts.sort((a, b) => b.update_time - a.update_time);

        if (biologyDrafts.length <= 1) {
            console.log("No extra biology drafts to delete. Found:", biologyDrafts.length);
            return;
        }

        const latestDraft = biologyDrafts[0];
        console.log(`Keeping latest draft: ${latestDraft.media_id} (update_time: ${latestDraft.update_time})`);

        const toDelete = biologyDrafts.slice(1);
        console.log(`Found ${toDelete.length} older draft(s) to delete.`);

        const deleteUrl = `https://api.weixin.qq.com/cgi-bin/draft/delete?access_token=${accessToken}`;
        let deletedCount = 0;
        for (const item of toDelete) {
            console.log(`Deleting media_id: ${item.media_id}`);
            const deleteRes = await httpsPost(deleteUrl, { media_id: item.media_id });
            if (deleteRes.errcode === 0) {
                console.log(`✅ Deleted successfully.`);
                deletedCount++;
            } else {
                console.error(`❌ Failed to delete:`, deleteRes);
            }
        }
        
        console.log(`Successfully deleted ${deletedCount} item(s).`);
        
        // Write to worker file
        const workerFilePath = "/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/workers/worker-1774672443693-bvjm3i.md";
        const content = `# WeChat Draft Cleanup Results\n\nFound ${biologyDrafts.length} total drafts related to '生物学'. Kept the latest one (${latestDraft.media_id}) and successfully deleted ${deletedCount} older/test iterations.\n`;
        fs.writeFileSync(workerFilePath, content);
        
        // Send completion notice
        const report = {
            chat_id: 1495516896,
            text: `Draft box sanitized. Kept the latest Biology HTML version and deleted ${deletedCount} older test drafts.`,
            worker_id: "worker-1774672443693-bvjm3i"
        };
        
        const notifyReq = require('http').request({
            hostname: 'localhost',
            port: 18791,
            path: '/worker-done',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            console.log(`Worker-done response: ${res.statusCode}`);
            process.exit(0);
        });
        
        notifyReq.on('error', (e) => {
            console.error("Notify error:", e.message);
            process.exit(1);
        });
        notifyReq.write(JSON.stringify(report));
        notifyReq.end();

    } catch (e) {
        console.error(e);
        const report = {
            chat_id: 1495516896,
            text: `Error sanitizing draft box: ${e.message}`,
            worker_id: "worker-1774672443693-bvjm3i"
        };
        const notifyReq = require('http').request({
            hostname: 'localhost',
            port: 18791,
            path: '/worker-done',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        notifyReq.write(JSON.stringify(report));
        notifyReq.end();
        process.exit(1);
    }
}

main();
