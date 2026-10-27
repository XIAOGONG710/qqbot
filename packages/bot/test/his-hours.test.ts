import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import { candidatesOn, HIS_HOURS_DAYS, HIS_HOURS_MIN, hisHourWeights, moveToHisHours, withAsk, withInvite, type ProactiveInput } from '../src/proactive/proactive.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// ADR 0117：按他平时在线的钟头排
const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const DAY = 86_400_000;
const day = new Date(2026, 10, 20);
const msgAt = (daysAgo: number, hour: number, minute = 0): StoredMessage => ({
    time: new Date(day.getFullYear(), day.getMonth(), day.getDate() - daysAgo, hour, minute).toISOString(), role: 'user', content: '嗯', messageId: daysAgo * 100 + hour,
});
/** 他每天只在 hours 这些钟头说话，说 days 天 */
const active = (hours: number[], days = 14): StoredMessage[] => Array.from({ length: days }, (_, d) => hours.flatMap(h => [msgAt(d + 1, h, 5), msgAt(d + 1, h, 25)])).flat();

describe('他在线的钟头', () => {
    test('每个钟头的占比：只算最近 21 天的他的话；相邻钟头借一点做平滑；太少没规律', () => {
        const weights = hisHourWeights(active([20, 21], 15), day)!;
        assert.ok(weights);
        assert.equal(weights.length, 24);
        assert.ok(weights[20]! > 0.3 && weights[21]! > 0.3);
        assert.ok(weights[19]! > 0 && weights[19]! < 0.2, '紧挨着的钟头借到一点');
        assert.equal(weights[15], 0);
        assert.equal(hisHourWeights(active([20], 2), day), undefined, `少于 ${HIS_HOURS_MIN} 条`);
        const old = Array.from({ length: 40 }, (_, i) => msgAt(HIS_HOURS_DAYS + 5 + i % 3, 15));
        assert.equal(hisHourWeights([...active([20], 2), ...old], day), undefined, '21 天之前的不算');
        const hers = active([20], 14).map(m => ({ ...m, role: 'assistant' as const }));
        assert.equal(hisHourWeights(hers, day), undefined, '她的话不算');
    });

    test('挪：占比低的钟头挪到窗口里最近的好钟头，分钟保留；已经是好钟头 / 窗口里没有好钟头不动', () => {
        const weights = hisHourWeights(active([19, 20, 21]), day)!;
        const at = (h: number, m: number) => new Date(2026, 10, 20, h, m).getTime();
        const from = at(14, 0);
        const until = at(21, 30);
        assert.equal(moveToHisHours(at(15, 40), weights, from, until, 's'), at(18, 40), '15:40 → 18:40（紧挨着他常在的 19 点，平滑后算好钟头；分钟保留）');
        assert.equal(moveToHisHours(at(20, 10), weights, from, until, 's'), undefined, '本来就是好钟头');
        const narrow = moveToHisHours(at(15, 40), weights, at(14, 0), at(17, 0), 's');
        assert.equal(narrow, undefined, '窗口 14–17 点里没有好钟头');
    });
});

describe('排进去：随口说件事 / 约他 / 问他意见', () => {
    const input = (history: StoredMessage[], hisHours: boolean): ProactiveInput => ({
        qq: 10001, schedule: boyfriend.schedule!, settings: withAsk(withInvite(boyfriend.proactive!)), dates: [], history, records: [], mode: 'on', ...(hisHours ? { hisHours: true } : {}),
    });
    const occasions = ['share', 'invite', 'ask'];

    test('开了并且他有规律：落在他从不说话的钟头的，挪到他常在的钟头（理由里写明）；早安 / 睡前这些不动；没开 / 没规律不动', () => {
        const history = active([20, 21, 22], 15);
        let moved = 0;
        for (let i = 0; i < 60; i++) {
            const d = new Date(2026, 10, 20 + i);
            const plain = candidatesOn(d, input(history, false));
            const adjusted = candidatesOn(d, input(history, true));
            for (const p of plain) {
                const a = adjusted.find(x => x.id === p.id);
                if (!occasions.includes(p.occasion)) { assert.equal(a?.at, p.at, `${p.occasion} 不动`); continue; }
                if (a && a.at !== p.at) { moved++; assert.ok(a.reason.includes('挪到他平时在线的钟头')); assert.ok([18, 19, 20, 21, 22, 23].includes(new Date(a.at).getHours()), new Date(a.at).toTimeString()); }
            }
        }
        assert.ok(moved > 5, `60 天里挪了 ${moved} 个`);
        const thin = active([20], 2);
        const d = new Date(2026, 10, 25);
        assert.deepEqual(candidatesOn(d, input(thin, true)).map(c => c.at), candidatesOn(d, input(thin, false)).map(c => c.at), '没规律不动');
        void DAY;
    });
});
