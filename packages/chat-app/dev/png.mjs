// 开发用：不靠任何依赖生成 PNG / WAV（图标、假中继里她发的图和语音）。
import { crc32, deflateSync } from 'node:zlib';

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
}

/** pixel(x, y) → [r, g, b, a]，各 0..255 */
export function makePng(width, height, pixel) {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = y * (width * 4 + 1);
        raw[row] = 0;
        for (let x = 0; x < width; x++) {
            const [r, g, b, a] = pixel(x, y);
            const at = row + 1 + x * 4;
            raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = a;
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; header[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** 一段正弦音，8 kHz 16 位单声道 */
export function makeWav(seconds, hz = 440) {
    const rate = 8000;
    const samples = Math.round(seconds * rate);
    const out = Buffer.alloc(44 + samples * 2);
    out.write('RIFF', 0, 'latin1'); out.writeUInt32LE(36 + samples * 2, 4); out.write('WAVEfmt ', 8, 'latin1');
    out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24);
    out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
    out.write('data', 36, 'latin1'); out.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) {
        const fade = Math.min(1, i / 400, (samples - i) / 400);
        out.writeInt16LE(Math.round(Math.sin(i / rate * hz * 2 * Math.PI) * 9000 * fade), 44 + i * 2);
    }
    return out;
}
