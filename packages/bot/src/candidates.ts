// 候选选择（ADR 0041，ADR 0036「不是只靠提示词的后续方案」第 3 层）：他难过、说亲密话、收尾这三种时候，
// 同一份提示词生成几个候选，按看得见的规则挑一个，不让模型给自己打分。
// 模型在这三种时候有稳定的倾向：一轮说 3–4 句、回完再补一句自己在追剧 / 喂猫、收尾约「写完跟我说一声」（10-08 三批真模型回归）。
// 提示词再加限制只会让她更僵；几个候选里多半有一个没犯，挑出来就行。

import { inspectReply, summarizeIssues } from './exit-check.ts';
import { inspectSpeech, describeSpeechIssue, type SpeechContext } from './speech-check.ts';

/** 这三种时候挑（intent.ts 的意图行），各最多说几句（和 sim/conversation-naturalness.json 的 maxLines 一致） */
export const PICKED_INTENTS: readonly { pattern: RegExp; kind: 'care' | 'bid' | 'ending'; maxLines: number }[] = [
    { pattern: /先接住他此刻的情绪/, kind: 'care', maxLines: 2 },
    { pattern: /只接他刚说的你们两个人的事/, kind: 'bid', maxLines: 3 },
    { pattern: /顺着他的话收尾/, kind: 'ending', maxLines: 2 },
];

/** 客服式约定：「写完跟我说一声」「忙完找我」（DSH 复核 ADR 0036 3.1） */
const SERVICE = [/(写完|忙完|看完|弄完|搞定|睡醒|考完|下课|上完|回来).{0,4}(跟我说|找我|喊我|叫我|告诉我|回我|说一声)/, /(记得|别忘了).{0,6}(找我|跟我说)/];
/** 他哭的时候岔开去叮嘱作息（persona 里她爱念叨熬夜、早饭，别的时候不算毛病） */
const NAG = /早点睡|别熬夜|别熬太晚|记得吃|吃早饭|多穿|多喝水/;

export interface PickRules {
    kind: 'care' | 'bid' | 'ending';
    maxLines: number;
    /** 她自己生活里的东西（猫的名字、相机、在读的书……）：这三种时候不该扯过去；他这次说到的不算 */
    own: readonly string[];
    /** 他这次说的（她上次回复之后的几条） */
    heard: string;
    banned: readonly string[];
    speech?: SpeechContext;
}

export interface Scored { text: string; penalty: number; reasons: string[] }

/** 一个候选扣几分、为什么（扣分越少越好；0 分就是这几条都没犯） */
export function scoreCandidate(text: string, rules: PickRules): Scored {
    const reasons: string[] = [];
    let penalty = 0;
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) return { text, penalty: 100, reasons: ['空的'] };
    if (lines.length > rules.maxLines) {
        penalty += 2 * (lines.length - rules.maxLines);
        reasons.push(`说了 ${lines.length} 句`);
    }
    const own = rules.own.filter(word => word && text.includes(word) && !rules.heard.includes(word));
    if (own.length) {
        penalty += 3 * own.length;
        reasons.push(`扯到自己的「${own.join('」「')}」`);
    }
    const service = SERVICE.map(re => text.match(re)?.[0]).find(Boolean);
    if (service) {
        penalty += 3;
        reasons.push(`约「${service}」`);
    }
    if (rules.kind === 'care' && NAG.test(text)) {
        penalty += 2;
        reasons.push('他难过时叮嘱作息');
    }
    const exit = inspectReply(text, rules.banned);
    if (exit.length) {
        penalty += 4 * exit.length;
        reasons.push(`出口检查：${summarizeIssues(exit)}`);
    }
    const speech = rules.speech ? inspectSpeech(text, rules.speech) : [];
    if (speech.length) {
        penalty += 2 * speech.length;
        reasons.push(speech.map(describeSpeechIssue).join('、'));
    }
    return { text, penalty, reasons };
}

/** 挑扣分最少的；一样少挑先生成的那个。返回挑中的下标和每个的扣分（日志用） */
export function pickBest(candidates: readonly string[], rules: PickRules, clean: (text: string) => string): { index: number; scored: Scored[] } {
    const scored = candidates.map(text => scoreCandidate(clean(text), rules));
    let index = 0;
    for (const [i, s] of scored.entries()) if (s.penalty < scored[index]!.penalty) index = i;
    return { index, scored };
}

/** 日志：「候选 3 个，挑第 2 个（第 1 个：说了 4 句；第 3 个：扯到自己的「土豆」）」 */
export function describePick(index: number, scored: readonly Scored[]): string {
    const others = scored.map((s, i) => (i !== index && s.reasons.length ? `第 ${i + 1} 个：${s.reasons.join('，')}` : undefined)).filter(Boolean);
    const chosen = scored[index]!.reasons.length ? `；挑中的也有：${scored[index]!.reasons.join('，')}` : '';
    return `候选 ${scored.length} 个，挑第 ${index + 1} 个${others.length ? `（${others.join('；')}）` : ''}${chosen}`;
}
