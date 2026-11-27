// D 模块两条验收的合成、可重放用例（设计稿 runtime/design/2026-11-27-linmengyao-life-design.md 的 D 行）：
// 1. 修复事件后短时负面心境回落，账里能看出是哪条证据造成的；没有修复事件就不回落、不记账。
// 2. 私聊里形成的原因不进群提示词，群只带可分享的当下线索。
// 固定时钟、合成事实、临时目录；不读真实角色资料，不发任何消息。

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appraisals, feelingsAt, feltForAudience, type Appraisal } from '../src/emotion/feelings.ts';
import { moodStateLine } from '../src/emotion/express.ts';
import { applyRecovery, repairFromHistory, type RepairEvent } from '../src/emotion/recovery.ts';
import { appendRecoveries, readLedger, readRecoveries, recoveryNote } from '../src/emotion/feeling-ledger.ts';

const T0 = Date.parse('2026-11-27T10:00:00Z');
const min = 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// ── 验收 1：道歉 / 解释之后回落，没有证据就不凭空回落 ──

const hurt: Appraisal = {
    id: 'review:private-sad-1', at: T0, kind: 'sad', strength: 3,
    cause: '他一整天没理我', source: 'him', aboutHim: true,
};
const repair: RepairEvent = {
    id: 'm7', at: T0 + 30 * min, kind: 'sad', target: hurt.id,
    cause: '他说刚才在忙，还说对不起', source: 'him',
};

test('修复事件后负面心境在后续几轮回落，账里记着是哪条证据；没有修复事件就不动', () => {
    const later = T0 + 3.5 * 3_600_000;
    // 没有修复事件：衰减速度逐字不变，也没有任何回落记录
    const plain = applyRecovery([hurt], []);
    assert.deepEqual(plain.list, [hurt]);
    assert.deepEqual(plain.recoveries, []);
    assert.deepEqual(feelingsAt(plain.list, later), feelingsAt([hurt], later));
    assert.equal(feelingsAt(plain.list, later)[0]!.level, 'clear');

    // 有修复事件：同一条合成输入重放两次逐字一样（不重复受影响）
    const first = applyRecovery([hurt], [repair]);
    const again = applyRecovery([hurt], [repair]);
    assert.deepEqual(first, again);
    assert.equal(first.recoveries.length, 1);
    assert.equal(first.recoveries[0]!.repaired, hurt.id);
    assert.equal(first.recoveries[0]!.by, 'm7');
    assert.equal(first.list[0]!.repairedAt, repair.at);

    // 修复前照常，修复后按更短的半衰期落回去：从 clear 落到刚能察觉以下
    const atRepair = feelingsAt(first.list, repair.at);
    assert.equal(atRepair[0]!.level, 'strong');
    const after = feelingsAt(first.list, later);
    assert.ok(after.length === 0 || after[0]!.level === 'faint', '修复后已经明显回落');
    assert.equal(feelingsAt(plain.list, later)[0]!.level, 'clear', '没有证据时不会自己回落');

    // 账本只多一类回落行，感觉账本身逐字不变；同一证据不重复记
    const soul = mkdtempSync(join(tmpdir(), 'qqbot-emotion-recovery-')); dirs.push(soul);
    assert.equal(appendRecoveries(soul, first.recoveries), 1);
    assert.equal(appendRecoveries(soul, first.recoveries), 0);
    assert.equal(readLedger(soul).length, 0, '回落行不混进原来的感觉账');
    const rows = readRecoveries(soul);
    assert.equal(rows.length, 1);
    assert.match(recoveryNote(rows[0]!), /难过/);
    assert.match(recoveryNote(rows[0]!), /证据 m7/);
    const none = applyRecovery([hurt], []).recoveries;
    assert.equal(appendRecoveries(soul, none), 0, '没有修复事件时账里不会多一行');
    assert.equal(readRecoveries(soul).length, 1);
});

test('修复事件匹配按目标和种类收窄，别的证据不会凭空把它算成回落', () => {
    assert.equal(applyRecovery([hurt], [{ ...repair, target: 'review:other' }]).recoveries.length, 0);
    assert.equal(applyRecovery([hurt], [{ ...repair, kind: 'joy' }]).recoveries.length, 0);
    assert.equal(applyRecovery([hurt], [{ ...repair, at: T0 - min }]).recoveries.length, 0);
    // 同一刻的修复不算「之后」：否则账里写了回落、分量却没变
    assert.equal(applyRecovery([hurt], [{ ...repair, at: T0 }]).recoveries.length, 0);
    const other: Appraisal = { ...hurt, id: 'other', kind: 'tired' };
    assert.equal(applyRecovery([other], [repair]).recoveries.length, 0);
});

test('从聊天记录认修复事件：道歉 / 解释才算，单纯哄一句或说想念不算', () => {
    const say = (content: string, minute: number, messageId: number) => ({ role: 'user' as const, content, time: new Date(T0 + minute * min).toISOString(), messageId });
    const history = [
        say('想你了', 5, 1),
        say('抱抱，别难过了', 6, 2),
        say('对不起，是我没回你', 7, 3),
        { role: 'assistant' as const, content: '他也没错吧', time: new Date(T0 + 8 * min).toISOString(), messageId: 4 },
    ];
    const events = repairFromHistory(history, T0 + 30 * min);
    assert.deepEqual(events.map(event => event.id), ['m3'], '只有道歉那条算证据，而且她自己的话不算');
    assert.equal(events[0]!.at, T0 + 7 * min);
    assert.equal(repairFromHistory([say('对不起', 40, 9)], T0 + 30 * min).length, 0, '还没发生的话不算证据');
});

// ── 验收 2：私聊原因的受众级别 ──

test('同一个人先私聊引发情绪、再在群里说话，群提示词里没有那段私聊原因', () => {
    const at = T0 + 20 * min;
    // 私聊：他说了想念（引发情绪），另有她记下的、只属于私聊的那一条
    const chat = [
        { time: new Date(T0).toISOString(), role: 'assistant' as const, content: '嗯，我在' },
        { time: new Date(T0 + 10 * min).toISOString(), role: 'user' as const, content: '想你了' },
    ];
    const secret: Appraisal = {
        id: 'him:private-vow', at: T0 + 10 * min, kind: 'joy', strength: 3,
        cause: '他私下说只想跟我一个人讲、想你了', source: 'him', aboutHim: true,
    };
    const felt = feelingsAt(appraisals({ now: at, history: chat, extra: [secret] }), at);
    const joy = felt.find(item => item.kind === 'joy');
    assert.ok(joy, '私聊里确实形成了情绪');
    assert.match(joy.cause, /想你/);
    assert.equal(joy.audience, 'private', '他的态度属于私聊原因');

    // 群提示词里唯一带心境的槽是 moodStateLine（group-room.ts 的 mood）：只带语气 / 状态，不带来由
    const groupPrompt = moodStateLine(feltForAudience(felt, 'group'));
    assert.ok(groupPrompt);
    assert.match(groupPrompt, /心情不错/);
    assert.doesNotMatch(groupPrompt, /想你|喜欢你|私下|他/);

    // 私聊那一路仍保留原因（不是把情绪抹掉，只是按受众分级）
    assert.match(moodStateLine(feltForAudience(felt, 'private')) ?? '', /心情不错/);
    assert.ok(feltForAudience(felt, 'private').some(item => /想你/.test(item.cause)));
});
