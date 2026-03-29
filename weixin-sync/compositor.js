const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');

const configs = [
    {
        input: '/Users/yourusername/.gemini/antigravity/brain/66c3a294-0eb2-4162-9f31-cdc5f88fd608/biology_hardest_header_1774643734853.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/final_orig_multiscale.png',
        text: '多尺度层叠与涌现特性'
    },
    {
        input: '/Users/yourusername/.gemini/antigravity/brain/66c3a294-0eb2-4162-9f31-cdc5f88fd608/pendulum_vs_cell_1774643763063.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/final_orig_adaptation.png',
        text: '适应、可塑性与历史偶然性'
    },
    {
        input: '/Users/yourusername/.gemini/antigravity/brain/66c3a294-0eb2-4162-9f31-cdc5f88fd608/evolution_complexity_diagram_1774643783233.png',
        output: '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/notes/images/final_orig_disease.png',
        text: '疾病：贯穿各尺度的案例研究'
    }
];

async function run() {
    for (const conf of configs) {
        const image = await loadImage(conf.input);
        const w = image.width;
        const h = image.height;
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, w, h);

        const barHeight = 200;
        const barY = (h - barHeight) / 2;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(0, barY, w, barHeight);
        
        ctx.fillStyle = '#07C160'; 
        ctx.fillRect(0, barY, w, 4);
        ctx.fillRect(0, barY + barHeight - 4, w, 4);

        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 54px sans-serif';
        ctx.fillText(conf.text, w / 2, h / 2);

        const outDir = require('path').dirname(conf.output);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }
        fs.writeFileSync(conf.output, canvas.toBuffer('image/png'));
        console.log("Composited: " + conf.output);
    }
}

run().catch(console.error);
