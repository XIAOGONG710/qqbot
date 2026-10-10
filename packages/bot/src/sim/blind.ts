// 盲评生成器（ADR 0036「盲评层」，exchange 的 T2 题库）：
//   npm run blind -w @qqbot/bot -- <题库.json> --label O [--status] [--only be-001,be-002] [--card <目录>] [--parallel 4]
//   npm run blind -w @qqbot/bot -- --pack <题库.json> <回答.json>... --out <评分包目录> [--batch 10] [--seed 1]
// 每题照固定上文重放：他最后一句之前的话（她说过的也一样，原样放、不重新生成）带着各自的时刻放进聊天记录，最后一句在那一刻发出，只记她这一轮。
// --status：生成器换成固定的「嗯」，不调模型，只取每题那一刻提示词里的时间块（她在干嘛、天气、心情），给出题的人核对上文和她的状态打不打架。
// 不开长期记忆；每题只跑一次、不挑，出口检查拦下或没回照实记。回答写到 runtime/blind/<时间>-<label>/answers.json。
// --pack：几份回答按题混排、分批，编号 q01-a 这样的中性编号；对照表写到 runtime/blind/，不进评分包。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTACT_TIERS, loadConfig, type ContactTier } from '../config.ts';
import { loadTierCard } from '../contact.ts';
import { runScenario, type RunResult } from './runner.ts';
import { parseScenario, type Scenario } from './scenario.ts';

/** 题目里的一句话：他（对方）或她；at 是带时区的 ISO 时间 */
export interface BlindLine { who: '他' | '她'; at: string; text: string }

export interface BlindQuestion {
    id: string;
    /** 题面上的关系（男朋友 / 闺蜜 / 同学 / 普通朋友），给评分人看 */
    relation: string;
    tier: ContactTier;
    /** 对方在她手机里的称呼 */
    user: string;
    /** 类别 1–8 */
    scene: number;
    lines: BlindLine[];
    /** 以下只给组织者：出题意图（原来的「她那时」）、考察点、依赖的固定事实 */
    intent?: string;
    probe?: string;
    facts?: string[];
}

export interface BlindAnswer {
    id: string;
    /** 她的每一条：离他最后一句多少秒、原文 */
    bubbles: { after: number; text: string }[];
    /** 那一刻提示词里的时间块 */
    timeBlock?: string;
    /** 出口检查、清理之类的日志（排查用，不进评分包） */
    logs: string[];
}

export interface AnswerSet {
    label: string;
    commit: string;
    dirty: boolean;
    status: boolean;
    createdAt: string;
    answers: BlindAnswer[];
}

export function loadQuestions(path: string): BlindQuestion[] {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { questions?: unknown };
    if (!Array.isArray(data.questions)) throw new Error(`${path}：缺少 questions 数组`);
    const questions = data.questions as BlindQuestion[];
    const ids = new Set<string>();
    for (const q of questions) {
        const fail = (message: string): never => { throw new Error(`${path} ${q.id ?? '?'}：${message}`); };
        if (typeof q.id !== 'string' || !q.id) fail('缺少 id');
        if (ids.has(q.id)) fail('id 重复');
        ids.add(q.id);
        if (!CONTACT_TIERS.includes(q.tier)) fail(`tier 应为 ${CONTACT_TIERS.join(' / ')} 之一`);
        if (!Array.isArray(q.lines) || q.lines.length === 0) fail('lines 应为非空数组');
        let last = -Infinity;
        for (const line of q.lines) {
            if (line.who !== '他' && line.who !== '她') fail('who 应为「他」或「她」');
            const time = Date.parse(line.at);
            if (Number.isNaN(time)) fail(`时间不对：${line.at}`);
            if (time < last) fail(`时间倒退：${line.at}`);
            last = time;
            if (typeof line.text !== 'string' || !line.text) fail('text 应为非空字符串');
        }
        if (q.lines.at(-1)!.who !== '他') fail('最后一句要是他说的（停在轮到她回）');
    }
    return questions;
}

/** 题目只写到分钟：同一分钟的几句从后往前每句早 15 秒，最后一句还在原来的时刻 */
const SAME_MINUTE_STEP_MS = 15_000;

/** 一道题 → 一个场景：他最后一句之前的都进事先的聊天，最后一句在那一刻发出 */
export function toScenario(q: BlindQuestion): Scenario {
    const last = q.lines.at(-1)!;
    const times = q.lines.map(line => Date.parse(line.at));
    for (let i = times.length - 2; i >= 0; i--) times[i] = Math.min(times[i]!, times[i + 1]! - SAME_MINUTE_STEP_MS);
    return parseScenario({
        name: q.id,
        tier: q.tier,
        user: q.user,
        start: last.at,
        memory: false,
        history: q.lines.slice(0, -1).map((line, i) => ({ time: new Date(times[i]!).toISOString(), role: line.who === '他' ? 'user' : 'assistant', content: line.text })),
        steps: [{ say: last.text }],
    }, q.id);
}

export function answerOf(q: BlindQuestion, result: RunResult): BlindAnswer {
    const say = result.steps.find(step => step.kind === 'say');
    const from = say?.inputTime ?? Date.parse(q.lines.at(-1)!.at);
    return {
        id: q.id,
        bubbles: (say?.bubbles ?? []).map(b => ({ after: Math.round((b.time - from) / 1000), text: b.text })),
        ...(say?.generations[0]?.timeBlock ? { timeBlock: say.generations[0].timeBlock } : {}),
        logs: (say?.logs ?? []).filter(line => /出口|清理|重写|没有回|不回|拦/.test(line)),
    };
}

/** 评分人看的「她那时」：时刻、在哪在干嘛、心情、天气（从时间块里摘） */
export function statusSummary(timeBlock: string | undefined): string | undefined {
    if (!timeBlock) return undefined;
    const line = (header: string) => timeBlock.split('\n').find(l => l.startsWith(header))?.slice(header.length).replace(/\]$/, '');
    const time = line('[当前时间：');
    const now = line('[你现在：');
    const mood = line('[你今天的心情：')?.replace(/[（(。].*$/, '');
    const weather = timeBlock.match(/天气：([^｜\]]+)/)?.[1];
    return [time, now, mood && `心情${mood}`, weather && `天气${weather}`].filter(Boolean).join(' · ');
}

/** 固定种子的随机数（mulberry32） */
export function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
}

export interface PackKey {
    seed: number;
    sources: { label: string; commit: string; createdAt: string }[];
    /** 评分包里的题号 → 原题 id、每个回答字母 → 版本 */
    items: { q: string; id: string; batch: number; answers: Record<string, string> }[];
}

/** 混排、分批：返回每批的 Markdown 和对照表 */
export function pack(questions: BlindQuestion[], sets: AnswerSet[], options: { batch: number; seed: number }): { batches: string[]; key: PackKey } {
    const random = seeded(options.seed);
    const byLabel = new Map(sets.map(set => [set.label, new Map(set.answers.map(a => [a.id, a]))]));
    const usable = questions.filter(q => sets.every(set => byLabel.get(set.label)!.has(q.id)));
    const order = shuffle(usable, random);
    const letters = 'abcdefgh';
    const key: PackKey = { seed: options.seed, sources: sets.map(s => ({ label: s.label, commit: s.commit, createdAt: s.createdAt })), items: [] };
    const batches: string[] = [];
    const time = (iso: string) => {
        const d = new Date(iso);
        const pad = (n: number) => String(n).padStart(2, '0');
        // 题目时间是东八区的
        const local = new Date(d.getTime() + 8 * 3_600_000);
        return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
    };
    for (let b = 0; b * options.batch < order.length; b++) {
        const chunk = order.slice(b * options.batch, (b + 1) * options.batch);
        const out: string[] = [
            `# 盲评第 ${b + 1} 批（${chunk.length} 题）`,
            '',
            '每题是一段聊天，停在轮到林梦瑶回；下面几个回答是不同来源的，顺序随机。每个回答打六项（1–5 分）：',
            '',
            '| 项 | 1 分 | 5 分 |',
            '| --- | --- | --- |',
            '| 真人 | 一眼 AI：工整、书面、句句接梗 | 像手机对面的真人随手打的 |',
            '| 她 | 谁都行，跟人设无关 | 就是她：嘴硬、爱损、报喜不报忧、怕麻烦人 |',
            '| 接住 | 答非所问，没接住对方真正在说的事 | 稳稳接住 |',
            '| 想聊 | 这句一来天就聊死了 | 想接着往下说 |',
            '| 跑题 | 跑到别的事上去了 | 就在这个话题里 |',
            '| 编事 | 编了没发生的事、替对方做决定、许了做不到的诺 | 只说了该说的 |',
            '',
            '**某项打 1 或 2 分时，在「理由」里写一句为什么；其他不用写。**「最假」：抄下最像 AI 的那一句，没有就空着。',
            '「她那时」是她那一刻的状态，回答的人也知道这些。',
            '',
        ];
        for (const [i, q] of chunk.entries()) {
            const n = String(b * options.batch + i + 1).padStart(2, '0');
            const status = statusSummary(sets.map(set => byLabel.get(set.label)!.get(q.id)!.timeBlock).find(Boolean));
            out.push('---', '', `## q${n} ｜ ${q.relation}`, '');
            if (status) out.push(`她那时：${status}`, '');
            out.push('```text', ...q.lines.map(line => `${time(line.at)} ${line.who === '他' ? q.user : '林梦瑶'}：${line.text}`), '```', '');
            const labels = shuffle(sets.map(set => set.label), random);
            const answers: Record<string, string> = {};
            for (const [j, label] of labels.entries()) {
                const letter = letters[j]!;
                answers[letter] = label;
                const answer = byLabel.get(label)!.get(q.id)!;
                out.push(`**q${n}-${letter}**`, '');
                // 一条一段；一条里的换行（她在一条里打了两行）标成 ⏎，不和下一条混在一起
                if (answer.bubbles.length === 0) out.push('> （没有回复）');
                else out.push(answer.bubbles.map(bubble => `> ${bubble.text.replace(/\n/g, ' ⏎ ')}`).join('\n>\n'));
                out.push('', '真人 _ ｜ 她 _ ｜ 接住 _ ｜ 想聊 _ ｜ 跑题 _ ｜ 编事 _ ｜ 理由： ｜ 最假：', '');
            }
            key.items.push({ q: `q${n}`, id: q.id, batch: b + 1, answers });
        }
        batches.push(out.join('\n'));
    }
    return { batches, key };
}

async function main(): Promise<void> {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const cwd = process.env.INIT_CWD ?? process.cwd();
    const args = process.argv.slice(2);
    const flag = (name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
    const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };
    const stampNow = () => {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    };

    if (flag('--pack')) {
        const out = option('--out');
        const batch = Number(option('--batch') ?? 10);
        const seed = Number(option('--seed') ?? 1);
        if (!out || args.length < 2 || !Number.isInteger(batch) || batch < 1 || !Number.isInteger(seed)) {
            console.error('用法：npm run blind -w @qqbot/bot -- --pack <题库.json> <回答.json>... --out <评分包目录> [--batch 10] [--seed 1]');
            process.exit(2);
        }
        const [questionFile, ...answerFiles] = args.map(arg => resolve(cwd, arg));
        const questions = loadQuestions(questionFile!);
        const sets = answerFiles.map(file => JSON.parse(readFileSync(file, 'utf8')) as AnswerSet);
        if (new Set(sets.map(s => s.label)).size !== sets.length) throw new Error('几份回答的 label 不能重复');
        if (sets.some(s => s.status)) throw new Error('--status 跑出来的不是回答，不能混排');
        const { batches, key } = pack(questions, sets, { batch, seed });
        const outDir = resolve(cwd, out);
        mkdirSync(outDir, { recursive: true });
        batches.forEach((text, i) => writeFileSync(join(outDir, `batch-${i + 1}.md`), text + '\n'));
        const keyDir = join(repoRoot, 'runtime', 'blind');
        mkdirSync(keyDir, { recursive: true });
        const keyFile = join(keyDir, `key-${stampNow()}.json`);
        writeFileSync(keyFile, JSON.stringify({ ...key, questionFile, answerFiles, outDir }, null, 2));
        console.log(`${batches.length} 批、${key.items.length} 题 → ${outDir}；对照表 ${keyFile}（不进仓库）`);
        return;
    }

    const label = option('--label');
    const status = flag('--status');
    const only = option('--only')?.split(',');
    const cardDir = option('--card');
    const parallel = Number(option('--parallel') ?? 4);
    if (args.length !== 1 || (!label && !status) || !Number.isInteger(parallel) || parallel < 1) {
        console.error('用法：npm run blind -w @qqbot/bot -- <题库.json> --label O [--status] [--only be-001,be-002] [--card <目录>] [--parallel 4]');
        process.exit(2);
    }
    const questions = loadQuestions(resolve(cwd, args[0]!)).filter(q => !only || only.includes(q.id));
    const loaded = loadConfig(repoRoot);
    const config = cardDir ? { ...loaded, characterCard: join(resolve(cwd, cardDir), loaded.characterCard.split(/[\\/]/).at(-1)!) } : loaded;
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8' }).trim();
    const name = `${stampNow()}-${status ? 'status' : label}`;
    const root = join(repoRoot, 'runtime', 'blind', name);
    if (existsSync(root)) throw new Error(`${root} 已经有了`);
    mkdirSync(root, { recursive: true });
    const diaryCard = loadTierCard(config.characterCard, 'classmate').character;
    const answers: BlindAnswer[] = new Array(questions.length);
    let next = 0;
    const worker = async () => {
        while (next < questions.length) {
            const i = next++;
            const q = questions[i]!;
            const result = await runScenario(toScenario(q), {
                runId: `blind-${name}-${q.id}`,
                dataDir: join(root, q.id),
                card: loadTierCard(config.characterCard, q.tier),
                llm: config.llm,
                prompt: config.prompt,
                speechCheck: config.speechCheck,
                herDays: config.herDays,
                candidates: config.candidates,
                ...(diaryCard.herWorld ? { diaryWorld: diaryCard.herWorld } : {}),
                ...(diaryCard.schedule ? { diaryWorldSchedule: diaryCard.schedule } : {}),
                ...(status ? { generate: async () => '嗯' } : {}),
            });
            answers[i] = answerOf(q, result);
            const a = answers[i]!;
            console.log(`${q.id}：${a.bubbles.length ? a.bubbles.map(b => b.text).join(' / ') : '（没回）'}${a.bubbles[0] && a.bubbles[0].after > 300 ? `（${Math.round(a.bubbles[0].after / 60)} 分钟后）` : ''}`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, questions.length) }, worker));
    const set: AnswerSet = {
        label: status ? 'status' : label!,
        commit: git('rev-parse', 'HEAD'),
        dirty: git('status', '--porcelain', '--untracked-files=no').length > 0,
        status,
        createdAt: new Date().toISOString(),
        answers,
    };
    writeFileSync(join(root, 'answers.json'), JSON.stringify(set, null, 2));
    console.log(`→ ${join(root, 'answers.json')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
