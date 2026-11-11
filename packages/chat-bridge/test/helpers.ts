// 测试公用：合成的图片 / 语音字节、临时目录。名字和号码都是虚构的（他 10001，她 20002）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OWNER = 10001;
export const HER = 20002;

export const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('synthetic-png-body')]);
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic-jpeg-body')]);
export const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WAVEfmt synthetic')]);
export const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('synthetic-webm-body')]);

export function tempDir(t: { after(fn: () => void): void }): string {
    const dir = mkdtempSync(join(tmpdir(), 'chat-bridge-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** 等到条件成立；超时抛错 */
export async function until(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`等不到：${label}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
