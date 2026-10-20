// node src/ops/blind-judge-cli.ts --cases <cases.json> --hers <hers.json> [--label 名字]
// 让模型当“鉴别员”做盲评（代替要用户一条条打分）：同一句话，一个是真人女生当时回的、一个是她回的，顺序随机，问模型哪个是真人、凭什么。
//   cases.json：[{ id, stimulus: string[]（男生这一轮说的话）, human: string[]（真人女生回的气泡） }]
//   hers.json ：{ [id]: string[]（她回的气泡） }
// 输出：鉴别员挑中真人的比例（挑中她 = 被骗；50% 以内说明分不开）、判断依据的归类。只出数字和归类，不出原话。
// 局限：鉴别员也是模型，容易把“更得体、更会接话”的当成 AI——它抓到的差别正好是要改的地方，但“被骗率”不等于真人会被骗；
// 她的回复是在没有上文、没有记忆的单轮里生成的，真人那条有上文，所以这是偏严的测法。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { chatCompletion, unlimitedModelGuard } from '../llm.ts';
import { unit } from '../expression.ts';

unlimitedModelGuard();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const one = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const abs = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);
const casesPath = one('--cases');
const hersPath = one('--hers');
if (!casesPath || !hersPath) {
    console.error('用法：node src/ops/blind-judge-cli.ts --cases <cases.json> --hers <hers.json> [--label 名字]');
    process.exit(2);
}

interface Case { id: string; stimulus: string[]; human: string[] }
const cases = JSON.parse(readFileSync(abs(casesPath), 'utf8')) as Case[];
const hers = JSON.parse(readFileSync(abs(hersPath), 'utf8')) as Record<string, string[]>;
const config = loadConfig(repoRoot);
const llm = { ...config.llm, temperature: 0 };

const SYSTEM = [
    '你是聊天记录鉴别员。下面是一段中文即时聊天里男生发的话，和两个女生的回复（A 和 B）。其中一个是真人女生当时发的，另一个是 AI 写的。',
    '判断哪一个是真人。真人的回复常常不完整、跳跃、带情绪、有口头习惯、有时答非所问或只应一声；AI 写的常常过于得体、很会接话、爱用巧妙的反问或反驳、每句都完整。',
    '只输出两行：第一行只写 A 或 B（你认为是真人的那个）；第二行用不超过 25 个字说明你判断的依据（说你认为 AI 的那个哪里像 AI）。',
].join('\n');

const block = (lines: string[]) => lines.join('\n');
interface Verdict { id: string; pickedHuman: boolean; reason: string }
const verdicts: Verdict[] = [];
for (const item of cases) {
    const reply = hers[item.id];
    if (!reply?.length) continue;
    const humanFirst = unit(`${item.id} order`) < 0.5;
    const [a, b] = humanFirst ? [item.human, reply] : [reply, item.human];
    let raw: string;
    try {
        raw = await chatCompletion(llm, [{ role: 'system', content: SYSTEM }, { role: 'user', content: `男生说：\n${block(item.stimulus)}\n\nA：\n${block(a)}\n\nB：\n${block(b)}` }], { purpose: 'background' });
    } catch (error) {
        console.error(`${item.id}：鉴别失败（${error instanceof Error ? error.message : String(error)}）`);
        continue;
    }
    const lines = raw.trim().split('\n').map(line => line.trim()).filter(Boolean);
    const pick = /^[AB]/i.exec(lines[0] ?? '')?.[0]?.toUpperCase();
    if (!pick) continue;
    const pickedHuman = (pick === 'A') === humanFirst;
    verdicts.push({ id: item.id, pickedHuman, reason: lines.slice(1).join(' ').slice(0, 60) });
}

const label = one('--label') ?? '';
const correct = verdicts.filter(v => v.pickedHuman).length;
console.log(`鉴别 ${label}：${verdicts.length} 条；挑中真人 ${Math.round((100 * correct) / (verdicts.length || 1))}%（被她骗过 ${Math.round((100 * (verdicts.length - correct)) / (verdicts.length || 1))}%，50% 以上算分不开）`);

const spotted = verdicts.filter(v => v.pickedHuman && v.reason);
if (spotted.length >= 5) {
    const summary = await chatCompletion(llm, [
        { role: 'system', content: '你把一批“为什么认为这条回复是 AI 写的”的理由归类。' },
        { role: 'user', content: `下面是 ${spotted.length} 条理由。归纳成不超过 6 类，每类一行，格式「类名（条数）：一句话说明」，按条数从多到少。只输出这几行。\n\n${spotted.map((v, i) => `${i + 1}. ${v.reason}`).join('\n')}` },
    ], { purpose: 'background' });
    console.log(`\n鉴别员认为“像 AI”的理由归类（${spotted.length} 条）：\n${summary.trim() || '（归类没返回内容，下面是原始理由）'}`);
    if (!summary.trim() || args.includes('--reasons')) for (const v of spotted) console.log(`  - ${v.reason}`);
}
