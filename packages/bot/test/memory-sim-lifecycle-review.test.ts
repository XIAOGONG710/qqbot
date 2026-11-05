import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { runScenario, type SimHindsight } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { LongTermMemory } from '../src/memory/long-term.ts';
import { realWeather, useRealWeather } from '../src/world/weather.ts';

const start = '2026-11-09T12:00:00+08:00', marker = 'SYNTHETIC_LATE_SIM_READ';
const history = [{ role: 'user', content: '合成过去的话', time: '2026-11-08T12:00:00+08:00' },
    { role: 'assistant', content: '合成过去的回复', time: '2026-11-08T12:01:00+08:00' }];
const tick = () => new Promise<void>(done => setImmediate(done));
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-sim-lifecycle-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const cardPath = join(root, 'synthetic-card.json'); writeFileSync(cardPath, JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, name: '合成甲', tier: 'classmate' }] }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const api: SimHindsight = { putBank: async () => {}, retain: async () => {}, recall: async () => [], getMentalModel: async () => undefined,
        createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '', activeOperations: async () => [], operationStatus: async () => 'completed', deleteBank: async () => {} };
    const scenario = (steps: unknown[], extra: object = {}) => parseScenario({ name: 'SYNTHETIC_SIM_OWNER', tier: 'classmate', start, memory: true, schedule: false, history, steps, ...extra });
    const options = { runId: 'synthetic-owner', dataDir, card: loadTierCard(cardPath, 'classmate'), llm: config.llm, prompt: config.prompt, hindsight: api,
        generate: async () => '合成回应', sleep: async () => {}, hindsightWaitMs: 100, settle: { quietMs: 0, maxMs: 0 }, realNow: () => Date.parse(start) };
    return { root, dataDir, api, scenario, options };
}
function clean(root: string) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-sim-lifecycle-')); rmSync(root, { recursive: true, force: true }); }
function holdBackground(api: SimHindsight) {
    let release!: () => void, heldReads = 0;
    const held = new Promise<never>((_, reject) => { release = () => reject(new Error(marker)); });
    const calls = new Map<string, number>();
    api.getMentalModel = async (bank, id) => {
        const key = `${bank}:${id}`, count = calls.get(key) ?? 0; calls.set(key, count + 1);
        if (count !== 1) return undefined; heldReads++; return held;
    };
    return { release, reads: () => heldReads };
}

for (const restart of [false, true]) test(`模拟宿主${restart ? 'restart后' : '最终返回后'}拒旧background读取写日志/报告`, async () => {
    const f = fixture(), model = holdBackground(f.api); let releasedAfterRestart = false, lateDuringRestart = false, deleted = 0;
    f.api.deleteBank = async () => { deleted++; };
    try {
        const result = await runScenario(f.scenario([{ say: '合成新问候' }, ...(restart ? [{ restart: true }, { say: '合成重启后问候' }] : [])]), {
            ...f.options, generate: async messages => {
                if (restart && messages.some(message => message.role === 'user' && message.content.includes('合成重启后问候'))) {
                    releasedAfterRestart = true; model.release(); await tick(); await tick(); lateDuringRestart = readFileSync(join(f.dataDir, 'sim.log'), 'utf8').includes(marker);
                }
                return '合成回应';
            },
        });
        assert.equal(model.reads(), 1); assert.equal(deleted, 2); const before = readFileSync(join(f.dataDir, 'sim.log'), 'utf8'), returned = JSON.stringify(result);
        model.release(); await tick(); await tick();
        assert.equal(readFileSync(join(f.dataDir, 'sim.log'), 'utf8'), before); assert.equal(JSON.stringify(result), returned);
        assert.equal(releasedAfterRestart, restart); assert.equal(lateDuringRestart, false); assert.ok(!before.includes(marker));
    } finally { model.release(); await tick(); clean(f.root); }
});

test('步骤异常退出也关闭background owner，然后才清bank，晚失败不写已结束日志', async () => {
    const f = fixture(), model = holdBackground(f.api); let deleted = 0; f.api.deleteBank = async () => { deleted++; };
    try {
        await assert.rejects(runScenario(f.scenario([{ say: '合成问候' }, { action: { id: 'synthetic-failure', kind: 'eat', durationMinutes: 5 } }]), f.options), /action 步骤需要开启/);
        assert.equal(model.reads(), 1); assert.equal(deleted, 2);
        const before = readFileSync(join(f.dataDir, 'sim.log'), 'utf8'); model.release(); await tick(); await tick();
        assert.equal(readFileSync(join(f.dataDir, 'sim.log'), 'utf8'), before);
    } finally { model.release(); await tick(); clean(f.root); }
});

test('try前构造失败仍停止已经创建的memory，不能留下可派发的旧实例', async () => {
    const f = fixture(), method = LongTermMemory.prototype.commonBankId, memories = new Set<LongTermMemory>();
    try {
        LongTermMemory.prototype.commonBankId = function () { memories.add(this); return method.call(this); };
        await assert.rejects(runScenario(f.scenario([{ restart: true }], { mood: 'SYNTHETIC_UNKNOWN_MOOD' }), f.options), /不是卡上的心情/);
        assert.ok(memories.size > 0); assert.ok([...memories].every(memory => memory.derivedAvailable() === false));
    } finally { LongTermMemory.prototype.commonBankId = method; for (const memory of memories) await memory.stop(); clean(f.root); }
});

test('try前非法mood异常也恢复已安装的合成天气来源', async () => {
    const f = fixture(), before = realWeather(); useRealWeather(undefined);
    try {
        await assert.rejects(runScenario(f.scenario([{ restart: true }], { mood: 'SYNTHETIC_UNKNOWN_MOOD', realRain: { '2026-11-09': [0, 1] } }), f.options), /不是卡上的心情/);
        assert.equal(realWeather(), undefined);
    } finally { useRealWeather(before); clean(f.root); }
});

test('异常退出取消未合作上下文模型等待，授予旧模型的log晚调用也不改结束文件', async () => {
    const f = fixture(); let entered = false, release!: (value: string) => void, oldLog: ((message: string) => void) | undefined;
    const held = new Promise<string>(done => { release = done; });
    try {
        await assert.rejects(runScenario(f.scenario([{ say: '合成新问候' }]), { ...f.options, contextTurns: { turns: 1, step: 1 },
            generate: async (messages, log) => {
                if (messages[0]?.content.includes('较早的聊天记录')) { entered = true; oldLog = log; return held; }
                return '合成回应';
            },
            sleep: async () => { if (entered) throw new Error('SYNTHETIC_SUMMARY_OWNER_EXIT'); },
        }), /SYNTHETIC_SUMMARY_OWNER_EXIT/);
        assert.equal(entered, true); assert.ok(oldLog);
        const before = readFileSync(join(f.dataDir, 'sim.log'), 'utf8');
        oldLog('SYNTHETIC_LATE_GRANTED_LOG'); release('- 合成事实'); await tick(); await tick();
        assert.equal(readFileSync(join(f.dataDir, 'sim.log'), 'utf8'), before);
    } finally { release?.('- 合成事实'); await tick(); clean(f.root); }
});

test('final等待已经派发retain的真实ACK和本地进度，然后才删bank', async () => {
    const f = fixture(), method = LongTermMemory.prototype.commonBankId;
    let memory: LongTermMemory | undefined, generated = false, injected = false, entered!: () => void, release!: () => void, finished = false;
    const enteredPromise = new Promise<void>(done => { entered = done; }), held = new Promise<void>(done => { release = done; });
    let mutation: Promise<void> | undefined, deletedAfterProgress = true, deletes = 0;
    f.api.retain = async (_bank, item) => { if (item.content.includes('SYNTHETIC_PENDING_ACK')) { entered(); await held; } };
    f.api.deleteBank = async () => {
        deletes++; const state = JSON.parse(readFileSync(join(f.dataDir, 'memory', '10001-classmate.json'), 'utf8'));
        deletedAfterProgress &&= Object.values(state.retained).includes(30);
    };
    const run = runScenario(f.scenario([{ say: '合成问候' }]), { ...f.options,
        generate: async () => { generated = true; return '合成回应'; },
        sleep: async () => {
            if (!generated || injected) return; injected = true; assert.ok(memory);
            mutation = memory.sync({ qq: 10001, tier: 'classmate' }, { user: '阿明', char: '合成角色' }, [
                ...history.map(message => ({ ...message, role: message.role as 'user' | 'assistant' })),
                ...Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: `SYNTHETIC_PENDING_ACK_${i}`, time: new Date(Date.parse('2026-11-08T14:00:00+08:00') + i * 1000).toISOString() })),
            ]);
            await enteredPromise;
        },
    }).then(result => { finished = true; return result; });
    try {
        LongTermMemory.prototype.commonBankId = function () { memory = this; return method.call(this); };
        // The first async runner call yields during initial sync; capture its
        // subsequent owned service calls before the injected write starts.
        await Promise.race([enteredPromise, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('synthetic retain did not start')), 3000); timer.unref(); })]);
        await new Promise(done => setTimeout(done, 25)); assert.equal(finished, false); assert.equal(deletes, 0);
        release(); await run; await mutation; assert.equal(deletedAfterProgress, true); assert.equal(deletes, 2);
    } finally { release(); await run.catch(() => {}); await mutation?.catch(() => {}); LongTermMemory.prototype.commonBankId = method; clean(f.root); }
});
