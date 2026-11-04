// AI 生活照草稿（ADR 0239）：generate 只生成待审核草稿；approve 才进入照片货架；这里不负责发 QQ。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiPhotoDraftStore, AI_PHOTO_KINDS, generateAiPhoto, type AiPhotoContext, type AiPhotoDraftStatus, type AiPhotoKind } from '../vision/ai-photo-drafts.ts';
import { photoShelf } from '../vision/photos.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const one = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const baseDir = resolve(process.env.INIT_CWD ?? process.cwd(), one('--dir') ?? resolve(repoRoot, 'runtime/bot'));
const drafts = aiPhotoDraftStore({ dir: resolve(baseDir, 'ai-photo-drafts'), log: line => console.log(line) });
const command = args[0];

const usage = () => [
    '用法：',
    `  generate --kind <${AI_PHOTO_KINDS.join('|')}> --event <稳定事件键> --subject "画面主体" --caption "照片说明" --at <ISO 时间>`,
    '           [--dish "菜名"] [--weather "天气"] [--place "普通地点"] [--activity "正在做什么"] [--dir <数据目录>]',
    '  list [--status pending_review|approved|rejected] [--dir <数据目录>]',
    '  approve <编号> [--dir <数据目录>]',
    '  reject <编号> [--dir <数据目录>]',
    '',
    'generate 需要环境变量 QQBOT_IMAGE_API_KEY；可选 QQBOT_IMAGE_BASE_URL、QQBOT_IMAGE_MODEL。',
    '生成结果只在本地等待审核，不会自动发送。',
].join('\n');

async function run(): Promise<void> {
    if (command === 'generate') {
        const kind = one('--kind');
        const eventKey = one('--event');
        const subject = one('--subject');
        const caption = one('--caption');
        const at = one('--at') ?? new Date().toISOString();
        if (!kind || !AI_PHOTO_KINDS.includes(kind as AiPhotoKind) || !eventKey || !subject || !caption) throw new Error(usage());
        const context: AiPhotoContext = {
            kind: kind as AiPhotoKind, eventKey, subject, caption, at,
            ...(one('--dish') ? { dish: one('--dish') } : {}),
            ...(one('--weather') ? { weather: one('--weather') } : {}),
            ...(one('--place') ? { place: one('--place') } : {}),
            ...(one('--activity') ? { activity: one('--activity') } : {}),
        };
        const apiKey = process.env.QQBOT_IMAGE_API_KEY ?? '';
        const model = process.env.QQBOT_IMAGE_MODEL ?? 'gpt-image-2.5-flare';
        const baseUrl = process.env.QQBOT_IMAGE_BASE_URL ?? 'https://api.openai.com/v1/';
        const entry = await drafts.generate(context, prompt => generateAiPhoto(prompt, { apiKey, model, baseUrl }));
        console.log(`待审核：${entry.id}  ${entry.kind}  ${entry.caption}`);
        console.log(`图片：${resolve(baseDir, 'ai-photo-drafts/files', entry.file)}`);
        return;
    }
    if (command === 'list') {
        const status = one('--status');
        if (status && !['pending_review', 'approved', 'rejected'].includes(status)) throw new Error(usage());
        const entries = drafts.list(status as AiPhotoDraftStatus | undefined);
        if (!entries.length) console.log('没有符合条件的 AI 照片草稿');
        for (const entry of entries) console.log(`${entry.id}  ${entry.status.padEnd(14)}  ${entry.kind.padEnd(4)}  ${entry.caption}`);
        const count = drafts.status();
        console.log(`共 ${count.total} 张：待审核 ${count.pending}，已通过 ${count.approved}，已拒绝 ${count.rejected}`);
        return;
    }
    const id = args[1];
    if (command === 'approve') {
        if (!id) throw new Error(usage());
        const shelf = photoShelf({ dir: resolve(baseDir, 'photos'), log: line => console.log(line) });
        const entry = drafts.approve(id, shelf);
        console.log(`已通过：${entry.id}；照片货架编号 ${entry.shelfId}`);
        return;
    }
    if (command === 'reject') {
        if (!id) throw new Error(usage());
        const entry = drafts.reject(id);
        console.log(`已拒绝：${entry.id}`);
        return;
    }
    throw new Error(usage());
}

run().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
});
