const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

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

function uploadMaterial(url, boundary, filePath, fileName = "image.jpg") {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const fileContent = fs.readFileSync(filePath);
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

        const htmlPath = '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/cody-workspace/x-article-2010751592346030461/article-zh-styled.html';
        let rawHtml = fs.readFileSync(htmlPath, 'utf8');

        // Parse HTML to extract images
        const $ = cheerio.load(rawHtml, null, false);
        const boundary = '----WebKitFormBoundary7MAbb7JmBAtPibq8';

        let thumbMediaId = null;

        const imgs = $('img');
        for (let i = 0; i < imgs.length; i++) {
            const el = $(imgs[i]);
            let src = el.attr('src');
            
            if (src && src.startsWith('/Users/')) {
                console.log(`Uploading inline image ${src}`);
                
                // If it's the header image, upload as permanent material first to get thumb_media_id
                if (src.includes('header-main') && !thumbMediaId) {
                    const materialUrl = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${accessToken}&type=image`;
                    const headerRes = await uploadMaterial(materialUrl, boundary, src, path.basename(src));
                    
                    if (headerRes.media_id) {
                        thumbMediaId = headerRes.media_id;
                        console.log("✅ Header uploaded as material. media_id:", thumbMediaId);
                        el.attr('data-src', headerRes.url); // Use data-src instead of src for WeChat format if needed, but we'll put in src
                        el.attr('src', headerRes.url);
                    } else {
                        console.error("Failed to upload header material:", headerRes);
                    }
                } else {
                    const uploadImgUrl = `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${accessToken}`;
                    const imgRes = await uploadMaterial(uploadImgUrl, boundary, src, path.basename(src));
                    
                    if (imgRes.url) {
                        el.attr('src', imgRes.url);
                        console.log(`✅ Uploaded to ${imgRes.url}`);
                    } else {
                        console.error("Failed to upload inline image:", imgRes);
                    }
                }
            }
        }

        const finalHtml = $.html();
        
        let digest = "Dan Koe的深思文章翻译，关于如何在一天之内改变你的人生。";
        let title = "如何在一天之内彻底改变你的人生 - Dan Koe";
        
        const h1 = $('h1').first().text();
        if (h1) title = h1;

        console.log("Pushing inline styled HTML draft to WeChat...");
        const draftUrl = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${accessToken}`;
        
        const draftRes = await httpsPost(draftUrl, {
            articles: [{
                title: title,
                author: "Dan Koe",
                digest: digest,
                content: finalHtml,
                thumb_media_id: thumbMediaId || "dummy", // we need a dummy if none, but header-main should provide it
                need_open_comment: 0,
                only_fans_can_comment: 0
            }]
        });

        console.log("Draft response:", draftRes);

        if (draftRes.errcode === 0 || !draftRes.errcode) { 
            console.log("✅ Draft successfully added with inline styles and images.");
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
