// 写一条 QQ 空间说说（ADR 0083）：模仿「空友爱看」里常见的那种——随手发的一两句，有图就围着图写，没图就一句文字。
// 隐私：说说比聊天更多人能看到，所以用最低隐私档（同学档）的角色卡来写，并过这一档的禁用词（cleanQzoneText）。
// 图：只用放图文件夹里的图（用户放的），不用别人的图冒充她拍的，也不生成「她的自拍」；有图先让看图模型描述，再照描述写一句。

import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ImageDescriber } from '.././vision/media.ts';
import { cleanQzoneText } from './presence.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import { imageDataUrl, type SupportedImageType } from '.././vision/safe-image.ts';

export interface QzoneComposerDeps {
    /** 同学档卡上的名字、资料、性格、这一档的禁用词 */
    character: { name: string; description: string; personality: string; banned: readonly string[] };
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    vision?: ImageDescriber;
    photoDir: string;
    /** 「你现在：在宿舍刷手机」这类一行；天气一行（没有就不给） */
    situation: (now: number) => string[];
    log: (message: string) => void;
}

/** 说明写在最前：风格、不要什么。每个「不要」都对应一种会泄露或出戏的写法 */
export function qzoneSystemPrompt(character: QzoneComposerDeps['character']): string {
    return [
        `你是${character.name}。下面是你的资料：`,
        character.description.trim(),
        character.personality.trim(),
        '',
        '现在你要在自己的 QQ 空间发一条说说。像 QQ 空间里常见的随手发的那种：一两句，很短，口语，不写长文，不讲大道理，不堆感叹号；',
        '可以是天空 / 天气、食堂和饭、猫、学习的小抱怨、发呆、想去哪、一点小确幸。',
        '不要 @ 人、不要网址、不要电话或学号、不要写真实的人名和具体的地址、不要提男朋友或恋爱、不要提你是 AI、不要用方括号的表情。',
        '只输出说说正文，不要引号，不要解释。',
    ].filter(line => line !== undefined).join('\n');
}

const MIME: Record<string, SupportedImageType> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
const TRIES = 3;

/** 写说说的函数，给 createPresence 的 composeQzone 用：写不出合格的（模型出错、三次都不合格）返回 undefined */
export function qzoneComposer(deps: QzoneComposerDeps): (input: { now: number; photoFile?: string; recent: readonly string[] }) => Promise<{ text: string; withPhoto: boolean } | undefined> {
    return async ({ now, photoFile, recent }) => {
        let seen: string | undefined;
        if (photoFile) {
            if (!deps.vision) {
                deps.log('说说：放了图但没开看图（vision），这次不带图');
            } else {
                try {
                    const path = join(deps.photoDir, photoFile);
                    const type = MIME[extname(photoFile).toLowerCase()] ?? 'image/jpeg';
                    seen = await deps.vision.describe({ url: '', dataUrl: imageDataUrl({ bytes: new Uint8Array(readFileSync(path)), type }) });
                } catch (error) {
                    deps.log(`说说：看图失败（${error instanceof Error ? error.message : String(error)}），这次不带图`);
                }
            }
        }
        const lines = [
            `现在是：${new Date(now).toLocaleString('zh-CN', { hour12: false })}`,
            ...deps.situation(now),
            seen ? `你要配的这张照片里是：${seen}。围着这张照片写一句。` : '这次没有照片，就写一句文字说说。',
            recent.length ? `你最近发过：${recent.slice(-5).map(text => `「${text}」`).join('、')}。这条不要和它们像。` : '',
        ].filter(Boolean);
        const messages: OpenAIMessage[] = [
            { role: 'system', content: qzoneSystemPrompt(deps.character) },
            { role: 'user', content: lines.join('\n') },
        ];
        for (let attempt = 0; attempt < TRIES; attempt++) {
            let raw: string;
            try {
                raw = await deps.generate(messages);
            } catch (error) {
                deps.log(`说说：模型出错（${error instanceof Error ? error.message : String(error)}）`);
                return undefined;
            }
            const text = cleanQzoneText(raw, deps.character.banned);
            // withPhoto：配文是照着这张图写的才带图（没看成图就写成了纯文字，这时不能再把图发出去）
            if (text && !recent.includes(text)) return { text, withPhoto: Boolean(seen) };
        }
        return undefined;
    };
}
