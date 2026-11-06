// 她的语音念什么、怎么念（2026-11-06，用户：「像在念稿、音色不像她、有电音、说的内容不像」，要「自然随意的女大学生」）。
// 这里只管机器人这一侧：
// - speechText：把她写的那句整理成 TTS 念得顺的样子（去掉表情、链接、括号里的小黄脸，数字和时刻换成汉字）；
// - voiceStyle：按她这一刻的心境给语气参数（口语程度、笑、停顿、语速），交给 DSH 端的 worker。
// worker 用 ChatTTS 的 [oral_n][laugh_n][break_n][speed_n] 控制词；IndexTTS 的旧 worker 只认 emo，emo 也一起给。
// 不改她说什么：念的还是她写的那句，只是去掉念不出来的东西。

import type { FeelingKind } from '../emotion/feelings.ts';

/** ChatTTS 的语气参数：oral 0–9 口语程度，laugh 0–2 笑，breaks 0–7 停顿，speed 0–9 语速 */
export interface VoiceStyle {
    oral: number;
    laugh: number;
    breaks: number;
    speed: number;
    /** 给只认文字描述的 TTS（IndexTTS）用的一句情绪描述 */
    emo: string;
}

const DIGITS = '零一二三四五六七八九';

/** 0–9999 的整数念成汉字（「20」→「二十」，「105」→「一百零五」）；更大的按位念 */
export function numberWords(value: number): string {
    if (!Number.isSafeInteger(value) || value < 0) return String(value);
    if (value >= 10_000) return [...String(value)].map(d => DIGITS[Number(d)]).join('');
    if (value < 10) return DIGITS[value]!;
    const units = ['', '十', '百', '千'];
    const digits = [...String(value)].map(Number);
    let out = '';
    let zero = false;
    digits.forEach((d, i) => {
        const unit = units[digits.length - 1 - i]!;
        if (d === 0) { zero = out !== ''; return; }
        if (zero) { out += '零'; zero = false; }
        out += (d === 1 && unit === '十' && i === 0 ? '' : DIGITS[d]) + unit;
    });
    return out;
}

/** 时刻念成口语（「20:30」→「八点半」，「7:05」→「七点零五」，「23:00」→「十一点」） */
function clockWords(h: number, m: number): string {
    const hour = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const head = `${hour === 2 ? '两' : numberWords(hour)}点`;
    if (m === 0) return head;
    if (m === 30) return `${head}半`;
    return `${head}${m < 10 ? `零${numberWords(m)}` : numberWords(m)}`;
}

/** 把她写的那句整理成 TTS 念得顺的样子；整理完是空的就返回空串（调用方改发文字） */
export function speechText(line: string): string {
    let text = line
        .replace(/<sticker:[^>]*>|<photo:[^>]*>|<device:[^>]*>/gi, '')
        .replace(/https?:\/\/\S+/gi, '')
        // QQ 小黄脸（[doge] [捂脸]）念不出来
        .replace(/\[[^\]\s]{1,8}\]/g, '')
        .replace(/\p{Extended_Pictographic}|️|‍/gu, '');
    text = text.replace(/(\d{1,2})[:：](\d{2})/g, (_all, h: string, m: string) => {
        const hour = Number(h), minute = Number(m);
        return hour < 24 && minute < 60 ? clockWords(hour, minute) : `${h}${m}`;
    });
    text = text.replace(/\d+/g, digits => numberWords(Number(digits)));
    return text
        // 拖长的「～」念成一个停顿；一串标点只留一个
        .replace(/[~～]+/g, '，')
        .replace(/[!！]{2,}/g, '！').replace(/[?？]{2,}/g, '？').replace(/[.。]{3,}|…+/g, '……')
        .replace(/[，,]{2,}/g, '，')
        .replace(/\s+/g, ' ')
        .replace(/^[，,。\s]+|[，,\s]+$/g, '')
        .trim();
}

/**
 * 平常的语气：自然随意的女大学生，跟男朋友说话的那种甜（用户 11-06：「甜一点，小女友那种感觉」）——
 * 口语、带一点笑意、语速比正常稍慢、停顿软。语音只发给男朋友档（app.ts 的 voiceOn），所以这是对他的语气
 */
const BASE: Omit<VoiceStyle, 'emo'> = { oral: 4, laugh: 1, breaks: 4, speed: 4 };

const BY_FEELING: Record<FeelingKind, { change: Partial<Omit<VoiceStyle, 'emo'>>; emo: string }> = {
    joy: { change: { oral: 5, laugh: 2, speed: 5 }, emo: '开心、甜、轻快，笑着说' },
    relief: { change: { oral: 4, breaks: 4 }, emo: '松了口气，放松' },
    worry: { change: { breaks: 5, speed: 4 }, emo: '有点担心，语气轻' },
    sad: { change: { oral: 2, breaks: 6, speed: 3 }, emo: '低落，声音小一点、慢一点' },
    annoyed: { change: { breaks: 2, speed: 6 }, emo: '有点烦，语气冲一点但不凶' },
    tired: { change: { oral: 3, breaks: 6, speed: 3 }, emo: '累了，懒懒的、拖着说' },
};

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(value)));

/**
 * 这一句用什么语气念：按她这一刻最明显的那种感受（feelings.ts 的 Felt，没有就平常的样子），
 * 句子里有「哈哈」就多笑一点，深夜（23 点到 7 点）慢一点、停顿多一点。
 */
export function voiceStyle(felt: { kind: FeelingKind; level?: string } | undefined, line: string, at: Date): VoiceStyle {
    const mood = felt && felt.level !== 'faint' ? BY_FEELING[felt.kind] : undefined;
    const style = { ...BASE, ...(mood?.change ?? {}) };
    if (/哈{2,}|嘿嘿|嘻嘻|笑死/.test(line)) style.laugh = Math.max(style.laugh, 2);
    const hour = at.getHours();
    if (hour >= 23 || hour < 7) { style.speed -= 1; style.breaks += 1; }
    return {
        oral: clamp(style.oral, 9), laugh: clamp(style.laugh, 2), breaks: clamp(style.breaks, 7), speed: clamp(style.speed, 9),
        emo: mood?.emo ?? '甜甜的、软软的，带点笑意，像跟男朋友随口发语音',
    };
}
