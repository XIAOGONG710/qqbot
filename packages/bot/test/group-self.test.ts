import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { realFiles } from '../src/executor/executor.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import type { AppConfig } from '../src/platform/config.ts';
import { groupLog, groupNote, withinBudget, type GroupEntry } from '../src/social/group-chat.ts';
import { groupRoom, type GroupRoomDeps } from '../src/social/group-room.ts';
import { chimePlan, crossesHerLine, freeToChime, GROUP_OWN, GROUP_OWN_LINES, groupNowLine, smallNews } from '../src/social/group-self.ts';
import { stateAt } from '../src/life/schedule.ts';
import type { WorldNow } from '../src/world/world.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 群里她也有自己（ADR 0341 G1–G3，配置 groupOwn）。她本人 11-20 的条件：分数排名一个字不提；她和他的事群里一句不说；下雨、考完了可以顺嘴说；表情包一天最多一次。
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-group-self-')); dirs.push(dir); return dir; };

const HOUR = 3_600_000;
const entry = (at: number, from: number, content: string, extra: Partial<GroupEntry> = {}): GroupEntry =>
    ({ time: new Date(at).toISOString(), from, name: `群友${from}`, content, messageId: at % 1_000_000, ...extra });
const world = (extra: Partial<WorldNow> = {}): WorldNow => ({ day: '2026-11-20', atSchool: true, parcels: [], homework: [], ...extra }) as WorldNow;

describe('她自己定的线', () => {
    test('分数、排名、她和他的事：越线；考完了、下雨、平常的话：不越', () => {
        for (const line of ['我这次考了 92 分', '排名出来了，第 3 名', '绩点又掉了', '我男朋友昨天来找我', '我们俩周末去看电影']) assert.ok(crossesHerLine(line), line);
        for (const line of ['终于考完了！', '外面下雨了，没带伞', '食堂的麻辣烫确实好吃', '等我十分钟']) assert.equal(crossesHerLine(line), undefined, line);
    });
});

describe('群里能带的「你现在」', () => {
    test('带几点、天气、楼下的猫和她定的规矩；不带作业、相机和钱', () => {
        const at = new Date('2026-11-20T15:30:00');
        const line = groupNowLine({
            at, world: world({
                weather: { rain: true, low: 8, high: 14 } as WorldNow['weather'],
                cat: { name: '合成猫', today: { fed: new Date('2026-11-20T15:00:00'), seen: true }, yesterdayFed: true, foodDays: 9 },
                homework: [{ course: '高数', done: false, due: new Date('2026-11-21T00:00:00') }] as WorldNow['homework'],
                cameraFund: { saved: 2000, goal: 4500 } as WorldNow['cameraFund'],
            }),
        });
        assert.match(line, /15:30/);
        assert.match(line, /下雨/);
        assert.match(line, /合成猫/);
        assert.ok(line.includes(GROUP_OWN_LINES));
        assert.doesNotMatch(line, /作业|高数|相机|元/);
    });

    test('进群的说明里放在心情前面；不给就和原来一字不差', () => {
        const base = { groupName: '宿舍群', boyfriendHere: false, reason: 'mentioned' as const, mood: '[你这会儿开心。]' };
        const plain = groupNote(base);
        const withSelf = groupNote({ ...base, self: '[你现在（群里的人也能知道的那些）：15:30]' });
        assert.equal(withSelf.replace('[你现在（群里的人也能知道的那些）：15:30]', ''), plain);
        assert.ok(withSelf.indexOf('你现在') < withSelf.indexOf('你这会儿开心'));
        assert.match(groupNote({ ...base, reason: 'news', news: '外面下雨了' }), /你这边的事：外面下雨了/);
    });
});

describe('什么时候自己冒一句', () => {
    const now = Date.parse('2026-11-20T16:00:00');
    /** 6 句别人的闲聊，最后一句在 at 之前 lastAgo */
    const lively = (lastAgo: number, at = now) => Array.from({ length: 6 }, (_, i) => entry(at - lastAgo - (5 - i) * 60_000, 30001 + (i % 2), `闲聊 ${i}`));
    type Input = Parameters<typeof chimePlan>[0];
    /** 同样的情形放在 96 个不同的整点各抽一次 */
    const tryHours = (make: (at: number) => Input) => Array.from({ length: 96 }, (_, h) => chimePlan(make(now + h * HOUR)));

    test('冷场：安静 4 小时以上、之前热闹过、她闲着——抽签，有时冒有时不冒', () => {
        const plans = tryHours(at => ({ groupId: 555, entries: lively(5 * HOUR, at), now: at, free: true, done: { quiet: 0, news: 0 } }));
        assert.ok(plans.some(plan => plan?.kind === 'quiet'), '抽得中');
        assert.ok(plans.some(plan => plan === undefined), '也有不冒的');
    });

    test('不冒：她在上课 / 睡觉、刚安静一会儿、死群、之前没人说话、最后一句是她自己、今天冒过了', () => {
        const never = (change: (at: number, input: Input) => Input) =>
            tryHours(at => change(at, { groupId: 555, entries: lively(5 * HOUR, at), now: at, free: true, done: { quiet: 0, news: 0 } })).every(plan => plan === undefined);
        assert.equal(never((_at, input) => input), false, '对照：什么都不改时抽得中');
        assert.ok(never((_at, input) => ({ ...input, free: false })), '上课 / 睡觉');
        assert.ok(never((at, input) => ({ ...input, entries: lively(2 * HOUR, at) })), '刚安静两小时');
        assert.ok(never((at, input) => ({ ...input, entries: lively(30 * HOUR, at) })), '死群');
        assert.ok(never((at, input) => ({ ...input, entries: lively(5 * HOUR, at).slice(-2) })), '之前没几句');
        assert.ok(never((at, input) => ({ ...input, entries: [...lively(5 * HOUR, at), entry(at - 5 * HOUR + 1000, 20000, '有人吗', { mine: true })] })), '最后一句是她');
        assert.ok(never((_at, input) => ({ ...input, done: { quiet: 1, news: 0 } })), '今天冒过了');
        assert.ok(never((at, input) => ({ ...input, entries: lively(5 * HOUR, at).map(item => ({ ...item, history: true as const })) })), '导进来的旧记录不算');
    });

    test('有事：群里刚有人、她那边下雨了——抽签说一句；群里没人在就不说', () => {
        const recent = [entry(now - 10 * 60_000, 30001, '晚上吃啥')];
        const plans = Array.from({ length: 96 }, (_, h) => chimePlan({ groupId: 555, entries: recent.map(item => ({ ...item, time: new Date(now + h * HOUR - 10 * 60_000).toISOString() })), now: now + h * HOUR, free: true, done: { quiet: 0, news: 0 }, news: '外面下雨了' }));
        assert.ok(plans.some(plan => plan?.kind === 'news' && plan.news === '外面下雨了'));
        assert.ok(plans.some(plan => plan === undefined));
        const stale = [entry(now - 2 * HOUR, 30001, '晚上吃啥')];
        assert.ok(Array.from({ length: 96 }, (_, h) => chimePlan({ groupId: 555 + h, entries: stale, now, free: true, done: { quiet: 0, news: 0 }, news: '外面下雨了' })).every(plan => plan?.kind !== 'news'));
        assert.ok(Array.from({ length: 96 }, (_, h) => chimePlan({ groupId: 555 + h, entries: recent, now, free: true, done: { quiet: 0, news: 1 }, news: '外面下雨了' })).every(plan => plan?.kind !== 'news'), '今天说过了');
    });

    test('她那边的事只认同学都看得见的：下雨、刚喂过猫且见着了', () => {
        const at = new Date('2026-11-20T16:00:00');
        assert.equal(smallNews(world({ weather: { rain: true, low: 8, high: 14, real: true, now: { text: '小雨', temp: 9 } } as WorldNow['weather'] }), at), '外面下雨了');
        assert.match(smallNews(world({ cat: { name: '合成猫', today: { fed: new Date('2026-11-20T15:20:00'), seen: true }, yesterdayFed: true, foodDays: 9 } }), at)!, /刚下楼喂了合成猫/);
        assert.equal(smallNews(world({ cat: { name: '合成猫', today: { fed: new Date('2026-11-20T11:00:00'), seen: true }, yesterdayFed: true, foodDays: 9 } }), at), undefined, '喂得太早');
        assert.equal(smallNews(world(), at), undefined);
    });

    test('自己冒的也走额度：刚说过就隔一会儿', () => {
        const now2 = Date.parse('2026-11-20T16:00:00');
        assert.equal(withinBudget([entry(now2 - 30_000, 20000, '嗯', { mine: true })], now2, 'quiet').ok, false);
        assert.equal(withinBudget([], now2, 'news').ok, true);
    });
});

describe('群里那一摊：定时看一眼', () => {
    const card = loadTierCard(syntheticCardPattern, 'classmate-open');
    const schedule = card.character.schedule!;
    /** 合成卡上她闲着的一个下午时刻 */
    const freeAt = (() => {
        for (let h = 0; h < 24 * 14; h++) {
            const at = new Date(Date.parse('2026-11-16T08:00:00') + h * HOUR);
            if (at.getHours() >= 9 && at.getHours() <= 21 && freeToChime(stateAt(schedule, at))) return at;
        }
        throw new Error('合成卡上找不到她闲着的时候');
    })();

    function room(mode: 'off' | 'dryRun' | 'on', options: { groupChat?: 'on' | 'dryRun' | 'read'; reply?: string } = {}) {
        const dataDir = tmp();
        const logs = groupLog(dataDir);
        const prompts: string[] = [];
        const sent: string[] = [];
        const lines: string[] = [];
        let clock = freeAt.getTime();
        const config = {
            dataDir, schedule: true, herDays: false, herFeelings: false, pokeOut: false, profileLikes: false,
            groupChat: options.groupChat ?? 'on', groupOwn: mode, groups: [{ id: 555, name: '合成宿舍群' }], contacts: [],
            llm: { temperature: 1 },
        } as unknown as AppConfig;
        const deps = {
            config, log: (line: string) => lines.push(line), worldNow: () => clock, reading: undefined, dormancy: undefined,
            exec: { files: realFiles, llm: async (request: { messages: { content: string }[] }) => { prompts.push(request.messages.map(m => m.content).join('\n')); return options.reply ?? '有人吗，外面好冷'; } },
            transport: { sendGroupText: async (_g: number, text: string) => { sent.push(text); return 9000 + sent.length; } },
            cardFor: () => card, sendOwnedNotice: async () => {}, sing: async () => ({}), repoRoot: dataDir,
            groupsOn: true, groupLogs: logs, groupPeopleBook: undefined, groupFeel: undefined, groupSongRequests: new Map(), songRequestLifetime: 0,
            stopped: () => false, selfId: () => 20000, lastFeelings: () => undefined, plainTextOf: () => undefined, singBusyLine: () => '',
        } as unknown as GroupRoomDeps;
        // 之前热闹过，安静了 5 小时
        for (let i = 0; i < 6; i++) logs.append(555, entry(clock - 5 * HOUR - (6 - i) * 60_000, 30001 + (i % 2), `闲聊 ${i}`));
        return { room: groupRoom(deps), prompts, sent, lines, dataDir, advance: (ms: number) => { clock += ms; }, now: () => clock };
    }
    /** 一个个整点试，直到抽中冷场那一签（最多两天） */
    async function untilChimed(r: ReturnType<typeof room>, done: () => boolean) {
        for (let h = 0; h < 48 && !done(); h++) { await r.room.tick(); r.advance(HOUR); }
    }

    test('关着（默认）：怎么看都不冒', async () => {
        const r = room('off');
        for (let h = 0; h < 48; h++) { await r.room.tick(); r.advance(HOUR); }
        assert.equal(r.prompts.length, 0);
        assert.equal(r.sent.length, 0);
    });

    test('只看不说（read）的群：不冒', async () => {
        const r = room('on', { groupChat: 'read' });
        for (let h = 0; h < 48; h++) { await r.room.tick(); r.advance(HOUR); }
        assert.equal(r.prompts.length, 0);
    });

    test('dryRun：冷场时她自己冒的那句只写草稿、不发；提示词里有她此刻和她的规矩；一天最多一次', async () => {
        const r = room('dryRun');
        await untilChimed(r, () => r.prompts.length > 0);
        assert.equal(r.prompts.length, 1, r.lines.join('\n'));
        assert.equal(r.sent.length, 0, '没发');
        assert.match(r.prompts[0]!, /群里安静了好一阵了/);
        assert.match(r.prompts[0]!, /你现在（群里的人也能知道的那些）/);
        assert.ok(r.prompts[0]!.includes(GROUP_OWN_LINES));
        const drafts = realFiles.read(join(r.dataDir, 'groups', 'drafts.md'));
        assert.match(drafts, /（quiet）：有人吗，外面好冷/);
        // 同一天再看也不冒第二次：剩下的钟点每 10 分钟看一眼，直到午夜
        const before = r.prompts.length;
        const day = new Date(r.now()).getDate();
        while (new Date(r.now()).getDate() === day) { await r.room.tick(); r.advance(GROUP_OWN.tickMs); }
        assert.equal(r.prompts.length, before);
    });

    test('被 @ 时的平常回话：dryRun 照旧（不带她此刻），on 带上她此刻和她的规矩', async () => {
        for (const mode of ['dryRun', 'on'] as const) {
            const r = room(mode);
            r.room.receive({
                post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 20000, user_id: 30001, group_id: 555, message_id: 7777,
                time: Math.floor(freeAt.getTime() / 1000), message: [{ type: 'at', data: { qq: '20000' } }, { type: 'text', data: { text: ' 你在干嘛' } }], raw_message: '',
                sender: { user_id: 30001, card: '老王', nickname: '老王' },
            } as never);
            const deadline = Date.now() + 5000;
            while (!r.prompts.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(r.prompts.length, 1, mode);
            assert.equal(r.prompts[0]!.includes(GROUP_OWN_LINES), mode === 'on', mode);
            assert.equal(/你现在（群里的人也能知道的那些）/.test(r.prompts[0]!), mode === 'on', mode);
        }
    });

    test('on：冒的那句真发；越过她的线（分数排名）的那条不发', async () => {
        const ok = room('on');
        await untilChimed(ok, () => ok.sent.length > 0);
        assert.deepEqual(ok.sent, ['有人吗，外面好冷']);
        const crossed = room('on', { reply: '这次排名出来了，第 3 名' });
        await untilChimed(crossed, () => crossed.prompts.length > 0);
        assert.equal(crossed.prompts.length, 1);
        assert.equal(crossed.sent.length, 0);
        assert.ok(crossed.lines.some(line => line.includes('越过了她自己定的线')));
    });
});
