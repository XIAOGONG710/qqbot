// 心境与恢复（硬编码改造第五批）：参数表、道歉 / 解释接没接住的判断。
// 只用合成对话、临时文件和按剧本回答的假模型；不读真实角色资料、不连模型和网络。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    FEELING_PARAM_DEFAULTS, FEELING_PARAM_KEYS, FEELING_PARAM_SPECS, feelingParamsLogLine, loadFeelingParams, resolveFeelingParams,
    SHARED_FEELING_PARAM_KEYS, type FeelingParamKey,
} from '../../../dsh-plugins/dsh-linmengyao-memory/feeling-params.mjs';
import { JUDGMENT_SYSTEM, judgmentConversation, judgmentLine, parseJudgment, type Judgment } from '../../../dsh-plugins/dsh-linmengyao-memory/semantic-judgment.mjs';
import { FEELING_PARAMS, FEELING_PARAMS_RESULT, feelingParamsLine } from '../src/emotion/feeling-params.ts';
import { appraisals, CLEAR, FAINT, feelingsAt, feltForAudience, STRONG, type Appraisal } from '../src/emotion/feelings.ts';
import { privateConversationRecovery, RECOVERY_HALF_LIFE_H, RECOVERY_WINDOW_MS, repairFromHistory } from '../src/emotion/recovery.ts';
import { AFFECT_REPLIES } from '../src/emotion/affect.ts';
import { GRIEVANCE_GAP_MS, GRIEVANCE_ROUNDS, GRIEVANCE_WINDOW_MS, IGNORED_GAP_MS, IGNORED_MAX_MS } from '../src/emotion/grievance.ts';
import { FEELINGS_STALE_MS } from '../src/emotion/feeling-export.ts';
import { judgedBy, repairKey, RepairVerdicts, verdictsFromJudgment } from '../src/emotion/repair-judgment.ts';
import { moodStateLine } from '../src/emotion/express.ts';
import { repairJudgmentModule } from '../src/modules/repair-judgment.ts';
import { semanticJudgmentModule } from '../src/modules/semantic-judgment.ts';
import { buildTurnModules } from '../src/platform/turn-modules.ts';
import type { Turn } from '../src/interpreter/interpreter.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-feeling-params-')); dirs.push(dir); return dir; };
const H = 3_600_000;
const MIN = 60_000;

/** 改造前写死在各处的数（逐个抄下来的，默认值必须和它们一模一样） */
const BEFORE: Record<FeelingParamKey, number> = {
    feelingsStaleMs: 3 * H,
    joyHalfLifeH: 5, reliefHalfLifeH: 3, worryHalfLifeH: 8, sadHalfLifeH: 8, annoyedHalfLifeH: 4, tiredHalfLifeH: 5, halfLivesKept: 4, historyWindowMs: 30 * H, silentAfterMs: 4 * H,
    smallAmplitude: 0.8, mediumAmplitude: 1.5, bigAmplitude: 2.6, faintAt: 0.6, clearAt: 1.2, strongAt: 2.2, kindCap: 3.4, warmAffectReplies: 3,
    recoveryHalfLifeH: 1, recoveryWindowMs: 12 * H,
    grievanceGapMs: 72 * H, grievanceRounds: 2, grievanceWindowMs: 3 * H, burstGapMs: 20 * MIN, ignoredGapMs: 45 * MIN, ignoredMaxMs: 6 * H,
};

describe('心境参数表：默认值就是改造前写死的数', () => {
    test('表里每一项的默认值和原来一样；没有多也没有少；写了范围、谁读、原来在哪', () => {
        assert.deepEqual({ ...FEELING_PARAM_DEFAULTS }, BEFORE);
        assert.deepEqual([...FEELING_PARAM_KEYS].sort(), Object.keys(BEFORE).sort());
        for (const key of FEELING_PARAM_KEYS) {
            const spec = FEELING_PARAM_SPECS[key];
            assert.ok(spec.min <= spec.value && spec.value <= spec.max, `${key} 的默认值在范围里`);
            assert.ok(spec.readers.length > 0 && spec.where && spec.note, `${key} 写了谁读、原来在哪、是什么`);
        }
        assert.deepEqual([...SHARED_FEELING_PARAM_KEYS], ['feelingsStaleMs']);
    });

    test('QQ 各处的常量（没设环境变量时）就是默认值，不记日志', () => {
        assert.equal(process.env.QQBOT_FEELING_PARAMS, undefined, '测试进程不设覆盖文件');
        assert.equal(FEELING_PARAMS_RESULT.issue, undefined);
        assert.equal(FEELING_PARAMS, FEELING_PARAM_DEFAULTS);
        assert.equal(feelingParamsLine(), '');
        assert.deepEqual([FAINT, CLEAR, STRONG, RECOVERY_HALF_LIFE_H, RECOVERY_WINDOW_MS, AFFECT_REPLIES, GRIEVANCE_GAP_MS, GRIEVANCE_ROUNDS, GRIEVANCE_WINDOW_MS, IGNORED_GAP_MS, IGNORED_MAX_MS, FEELINGS_STALE_MS],
            [0.6, 1.2, 2.2, 1, 12 * H, 3, 72 * H, 2, 3 * H, 45 * MIN, 6 * H, 3 * H]);
        // 半衰期和起始分量：一件一般的难过刚发生是 1.5，过一个默认半衰期（8 小时）剩一半
        const sad: Appraisal = { id: 'synthetic:sad', at: 0, kind: 'sad', strength: 2, cause: '合成的难过', source: 'world' };
        assert.equal(feelingsAt([sad], 0)[0]!.weight, 1.5);
        assert.equal(feelingsAt([sad], 8 * H)[0]!.weight, 0.75);
        assert.equal(feelingsAt([{ ...sad, strength: 3 }, { ...sad, id: 'b', strength: 3 }], 0)[0]!.weight, 3.4, '同一种感受的上限');
        assert.deepEqual(feelingsAt([sad], 32 * H + 1), [], '过了 4 个半衰期就散了');
    });

    test('DSH 插件（没设环境变量时）也是默认值', async () => {
        const plugin = await import(pathToFileURL(join(root, 'dsh-plugins/dsh-linmengyao-memory/index.js')).href) as {
            DESKTOP_FEELINGS_STALE_MS: number; FEELING_PARAMS_RESULT: { values: unknown; issue?: string };
        };
        assert.equal(plugin.FEELING_PARAMS_RESULT.values, FEELING_PARAM_DEFAULTS);
        assert.equal(plugin.DESKTOP_FEELINGS_STALE_MS, FEELINGS_STALE_MS);
    });

    test('每一项都真的接上了：QQ 读的在 packages/bot/src 里用到，DSH 读的在插件 index.js 里用到', () => {
        const qqSource = (function walk(dir: string): string {
            return readdirSync(dir, { withFileTypes: true }).map(entry => entry.isDirectory() ? walk(join(dir, entry.name))
                : entry.name.endsWith('.ts') ? readFileSync(join(dir, entry.name), 'utf8') : '').join('\n');
        })(join(here, '..', 'src'));
        const dshSource = readFileSync(join(root, 'dsh-plugins/dsh-linmengyao-memory/index.js'), 'utf8');
        for (const key of FEELING_PARAM_KEYS) {
            const { readers } = FEELING_PARAM_SPECS[key];
            assert.equal(qqSource.includes(`FEELING_PARAMS.${key}`), readers.includes('qq'), `${key}：QQ ${readers.includes('qq') ? '要' : '不该'}读`);
            assert.equal(dshSource.includes(`FEELING_PARAMS.${key}`), readers.includes('dsh'), `${key}：DSH ${readers.includes('dsh') ? '要' : '不该'}读`);
        }
    });
});

describe('心境参数表：覆盖文件严格，有一样不对就整个不用', () => {
    test('只写要改的键；其余默认；日志只写键和数', () => {
        const result = resolveFeelingParams({ sadHalfLifeH: 6, recoveryHalfLifeH: 0.5 });
        assert.equal(result.issue, undefined);
        assert.equal(result.values.sadHalfLifeH, 6);
        assert.equal(result.values.recoveryHalfLifeH, 0.5);
        assert.equal(result.values.joyHalfLifeH, 5);
        assert.ok(Object.isFrozen(result.values));
        assert.equal(feelingParamsLogLine(result), '心境参数：调过 sadHalfLifeH=6，recoveryHalfLifeH=0.5，其余默认');
        assert.equal(resolveFeelingParams({}).issue, undefined);
    });

    test('不认识的键、不是数、该是整数的不是整数、超出范围、先后不对、不是对象：整个不用，退回默认并写原因', () => {
        const cases: Array<[unknown, RegExp]> = [
            [{ sadHalfLifeH: 6, sadHalfLife: 3 }, /不认识的键/],
            [{ sadHalfLifeH: '6' }, /sadHalfLifeH 不是数/],
            [{ sadHalfLifeH: Number.NaN }, /sadHalfLifeH 不是数/],
            [{ grievanceRounds: 1.5 }, /grievanceRounds 不是整数/],
            [{ sadHalfLifeH: 0 }, /sadHalfLifeH 超出范围/],
            [{ feelingsStaleMs: 1000 }, /feelingsStaleMs 超出范围/],
            [{ faintAt: 1.5 }, /三档门槛/],
            [{ strongAt: 3.5 }, /strongAt 大于 kindCap/],
            [{ smallAmplitude: 2 }, /起始分量/],
            [{ ignoredGapMs: 7 * H }, /ignoredGapMs 不小于 ignoredMaxMs/],
            [[1, 2], /不是一个 JSON 对象/],
            [null, /不是一个 JSON 对象/],
            [{ __proto__: { sadHalfLifeH: 9 }, toString: 1 }, /不认识的键/],
        ];
        for (const [input, reason] of cases) {
            const result = resolveFeelingParams(input);
            assert.equal(result.values, FEELING_PARAM_DEFAULTS, JSON.stringify(input));
            assert.match(result.issue ?? '', reason);
            assert.match(feelingParamsLogLine(result), /没用上.*全部用默认值/);
        }
    });

    test('文件：没给 / 读不了 / 不是 JSON；日志不写路径和文件内容', () => {
        assert.equal(loadFeelingParams(undefined).values, FEELING_PARAM_DEFAULTS);
        assert.equal(loadFeelingParams('').values, FEELING_PARAM_DEFAULTS);
        const dir = tmp();
        const missing = loadFeelingParams(join(dir, '合成-不存在.json'));
        assert.equal(missing.issue, '文件读不了');
        const bad = join(dir, 'bad.json');
        writeFileSync(bad, '{"sadHalfLifeH": 合成私密内容');
        const broken = loadFeelingParams(bad);
        assert.equal(broken.issue, '不是合法的 JSON');
        for (const line of [feelingParamsLogLine(missing), feelingParamsLogLine(broken)]) assert.doesNotMatch(line, /qqbot-feeling-params|合成私密内容|bad\.json/);
        const good = join(dir, 'good.json');
        writeFileSync(good, JSON.stringify({ feelingsStaleMs: H }));
        assert.equal(loadFeelingParams(good).values.feelingsStaleMs, H);
    });
});

describe('QQ 和 DSH 读到同一个心境过期时间（同一个环境变量、同一个文件）', () => {
    const probe = (overrides: unknown) => {
        const dir = tmp();
        const file = join(dir, 'feeling-params.json');
        writeFileSync(file, JSON.stringify(overrides));
        const script = join(dir, 'probe.mjs');
        const url = (path: string) => pathToFileURL(join(root, path)).href;
        writeFileSync(script, `
            const qq = await import(${JSON.stringify(url('packages/bot/src/emotion/feeling-params.ts'))});
            const exported = await import(${JSON.stringify(url('packages/bot/src/emotion/feeling-export.ts'))});
            const feelings = await import(${JSON.stringify(url('packages/bot/src/emotion/feelings.ts'))});
            const dsh = await import(${JSON.stringify(url('dsh-plugins/dsh-linmengyao-memory/index.js'))});
            const sad = { id: 'synthetic:sad', at: 0, kind: 'sad', strength: 2, cause: '合成的难过', source: 'world' };
            console.log(JSON.stringify({
                qq: qq.FEELING_PARAMS, dsh: dsh.FEELING_PARAMS_RESULT.values, issue: qq.FEELING_PARAMS_RESULT.issue ?? null, dshIssue: dsh.FEELING_PARAMS_RESULT.issue ?? null,
                stale: exported.FEELINGS_STALE_MS, dshStale: dsh.DESKTOP_FEELINGS_STALE_MS, sadAt6h: feelings.feelingsAt([sad], 6 * 3600000)[0]?.weight ?? 0,
            }));
        `);
        const out = execFileSync(process.execPath, ['--import', pathToFileURL(join(here, 'time-zone-setup.ts')).href, script], {
            env: { ...process.env, QQBOT_FEELING_PARAMS: file, QQBOT_SOUL_DIR: join(dir, 'soul'), QQBOT_OWNER_BANK_FILE: join(dir, 'none.json'), QQBOT_PERSONA_CARD: join(dir, 'none-card.json') },
            encoding: 'utf8',
        });
        return JSON.parse(out.trim().split('\n').at(-1)!) as {
            qq: Record<string, number>; dsh: Record<string, number>; issue: string | null; dshIssue: string | null; stale: number; dshStale: number; sadAt6h: number;
        };
    };

    test('调过：两边读到的整张表一样，桌面插件的过期时间和 QQ 的同一个数；难过按新半衰期散', () => {
        const run = probe({ feelingsStaleMs: H, sadHalfLifeH: 6 });
        assert.equal(run.issue, null);
        assert.equal(run.dshIssue, null);
        assert.deepEqual(run.qq, run.dsh);
        assert.equal(run.stale, H);
        assert.equal(run.dshStale, H);
        assert.equal(run.sadAt6h, 0.75, '半衰期调成 6 小时，6 小时后剩一半');
    });

    test('文件不对：两边一起退回默认', () => {
        const run = probe({ feelingsStaleMs: H, unknownKey: 1 });
        assert.match(run.issue ?? '', /不认识的键/);
        assert.equal(run.dshIssue, run.issue);
        assert.deepEqual(run.qq, { ...FEELING_PARAM_DEFAULTS });
        assert.deepEqual(run.dsh, { ...FEELING_PARAM_DEFAULTS });
        assert.equal(run.stale, 3 * H);
        assert.equal(run.dshStale, 3 * H);
    });
});

// ── 道歉 / 解释接没接住（QQBOT_REPAIR_JUDGMENT） ──

const T0 = Date.parse('2026-11-27T10:00:00Z');
const say = (role: 'user' | 'assistant', content: string, at: number, messageId?: number) => ({ role, content, time: new Date(at).toISOString(), ...(messageId ? { messageId } : {}) });
/** 她难过时发了两条，他隔了一小时才回 */
const waiting = [say('assistant', '合成：今天被导师骂了，心里有点难过。', T0 - MIN), say('assistant', '你有空听我说么？', T0)];
const judgment = (category: Judgment['category'], quote: string, history: readonly { role: string; content: string }[]): Judgment => {
    const conversation = judgmentConversation(history);
    const line = conversation.findLastIndex(item => item.content.includes(quote)) + 1;
    const parsed = parseJudgment(JSON.stringify({ category, evidence: [{ line, quote }], uncertainty: 0.1 }), conversation);
    assert.ok(parsed, `${category} 能解析`);
    return parsed;
};
const sadWeight = (list: readonly Appraisal[], at: number) => feelingsAt(list, at).find(item => item.kind === 'sad')?.weight ?? 0;
/** 按 modules/feelings.ts 的走法算一遍：评估（带判过的）→ 私聊回落 */
const feel = (history: ReturnType<typeof say>[], now: number, verdicts?: ReadonlyMap<string, boolean>) => {
    const judged = judgedBy(verdicts);
    const entries = appraisals({ now, history, trackRepairedReturn: true, ...(judged ? { repairJudged: judged } : {}) });
    return privateConversationRecovery(entries, history, now, judged);
};

describe('道歉 / 解释接没接住：判断约定（和 DSH 共用的那一份）', () => {
    test('多了 repair / brushoff 两类：依据要落在他最后那几行；那一行说明怎么回由她自己定', () => {
        assert.match(JUDGMENT_SYSTEM, /- repair：/);
        assert.match(JUDGMENT_SYSTEM, /- brushoff：/);
        assert.match(JUDGMENT_SYSTEM, /客气的「不好意思」「抱歉打扰」不算 repair 也不算 brushoff/);
        const history = [...waiting, say('user', '对不起嘛', T0 + 60 * MIN)];
        const conversation = judgmentConversation(history);
        assert.equal(parseJudgment(JSON.stringify({ category: 'repair', evidence: [{ line: 1, quote: '被导师骂了' }], uncertainty: 0.1 }), conversation), undefined, '只引了她的话不认');
        const brushoff = judgment('brushoff', '对不起嘛', history);
        assert.match(judgmentLine(brushoff), /他像是嘴上道了歉或给了个理由，但没真说到让你不舒服的那件事上.*气消没消、软不软、怎么回，由你自己定\]$/);
        const repair = judgment('repair', '对不起嘛', history);
        assert.match(judgmentLine(repair), /而且说到了那件事上/);
        assert.doesNotMatch(judgmentLine(judgment('none', '对不起嘛', history)), /由你自己定/);
    });
});

describe('道歉 / 解释接没接住：心境怎么变（合成验收）', () => {
    const back = T0 + 60 * MIN;
    const later = back + 60 * MIN;

    test('关着（没判过）：逐字照旧按正则——回来就道歉，难过还在、从这时加快回落', () => {
        const history = [...waiting, say('user', '对不起嘛', back, 7)];
        const plain = feel(history, back);
        const viaEmpty = feel(history, back, new Map());
        assert.deepEqual(viaEmpty, plain, '没有判过的就和没开一模一样');
        assert.deepEqual(plain.recoveries.map(item => item.by), ['m7']);
        assert.ok(sadWeight(plain.list, back) >= CLEAR, '道歉当刻不清零');
        assert.ok(sadWeight(plain.list, later) < CLEAR, '一小时后落到明显以下');
    });

    test('嘴上道歉没接住：难过不清零，也不加快，照常按半衰期慢慢散；不给「他在认真道歉」那点松口气', () => {
        const history = [...waiting, say('user', '对不起嘛', back, 7)];
        const verdicts = verdictsFromJudgment(history, judgment('brushoff', '对不起嘛', history));
        assert.deepEqual([...verdicts.values()], [false]);
        const result = feel(history, back, verdicts);
        assert.deepEqual(result.recoveries, []);
        assert.ok(sadWeight(result.list, back) >= CLEAR, '当刻还明显');
        assert.ok(sadWeight(result.list, later) >= CLEAR, '一小时后仍明显（没有加快）');
        assert.ok(sadWeight(result.list, later) < sadWeight(result.list, back), '但自然恢复照样在');
        assert.ok(sadWeight(result.list, back + 24 * H) < FAINT, '过一天自然散了');
        assert.equal(result.list.some(item => item.id.startsWith('him:repair:')), false);
        assert.ok(feel(history, back).list.some(item => item.id.startsWith('him:repair:')), '关着时正则会给那点松口气');
    });

    test('没说「对不起」的认真解释接住了：正则不认也算修复、加快回落，但道歉当刻不清零；这条回落不写进感觉账', () => {
        const explain = '刚在地铁上没信号，现在才看到你说被导师骂了，怎么回事？';
        const history = [...waiting, say('user', explain, back, 8)];
        assert.deepEqual(feel(history, back).recoveries, [], '正则不认这句');
        const verdicts = verdictsFromJudgment(history, judgment('repair', '现在才看到你说被导师骂了', history));
        const result = feel(history, back, verdicts);
        assert.deepEqual(result.recoveries.map(item => [item.by, item.judged]), [['m8', true]]);
        assert.ok(sadWeight(result.list, back) >= CLEAR, '当刻不清零');
        assert.ok(sadWeight(result.list, later) < CLEAR, '之后加快回落，一小时后落到明显以下');
        assert.deepEqual(repairFromHistory(history, back, judgedBy(verdicts)).map(item => item.judged), [true]);
        // 关键词也认的那种（「对不起，刚才…」）判成接住：回落行不带 judged，照旧可以记账
        const both = [...waiting, say('user', '对不起，刚才没看手机，你被导师骂了？', back, 9)];
        const caught = feel(both, back, verdictsFromJudgment(both, judgment('repair', '你被导师骂了', both)));
        assert.deepEqual(caught.recoveries.map(item => [item.by, item.judged]), [['m9', undefined]]);
    });

    test('判过的在后几轮按同一个结论：上一轮没接住的「对不起」，下一轮不会被正则重新当成道歉', () => {
        const history = [...waiting, say('user', '对不起嘛', back, 7)];
        const remembered = new RepairVerdicts();
        remembered.remember(verdictsFromJudgment(history, judgment('brushoff', '对不起嘛', history)));
        const next = [...history, say('assistant', '哦。', back + MIN), say('user', '在干嘛呢', back + 30 * MIN, 10)];
        remembered.remember(verdictsFromJudgment(next, judgment('none', '在干嘛呢', next)));
        const result = feel(next, later, remembered.snapshot());
        assert.deepEqual(result.recoveries, []);
        assert.ok(sadWeight(result.list, later) >= CLEAR);
        // 进程里记着的不带原话：只有时刻和内容摘要
        assert.doesNotMatch(repairKey(history.at(-1)!), /对不起/);
        // 重启以后没记着：退回正则
        assert.deepEqual(feel(next, later).recoveries.map(item => item.by), ['m7']);
    });

    test('私聊隔离：判过以后群里也只读得到语气，读不到私聊原因', () => {
        const history = [...waiting, say('user', '对不起嘛', back, 7)];
        const result = feel(history, back, verdictsFromJudgment(history, judgment('brushoff', '对不起嘛', history)));
        const felt = feelingsAt(result.list, back);
        assert.match(felt.find(item => item.kind === 'sad')!.cause, /隔了很久才回/);
        const group = moodStateLine(feltForAudience(felt, 'group')) ?? '';
        assert.match(group, /有点低落/);
        assert.doesNotMatch(group, /隔了很久|导师|对不起/);
        assert.ok(feltForAudience(felt, 'group').every(item => item.cause === '' || item.audience === 'group'));
    });
});

describe('道歉 / 解释接没接住：模块接线', () => {
    const contact = { qq: 10001, name: '阿明', tier: 'boyfriend' as const };
    test('关着时不挂；开着时挂在心境前面，decideAt.feelings 先取回判断、写进 repairVerdicts；deliberate 不再取第二次', async () => {
        const keys = ['QQBOT_SEMANTIC_JUDGMENT', 'QQBOT_REPAIR_JUDGMENT'] as const;
        const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
        const deps = { semanticAsk: async () => '' } as unknown as Parameters<typeof buildTurnModules>[0];
        const ids = () => buildTurnModules({ ...deps, log: () => {}, now: Date.now, history: () => [], contacts: [] as never, worldState: () => undefined, appointmentsAt: (() => []) as never, promises: (() => []) as never, schedule: false, herDays: false, grievance: false, lagTail: false, lifeInPrompt: false, intent: {} as never }).map(module => module.id);
        try {
            process.env.QQBOT_SEMANTIC_JUDGMENT = '1';
            delete process.env.QQBOT_REPAIR_JUDGMENT;
            assert.equal(ids().includes('repair-judgment'), false);
            process.env.QQBOT_REPAIR_JUDGMENT = '1';
            const list = ids();
            assert.equal(list.indexOf('repair-judgment'), list.indexOf('feelings') - 1);
            delete process.env.QQBOT_SEMANTIC_JUDGMENT;
            assert.equal(ids().includes('repair-judgment'), false, '没开语义判断就不挂');
        } finally {
            for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
        }

        const history = [...waiting, say('user', '对不起嘛', T0 + 60 * MIN, 7)];
        let asked = 0;
        const logs: string[] = [];
        const semantic = semanticJudgmentModule({ ask: async () => { asked++; return JSON.stringify({ category: 'brushoff', evidence: [{ line: 3, quote: '对不起嘛' }], uncertainty: 0.1 }); }, log: line => logs.push(line) });
        const repair = repairJudgmentModule({ settle: semantic.settle, log: line => logs.push(line) });
        const turn: Turn = { contact, at: new Date(T0 + 60 * MIN), history, thinking: false, facts: {} };
        semantic.assess!(turn);
        await repair.decideAt!.feelings!(turn, { history: () => [], log: () => {} });
        assert.equal(turn.facts.semanticJudgment?.category, 'brushoff');
        assert.deepEqual([...turn.facts.repairVerdicts!.values()], [false]);
        assert.equal(semantic.decideAt!.deliberate!(turn, { history: () => [], log: () => {} }), undefined, '已经取过');
        assert.equal(asked, 1);
        assert.ok(logs.some(line => /道歉判断：他这几句不算修复，记着 1 条/.test(line)));
        assert.ok(logs.every(line => !/对不起|10001/.test(line)), '日志不记原话和 QQ 号');

        // 判断用不上（读不懂）：不写这一轮的判定，记着的照旧给
        const bad = semanticJudgmentModule({ ask: async () => '他像是在敷衍', log: () => {} });
        const repair2 = repairJudgmentModule({ settle: bad.settle, log: () => {} });
        const next: Turn = { contact, at: new Date(T0 + 61 * MIN), history, thinking: false, facts: {} };
        bad.assess!(next);
        await repair2.decideAt!.feelings!(next, { history: () => [], log: () => {} });
        assert.equal(next.facts.repairVerdicts, undefined, '没判过就没有，心境照旧按正则');
        assert.equal(next.facts.semanticJudgmentFallback, 'unparsable');
    });
});
