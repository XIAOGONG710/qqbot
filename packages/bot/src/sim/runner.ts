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
import { parseDuration, VirtualClock, type Checks, type Scenario, type SayStep } from './scenario.ts';

/** 模拟的联系人用的 QQ 号（虚构） */
export const SIM_QQ = 10001;

/** 模拟器要用到的 Hindsight 接口（HindsightClient 都有） */
export interface SimHindsight extends HindsightApi {
    countOperations(bankId: string, status: string): Promise<number>;
    refreshMentalModel(bankId: string, id: string): Promise<void>;
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
export interface Generation { time: number; recall?: string; timeBlock?: string; relationship?: string; messages: number }
export interface CheckResult { ok: boolean; text: string }

export interface StepRecord {
    kind: 'case' | 'say' | 'advance' | 'memory' | 'refresh' | 'check' | 'forget' | 'hindsight';
    /** 这一步开始时的虚拟时间 */
    time: number;
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

    const receive = (text: string, interrupt = false) => {
        const time = clock.now();
        current.inputs.push({ time, text, ...(interrupt ? { interrupt } : {}) });
        responder.receive(text, nextMessageId++, new Date(time));
    };
    const baseGenerate = options.generate ?? ((messages: OpenAIMessage[], log: Log) => chatCompletion(options.llm, messages, { log }));

    const createResponder = () => createContactResponder({
        contact,
        card: options.card,
        llm: options.llm,
        prompt: options.prompt,
        history,
        memory,
        log,
        now: clock.now,
        settle: options.settle,
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
            const reply = baseGenerate(messages, log);
            if (armed?.during === 'generation') {
                const it = armed;
                armed = undefined;
                receive(it.say, true);
            }
            return reply;
        },
        onPrompt: prompt => {
            current.generations.push(dynamicParts(prompt, clock.now()));
            writeFileSync(join(dataDir, 'prompts', `${++generationCount}.json`), JSON.stringify(prompt, null, 2));
        },
    });
    let responder = createResponder();
    let forgotten = 0;

    /** 等她把这一轮（含插话之后的回复）都发完 */
    async function settle(): Promise<void> {
        for (;;) {
            await responder.whenIdle();
            const before = history.load(contact.qq).length;
            await sleep(300);
            if (injecting === 0 && history.load(contact.qq).length === before) {
                await responder.whenIdle();
                if (history.load(contact.qq).length === before) return;
            }
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
                busy = (await options.hindsight.countOperations(bankId, 'pending')) + (await options.hindsight.countOperations(bankId, 'processing'));
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
                await settle();
                if (armed) {
                    log(`插话没有触发（这一轮她只发了 ${bubblesThisStep} 条）`);
                    armed = undefined;
                }
            } else if ('advance' in step) {
                current.advance = step.advance;
                clock.advance(parseDuration(step.advance));
                await syncMemory();
            } else if ('memory' in step) {
                await syncMemory();
            } else if ('refresh' in step) {
                if (options.hindsight && bankId && !hindsightDown) {
                    await options.hindsight.refreshMentalModel(bankId, RELATIONSHIP_MODEL.id);
                    await syncMemory();
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
                current.checks = lastSay ? runChecks(step.check, lastSay) : [{ ok: false, text: '前面没有 say 步骤' }];
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
        countOperations: (...a) => guard(() => api.countOperations(...a)),
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

export function runChecks(checks: Checks, step: StepRecord): CheckResult[] {
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
    if (checks.dropped !== undefined) {
        results.push({ ok: has(/发送中途对方插话/) === checks.dropped, text: checks.dropped ? '发送中途插话，剩下的没发' : '没有丢弃剩下的' });
    }
    return results;
}
