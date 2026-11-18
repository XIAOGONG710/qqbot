import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import { moodySkip } from '../src/social/reply-timing.ts';
import {
    kindOfSkip, kindOfWaiting, noteFromInfo, recentSilence, recordSilence, silencePath, silenceReplyCue, type SilenceNote,
} from '../src/social/silence.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-silence-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const T0 = Date.parse('2026-10-29T14:00:00+08:00');
const min = (n: number) => n * 60_000;
const msg = (role: 'user' | 'assistant', at: number, content = 'x'): StoredMessage => ({ time: new Date(at).toISOString(), role, content });

describe('没回的原因归类（ADR 0173）：谁的决定 —— 作息 / 她自己 / 故障', () => {
    test('等到几点才看到（reply-timing 给的话）：睡觉、上课、忙、冷场', () => {
        assert.equal(kindOfWaiting('睡着了，被连着来的消息吵醒'), 'asleep');
        assert.equal(kindOfWaiting('说了睡了，在睡觉，起床后看'), 'asleep');
        assert.equal(kindOfWaiting('在上高数课'), 'class');
        assert.equal(kindOfWaiting('在洗澡'), 'busy');
        assert.equal(kindOfWaiting('正聊着'), 'lag');
        assert.equal(kindOfWaiting('冷场，过一会儿才看到'), 'lag');
        assert.equal(kindOfWaiting('冷场，过一会儿才看到；在做别的，12 分钟才看到'), 'lag');
    });

    test('看到了决定不回：已经收尾 / 看心情；认不出的按她的决定算。用 reply-timing 真正产生的那句话防「文案改了这里没跟着改」', () => {
        assert.equal(kindOfSkip('她已经收尾，对方只回了附和，不回'), 'closing');
        // 真的跑一遍 moodySkip：她刚回过，他连着发几个「哈哈」，概率定成 1
        const history = [msg('assistant', T0), msg('user', T0 + 5_000, '哈哈'), msg('user', T0 + 9_000, '嗯嗯')];
        const real = moodySkip(history, 1, 1);
        assert.ok(real, 'moodySkip 应该给出原因');
        assert.equal(kindOfSkip(real!), 'moody');
        assert.equal(kindOfSkip('别的什么原因'), 'declined');
    });

    test('每一类都标明是谁的决定；响应器的回调信息变成记账的一条', () => {
        assert.deepEqual(noteFromInfo({ phase: 'waiting', reason: '在上高数课', seenAt: T0 + min(30) }, T0), { at: T0, kind: 'class', by: 'schedule', reason: '在上高数课', until: T0 + min(30) });
        assert.equal(noteFromInfo({ phase: 'skipped', reason: '看心情没回' }, T0).by, 'her');
        const retry = noteFromInfo({ phase: 'retry', reason: '回复失败：连不上', retryAt: T0 + min(5), failures: 2 }, T0);
        assert.deepEqual([retry.kind, retry.by, retry.until, retry.failures], ['failing', 'system', T0 + min(5), 2]);
        assert.equal(noteFromInfo({ phase: 'gaveUp', reason: 'x', failures: 3 }, T0).until, undefined);
    });
});

describe('在正常回复里解释', () => {
    const history = [msg('assistant', T0, '晚安'), msg('user', T0 + min(1), '嗯嗯')];
    const now = T0 + min(2);
    const busy = noteFromInfo({ phase: 'waiting', reason: '在洗澡' }, T0 + min(1));
    const closing = noteFromInfo({ phase: 'skipped', reason: '收尾后的附和' }, T0 + min(1));
    const privateSkip = noteFromInfo({ phase: 'skipped', reason: '只想自己安静一下，别说这句' }, T0 + min(1));

    test('确实忙了或有明确忘回记录，可以在回复时顺口说；不能从延迟猜忘了', () => {
        assert.match(silenceReplyCue('吃了吗', history, [busy], now) ?? '', /确实在忙/);
        assert.match(silenceReplyCue('吃了吗', history, [{ ...busy, kind: 'forgotten', by: 'her', reason: '明确记得忘了回' }], now) ?? '', /确实忘了回/);
        assert.equal(silenceReplyCue('吃了吗', history, [noteFromInfo({ phase: 'waiting', reason: '冷场' }, now)], now), undefined);
        assert.match(silenceReplyCue('刚才怎么没回？', history, [], now) ?? '', /别编/);
        assert.equal(silenceReplyCue('吃了吗', [...history, msg('assistant', now, '嗯'), msg('user', now + 1, '吃了吗')], [busy], now + 1), undefined);
    });

    test('小事不主动说明；自然问才提示可简短回答，且不传入私密原因', () => {
        assert.equal(silenceReplyCue('吃了吗', history, [closing], now), undefined);
        assert.equal(silenceReplyCue('之前你没回', history, [closing], now), undefined);
        assert.match(silenceReplyCue('你刚刚怎么没回我？', history, [closing], now) ?? '', /愿意就简单说一句/);
        const cue = silenceReplyCue('刚才怎么没回？', history, [privateSkip], now) ?? '';
        assert.match(cue, /不用交代具体原因/);
        assert.doesNotMatch(cue, /安静一下/);
    });
});

describe('记账', () => {
    const note = (over: Partial<SilenceNote> = {}): SilenceNote => ({ at: T0, kind: 'class', by: 'schedule', reason: '在上课', ...over });

    test('追加、最新的在前；一分钟内同一条不重复记；坏行跳过', () => {
        const dir = tmp();
        recordSilence(dir, 7, note());
        recordSilence(dir, 7, note({ at: T0 + 30_000 }));
        assert.equal(recentSilence(dir, 7).length, 1, '一分钟内同类同原因不重复');
        recordSilence(dir, 7, note({ at: T0 + min(5), kind: 'failing', by: 'system', reason: '连不上' }));
        appendFileSync(silencePath(dir, 7), '{坏掉的一行\n');
        const list = recentSilence(dir, 7);
        assert.deepEqual(list.map(n => n.kind), ['failing', 'class']);
        assert.deepEqual(recentSilence(dir, 99), []);
    });

    test('文件长了只留最近的', () => {
        const dir = tmp();
        const pad = '长'.repeat(150);
        // 修剪条件：文件超过 60 KB 并且超过 300 行（只留最近 300 行）
        for (let i = 0; i < 320; i++) recordSilence(dir, 7, note({ at: T0 + i * min(2), reason: `原因${i}${pad}` }));
        const lines = readFileSync(silencePath(dir, 7), 'utf8').split('\n').filter(Boolean);
        assert.ok(lines.length < 320, `修剪过：${lines.length} 行`);
        assert.ok(lines.length >= 20, '不是全删了');
        assert.match(recentSilence(dir, 7, 1)[0]!.reason, /^原因319长/);
    });
});

describe('检查文件落盘的位置', () => {
    test('原因记录保存在指定数据目录下', () => {
        const dir = tmp();
        recordSilence(dir, 5, { at: T0, kind: 'lag', by: 'schedule', reason: '冷场' });
        assert.equal(silencePath(dir, 5), join(dir, 'silence', '5.jsonl'));
    });
});
