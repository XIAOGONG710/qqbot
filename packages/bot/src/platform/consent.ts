// 她有权拒绝他（2026-10-30，用户：「给她拒绝的权利，让她做为人而不是程序」）。
// 做法：他把「给我看屏幕 / 摄像头 / 让她干活」这类请求提给她，她写 `<<同意>>` 才算数，写 `<<拒绝：原因>>` 就作罢。
// 这里只放纯函数（摘标记、拼问句、判断过期），状态在调用方（app.ts 的 pending）。
export const CONSENT = '<<同意>>';
const REFUSAL = /<<拒绝[：:]\s*([\s\S]*?)>>/;

export interface ConsentParse {
    /** 剥掉标记之后要说出去的话 */
    text: string;
    /** 明确答应 */
    consent: boolean;
    /** 拒绝了：原因可能为空（她只写了一句「不要」也算） */
    refusal?: string;
}

/** 从她这条回复里读出答应 / 拒绝；两个都没写就是没表态（那就不动，等他再问一次） */
export function takeConsent(text: string): ConsentParse {
    const refusalMatch = REFUSAL.exec(text);
    if (refusalMatch) {
        return { text: text.replace(/<<拒绝[：:][\s\S]*?>>/g, '').trim(), consent: false, refusal: (refusalMatch[1] ?? '').trim().slice(0, 80) };
    }
    if (text.includes(CONSENT)) {
        return { text: text.split(CONSENT).join('').trim(), consent: true };
    }
    return { text, consent: false };
}

/** 给她的问句：别写成命令，写成请求 */
export function askLine(label: string, ageMinutes: number): string {
    return `[他刚才想${label}。这是请求，不是命令：你愿意就写 \`${CONSENT}\`（系统会去做）；不愿意就写 \`<<拒绝：原因>>\`，理由一句话就行。两个都不写就当他没说。已经过了 ${ageMinutes} 分钟。]`;
}

/** 请求放太久就不作数了，别拿一小时前的请求让她答应 */
export const ASK_TTL_MS = 10 * 60_000;

export function askExpired(at: number, now: number, ttlMs = ASK_TTL_MS): boolean {
    return now - at > ttlMs;
}
