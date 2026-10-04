// 跑一个场景（ADR 0005）：和 bot 同一条流水线（contact.ts），只换掉收发、时钟和数据目录。
// 对方的消息由场景给出，按虚拟时间记录；她发出的每一条、每次生成的提示词、调度日志都按步骤记下来，最后写成报告。

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig, Contact } from '../config.ts';
import { createContactResponder, type TierCard } from '../contact.ts';
import { ChatHistory } from '../history.ts';
import { chatCompletion } from '../llm.ts';
import type { Log } from '../log.ts';
import type { HindsightApi } from '../memory/hindsight.ts';
import { LongTermMemory, RELATIONSHIP_MODEL } from '../memory/long-term.ts';
import type { OpenAIMessage, PromptResult } from '../prompt.ts';
import { inspectReply, summarizeIssues } from '../exit-check.ts';
import { parseDuration, VirtualClock, type Checks, type Scenario, type SayStep } from './scenario.ts';

/** 模拟的联系人用的 QQ 号（虚构） */
export const SIM_QQ = 10001;
/** say 之后，她要等这么久（虚拟时间）之内才看到的，自动把时钟拨过去（冷场、上课）；更久的（睡觉）要 advance 或 wait */
export const AUTO_TIMER_MS = 60 * 60_000;
/** wait: reply 最多等多久 */
export const WAIT_REPLY_MS = 24 * 3_600_000;

/** 模拟器要用到的 Hindsight 接口（HindsightClient 都有） */
export interface SimHindsight extends HindsightApi {
    activeOperations(bankId: string): Promise<string[]>;
    operationStatus(bankId: string, operationId: string): Promise<string>;
    deleteBank(bankId: string): Promise<void>;
}

export interface RunOptions {
    /** 用在 bank 前缀里，只能是字母、数字、短横线 */
    runId: string;
    dataDir: string;
    card: TierCard;
    llm: BotConfig['llm'];
    prompt: BotConfig['prompt'];
    /** 不传就不用记忆（场景里 memory: true 也一样） */
    hindsight?: SimHindsight;
    recallTimeoutMs?: number;
    /** 等 Hindsight 后台任务的上限 */
    hindsightWaitMs?: number;
    /** 默认调模型接口；测试传假的 */
    generate?: (messages: OpenAIMessage[], log: Log) => Promise<string>;
    /** 跑完不删 bank，方便事后去 Hindsight 里看 */
    keepBank?: boolean;
    sleep?: (ms: number) => Promise<void>;
    /** 连发合并的等待，默认和 bot 一样（测试用短的） */
    settle?: { quietMs: number; maxMs: number };
}

export interface Bubble { time: number; text: string }
export interface Input { time: number; text: string; interrupt?: boolean }
export interface Generation {
    time: number; recall?: string; timeBlock?: string; relationship?: string; messages: number;
    /** 模型原文（清理之前） */
    raw?: string;
    /** 出口检查带说明重写的原文（ADR 0006） */
    rewrites?: string[];
}
export interface CheckResult { ok: boolean; text: string }

export interface StepRecord {
    kind: 'case' | 'say' | 'advance' | 'wait' | 'memory' | 'refresh' | 'check' | 'forget' | 'hindsight';
    /** 这一步开始时的虚拟时间 */
    time: number;
    /** 到这一步为止对方最后一条消息的虚拟时间（replyAfter / replyWithin 从这里算） */
    inputTime?: number;
    caseId?: string;
    note?: string;
    inputs: Input[];
    bubbles: Bubble[];
    generations: Generation[];
    logs: string[];
    checks: CheckResult[];
    relationship?: string;
    advance?: string;
}

export interface RunResult {
    scenario: Scenario;
    runId: string;
    dataDir: string;
    bankId?: string;
    steps: StepRecord[];
    checks: { passed: number; failed: number };
}

const RECALL_HEADER = '[你们以前聊过的事';
const TIME_HEADER = '[当前时间：';
const RELATIONSHIP_HEADER = '[你们关系的整体情况';

export async function runScenario(scenario: Scenario, options: RunOptions): Promise<RunResult> {
    const { dataDir } = options;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    mkdirSync(join(dataDir, 'prompts'), { recursive: true });
    const clock = new VirtualClock(new Date(scenario.start));
    const contact: Contact = { qq: SIM_QQ, name: scenario.user, tier: scenario.tier, persona: scenario.persona };
    const names = { user: contact.name, char: options.card.character.name };
    const history = new ChatHistory(dataDir);

    const steps: StepRecord[] = [];
    let current = newStep('case', clock.now());
    const log: Log = message => {
        current.logs.push(message.replace(/^\[\d+\] /, ''));
        appendFileSync(join(dataDir, 'sim.log'), `[${new Date(clock.now()).toLocaleString('zh-CN', { hour12: false })}] ${message}\n`);
    };

    let hindsightDown = false;
    const hindsight = options.hindsight && switchable(options.hindsight, () => hindsightDown);
    const memory = scenario.memory && hindsight
        ? new LongTermMemory({
            api: hindsight,
            dir: join(dataDir, 'memory'),
            bankPrefix: `sim-${options.runId}`,
            recallTimeoutMs: options.recallTimeoutMs ?? 5000,
            log,
            now: clock.now,
        })
        : undefined;
    const bankId = memory?.bankId(contact);

    let nextMessageId = 1;
    let armed: SayStep['interrupt'];
    let bubblesThisStep = 0;
    let injecting = 0;
    let generationCount = 0;
    let lastInputTime: number | undefined;

    const receive = (text: string, interrupt = false) => {
        const time = clock.now();
        lastInputTime = time;
        current.inputs.push({ time, text, ...(interrupt ? { interrupt } : {}) });
        responder.receive(text, nextMessageId++, new Date(time));
    };
    const baseGenerate = options.generate ?? ((messages: OpenAIMessage[], log: Log) => chatCompletion(options.llm, messages, { log }));

    const createResponder = () => createContactResponder({
        contact,
        card: options.card,
        llm: options.llm,
        prompt: options.prompt,
        schedule: scenario.schedule,
        history,
        memory,
        log,
        now: clock.now,
        settle: options.settle,
        retryAfterMs: [],
        waitUntil: clock.waitUntil,
        send: async (_userId, text) => {
            current.bubbles.push({ time: clock.now(), text });
            bubblesThisStep++;
            if (armed?.afterBubbles !== undefined && bubblesThisStep >= armed.afterBubbles) {
                const it = armed;
                armed = undefined;
                // 等这一条记进聊天记录之后、下一条发出之前再插话（气泡间隔是 1 秒）
                injecting++;
                setTimeout(() => { injecting--; receive(it.say, true); }, 100);
            }
            return nextMessageId++;
        },
        generate: async (messages, log) => {
            const generation = current.generations.at(-1);
            const reply = baseGenerate(messages, log);
            if (armed?.during === 'generation') {
                const it = armed;
                armed = undefined;
                receive(it.say, true);
            }
            const raw = await reply;
            // 出口检查的重写不经过 onPrompt，算在同一次生成里
            if (generation) {
                if (generation.raw === undefined) generation.raw = raw;
                else (generation.rewrites ??= []).push(raw);
            }
            return raw;
        },
        onPrompt: prompt => {
            current.generations.push(dynamicParts(prompt, clock.now()));
            writeFileSync(join(dataDir, 'prompts', `${++generationCount}.json`), JSON.stringify(prompt, null, 2));
        },
    });
    let responder = createResponder();
    let forgotten = 0;

    /** 等她把这一轮（含插话之后的回复）都发完，或者停在「到点才看到」的等待上 */
    async function settle(): Promise<void> {
        for (;;) {
            await responder.whenQuiet();
            const before = history.load(contact.qq).length;
            await sleep(300);
            if (injecting === 0 && history.load(contact.qq).length === before) {
                await responder.whenQuiet();
                if (history.load(contact.qq).length === before) return;
            }
        }
    }

    /** 把虚拟时钟一个个拨到她等着的时刻（不超过 limit），每拨一次等她这一轮做完；stopOnReply：这一步她发了就停 */
    async function runTimers(limit: number, stopOnReply = false): Promise<void> {
        for (;;) {
            await settle();
            if (stopOnReply && current.bubbles.length > 0) return;
            const next = clock.nextTimer();
            if (next === undefined || next > limit) return;
            clock.advanceTo(next);
        }
    }

    async function syncMemory(): Promise<void> {
        if (!memory || !options.hindsight || !bankId || hindsightDown) return;
        await memory.sync(contact, names, history.load(contact.qq));
        const started = Date.now();
        const limit = options.hindsightWaitMs ?? 240_000;
        let quietPolls = 0;
        while (quietPolls < 2) {
            let busy = 0;
            try {
                // 关系概况的自动刷新有 30 分钟（真实时间）的最短间隔，会一直排着，不等它；T23 用手动刷新
                busy = (await options.hindsight.activeOperations(bankId)).filter(t => t !== 'refresh_mental_model').length;
            } catch {
                return; // bank 还没建（没有结束了的片段）
            }
            quietPolls = busy === 0 ? quietPolls + 1 : 0;
            if (Date.now() - started > limit) {
                log(`Hindsight 后台任务 ${Math.round(limit / 1000)} 秒还没做完，不再等`);
                return;
            }
            await sleep(1000);
        }
        log(`Hindsight 后台任务做完（${Math.round((Date.now() - started) / 1000)} 秒）`);
    }

    let lastSay: StepRecord | undefined;
    try {
        for (const step of scenario.steps) {
            current = newStep(Object.keys(step)[0] as StepRecord['kind'], clock.now());
            steps.push(current);
            if ('case' in step) {
                current.caseId = step.case;
                current.note = step.note;
            } else if ('say' in step) {
                lastSay = current;
                bubblesThisStep = 0;
                armed = step.interrupt;
                const texts = Array.isArray(step.say) ? step.say : [step.say];
                for (const [i, text] of texts.entries()) {
                    if (i > 0) await sleep(step.gapMs ?? 800);
                    receive(text);
                }
                current.inputTime = lastInputTime;
                await runTimers(lastInputTime! + AUTO_TIMER_MS);
                if (armed) {
                    log(`插话没有触发（这一轮她只发了 ${bubblesThisStep} 条）`);
                    armed = undefined;
                }
            } else if ('advance' in step) {
                current.advance = step.advance;
                const target = clock.now() + parseDuration(step.advance);
                await runTimers(target);
                clock.advanceTo(target);
                current.time = clock.now();
                await syncMemory();
            } else if ('wait' in step) {
                lastSay = current;
                current.inputTime = lastInputTime;
                await runTimers(clock.now() + WAIT_REPLY_MS, true);
                if (current.bubbles.length === 0) log('等了一天也没回');
            } else if ('memory' in step) {
                await syncMemory();
            } else if ('refresh' in step) {
                if (options.hindsight && bankId && !hindsightDown) {
                    const operation = await options.hindsight.refreshMentalModel(bankId, RELATIONSHIP_MODEL.id);
                    const started = Date.now();
                    let status = '';
                    while (!['completed', 'failed', 'cancelled', 'not_found'].includes(status) && Date.now() - started < (options.hindsightWaitMs ?? 240_000)) {
                        await sleep(1000);
                        status = await options.hindsight.operationStatus(bankId, operation);
                    }
                    log(`关系概况刷新：${status || '没等到'}（${Math.round((Date.now() - started) / 1000)} 秒）`);
                    current.relationship = (await options.hindsight.getMentalModel(bankId, RELATIONSHIP_MODEL.id))?.content ?? '';
                } else {
                    log('没有记忆，跳过刷新关系概况');
                }
            } else if ('forget' in step) {
                await settle();
                const chats = join(dataDir, 'chats');
                renameSync(join(chats, `${contact.qq}.jsonl`), join(chats, `${contact.qq}.forgotten-${++forgotten}.jsonl`));
                responder = createResponder();
                log('聊天记录挪走了，之后只能靠记忆');
            } else if ('hindsight' in step) {
                hindsightDown = step.hindsight === 'down';
                log(hindsightDown ? 'Hindsight 停了' : 'Hindsight 恢复');
            } else if ('check' in step) {
                current.checks = lastSay ? runChecks(step.check, lastSay, options.card.character.banned) : [{ ok: false, text: '前面没有 say 步骤' }];
            }
        }
    } finally {
        if (memory && options.hindsight && bankId && !options.keepBank) {
            await options.hindsight.deleteBank(bankId).catch(error => log(`删除测试 bank 失败：${error instanceof Error ? error.message : String(error)}`));
        }
    }

    const all = steps.flatMap(s => s.checks);
    return {
        scenario,
        runId: options.runId,
        dataDir,
        bankId,
        steps,
        checks: { passed: all.filter(c => c.ok).length, failed: all.filter(c => !c.ok).length },
    };
}

/** 包一层：停了的时候每个请求都报错，和连不上一样 */
function switchable(api: SimHindsight, down: () => boolean): SimHindsight {
    const guard = <T>(call: () => Promise<T>): Promise<T> =>
        (down() ? Promise.reject(new Error('fetch failed（模拟 Hindsight 停了）')) : call());
    return {
        putBank: (...a) => guard(() => api.putBank(...a)),
        retain: (...a) => guard(() => api.retain(...a)),
        recall: (...a) => guard(() => api.recall(...a)),
        getMentalModel: (...a) => guard(() => api.getMentalModel(...a)),
        createMentalModel: (...a) => guard(() => api.createMentalModel(...a)),
        updateMentalModel: (...a) => guard(() => api.updateMentalModel(...a)),
        activeOperations: (...a) => guard(() => api.activeOperations(...a)),
        operationStatus: (...a) => guard(() => api.operationStatus(...a)),
        refreshMentalModel: (...a) => guard(() => api.refreshMentalModel(...a)),
        deleteBank: (...a) => api.deleteBank(...a),
    };
}

function newStep(kind: StepRecord['kind'], time: number): StepRecord {
    return { kind, time, inputs: [], bubbles: [], generations: [], logs: [], checks: [] };
}

/** 提示词里每次都变的几块：召回、时间、关系概况（按开头的标记找，后处理合并了消息也找得到） */
export function dynamicParts(prompt: PromptResult, time: number): Generation {
    const text = prompt.messages.map(m => m.content ?? '').join('\n\n');
    const block = (header: string) => {
        const start = text.indexOf(header);
        if (start < 0) return undefined;
        const end = text.indexOf('\n\n', start);
        return text.slice(start, end < 0 ? undefined : end).trim();
    };
    return {
        time,
        recall: block(RECALL_HEADER),
        timeBlock: block(TIME_HEADER),
        relationship: block(RELATIONSHIP_HEADER),
        messages: prompt.messages.length,
    };
}

export function runChecks(checks: Checks, step: StepRecord, banned: readonly string[] = []): CheckResult[] {
    const results: CheckResult[] = [];
    const last = step.generations.at(-1);
    const recall = last?.recall ?? '';
    const replies = step.bubbles.map(b => b.text).join('\n');
    const has = (pattern: RegExp) => step.logs.some(l => pattern.test(l));
    for (const word of checks.recall ?? []) results.push({ ok: recall.includes(word), text: `召回里有「${word}」` });
    for (const word of checks.recallNot ?? []) results.push({ ok: !recall.includes(word), text: `召回里没有「${word}」` });
    if (checks.replyAny) {
        const hit = checks.replyAny.filter(w => replies.includes(w));
        results.push({ ok: hit.length > 0, text: `回复里有「${checks.replyAny.join('」「')}」之一${hit.length ? `（${hit.join('、')}）` : ''}` });
    }
    for (const word of checks.replyNone ?? []) results.push({ ok: !replies.includes(word), text: `回复里没有「${word}」` });
    if (checks.timeBlock !== undefined) {
        results.push({ ok: new RegExp(checks.timeBlock).test(last?.timeBlock ?? ''), text: `时间块匹配 /${checks.timeBlock}/` });
    }
    if (checks.generations !== undefined) {
        results.push({ ok: step.generations.length === checks.generations, text: `生成 ${checks.generations} 次（实际 ${step.generations.length} 次）` });
    }
    if (checks.regenerated !== undefined) {
        results.push({ ok: has(/生成期间收到新消息/) === checks.regenerated, text: checks.regenerated ? '生成中来了新消息，丢掉草稿重新生成' : '没有重新生成' });
    }
    const chars = step.bubbles.reduce((n, b) => n + [...b.text].length, 0);
    if (checks.maxChars !== undefined) results.push({ ok: chars <= checks.maxChars, text: `她这一轮最多 ${checks.maxChars} 字（实际 ${chars}）` });
    if (checks.minChars !== undefined) results.push({ ok: chars >= checks.minChars, text: `她这一轮至少 ${checks.minChars} 字（实际 ${chars}）` });
    if (checks.maxBubbles !== undefined) results.push({ ok: step.bubbles.length <= checks.maxBubbles, text: `她这一轮最多 ${checks.maxBubbles} 条（实际 ${step.bubbles.length}）` });
    if (checks.exitClean) {
        const issues = inspectReply(replies, banned);
        const stage = step.bubbles.filter(b => /^[ \t]*[（(][^（）()\n]*[）)]/m.test(b.text)).length;
        const problems = [...(issues.length ? [summarizeIssues(issues)] : []), ...(stage ? [`${stage} 条有行首括号`] : [])];
        results.push({ ok: problems.length === 0, text: `出口检查干净${problems.length ? `（${problems.join('；')}）` : ''}` });
    }
    const first = step.bubbles[0]?.time;
    if (checks.noReply) results.push({ ok: step.bubbles.length === 0, text: `她没回（实际 ${step.bubbles.length} 条）` });
    const delay = first !== undefined && step.inputTime !== undefined ? first - step.inputTime : undefined;
    const minutes = (ms: number | undefined) => (ms === undefined ? '没回' : `${(ms / 60_000).toFixed(1)} 分钟`);
    if (checks.replyAfter !== undefined) {
        results.push({ ok: delay !== undefined && delay >= parseDuration(checks.replyAfter), text: `第一条在对方最后一条之后至少 ${checks.replyAfter}（实际 ${minutes(delay)}）` });
    }
    if (checks.replyWithin !== undefined) {
        results.push({ ok: delay !== undefined && delay <= parseDuration(checks.replyWithin), text: `第一条在对方最后一条之后 ${checks.replyWithin} 之内（实际 ${minutes(delay)}）` });
    }
    if (checks.log !== undefined) results.push({ ok: has(new RegExp(checks.log)), text: `日志里有 /${checks.log}/` });
    if (checks.dropped !== undefined) {
        results.push({ ok: has(/发送中途对方插话/) === checks.dropped, text: checks.dropped ? '发送中途插话，剩下的没发' : '没有丢弃剩下的' });
    }
    return results;
}
