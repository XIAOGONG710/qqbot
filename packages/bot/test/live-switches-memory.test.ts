// 线上开着、开关这一层没测过的几个（docs/reports/2026-11-24-switch-audit.md「测试覆盖」）：记忆那一块。
// diaryLookback（问到前几天时给她那天的日记）、memoryFeelings（回忆附当时的感觉，要 herFeelings）、memoryReconcile（Hindsight 对账）。
// 每个开关都在真的 App（行为基线的 harness：合成角色、假模型、假 QQ、假时钟、假 Hindsight）上跑开 / 关两遍：
// 关着什么都不做，开着在该出现的地方出现。函数本身的细节由各自的单元测试管（diary-lookback / felt-then / memory-reconcile）。
// 只用合成角色和合成的种子，不读真实资料；不改快照。

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { AppConfig, Contact } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { momentsPath } from '../src/emotion/moments.ts';
import type { Moment } from '../src/emotion/feelings.ts';
import { writeJsonAtomic } from '../src/memory/json-file.ts';
import { runScenario, type LlmCall, type Scenario } from './baseline/harness.ts';

/** 只开她的日子（作息、她那边的世界）这一点底子，其余按生产默认；不主动 */
const BASE: Partial<AppConfig> = { schedule: true, herDays: true, moody: false, proactive: 'off' };

const boyfriend: Contact = { qq: 10001, name: '阿明', tier: 'boyfriend', persona: '她的男朋友，同校不同专业', knowsBot: true };
const at = (iso: string) => Date.parse(iso);

/** 合成的日记：昨天（12-08）那一段 */
const DIARY_LINE = '水卡丢了，跑了两趟宿管。';
/** 作者写下的事：昨天中午很开心的那一件（心境的来由，回忆附感觉时用得上） */
const JOY_CAUSE = '拍的晚霞被选进了摄影社的展览';

const reply = () => (call: LlmCall) => {
    const last = typeof call.messages.at(-1)?.content === 'string' ? call.messages.at(-1)!.content as string : '';
    const first = typeof call.messages[0]?.content === 'string' ? call.messages[0].content as string : '';
    if (/JSON|json/.test(last) || /JSON|json/.test(first)) return '[]';
    if (first.includes('一个人安静地回想')) return '{}';
    return '嗯嗯\n昨天还好';
};

/**
 * 他晚上问「你昨天干嘛了」：长期记忆开着（问到过去的某一天要靠它认出来，ADR 0032），
 * 灵魂目录里有昨天的日记，数据目录里有作者写下的昨天的一件开心事
 */
function askYesterday(config: Partial<AppConfig>): Scenario {
    return {
        name: 'live-switches-memory',
        about: '开关层：问到昨天',
        start: '2026-12-09T18:30:00+08:00',
        contacts: [boyfriend],
        config: { ...BASE, ...config },
        memory: {},
        seed: dataDir => {
            const moments: Moment[] = [
                { id: 'exhibit', at: new Date(at('2026-12-08T12:50:00+08:00')).toISOString(), kind: 'joy', strength: 3, cause: JOY_CAUSE, halfLifeH: 12 },
            ];
            writeJsonAtomic(momentsPath(dataDir), { moments });
        },
        soul: soulDir => {
            writeFileSync(join(soulDir, 'JOURNAL.md'), `# 日记\n\n## 2026-12-07\n前天的事。\n\n## 2026-12-08\n${DIARY_LINE}\n`);
        },
        reply,
        script: async d => {
            await d.at('2026-12-09T19:00:00+08:00');
            d.say(boyfriend.qq, '你昨天干嘛了');
            await d.at('2026-12-09T19:10:00+08:00');
        },
    };
}

/** 提示词里那天的流水账那一行（他问到那天才有）；日记里最近一段另有「你自己最近的日子」那一行（selfThread），不算 */
const recapLines = (out: string) => out.split('\n').filter(line => line.startsWith('[那天（'));

describe('diaryLookback（ADR 0217）：问到前几天时给她那天的日记', () => {
    test('关着：那天的流水账照有，不带日记', async () => {
        const out = await runScenario(askYesterday({ diaryLookback: false }));
        assert.match(out, /\[那天（12月8日 周二）你那边的流水账/, '流水账本身照有（不是开关管的）');
        assert.ok(!out.includes('那天你自己写的日记'));
        assert.ok(recapLines(out).every(line => !line.includes(DIARY_LINE)));
    });

    test('开着：那天的流水账里带上她那天写的日记（只那一天的，前天的不带）', async () => {
        const out = await runScenario(askYesterday({ diaryLookback: true }));
        assert.ok(recapLines(out).some(line => line.includes(`那天你自己写的日记：「${DIARY_LINE}」`)), recapLines(out).join('\n'));
        assert.ok(!out.includes('前天的事。'));
    });

    test('开着但不是男朋友档：不给（只男朋友档）', async () => {
        const classmate: Contact = { qq: 10002, name: '小周', tier: 'classmate' };
        const base = askYesterday({ diaryLookback: true });
        const out = await runScenario({
            ...base, contacts: [classmate],
            script: async d => {
                await d.at('2026-12-09T19:00:00+08:00');
                d.say(classmate.qq, '你昨天干嘛了');
                await d.at('2026-12-09T19:10:00+08:00');
            },
        });
        assert.ok(recapLines(out).length >= 1, '同学问到昨天也有那天的流水账');
        assert.ok(recapLines(out).every(line => !line.includes(DIARY_LINE)));
        assert.ok(!out.includes('那天你自己写的日记'));
    });
});

describe('memoryFeelings（ADR 0218）× herFeelings：问到那天时附她那天的感觉', () => {
    test('memoryFeelings 关、herFeelings 开：不附', async () => {
        const out = await runScenario(askYesterday({ memoryFeelings: false, herFeelings: true }));
        assert.match(out, /\[那天（12月8日 周二）你那边的流水账/);
        assert.ok(!out.includes('那天你心里：'));
    });

    test('memoryFeelings 开、herFeelings 关：也不附（App 只在两个都开时给，感觉的来由也跟着 herFeelings）', async () => {
        const out = await runScenario(askYesterday({ memoryFeelings: true, herFeelings: false }));
        assert.match(out, /\[那天（12月8日 周二）你那边的流水账/);
        assert.ok(!out.includes('那天你心里：'));
    });

    test('两个都开：流水账后面附「那天你心里：很开心——<作者写下的那件事>」', async () => {
        const out = await runScenario(askYesterday({ memoryFeelings: true, herFeelings: true }));
        assert.ok(out.includes(`那天你心里：很开心——${JOY_CAUSE}`), out.split('\n').filter(line => line.includes('流水账')).join('\n'));
    });
});

/** 以前几天聊过的几段（连上时写进 Hindsight），之后跑过对账要等的宽限期 */
function reconcileRun(memoryReconcile: boolean): Scenario {
    return {
        name: 'live-switches-reconcile',
        about: '开关层：记忆对账',
        start: '2026-12-09T08:00:00+08:00',
        contacts: [boyfriend],
        config: { ...BASE, memoryReconcile },
        memory: {},
        seed: (dataDir, start) => {
            const chats = new ChatHistory(dataDir);
            [3, 2].forEach((daysAgo, i) => {
                const when = start - daysAgo * 86_400_000 + 12 * 3600_000;
                chats.append(boyfriend.qq, { time: new Date(when).toISOString(), role: 'user', content: '今天去图书馆了', messageId: 900 + i * 2 });
                chats.append(boyfriend.qq, { time: new Date(when + 60_000).toISOString(), role: 'assistant', content: '好认真', messageId: 901 + i * 2 });
            });
        },
        reply,
        // 写进去之后过了宽限期（2 小时）还要再到一次定时同步，对账才开始
        script: async d => { await d.at('2026-12-09T11:00:00+08:00'); },
    };
}

/** 快照里发给假 Hindsight 的「读文档清单」请求（对账用的那一个：带分页参数） */
const listRequests = (out: string) => out.split('\n').filter(line => /^@ .* 记忆 GET \/banks\/[^ ]*\/documents\?limit=/.test(line));
/** 写进他私人库的片段：每写一次快照里一行请求、下一行是写的内容，取出 document_id */
const retained = (out: string) => {
    const lines = out.split('\n');
    return lines.flatMap((line, i) => (/^@ .* 记忆 POST \/banks\/baseline-@10001\/memories → /.test(line)
        ? [...(lines[i + 1] ?? '').matchAll(/"document_id":"([^"]+)"/g)].map(match => match[1]!) : []));
};
const repeated = (ids: readonly string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);

describe('memoryReconcile（ADR 0201）：Hindsight 对账、漏写的重排', () => {
    test('关着：不读 bank 的文档清单，写过的片段只写一次', async () => {
        const out = await runScenario(reconcileRun(false));
        assert.deepEqual(listRequests(out), []);
        assert.equal(retained(out).length, 2, '以前的两段各写一次');
        assert.deepEqual(repeated(retained(out)), []);
    });

    test('开着：过了宽限期去读文档清单；Hindsight 里查不到（假服务回空的）就把那两段重新排队、再写一次', async () => {
        const out = await runScenario(reconcileRun(true));
        assert.ok(listRequests(out).length >= 1, '读了文档清单');
        assert.deepEqual(new Set(repeated(retained(out))), new Set(retained(out).slice(0, 2)), `漏写的重写了：${retained(out).join(', ')}`);
    });
});
