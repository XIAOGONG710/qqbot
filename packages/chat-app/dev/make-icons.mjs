// 开发用：生成 icons/ 下的 PNG 图标（暖色底上一颗心，四周留足 maskable 安全区）。
//   node dev/make-icons.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makePng } from './png.mjs';

const out = fileURLToPath(new URL('../icons/', import.meta.url));
await mkdir(out, { recursive: true });

/** 心形隐函数：<0 在里面。坐标 -1..1，y 向上 */
const heart = (x, y) => (x * x + y * y - 1) ** 3 - x * x * y * y * y;

function draw(size, { background, foreground }) {
    const samples = 3;
    return makePng(size, size, (px, py) => {
        let inside = 0;
        for (let sy = 0; sy < samples; sy++) {
            for (let sx = 0; sx < samples; sx++) {
                const x = ((px + (sx + 0.5) / samples) / size - 0.5) * 2 / 0.44;
                const y = -((py + (sy + 0.5) / samples) / size - 0.47) * 2 / 0.44;
                if (heart(x / 1.15, y / 1.15 + 0.1) < 0) inside++;
            }
        }
        const t = inside / (samples * samples);
        if (!background) return [foreground[0], foreground[1], foreground[2], Math.round(t * 255)];
        return [0, 1, 2].map(i => Math.round(background[i] * (1 - t) + foreground[i] * t)).concat(255);
    });
}

const warm = { background: [244, 232, 218], foreground: [178, 79, 55] };
await writeFile(`${out}icon-192.png`, draw(192, warm));
await writeFile(`${out}icon-512.png`, draw(512, warm));
// 通知栏的小图标：系统只取透明度
await writeFile(`${out}badge-96.png`, draw(96, { foreground: [255, 255, 255] }));
await writeFile(`${out}icon.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="#f4e8da"/><path d="M24 36c-.8 0-11-6.500-11-14.500C13 17 16.200 14 19.800 14c1.800 0 3.300.8 4.200 2.200.9-1.400 2.400-2.200 4.200-2.200C31.800 14 35 17 35 21.500 35 29.500 24.800 36 24 36z" fill="#b24f37"/></svg>\n`);
console.log('icons written to', out);
