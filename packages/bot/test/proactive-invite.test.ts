import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import {
    blockReason, candidatesOn, INVITE_ACTIVITIES, INVITE_MAX_PER_WEEK, inviteDeclined, occasionNote, OCCASIONS, REACH_DECLINE, withInvite, withReach,
    type Candidate, type ProactiveInput, type ProactiveRecord,
} from '../src/proactive/proactive.ts';
import { createProactivePlanner, type Planner } from '../src/proactive/proactive-planner.ts';
import type { InitiateOutcome, InitiateRequest } from '../src/social/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// ADR 0107：约他一起玩（配置 proactiveInvite）。用转换器生成的真卡（男朋友档）
const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const HOUR = 3_600_000;
let nextId = 1;
const user = (time: number, content = '在吗'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'user', content, messageId: nextId++ });
const her = (time: number, content = '早安'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'assistant', content, messageId: nextId++ });
const record = (id: string, at: number, result: ProactiveRecord['result'] = 'sent'): ProactiveRecord => ({
    id, occasion: id.split(':')[1] as ProactiveRecord['occasion'], plannedAt: new Date(at).toISOString(), at: new Date(at).toISOString(), result,
});
const on = withInvite(boyfriend.proactive!);
const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
    qq: 10001, schedule, settings: on, dates: boyfriend.dates, history: [], records: [], mode: 'on', ...patch,
});
const dayText = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inviteOf = (list: Candidate[]) => list.find(c => c.occasion === 'invite');
/** 从 start 起连续 days 天：每一天有约就当 19:45 发出去了，返回有约的那些天 */
function walk(start: Date, days: number, reply?: (sentAt: number) => StoredMessage[]): { day: Date; candidate: Candidate }[] {
    const records: ProactiveRecord[] = [];
    const history: StoredMessage[] = [];
    const out: { day: Date; candidate: Candidate }[] = [];
    for (let i = 0; i < days; i++) {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const candidate = inviteOf(candidatesOn(day, input({ records, history })));
        if (!candidate) continue;
        out.push({ day, candidate });
        records.push(record(candidate.id, candidate.at));
        history.push(her(candidate.at, '今晚上吗'), ...(reply ? reply(candidate.at) : []));
    }
    return out;
}

describe('约他一起玩：什么时候、约什么', () => {
    test('withInvite 只加 invite 一个时机，不动原来的卡；优先级在睡前之后、随口说件事之前', () => {
        assert.ok(!boyfriend.proactive!.occasions.includes('invite'));
        assert.ok(on.occasions.includes('invite'));
        assert.deepEqual(withInvite(on).occasions, on.occasions, '重复加不叠');
        assert.deepEqual(on.occasions.filter(o => o !== 'invite'), boyfriend.proactive!.occasions);
        assert.ok(OCCASIONS.indexOf('invite') > OCCASIONS.indexOf('bedtime') && OCCASIONS.indexOf('invite') < OCCASIONS.indexOf('share'));
    });

    test('没开就没有；开了每个月有 8–18 天约，晚上 19:30–21:10 之间，约的只是卡上写着的固定节目，两样都会抽到', () => {
        const off = Array.from({ length: 30 }, (_, i) => candidatesOn(new Date(2026, 9, 1 + i), input({ settings: boyfriend.proactive! })));
        assert.equal(off.flat().filter(c => c.occasion === 'invite').length, 0);
        // 不带记录地看：每一天单独的概率
        const days = Array.from({ length: 60 }, (_, i) => new Date(2026, 9, 1 + i)).map(d => ({ d, c: inviteOf(candidatesOn(d, input())) }));
        const hit = days.filter(x => x.c);
        assert.ok(hit.length >= 16 && hit.length <= 36, `60 天里 ${hit.length} 天`);
        for (const { d, c } of hit) {
            const at = c!.at;
            assert.ok(at >= new Date(d.getFullYear(), d.getMonth(), d.getDate(), 19, 30).getTime() && at < new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, 11).getTime(), new Date(at).toTimeString());
            assert.ok(INVITE_ACTIVITIES.some(a => a.id === c!.invite!.id && a.what === c!.invite!.what));
        }
        assert.deepEqual(new Set(hit.map(x => x.c!.invite!.id)), new Set(INVITE_ACTIVITIES.map(a => a.id)));
        // 同一天算两次一样（重启不变）
        assert.deepEqual(inviteOf(candidatesOn(days[3]!.d, input())), inviteOf(candidatesOn(days[3]!.d, input())));
    });

    test('固定节目只有卡上有的：我的世界存档、王者', () => {
        const card = JSON.stringify(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'), 'utf8')));
        assert.ok(card.includes('我的世界') && card.includes('王者'));
        assert.deepEqual(INVITE_ACTIVITIES.map(a => a.id).sort(), ['minecraft', 'wzry']);
    });

    test('周五到周日比工作日约得多', () => {
        const days = Array.from({ length: 140 }, (_, i) => new Date(2026, 9, 1 + i));
        const rate = (pick: (d: Date) => boolean) => {
            const list = days.filter(pick);
            return list.filter(d => inviteOf(candidatesOn(d, input()))).length / list.length;
        };
        assert.ok(rate(d => [0, 5, 6].includes(d.getDay())) > rate(d => ![0, 5, 6].includes(d.getDay())) + 0.1);
    });
});

describe('约他一起玩：不勉强', () => {
    test('两次之间至少隔 2 天，任意 7 天里最多 3 次', () => {
        const list = walk(new Date(2026, 9, 1), 120);
        assert.ok(list.length >= 20, `${list.length}`);
        for (let i = 1; i < list.length; i++) {
            const gap = Math.round((list[i]!.day.getTime() - list[i - 1]!.day.getTime()) / (24 * HOUR));
            assert.ok(gap >= 2, `${dayText(list[i - 1]!.day)} → ${dayText(list[i]!.day)}`);
        }
        for (let i = 0; i < list.length; i++) {
            const inWeek = list.filter(x => x.day.getTime() >= list[i]!.day.getTime() && x.day.getTime() < list[i]!.day.getTime() + 7 * 24 * HOUR).length;
            assert.ok(inWeek <= INVITE_MAX_PER_WEEK, `${dayText(list[i]!.day)} 起 7 天 ${inWeek} 次`);
        }
    });

    test('他回的第一句像拒绝：隔 4 天；他应了或没回：隔 2 天', () => {
        const declined = walk(new Date(2026, 9, 1), 120, at => [user(at + 20 * 60_000, '今天不行，在忙')]);
        const accepted = walk(new Date(2026, 9, 1), 120, at => [user(at + 20 * 60_000, '来')]);
        const minGap = (list: ReturnType<typeof walk>) => Math.min(...list.slice(1).map((x, i) => Math.round((x.day.getTime() - list[i]!.day.getTime()) / (24 * HOUR))));
        assert.ok(minGap(declined) >= 4, `被拒后最短 ${minGap(declined)} 天`);
        assert.equal(minGap(accepted), 2, '应了就按平时');
        assert.ok(declined.length < accepted.length);
    });

    test('只看约完之后他的第一句，隔太久回的不算；招呼、闲聊不算拒绝', () => {
        const sent = record('2026-10-05:invite', t(10, 5, 20, 0));
        assert.equal(inviteDeclined(sent, [user(t(10, 5, 20, 10), '今晚有点累了')]), true);
        assert.equal(inviteDeclined(sent, [user(t(10, 5, 20, 10), '来'), user(t(10, 5, 23, 0), '累了不玩了')]), false, '第一句是应了');
        assert.equal(inviteDeclined(sent, [user(t(10, 6, 9, 0), '昨晚在忙')]), false, '隔了一夜才回，不是回这个约');
        assert.equal(inviteDeclined(sent, []), false);
        assert.equal(inviteDeclined(sent, [user(t(10, 5, 20, 5), '哈哈你猜我刚看到什么')]), false);
    });

    test('到点再查：他说过去忙 / 去睡了、他今晚有事、太晚了，就不约', () => {
        const day = new Date(2026, 9, 9);
        const candidate = (() => { for (let i = 0; i < 20; i++) { const c = inviteOf(candidatesOn(new Date(2026, 9, 9 + i), input())); if (c) return c; } throw new Error('no invite'); })();
        const now = candidate.at;
        assert.equal(blockReason(candidate, now, input()), undefined);
        assert.equal(blockReason(candidate, now, input({ history: [user(now - 2.5 * HOUR, '我先去忙了'), her(now - 2.5 * HOUR + 60_000, '好')] })), '他刚说过去忙 / 去睡了，不约');
        assert.equal(blockReason(candidate, now, input({ history: [user(now - 5 * HOUR, '我先去忙了'), her(now - 5 * HOUR + 60_000, '好')] })), undefined, '好几个钟头前说的不算');
        // 他这几个钟头里说过在忙 / 累了 / 没空，或已经在聊游戏：今晚不约（模拟里他刚说「今天不行，在赶东西」，一个多小时后她又约了一遍）
        for (const [said, why] of [['今天不行，在赶东西', '他刚说过在忙 / 累了 / 没空，不约'], ['好累，不想动', '他刚说过在忙 / 累了 / 没空，不约'], ['我刚在打王者，连输', '他刚说到游戏，聊天里自然会说，不另外约']] as const) {
            assert.equal(blockReason(candidate, now, input({ history: [user(now - 2 * HOUR, said), her(now - 2 * HOUR + 60_000, '哦')] })), why, said);
            assert.equal(blockReason(candidate, now, input({ history: [user(now - 4 * HOUR, said), her(now - 4 * HOUR + 60_000, '哦')] })), undefined, `${said}：4 小时前说的不算`);
        }
        assert.equal(blockReason(candidate, now, input({ history: [her(now - 2 * HOUR, '我在打王者'), user(now - 2 * HOUR + 60_000, '哈哈'), her(now - 2 * HOUR + 120_000, '笑什么')] })), undefined, '她自己说的不算他说的');
        const evening = { id: 'f1', what: '朋友聚餐', date: candidate.day, time: 'evening', episode: 'x' };
        assert.equal(blockReason(candidate, now, input({ followUps: [evening] })), '他今晚有事，不约');
        assert.equal(blockReason(candidate, now, input({ followUps: [{ ...evening, time: '19:00' }] })), '他今晚有事，不约');
        assert.equal(blockReason(candidate, now, input({ followUps: [{ ...evening, time: 'morning' }] })), undefined, '上午的事不影响');
        assert.equal(blockReason({ ...candidate, at: now }, new Date(candidate.at).setHours(22, 5), input()), '太晚了，不约他');
        assert.ok(day);
    });

    test('一小时内聊过也不插进来（和别的主动一样）', () => {
        const candidate = (() => { for (let i = 0; i < 20; i++) { const c = inviteOf(candidatesOn(new Date(2026, 9, 9 + i), input())); if (c) return c; } throw new Error('no invite'); })();
        assert.equal(blockReason(candidate, candidate.at, input({ history: [user(candidate.at - 20 * 60_000, '哈哈'), her(candidate.at - 19 * 60_000, '？')] })), '一小时内聊过');
    });

    test('他没回这个约，她不催（reach 不接）；别的主动没回照样催', () => {
        const withReachOn = withInvite(withReach(boyfriend.proactive!));
        const base = (id: string, hour: number) => ({
            settings: withReachOn,
            history: [user(t(10, 5, 15, 0), '我去忙一下'), her(t(10, 5, 15, 1), '好'), her(t(10, 5, hour, 0), '在吗')],
            records: [record(id, t(10, 5, hour, 0))],
        });
        const reachOf = (state: ReturnType<typeof base>) => candidatesOn(new Date(2026, 9, 5), input(state)).filter(c => c.occasion === 'reach');
        assert.equal(reachOf(base('2026-10-05:invite', 19)).length, 0);
        assert.ok(reachOf(base('2026-10-05:share', 19)).length > 0, '对照：没回的是随口说的那条，照样催');
    });
});

describe('约他一起玩：提示词和计划器', () => {
    const candidate = (what: string): Candidate => ({ id: '2026-10-09:invite', occasion: 'invite', day: '2026-10-09', at: 0, reason: 'x', invite: { id: 'wzry', what } });

    test('只给方向：约的是哪一样，随口，不勉强，很累 / 不舒服 / 心情不好可以只输出「不发」', () => {
        const note = occasionNote(candidate(INVITE_ACTIVITIES[1]!.what), '宝宝');
        assert.ok(note.includes(INVITE_ACTIVITIES[1]!.what) && note.includes('别勉强他') && note.includes('别撒娇逼他'), note);
        assert.ok(note.includes(`只输出「${REACH_DECLINE}」两个字`) && note.includes('你此刻的心境'), note);
        assert.ok(note.endsWith('不抱怨对方没找你、没回你。]'), note);
    });

    test('开头别叫名字：除了重要的日子，每一种主动的说明里都写了（线上主动开口 32%、模拟里 63% 以「宝宝」开头，回话时只有 2%）', () => {
        const base = { day: '2026-10-09', at: 0, reason: 'x' };
        const list: Candidate[] = [
            { ...base, id: '2026-10-09:morning', occasion: 'morning' }, { ...base, id: '2026-10-09:after_class', occasion: 'after_class', classEnd: 0 },
            { ...base, id: '2026-10-09:bedtime', occasion: 'bedtime' }, { ...base, id: '2026-10-09:share', occasion: 'share' }, { ...base, id: '2026-10-09:quiet', occasion: 'quiet' },
            { ...base, id: '2026-10-09:weather', occasion: 'weather' }, candidate(INVITE_ACTIVITIES[0]!.what), { ...base, id: '2026-10-09:reach:1', occasion: 'reach', reach: { count: 1 } },
            { ...base, id: '2026-10-09:inner:th-1', occasion: 'inner', inner: { id: 'th-1', text: '想他了', goes: 'tell' } },
        ];
        for (const c of list) assert.ok(occasionNote(c, '宝宝').includes('开头直接说事，别先叫他的名字或昵称'), c.occasion);
        const date = occasionNote({ ...base, id: '2026-10-09:dates', occasion: 'dates', importantDays: [{ name: '他的生日', date: '10-09' }] }, '宝宝');
        assert.ok(!date.includes('开头直接说事'), '生日祝福叫名字是自然的');
    });

    const dirs: string[] = [];
    const planners: Planner[] = [];
    afterEach(() => {
        for (const p of planners.splice(0)) p.stop();
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    test('计划器：约他这一条带 canDecline，她决定不发就记成没发（不占当天的名额、不算他没回）', async () => {
        const first = (() => { for (let i = 0; i < 30; i++) { const d = new Date(2026, 9, 9 + i); const c = inviteOf(candidatesOn(d, input())); if (c) return { d, c }; } throw new Error('no invite'); })();
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-invite-'));
        dirs.push(dir);
        const clock = new VirtualClock(new Date(first.d.getFullYear(), first.d.getMonth(), first.d.getDate(), 19, 0));
        const requests: InitiateRequest[] = [];
        const history = [{ time: new Date(first.c.at - 10 * HOUR).toISOString(), role: 'user' as const, content: '我写代码去了' }, { time: new Date(first.c.at - 10 * HOUR + 60_000).toISOString(), role: 'assistant' as const, content: '去吧' }];
        const planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule, settings: { occasions: ['invite'], dailyMax: 3, unansweredMax: 2 }, dates: [], mode: 'dryRun',
            history: { load: () => history },
            responder: {
                initiate: async (request: InitiateRequest): Promise<InitiateOutcome> => {
                    requests.push(request);
                    return { result: 'skipped', reason: '她想了想，先不发' };
                },
            },
            dir, log: () => {}, now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: '林梦瑶' },
        });
        planners.push(planner);
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 30));
            const next = clock.nextTimer();
            if (next === undefined || next > first.c.at + 30 * 60_000) break;
            clock.advanceTo(next);
        }
        await new Promise(r => setTimeout(r, 30));
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.canDecline, true);
        assert.ok(requests[0]!.note.includes(first.c.invite!.what));
        const records = (JSON.parse(readFileSync(join(dir, '10001-boyfriend.json'), 'utf8')) as { records: ProactiveRecord[] }).records;
        assert.deepEqual(records.map(r => [r.occasion, r.result]), [['invite', 'skipped']]);
    });
});
