import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { contributeTurn, type Turn, type TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import { describeDays } from '../src/language/time-context.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { intentModule } from '../src/modules/intent.ts';
import { timeNotesModule, type TimeNotesFacts } from '../src/modules/time-notes.ts';
import type { BotConfig } from '../src/platform/config.ts';
import { createContactResponder, loadTierCard } from '../src/platform/contact.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 时间块里跟着时间的另几行（重要的日子 ADR 0011、她在 QQ 上的样子 ADR 0083、答应的事 ADR 0018）迁成模块（ADR 0336）：
// 重要的日子在 contribute 时现算（纯函数）；另两行在联系人流水线原位取、写进 turn.facts，模块只放。
// 行为基线：重要的日子只有 meetup（18 处「[明天是双十一……]」）；另两行基线一处都没有——答应的事由 sim.test.ts（模拟器那一路）管，
// 她在 QQ 上的样子由这里最后一项（联系人流水线那一路）管。全部用合成角色、假模型。

type Facts = TurnFacts & TimeNotesFacts;

const NOTE = '[你在 QQ 上的样子（他点开你的资料卡、空间能看到的；他问起或提到时照这个说，没写的别编）：个性签名现在是「合成签名」]';
const PROMISE = '你之前答应过阿明、还没做的事：给他讲那本书的结局（今天说的，说下次）。合适的时候接着说或者提一句，说过了就不用再提。';
const his = { name: '他的生日', date: '09-29', lunar: '08-08' };
const card = (dates: unknown[] = [his]) => parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红', extensions: { qqbot: { dates } } } });

describe('时间块里的另几行（ADR 0011 / 0083 / 0018 / 0336）', () => {
    const at = new Date('2026-09-27T12:00:00+08:00');
    const turnOf = (facts: Facts = {}, patch: Partial<Turn> = {}): Turn => ({
        contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [{ role: 'user', content: '在吗', time: at.toISOString() }],
        thinking: false, card: card(), facts, ...patch,
    });
    const run = (t: Turn) => timeNotesModule().contribute!(t) as Piece[];

    test('重要的日子：按这一轮的卡和时刻现算，写法同 describeDays；这几天没有就不放', () => {
        const t = turnOf();
        assert.deepEqual(run(t), [{ slot: 'days', text: describeDays(t.card!.dates, at) }]);
        assert.deepEqual(run(t), [{ slot: 'days', text: '[后天是他的生日]' }]);
        assert.deepEqual(run(turnOf({}, { at: new Date('2026-09-10T12:00:00+08:00') })), [], '还远着');
        assert.deepEqual(run(turnOf({}, { card: card([]) })), [], '卡上没写日子');
        assert.deepEqual(run(turnOf({}, { card: undefined })), [], '不经联系人流水线建的轮次可以没有卡');
    });

    test('她在 QQ 上的样子、答应的事：旧逻辑写了才放，原文照放；空串当没有（迁移前按真假判断）', () => {
        const none = { card: card([]) };
        assert.deepEqual(run(turnOf({}, none)), []);
        assert.deepEqual(run(turnOf({ selfNote: '', promisedLine: '' }, none)), []);
        assert.deepEqual(run(turnOf({ selfNote: NOTE }, none)), [{ slot: 'selfNote', text: NOTE }]);
        assert.deepEqual(run(turnOf({ promised: true, promisedLine: PROMISE }, none)), [{ slot: 'promised', text: PROMISE }]);
        assert.deepEqual(run(turnOf({ promised: true }, none)), [], '只有 promised 这个判断、没有那一句：不放（那一句由旧逻辑原位写）');
    });

    test('条件都在取的地方：同学档、危机、只想一想、主动找他也照放（迁移前这三行都不看这些）', () => {
        const facts: Facts = { selfNote: NOTE, promisedLine: PROMISE, crisis: { match: '', level: 'high' } };
        const all = [{ slot: 'days', text: '[后天是他的生日]' }, { slot: 'selfNote', text: NOTE }, { slot: 'promised', text: PROMISE }];
        assert.deepEqual(run(turnOf(facts)), all);
        assert.deepEqual(run(turnOf(facts, { contact: { qq: 2, name: '小周', tier: 'classmate' } })), all);
        assert.deepEqual(run(turnOf(facts, { thinking: true, initiate: { note: '', topic: '', think: true } })), all);
        assert.deepEqual(run(turnOf(facts, { initiate: { note: '[想他了]', topic: '想他' } })), all);
    });

    test('同步返回；「此刻」块里日子、她在 QQ 上的样子、答应的事按槽位表的先后', () => {
        const assembled = contributeTurn([timeNotesModule()], turnOf({ promisedLine: PROMISE, selfNote: NOTE }));
        assert.ok(!(assembled instanceof Promise));
        assert.deepEqual(assembled.afterMain, []);
        assert.deepEqual(assembled.afterHistory, [['[后天是他的生日]', NOTE, PROMISE].join('\n')]);
    });

    test('联系人流水线那一路：她在 QQ 上的样子、答应的事各取一次、提示词里各出现一次（接线前旧逻辑放、接线后模块放；模块没挂或旧逻辑没写 facts 时这里是 0）', async () => {
        const NOW = Date.parse('2026-11-05T12:00:00+08:00');
        const rows: StoredMessage[] = [];
        const prompts: OpenAIMessage[][] = [];
        const calls = { selfNote: [] as number[], describe: 0 };
        const responder = createContactResponder({
            contact: { qq: 1, name: '阿明', tier: 'boyfriend', knowsBot: true },
            // 卡上不写日子：接线前旧逻辑和模块会各放一份重要的日子，这里只看另两行
            card: { character: card([]), worldInfo: [] },
            llm: { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' },
            prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
            history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
            now: () => NOW, log: () => {}, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
            turnModules: [intentModule(), timeNotesModule()],
            selfNote: now => { calls.selfNote.push(now); return NOTE; },
            promises: { describe: () => { calls.describe++; return PROMISE; } },
            send: async () => 101,
            generate: async () => '在呢',
            onPrompt: prompt => { prompts.push(prompt.messages); },
        });
        try { responder.receive('在吗', 1, new Date(NOW)); await responder.whenIdle(); }
        finally { responder.stop(); }
        assert.equal(prompts.length, 1);
        const text = prompts[0]!.map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n');
        const count = (needle: string) => text.split(needle).length - 1;
        assert.equal(count(NOTE), 1);
        assert.equal(count(PROMISE), 1);
        assert.deepEqual(calls, { selfNote: [NOW], describe: 1 });
    });

    // 模拟器那一路：答应的事由 sim.test.ts 管（「你之前答应过阿明……」）；重要的日子这里管（公共节日 notes 并进卡上的日子）。接线后模拟器没挂这个模块，这里是 0、报错
    test('模拟器那一路：双十一前一天，「[明天是双十一……]」放一次', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-time-notes-sim-'));
        const prompts: string[] = [];
        const llm: BotConfig['llm'] = { baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: '', extraBody: {} };
        try {
            await runScenario(parseScenario({
                name: 'time-notes', tier: 'boyfriend', start: '2026-11-10T18:00:00+08:00', memory: false, schedule: false, festivals: 'notes',
                steps: [{ say: '在吗' }, { advance: '10m' }],
            }), {
                runId: 'time-notes', dataDir: dir, card: loadTierCard(syntheticCardPattern, 'boyfriend'), llm,
                prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true }, settle: { quietMs: 10, maxMs: 50 },
                generate: async messages => { prompts.push(messages.map(m => String(m.content)).join('\n')); return '在呢'; },
            });
        } finally { rmSync(dir, { recursive: true, force: true }); }
        assert.ok(prompts.length >= 1);
        assert.equal(prompts[0]!.split('[明天是双十一（网购大促，学生党都在抢）]').length - 1, 1, prompts[0]);
    });
});
