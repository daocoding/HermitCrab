const fs = require('fs');
const { createCanvas, loadImage, registerFont } = require('canvas');

// We don't have a guaranteed custom font, so we'll use sans-serif. Canvas will find a system font.
// However, macOS usually has "PingFang SC" or "Hiragino Sans GB".
const fontName = 'PingFang SC, sans-serif'; 

const configs = [
    {
        input: '/Users/yourusername/.gemini/antigravity/brain/47b5fc95-00c8-41a6-af13-bd3ade6188d5/biology_hardest_base_1774672290484.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/生物_visual.jpeg',
        text: '为什么生物学是最难的科学',
        isHeader: true
    },
    {
        input: '/Users/yourusername/.gemini/antigravity/brain/47b5fc95-00c8-41a6-af13-bd3ade6188d5/multiscale_emergent_base_1774672306299.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/multiscale_visual.png',
        text: '多尺度层叠与涌现特性',
        isHeader: false
    },
    {
        input: '/Users/yourusername/.gemini/antigravity/brain/47b5fc95-00c8-41a6-af13-bd3ade6188d5/adaptation_plasticity_base_1774672321338.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/adaptation_visual.png',
        text: '适应、可塑性与历史偶然性',
        isHeader: false
    },
    {
        input: '/Users/yourusername/.gemini/antigravity/brain/47b5fc95-00c8-41a6-af13-bd3ade6188d5/disease_multiscale_base_1774672334481.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/disease_visual.png',
        text: '疾病：贯穿各尺度的案例研究',
        isHeader: false
    }
];

async function processImage({ input, output, text, isHeader }) {
    console.log(`Processing ${output}...`);
    const image = await loadImage(input);
    const width = image.width;
    const height = image.height;
    
    // For header image we might want it wider like 2.38:1
    // But since the diffusion model outputs 1024x1024 or similar, let's just draw it.
    // If it's a header, maybe we crop it to 2.38:1? 
    let canvasW = width;
    let canvasH = height;
    if (isHeader) {
        // WeChat header aspect ratio 2.35:1
        canvasH = Math.floor(width / 2.35);
    }
    
    const canvas = createCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d');
    
    // Draw image (center crop if header)
    if (isHeader) {
        const sy = (height - canvasH) / 2;
        ctx.drawImage(image, 0, sy, width, canvasH, 0, 0, canvasW, canvasH);
    } else {
        ctx.drawImage(image, 0, 0, canvasW, canvasH);
    }
    
    // Dark overlay for text readability
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvasW, canvasH);
    
    // Text setup
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Font size scaling
    let fontSize = Math.floor(canvasW / 15);
    ctx.font = `bold ${fontSize}px "${fontName}"`;
    
    // Draw shadow
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    
    ctx.fillText(text, canvasW / 2, canvasH / 2);
    
    // Save
    const buffer = output.endsWith('.jpeg') ? canvas.toBuffer('image/jpeg') : canvas.toBuffer('image/png');
    fs.mkdirSync(require('path').dirname(output), { recursive: true });
    fs.writeFileSync(output, buffer);
    console.log(`Saved ${output}`);
}

async function run() {
    for (const conf of configs) {
        await processImage(conf);
    }
}

run().catch(console.error);
