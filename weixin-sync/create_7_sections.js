const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');

const fontName = 'PingFang SC, sans-serif'; 

const configs = [
    {
        input: '/Users/yourusername/.gemini/antigravity/brain/b9153b36-5d67-47e7-91af-79e171ea667f/sec1_pendulum_cell_1774674597661.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/section_1_visual.png',
        text: 'I. "最难的科学"在实践中意味着什么'
    },
    {
        input: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/final_orig_multiscale.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/section_2_visual.png',
        text: 'II. 多尺度层叠与涌现特性'
    },
    {
        input: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/final_orig_adaptation.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/section_3_visual.png',
        text: 'III. 适应、可塑性与历史偶然性'
    },
    {
        input: '/Users/yourusername/.gemini/antigravity/brain/b9153b36-5d67-47e7-91af-79e171ea667f/sec4_noise_robustness_1774674613301.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/section_4_visual.png',
        text: 'IV. 噪声、情境依赖性、冗余和鲁棒性'
    },
    {
        input: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/final_orig_disease.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/section_5_visual.png',
        text: 'V. 疾病：贯穿各尺度的案例研究'
    },
    {
        input: '/Users/yourusername/.gemini/antigravity/brain/b9153b36-5d67-47e7-91af-79e171ea667f/sec6_research_modeling_1774674628048.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/section_6_visual.png',
        text: 'VI. 对研究方法、建模、可重复性和教育的启示'
    },
    {
        input: '/Users/yourusername/.gemini/antigravity/brain/b9153b36-5d67-47e7-91af-79e171ea667f/sec7_genotype_phenotype_1774674641352.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/section_7_visual.png',
        text: 'VII. 主要未解问题与实践建议'
    }
];

async function processImage({ input, output, text }) {
    console.log(`Processing ${output}...`);
    const image = await loadImage(input);
    const width = image.width;
    const height = image.height;
    
    // Create a 2.35:1 aspect ratio centered crop
    let canvasW = width;
    let canvasH = Math.floor(width / 2.35);
    
    // In case the image is already wider than 2.35:1, adjust logic:
    if (height < canvasH) {
        canvasH = height;
        canvasW = Math.floor(height * 2.35);
    }
    
    const canvas = createCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d');
    
    // Center crop
    const sx = Math.max(0, (width - canvasW) / 2);
    const sy = Math.max(0, (height - canvasH) / 2);
    ctx.drawImage(image, sx, sy, canvasW, canvasH, 0, 0, canvasW, canvasH);
    
    // Dark overlay for text readability
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvasW, canvasH);
    
    // Text setup
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Font size scaling
    let fontSize = Math.floor(canvasW / 20);
    ctx.font = `bold ${fontSize}px "${fontName}"`;
    
    // Draw shadow
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    
    ctx.fillText(text, canvasW / 2, canvasH / 2);
    
    const buffer = canvas.toBuffer('image/png');
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
