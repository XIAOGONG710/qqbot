// 抽取 / 事实审稿关思考的离线 A/B 探针（docs/plans/2026-11-24-subtraction-round.md 第 5、6 条；用户 11-24：「抽取和事实检查审稿关思考——先在模拟器对一轮再定」）。
// 背景：docs/reports/2026-11-24-background-llm-audit.md 查到抽取类调用（forExtraction 只把输出上限放大）和事实审稿（A1）都跟着线上的 thinking: high 走。
// 这里不改线上任何东西，只量两臂：
//   live —— 照 runtime/bot/config.json 原样（思考同线上）；
//   off  —— 同一份配置，只把思考关掉（同 run.ts 的 --thinking off：extraBody.thinking = { type: 'disabled' }，去掉 reasoning_effort）。
// 每臂跑真的提示词和解析（不另写提示词），调用参数照线上接线（app.ts / planner-host.ts / reflections.ts）：
//   promises   她答应的事 + 挂着的事 + 世界动作：promisePrompt / episodeTranscript / parsePromises，forExtraction，后台；
//   followups  待跟进的事：extractionPrompt / parseExtraction，forExtraction，后台；
//   feelings   聊完回想的感受：reviewIfDue 整个跑（临时数据目录），forExtraction + 温度 0.9，后台；
//   facts      逐条事实审稿：checkFacts（log 档，不重写），forExtraction + 温度 0，聊天优先级，超时同线上 25 秒。
// 材料是写在下面的 8 段合成聊天（学生日常，不读任何真实资料）；facts 另给每段一份「设定和事实」和一条预埋了错（或干净）的回复。
// 报告每个抽取 × 臂：解析成功率、平均条数、臂内 / 两臂一致（同一段两次结果按归一化文字配对重合）、平均耗时、接口返回的 token 用量；facts 另报抓到预埋错误、干净稿误报、超时。
//
// 用法：npm run probe:extraction -w @qqbot/bot -- [--runs 3] [--parallel 4] [--only promises,followups,feelings,facts] [--out <报告.md>]
//   配置照 runtime/bot/config.json（QQBOT_CONFIG 可以换），key 从 QQBOT_LLM_API_KEY 读（同 npm run sim）。一次约 (8+8+8+5) × 2 臂 × runs 次调用。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadReviewState, reviewIfDue } from '../emotion/feeling-review.ts';
import { checkFacts, FACT_TIMEOUT_MS, type FactRecord } from '../language/fact-check.ts';
import { chatCompletion, forExtraction, type Fetch, type LlmDeps, type LlmOptions } from '../language/llm.ts';
import type { ModelPurpose } from '../language/model-guard.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import { parsePromises, promisePrompt } from '../life/promises.ts';
import type { StoredMessage } from '../memory/history.ts';
import { episodeTranscript, splitEpisodes } from '../memory/episodes.ts';
import { extractionPrompt, parseExtraction } from '../proactive/follow-ups.ts';

export const EXTRACTORS = ['promises', 'followups', 'feelings', 'facts'] as const;
export type ExtractorId = (typeof EXTRACTORS)[number];
export const ARMS = ['live', 'off'] as const;
export type ArmId = (typeof ARMS)[number];

const EXTRACTOR_NAME: Record<ExtractorId, string> = { promises: '她答应的事', followups: '待跟进', feelings: '聊完回想', facts: '事实审稿' };
const ARM_NAME: Record<ArmId, string> = { live: '同线上', off: '关思考' };

export const NAMES = { char: '测试角色', user: '小安' };
const PERSONA = '测试角色，二十岁，师范大学汉语言文学大二，住学校宿舍四人间，养了一只叫团子的橘猫（寄养在宿舍楼下阿姨那儿），喜欢推理小说和拍照，说话随意、爱开玩笑。小安是她的男朋友，在同城另一所大学读计算机。';

// ───────── 合成材料 ─────────

interface FactAudit {
    /** 这一轮她能依据的设定和事实（拼成 system） */
    facts: string;
    /** 她准备发的回复 */
    reply: string;
    /** 预埋的错：回复里的一段原话；没有就是干净稿（报误报） */
    slip?: string;
}

export interface Segment {
    id: string;
    /** 这一段哪天（YYYY-MM-DD，本地） */
    day: string;
    /** [谁, HH:MM, 说了什么]；u 是他，a 是她 */
    lines: ReadonlyArray<readonly ['u' | 'a', string, string]>;
    audit?: FactAudit;
}

export const SEGMENTS: readonly Segment[] = [
    {
        id: 's1-约饭', day: '2026-11-20',
        lines: [
            ['u', '18:02', '下课了吗'],
            ['a', '18:03', '刚下，今天现代汉语讲了一下午虚词，脑子嗡嗡的'],
            ['u', '18:05', '明天晚上要不要一起吃饭，东门那家砂锅粥'],
            ['a', '18:06', '好呀！几点？'],
            ['u', '18:06', '六点半吧 东门口见'],
            ['a', '18:07', '行，六点半东门口，我下午没课正好'],
            ['u', '18:09', '对了你上次说的那本推理小说结局到底是啥'],
            ['a', '18:10', '不告诉你哈哈，下次见面给你讲，现在讲就没意思了'],
            ['u', '18:12', '吊胃口'],
            ['a', '18:13', '就吊'],
        ],
        audit: {
            facts: '她今天下午在教学楼上现代汉语课，晚饭还没吃，打算等会儿去二食堂吃番茄炒蛋盖饭。室友小林今天去市里比赛了，不在宿舍。',
            reply: '刚从食堂出来，吃了一大碗麻辣香锅，辣死我了\n明天六点半东门口见哈',
            slip: '麻辣香锅',
        },
    },
    {
        id: 's2-期中考', day: '2026-11-21',
        lines: [
            ['u', '21:10', '下周三下午考高数 我感觉要挂'],
            ['a', '21:11', '不会吧，你上次小测不是还行嘛'],
            ['u', '21:12', '那是小测 期中难多了'],
            ['a', '21:13', '那这周末好好刷题，我陪你一起熬'],
            ['u', '21:14', '你周末干嘛'],
            ['a', '21:15', '我周六打算去图书馆把文学史那篇论文写完'],
            ['u', '21:16', '那我也去图书馆'],
            ['a', '21:17', '好啊，不过你要真的刷题，别光看我'],
            ['u', '21:18', '哈哈哈尽量'],
            ['a', '21:19', '早点睡吧，明天还有早八'],
        ],
        audit: {
            facts: '她今晚在宿舍，刚洗完头，正在改文学史论文的提纲。她周六上午要去图书馆三楼写论文。',
            reply: '我刚洗完头，在改论文提纲\n周六我去图书馆写论文，你来的话我给你占个座',
        },
    },
    {
        id: 's3-晾着', day: '2026-11-22',
        lines: [
            ['a', '14:00', '我今天拍的银杏，好不好看'],
            ['u', '14:30', '嗯'],
            ['a', '14:31', '就一个嗯？我在银杏树下蹲了半小时'],
            ['u', '14:35', '在打游戏 等会说'],
            ['a', '14:36', '哦'],
            ['u', '15:10', '打完了 刚才那张真的好看 光线绝了'],
            ['a', '15:11', '现在才说'],
            ['u', '15:12', '错了错了 你拍得比我手机壁纸还好看'],
            ['a', '15:13', '哼，这还差不多'],
            ['u', '15:14', '晚上请你喝奶茶赔罪'],
            ['a', '15:15', '那我要芋泥波波'],
        ],
    },
    {
        id: 's4-寒假喂猫', day: '2026-11-23',
        lines: [
            ['a', '20:30', '我刚下楼喂完团子了，今天它居然在，吃了好多'],
            ['u', '20:31', '团子还记得你吗'],
            ['a', '20:32', '记得，蹭了我半天腿'],
            ['a', '20:33', '对了你寒假回不回家呀？我想知道要不要一起买票'],
            ['u', '20:35', '我们宿舍今天停水了 好烦'],
            ['a', '20:35', '啊？那你怎么洗漱'],
            ['u', '20:36', '去隔壁楼打的水'],
            ['a', '20:37', '辛苦辛苦'],
            ['u', '20:40', '我去洗澡了 一会聊'],
        ],
        audit: {
            facts: '她今晚八点半下楼喂了团子，团子今天在，吃了半碗猫粮。之后回宿舍在床上看推理小说。',
            reply: '团子今天吃了半碗，还蹭我腿\n喂完我又去操场跑了五圈才回来',
            slip: '跑了五圈',
        },
    },
    {
        id: 's5-没看成电影', day: '2026-11-24',
        lines: [
            ['u', '17:40', '今晚电影可能去不了了 导师临时要开组会'],
            ['a', '17:41', '啊……说好的七点半那场'],
            ['u', '17:42', '对不起 票我去退'],
            ['a', '17:43', '好吧，那你先忙'],
            ['u', '17:45', '下周三上午我还得去医院复查牙'],
            ['a', '17:46', '牙还疼吗'],
            ['u', '17:47', '好多了 就是去拆个东西'],
            ['a', '17:48', '那复查完跟我说一声'],
            ['u', '17:49', '好'],
        ],
    },
    {
        id: 's6-篮球赛', day: '2026-11-25',
        lines: [
            ['u', '12:10', '周日下午两点我们院篮球赛决赛'],
            ['a', '12:11', '哇决赛！在哪打'],
            ['u', '12:11', '东区体育馆'],
            ['a', '12:12', '那我周日两点去体育馆给你加油'],
            ['u', '12:13', '真的？你不是周日要写论文'],
            ['a', '12:14', '论文周六写完，周日专门留给你'],
            ['u', '12:15', '那我得好好打了'],
            ['a', '12:16', '输了也请我吃饭'],
            ['u', '12:17', '赢了也请'],
        ],
        audit: {
            facts: '她中午在二食堂吃饭，下午两点有一节写作课。周三下午她没有别的课。',
            reply: '我在食堂呢，下午两点还有写作课\n周三下午我有两节高数课，上完才有空',
            slip: '两节高数课',
        },
    },
    {
        id: 's7-半夜驾校', day: '2026-11-27',
        lines: [
            ['u', '00:20', '还没睡？'],
            ['a', '00:21', '在看小说，停不下来'],
            ['u', '00:22', '我明天上午十点去驾校考科目二 紧张得睡不着'],
            ['a', '00:23', '倒车入库练得怎么样'],
            ['u', '00:24', '十次能过八次吧'],
            ['a', '00:25', '那稳了，考完第一时间告诉我'],
            ['u', '00:26', '嗯嗯'],
            ['a', '00:27', '快去睡，我也睡了'],
            ['u', '00:28', '晚安'],
        ],
    },
    {
        id: 's8-闲聊', day: '2026-11-28',
        lines: [
            ['u', '16:00', '今天好冷'],
            ['a', '16:01', '是啊，我把羽绒服都翻出来了'],
            ['u', '16:02', '食堂今天的饺子还挺好吃'],
            ['a', '16:03', '哪个食堂'],
            ['u', '16:03', '一食堂二楼'],
            ['a', '16:04', '我们这边一食堂只有面'],
            ['u', '16:05', '哈哈 那你过来吃'],
            ['a', '16:06', '太远啦，懒'],
            ['u', '16:07', '懒猫'],
        ],
        audit: {
            facts: '她下午在宿舍，刚把羽绒服从柜子里翻出来，室友小林在旁边打游戏。',
            reply: '我刚把羽绒服翻出来，小林在旁边打游戏\n你们食堂饺子听起来不错',
        },
    },
];

/** 一段的聊天记录（StoredMessage，本地时间） */
export function segmentMessages(segment: Segment): StoredMessage[] {
    const [y, m, d] = segment.day.split('-').map(Number);
    return segment.lines.map(([who, hm, content]) => {
        const [h, min] = hm.split(':').map(Number);
        return { role: who === 'u' ? 'user' : 'assistant', time: new Date(y!, m! - 1, d!, h!, min!).toISOString(), content };
    });
}

// ───────── 两臂 ─────────

/** 关思考（同 run.ts 的 --thinking off）：thinking 置 disabled，去掉 reasoning_effort，其余不动 */
export function thinkingOff(llm: LlmOptions): LlmOptions {
    const { reasoning_effort: _dropEffort, ...rest } = llm.extraBody ?? {};
    return { ...llm, extraBody: { ...rest, thinking: { type: 'disabled' } } };
}

export function armOptions(llm: LlmOptions): Record<ArmId, LlmOptions> {
    return { live: llm, off: thinkingOff(llm) };
}

// ───────── 计量：耗时、token、空正文 ─────────

export interface Usage { prompt?: number; completion?: number; reasoning?: number }

interface Metered { ms: number; usage?: Usage; emptyBody: boolean }

/** 包一层 fetch：读出接口返回的 usage（DeepSeek 的 reasoning_tokens 在 completion_tokens_details 里） */
function meteredFetch(base: Fetch, onUsage: (usage: Usage) => void): Fetch {
    return async (url, init) => {
        const response = await base(url, init);
        const body = await response.text();
        try {
            const usage = (JSON.parse(body) as { usage?: Record<string, unknown> }).usage;
            if (usage && typeof usage === 'object') {
                const n = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
                const details = usage.completion_tokens_details as Record<string, unknown> | undefined;
                const reasoning = n(details?.reasoning_tokens);
                onUsage({ prompt: n(usage.prompt_tokens), completion: n(usage.completion_tokens), ...(reasoning !== undefined ? { reasoning } : {}) });
            }
        } catch { /* 不是 JSON：交给 chatCompletion 报错 */ }
        return { ok: response.ok, status: response.status, text: async () => body };
    };
}

interface CallDeps { fetch: Fetch; guard?: LlmDeps['guard'] }

/** 调一次模型，顺便记下耗时、usage、有没有空正文 */
async function call(llm: LlmOptions, messages: OpenAIMessage[], purpose: ModelPurpose, deps: CallDeps): Promise<{ text: string; meter: Metered }> {
    let usage: Usage | undefined;
    let emptyBody = false;
    const start = performance.now();
    const text = await chatCompletion(llm, messages, {
        fetch: meteredFetch(deps.fetch, u => { usage = u; }),
        purpose,
        log: line => { if (/正文是空的|被截断/.test(line)) emptyBody = true; },
        ...(deps.guard ? { guard: deps.guard } : {}),
    });
    return { text, meter: { ms: performance.now() - start, ...(usage ? { usage } : {}), emptyBody } };
}

// ───────── 每个抽取跑一次 ─────────

/** 一条结果：key 必须一样（种类、日期），text 按归一化文字比 */
export interface Item { key: string; text: string }

export interface Sample {
    extractor: ExtractorId;
    arm: ArmId;
    run: number;
    segment: string;
    ok: boolean;
    items: Item[];
    ms?: number;
    usage?: Usage;
    emptyBody?: boolean;
    error?: string;
    /** facts：预埋的错抓到了没有（干净稿没有这一项） */
    caught?: boolean;
    /** facts：干净稿上报了问题 */
    falseAlarm?: boolean;
    /** facts：审稿超过线上的 25 秒，线上会照发（等于没查） */
    timedOut?: boolean;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 120);

async function runPromises(segment: Segment, llm: LlmOptions, deps: CallDeps): Promise<Omit<Sample, 'extractor' | 'arm' | 'run' | 'segment'>> {
    const [episode] = splitEpisodes(segmentMessages(segment));
    let meter: Metered | undefined;
    try {
        const reply = await call(forExtraction(llm), promisePrompt(episodeTranscript(episode!, NAMES), [], NAMES), 'background', deps);
        meter = reply.meter;
        const r = parsePromises(reply.text);
        const items: Item[] = [
            ...r.add.map(a => ({ key: `add|${a.date ?? '-'}|${a.meet?.time ?? '-'}`, text: a.what })),
            ...r.waiting.map(a => ({ key: `waiting|${a.date ?? '-'}`, text: a.what })),
            ...r.unanswered.map(a => ({ key: 'unanswered', text: a.what })),
            ...r.unsettled.map(a => ({ key: 'unsettled', text: a.what })),
            ...r.world.map(a => ({ key: `world|${a.kind}`, text: a.kind })),
        ];
        return { ok: true, items, ...metered(meter) };
    } catch (error) {
        return { ok: false, items: [], error: errorText(error), ...metered(meter) };
    }
}

async function runFollowUps(segment: Segment, llm: LlmOptions, deps: CallDeps): Promise<Omit<Sample, 'extractor' | 'arm' | 'run' | 'segment'>> {
    const [episode] = splitEpisodes(segmentMessages(segment));
    let meter: Metered | undefined;
    try {
        const reply = await call(forExtraction(llm), extractionPrompt(episodeTranscript(episode!, NAMES), [], NAMES), 'background', deps);
        meter = reply.meter;
        const r = parseExtraction(reply.text);
        return { ok: true, items: r.add.map(a => ({ key: a.date, text: a.what })), ...metered(meter) };
    } catch (error) {
        return { ok: false, items: [], error: errorText(error), ...metered(meter) };
    }
}

/** 聊完 45 分钟（过了半小时的门槛）回想一次，临时数据目录，跑完删掉 */
async function runFeelings(segment: Segment, llm: LlmOptions, deps: CallDeps): Promise<Omit<Sample, 'extractor' | 'arm' | 'run' | 'segment'>> {
    const history = segmentMessages(segment);
    const now = Date.parse(history.at(-1)!.time) + 45 * 60_000;
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-extraction-probe-'));
    let meter: Metered | undefined;
    try {
        const result = await reviewIfDue({
            dataDir: dir, soulDir: dir, now: () => now,
            generate: async messages => { const reply = await call({ ...forExtraction(llm), temperature: 0.9 }, messages, 'background', deps); meter = reply.meter; return reply.text; },
            history: () => history, persona: () => PERSONA, names: NAMES, others: () => [], existing: () => [], log: () => {},
        });
        if (!result.ran) return { ok: false, items: [], error: '没到回想的条件（探针材料有误）' };
        if (result.error) return { ok: false, items: [], error: result.error, ...metered(meter) };
        const items = loadReviewState(dir).items.map(item => ({ key: item.kind, text: item.cause }));
        return { ok: true, items, ...metered(meter) };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** 逐条事实审稿：log 档、同线上的 25 秒超时；超时了还等调用回来，记下真实耗时 */
async function runFacts(segment: Segment, llm: LlmOptions, deps: CallDeps): Promise<Omit<Sample, 'extractor' | 'arm' | 'run' | 'segment'>> {
    const audit = segment.audit!;
    const source: OpenAIMessage[] = [
        { role: 'system', content: `${PERSONA}\n\n${audit.facts}` },
        ...segmentMessages(segment).map((m): OpenAIMessage => ({ role: m.role, content: m.content })),
    ];
    let pending: Promise<{ text: string; meter: Metered }> | undefined;
    let record: FactRecord | undefined;
    await checkFacts(audit.reply, {
        mode: 'log', source, names: NAMES,
        audit: messages => { pending = call({ ...forExtraction(llm), temperature: 0 }, messages, 'chat', deps); return pending.then(r => r.text); },
        regenerate: () => Promise.reject(new Error('log 档不重写')),
        log: () => {},
        onRecord: r => { record = r; },
        timeoutMs: FACT_TIMEOUT_MS,
    });
    let raw: { text: string; meter: Metered } | undefined;
    let error: string | undefined;
    try { raw = await pending; } catch (e) { error = errorText(e); }
    const timedOut = record?.action === 'skipped' && raw !== undefined;
    const claims = record?.claims ?? [];
    const ok = raw !== undefined && !timedOut && jsonArray(raw.text);
    return {
        ok,
        items: claims.map(c => ({ key: c.kind, text: c.quote })),
        ...(raw ? metered(raw.meter) : {}),
        ...(error ? { error } : !ok && raw && !timedOut ? { error: '审稿输出不是 JSON 数组' } : {}),
        ...(timedOut ? { timedOut: true, error: `超过 ${FACT_TIMEOUT_MS / 1000} 秒` } : {}),
        ...(audit.slip ? { caught: claims.some(c => c.quote.includes(audit.slip!) || audit.slip!.includes(c.quote)) } : { falseAlarm: claims.length > 0 }),
    };
}

/** 审稿员的输出里有没有一个能解析的 JSON 数组（parseClaims 解析不了时静默当 []，这里单独看） */
function jsonArray(raw: string): boolean {
    const body = raw.replace(/```(?:json)?/gi, '');
    const start = body.indexOf('[');
    const end = body.lastIndexOf(']');
    if (start < 0 || end < start) return false;
    try { return Array.isArray(JSON.parse(body.slice(start, end + 1))); } catch { return false; }
}

const metered = (meter: Metered | undefined) => (meter ? { ms: meter.ms, ...(meter.usage ? { usage: meter.usage } : {}), ...(meter.emptyBody ? { emptyBody: true } : {}) } : {});

const RUNNERS: Record<ExtractorId, (segment: Segment, llm: LlmOptions, deps: CallDeps) => Promise<Omit<Sample, 'extractor' | 'arm' | 'run' | 'segment'>>> = {
    promises: runPromises, followups: runFollowUps, feelings: runFeelings, facts: runFacts,
};

export interface ProbeOptions {
    llm: LlmOptions;
    runs: number;
    parallel?: number;
    only?: readonly ExtractorId[];
    fetch: Fetch;
    guard?: LlmDeps['guard'];
    segments?: readonly Segment[];
    progress?: (done: number, total: number) => void;
}

/** 两臂交错排队（同一时刻两臂都在跑，免得接口忙闲不同偏向一臂） */
export async function runProbe(options: ProbeOptions): Promise<Sample[]> {
    const arms = armOptions(options.llm);
    const segments = options.segments ?? SEGMENTS;
    const extractors = options.only ?? EXTRACTORS;
    const jobs: Array<() => Promise<Sample>> = [];
    for (let run = 1; run <= options.runs; run++) {
        for (const extractor of extractors) {
            for (const segment of segments) {
                if (extractor === 'facts' && !segment.audit) continue;
                for (const arm of ARMS) {
                    jobs.push(async () => {
                        const base = { extractor, arm, run, segment: segment.id };
                        try { return { ...base, ...await RUNNERS[extractor](segment, arms[arm], { fetch: options.fetch, ...(options.guard ? { guard: options.guard } : {}) }) }; }
                        catch (error) { return { ...base, ok: false, items: [], error: errorText(error) }; }
                    });
                }
            }
        }
    }
    const results: Sample[] = new Array(jobs.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
        while (next < jobs.length) {
            const i = next++;
            results[i] = await jobs[i]!();
            options.progress?.(++done, jobs.length);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.parallel ?? 4, jobs.length)) }, worker));
    return results;
}

// ───────── 比对和汇总 ─────────

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]/gu, '');

function bigrams(text: string): string[] {
    const chars = [...text];
    if (chars.length < 2) return chars;
    return chars.slice(1).map((c, i) => chars[i]! + c);
}

/** 两句说的是不是同一件事：归一化后相同、互相包含、或二字组重合（Dice）≥ 0.5 */
export function similarText(a: string, b: string): boolean {
    const x = normalize(a);
    const y = normalize(b);
    if (x === y || (x && y && (x.includes(y) || y.includes(x)))) return true;
    const bx = bigrams(x);
    const by = [...bigrams(y)];
    if (!bx.length || !by.length) return false;
    let hit = 0;
    for (const g of bx) { const j = by.indexOf(g); if (j >= 0) { hit++; by.splice(j, 1); } }
    return (2 * hit) / (bx.length + bigrams(y).length) >= 0.5;
}

/** 两次结果的重合度：key 相同且文字相近的配成对，2×对数 / 两边条数之和；两边都没有算 1 */
export function overlap(a: readonly Item[], b: readonly Item[]): number {
    if (!a.length && !b.length) return 1;
    const used = new Set<number>();
    let matched = 0;
    for (const item of a) {
        const j = b.findIndex((other, i) => !used.has(i) && other.key === item.key && similarText(item.text, other.text));
        if (j >= 0) { used.add(j); matched++; }
    }
    return (2 * matched) / (a.length + b.length);
}

export interface ArmSummary {
    extractor: ExtractorId;
    arm: ArmId;
    samples: number;
    ok: number;
    meanItems?: number;
    /** 同一臂同一段不同次之间 */
    withinArm?: number;
    /** 这一臂和另一臂同一段之间（两行一样） */
    crossArm?: number;
    meanMs?: number;
    meanPrompt?: number;
    meanCompletion?: number;
    meanReasoning?: number;
    emptyBody: number;
    caught?: { hit: number; of: number };
    falseAlarm?: { hit: number; of: number };
    timedOut: number;
}

const mean = (values: readonly number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined);

function pairAgreement(left: readonly Sample[], right: readonly Sample[], same: boolean): number | undefined {
    const scores: number[] = [];
    for (const a of left) {
        for (const b of right) {
            if (a.segment !== b.segment || !a.ok || !b.ok) continue;
            if (same && a.run >= b.run) continue;
            scores.push(overlap(a.items, b.items));
        }
    }
    return mean(scores);
}

export function summarize(samples: readonly Sample[]): ArmSummary[] {
    const out: ArmSummary[] = [];
    for (const extractor of EXTRACTORS) {
        const of = (arm: ArmId) => samples.filter(s => s.extractor === extractor && s.arm === arm);
        if (!of('live').length && !of('off').length) continue;
        const cross = pairAgreement(of('live'), of('off'), false);
        for (const arm of ARMS) {
            const list = of(arm);
            const ok = list.filter(s => s.ok);
            const used = list.filter(s => s.usage);
            const field = (key: keyof Usage) => mean(used.flatMap(s => (s.usage![key] !== undefined ? [s.usage![key]!] : [])));
            const slipped = list.filter(s => s.caught !== undefined);
            const clean = list.filter(s => s.falseAlarm !== undefined);
            const summary: ArmSummary = {
                extractor, arm, samples: list.length, ok: ok.length,
                emptyBody: list.filter(s => s.emptyBody).length,
                timedOut: list.filter(s => s.timedOut).length,
            };
            const put = <K extends keyof ArmSummary>(key: K, value: ArmSummary[K] | undefined) => { if (value !== undefined) summary[key] = value; };
            put('meanItems', mean(ok.map(s => s.items.length)));
            put('withinArm', pairAgreement(list, list, true));
            put('crossArm', cross);
            put('meanMs', mean(list.flatMap(s => (s.ms !== undefined ? [s.ms] : []))));
            put('meanPrompt', field('prompt'));
            put('meanCompletion', field('completion'));
            put('meanReasoning', field('reasoning'));
            if (slipped.length) summary.caught = { hit: slipped.filter(s => s.caught).length, of: slipped.length };
            if (clean.length) summary.falseAlarm = { hit: clean.filter(s => s.falseAlarm).length, of: clean.length };
            out.push(summary);
        }
    }
    return out;
}

const fixed = (value: number | undefined, digits = 2) => (value === undefined ? '—' : value.toFixed(digits));
const pctOf = (hit: number, of: number) => `${of ? Math.round((100 * hit) / of) : 0}%（${hit}/${of}）`;

export function renderTable(rows: readonly ArmSummary[]): string {
    const lines = [
        '| 抽取 | 臂 | 解析成功 | 平均条数 | 臂内一致 | 两臂一致 | 平均耗时 | 平均 token 入 / 出（其中思考） | 备注 |',
        '|---|---|---|---|---|---|---|---|---|',
    ];
    for (const r of rows) {
        const tokens = r.meanPrompt === undefined && r.meanCompletion === undefined ? '接口没给' : `${fixed(r.meanPrompt, 0)} / ${fixed(r.meanCompletion, 0)}（${fixed(r.meanReasoning, 0)}）`;
        const notes = [
            r.caught ? `抓到预埋错误 ${pctOf(r.caught.hit, r.caught.of)}` : '',
            r.falseAlarm ? `干净稿误报 ${pctOf(r.falseAlarm.hit, r.falseAlarm.of)}` : '',
            r.timedOut ? `超 ${FACT_TIMEOUT_MS / 1000} 秒 ${r.timedOut} 次（线上照发）` : '',
            r.emptyBody ? `空正文 ${r.emptyBody} 次` : '',
        ].filter(Boolean).join('；');
        lines.push(`| ${EXTRACTOR_NAME[r.extractor]} | ${ARM_NAME[r.arm]} | ${pctOf(r.ok, r.samples)} | ${fixed(r.meanItems)} | ${fixed(r.withinArm)} | ${fixed(r.crossArm)} | ${r.meanMs === undefined ? '—' : `${(r.meanMs / 1000).toFixed(1)} 秒`} | ${tokens} | ${notes || '—'} |`);
    }
    return lines.join('\n');
}

/** 每段每臂抽出了什么（全是合成材料），方便看两臂差在哪 */
export function renderDetails(samples: readonly Sample[]): string {
    const out: string[] = [];
    for (const extractor of EXTRACTORS) {
        const mine = samples.filter(s => s.extractor === extractor);
        if (!mine.length) continue;
        out.push(`### ${EXTRACTOR_NAME[extractor]}`);
        for (const segment of [...new Set(mine.map(s => s.segment))]) {
            out.push(`- ${segment}`);
            for (const arm of ARMS) {
                const runs = mine.filter(s => s.segment === segment && s.arm === arm).sort((a, b) => a.run - b.run);
                const text = runs.map(s => (s.ok ? (s.items.length ? s.items.map(i => `${i.key}:${i.text}`).join('、') : '（无）') : `✗ ${s.error ?? '失败'}`)).join(' ‖ ');
                out.push(`  - ${ARM_NAME[arm]}：${text}`);
            }
        }
    }
    return out.join('\n');
}

function describeArm(llm: LlmOptions): string {
    const body = llm.extraBody ?? {};
    return `thinking=${JSON.stringify(body.thinking ?? '（未设）')}，reasoning_effort=${JSON.stringify(body.reasoning_effort ?? '（未设）')}`;
}

export function renderReport(llm: LlmOptions, runs: number, samples: readonly Sample[]): string {
    const arms = armOptions(llm);
    return [
        `## 抽取 / 事实审稿关思考 A/B（${new Date().toISOString().slice(0, 16)}，模型 ${llm.model}，每臂每段 ${runs} 次）`,
        '',
        `- 同线上：${describeArm(arms.live)}`,
        `- 关思考：${describeArm(arms.off)}`,
        '- 一致 = 同一段两次结果按「种类 / 日期一样、文字相近」配对的重合度（0–1，两边都没抽出东西算 1）；臂内一致是模型自己的抖动，两臂一致要和它比着看。',
        '',
        renderTable(summarize(samples)),
        '',
        '<details><summary>每段每臂抽出了什么（合成材料）</summary>',
        '',
        renderDetails(samples),
        '',
        '</details>',
    ].join('\n');
}

// ───────── 命令行 ─────────

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };
    const runs = Number(option('--runs') ?? 3);
    const parallel = Number(option('--parallel') ?? 4);
    const outPath = option('--out');
    const onlyText = option('--only');
    const only = onlyText?.split(',').map(s => s.trim()).filter(Boolean) as ExtractorId[] | undefined;
    if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(parallel) || parallel < 1 || args.length || only?.some(id => !EXTRACTORS.includes(id))) {
        console.error(`用法：npm run probe:extraction -w @qqbot/bot -- [--runs 3] [--parallel 4] [--only ${EXTRACTORS.join(',')}] [--out <报告.md>]`);
        process.exit(2);
    }
    // 动态引入：测试里不把配置层拉进来
    const { loadConfig } = await import('../platform/config.ts');
    const { modelDispatcher, unlimitedModelGuard } = await import('../language/llm.ts');
    const { fetch: undiciFetch } = await import('undici');
    unlimitedModelGuard();
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const config = loadConfig(repoRoot);
    console.log(`抽取 / 事实审稿关思考 A/B：模型 ${config.llm.model}，每臂每段 ${runs} 次，同时 ${parallel} 个`);
    const samples = await runProbe({
        llm: config.llm, runs, parallel, ...(only ? { only } : {}),
        fetch: (url, init) => undiciFetch(url, { ...init, dispatcher: modelDispatcher }),
        progress: (done, total) => { if (done % 10 === 0 || done === total) console.log(`  ${done}/${total}`); },
    });
    const report = renderReport(config.llm, runs, samples);
    console.log(`\n${renderTable(summarize(samples))}`);
    if (outPath) {
        const path = resolve(process.env.INIT_CWD ?? process.cwd(), outPath);
        writeFileSync(path, `${report}\n`);
        console.log(`\n报告（含每段明细）→ ${path}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
