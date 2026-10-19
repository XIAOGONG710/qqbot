import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    AWAY, BUSY, cleanQzoneText, createPresence, LIKE_CHANCE, LISTENING, ONLINE, onlineStatusFor, pickQzonePhoto, QZONE_CHANCE, QZONE_MAX_CHARS,
    describeSelf, likePlan, qzonePlan, reactionEmoji, SIGNATURES, signatureDueAt, signatureFor, type PresenceOptions, type PresenceTransport,
} from '../src/presence.ts';
import { formatDate, herDay, stateAt } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const schedule = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json')).schedule!;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-presence-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const at = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const dayOf = (t: number) => formatDate(herDay(schedule, new Date(t)));
const MINUTE_MS = 60_000;
const isWeekend = (t: number) => new Date(t).getDay() === 0 || new Date(t).getDay() === 6;

describe('在线状态（ADR 0083）', () => {
    test('睡着或说过睡了：离开；上课：忙碌；在听歌：听歌中；其余在线', () => {
        assert.deepEqual(onlineStatusFor({ kind: 'sleep', until: new Date() }, false), AWAY);
        assert.deepEqual(onlineStatusFor({ kind: 'free', text: '刷手机' }, true), AWAY);
        assert.deepEqual(onlineStatusFor({ kind: 'free', text: '刷手机' }, false), ONLINE);
        assert.deepEqual(onlineStatusFor({ kind: 'free', text: '戴着耳机听歌，写点东西' }, false), LISTENING);
        const lesson = { kind: 'hard' as const, start: new Date(), end: new Date() };
        assert.deepEqual(onlineStatusFor({ kind: 'class', lesson }, false), BUSY);
        assert.equal(LISTENING.ext, 1028);
    });
});

describe('点赞、签名、表情回应、说说的规则（ADR 0083）', () => {
    test('点赞：约 LIKE_CHANCE 的日子点，12:00–21:30，1–5 下，同一天每次一样', () => {
        const plans = Array.from({ length: 400 }, (_, i) => likePlan(10001, `d${i}`));
        const hits = plans.filter(plan => plan);
        assert.ok(Math.abs(hits.length / plans.length - LIKE_CHANCE) < 0.07, String(hits.length / plans.length));
        assert.ok(hits.every(plan => plan!.minutes >= 720 && plan!.minutes <= 1290 && plan!.times >= 1 && plan!.times <= 5));
        assert.deepEqual(likePlan(10001, '2026-11-03'), likePlan(10001, '2026-11-03'));
    });

    test('签名：节日当天是祝福；没列的节日不改；下雨天有雨天的；不和上一条重复；隔 3–5 天', () => {
        assert.equal(signatureFor({ day: '2026-12-24', festival: '平安夜' }), '平安夜快乐');
        assert.notEqual(signatureFor({ day: '2026-04-05', festival: '清明节' }), '清明节快乐', '清明不祝快乐');
        const text = signatureFor({ day: '2026-11-03' });
        assert.ok(SIGNATURES.includes(text));
        assert.notEqual(signatureFor({ day: '2026-11-03', last: text }), text);
        const base = 1_800_000_000_000;
        const gaps = Array.from({ length: 30 }, (_, i) => (signatureDueAt(base + i * 12_345_678) - (base + i * 12_345_678)) / 86_400_000);
        assert.ok(gaps.every(days => days >= 3 && days <= 5), gaps.join(','));
        const rainy = new Set(Array.from({ length: 200 }, (_, i) => signatureFor({ day: `d${i}`, rainy: true })));
        assert.ok([...rainy].some(sig => sig.includes('雨')));
    });

    test('表情回应：笑的点笑哭，亲密的点爱心，其余赞或爱心', () => {
        assert.equal(reactionEmoji('哈哈哈', 5), 182);
        assert.equal(reactionEmoji('晚安宝宝', 5), 66);
        assert.ok([76, 66].includes(reactionEmoji('嗯嗯', 7)));
        assert.equal(reactionEmoji('嗯嗯', 7), reactionEmoji('嗯嗯', 7));
    });

    test('说说：约 QZONE_CHANCE 的日子发；工作日晚上、周末白天到晚上', () => {
        const plans = Array.from({ length: 500 }, (_, i) => ({ weekend: i % 7 >= 5, plan: qzonePlan(`d${i}`, i % 7 >= 5) }));
        const hits = plans.filter(p => p.plan);
        assert.ok(Math.abs(hits.length / plans.length - QZONE_CHANCE) < 0.07, String(hits.length / plans.length));
        assert.ok(hits.filter(p => !p.weekend).every(p => p.plan!.minutes >= 17 * 60 + 30 && p.plan!.minutes <= 22 * 60 + 30));
        assert.ok(hits.filter(p => p.weekend).every(p => p.plan!.minutes >= 11 * 60 && p.plan!.minutes <= 22 * 60 + 30));
    });

    test('说说文字检查：去引号换行；空的、太长、网址、@、长数字、方括号、禁用词、助手腔都不要', () => {
        assert.equal(cleanQzoneText('“今天的云好看”'), '今天的云好看');
        assert.equal(cleanQzoneText('第一行\n第二行'), '第一行 第二行');
        for (const bad of ['', '很长'.repeat(QZONE_MAX_CHARS), '看这个 https://x.com', '@某人 在吗', '我的电话 13812345678', '今天[捂脸]', '作为一个AI我觉得', '很高兴为你发一条']) {
            assert.equal(cleanQzoneText(bad), undefined, bad);
        }
        assert.equal(cleanQzoneText('今天去了济南大学', ['济南大学']), undefined);
    });

    test('配图：文件夹里没用过的图按日期挑一张，用过的不再挑，没有图返回 undefined', () => {
        const dir = tmp();
        assert.equal(pickQzonePhoto(join(dir, 'nope'), [], '2026-11-03'), undefined);
        writeFileSync(join(dir, 'a.jpg'), 'x'); writeFileSync(join(dir, 'b.PNG'), 'x'); writeFileSync(join(dir, 'c.txt'), 'x');
        assert.ok(['a.jpg', 'b.PNG'].includes(pickQzonePhoto(dir, [], '2026-11-03')!));
        assert.equal(pickQzonePhoto(dir, ['a.jpg'], '2026-11-03'), 'b.PNG');
        assert.equal(pickQzonePhoto(dir, ['a.jpg', 'b.PNG'], '2026-11-03'), undefined);
    });
});

describe('每分钟看一眼的循环（ADR 0083）', () => {
    const OFF = { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends' } as const;
    const fake = () => {
        const calls: string[] = [];
        const transport: PresenceTransport = {
            setOnlineStatus: async (status, ext) => { calls.push(`status:${status}/${ext}`); },
            sendLike: async (qq, times) => { calls.push(`like:${qq}x${times}`); },
            setSignature: async text => { calls.push(`sig:${text}`); },
            postQzone: async post => { calls.push(`qzone:${post.content}|${post.images?.length ?? 0}|${post.ugcRight}`); return 'tid1'; },
        };
        return { calls, transport };
    };
    const make = (clock: { t: number }, flags: PresenceOptions['flags'], extra: Partial<PresenceOptions> = {}) => {
        const dir = tmp();
        const logs: string[] = [];
        const { calls, transport } = fake();
        const presence = createPresence({ flags, transport, schedule, likeTargets: [10001], dir, now: () => clock.t, log: m => logs.push(m), ...extra });
        return { presence, calls, logs, dir };
    };
    /** 找一个满足 ok 的日子（11 月里）的某个钟点 */
    const findDay = (hour: number, minute: number, ok: (t: number) => boolean) => {
        for (let day = 2; day < 29; day++) {
            const t = at(11, day, hour, minute);
            if (ok(t)) return t;
        }
        assert.fail('11 月里找不到满足条件的日子');
    };

    test('在线状态：这次启动后第一次就设；变了才改', async () => {
        const clock = { t: at(10, 10, 15) }; // 周六下午，空闲
        const { presence, calls } = make(clock, { ...OFF, onlineStatus: true });
        await presence.tick();
        assert.deepEqual(calls, ['status:10/0']);
        await presence.tick();
        assert.deepEqual(calls, ['status:10/0'], '没变不改');
        clock.t = at(10, 11, 3); // 周日凌晨，睡着
        await presence.tick();
        assert.deepEqual(calls, ['status:10/0', 'status:30/0']);
    });

    test('在线状态：上课「忙碌」，课间不改回在线，下课一小时后才改回；睡下立刻离开', async () => {
        // 找一个有课的日子，逐分钟看出她的课（class）和非课
        let day = 2;
        let minutes: { t: number; kind: string }[] = [];
        for (; day < 29; day++) {
            minutes = Array.from({ length: 24 * 60 }, (_, i) => { const t = at(11, day, 0, i); return { t, kind: stateAt(schedule, new Date(t)).activity.kind }; });
            if (minutes.filter(m => m.kind === 'class').length > 100) break;
        }
        const classMinutes = minutes.filter(m => m.kind === 'class');
        const first = classMinutes[0]!;
        const gap = classMinutes.find((m, i) => i > 0 && m.t - classMinutes[i - 1]!.t > MINUTE_MS)!; // 课间后的下一节课的第一分钟
        const breakStart = classMinutes[classMinutes.indexOf(gap) - 1]!.t + MINUTE_MS;
        const clock = { t: first.t };
        const { presence, calls } = make(clock, { ...OFF, onlineStatus: true });
        await presence.tick();
        assert.deepEqual(calls, ['status:50/0'], '上课：忙碌');
        assert.ok(gap.t - breakStart < 60 * MINUTE_MS, '第一个课间短于一小时');
        for (clock.t = first.t; clock.t < gap.t; clock.t += MINUTE_MS) await presence.tick(); // 每分钟一次，和真的一样
        assert.deepEqual(calls, ['status:50/0'], '课间不改回在线');
        // 当天最后一节课（重新开一个，从最后一节课的最后一分钟起每分钟一次）
        const lastClass = classMinutes.at(-1)!;
        const lateClock = { t: lastClass.t };
        const late = make(lateClock, { ...OFF, onlineStatus: true });
        await late.presence.tick();
        assert.deepEqual(late.calls, ['status:50/0']);
        for (lateClock.t += MINUTE_MS; lateClock.t < lastClass.t + 59 * MINUTE_MS; lateClock.t += MINUTE_MS) await late.presence.tick();
        assert.deepEqual(late.calls, ['status:50/0'], '下课不到一小时还是忙碌');
        for (; lateClock.t <= lastClass.t + 62 * MINUTE_MS; lateClock.t += MINUTE_MS) await late.presence.tick();
        assert.equal(late.calls.length, 2);
        assert.match(late.calls[1]!, /^status:10\//,'一小时后改回在线（或听歌中）');
        lateClock.t = at(11, day + 1, 3); // 凌晨睡着：不等一小时
        await late.presence.tick();
        assert.equal(late.calls.at(-1), 'status:30/0');
    });

    test('点赞：到点才点，一天一次；关着不点', async () => {
        const noon = findDay(8, 0, t => Boolean(likePlan(10001, dayOf(t))));
        const date = new Date(noon);
        const clockAt = (h: number, m: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m).getTime();
        const clock = { t: clockAt(11, 55) };
        const flags = { ...OFF, profileLikes: true };
        const { presence, calls } = make(clock, flags);
        await presence.tick();
        assert.deepEqual(calls, [], '12:00 之前不点');
        clock.t = clockAt(21, 45);
        await presence.tick();
        await presence.tick();
        const likes = (calls as string[]).filter(c => c.startsWith('like:'));
        assert.ok(likes.length <= 1, '一天最多一次：' + calls.join('|'));
        const off = make({ t: clockAt(21, 45) }, OFF);
        await off.presence.tick();
        assert.deepEqual(off.calls, []);
    });

    test('签名：试运行只写草稿不改；开着才改，3 天内不再改；失败只记一次日志', async () => {
        const clock = { t: at(11, 3, 15) };
        const dry = make(clock, { ...OFF, signature: 'dryRun' });
        await dry.presence.tick(); // 第一次只是排下一次
        clock.t += 3 * 3_600_000;
        await dry.presence.tick();
        assert.deepEqual(dry.calls, []);
        assert.match(readFileSync(join(dry.dir, 'drafts.md'), 'utf8'), /个性签名（草稿，没改）/);

        const on = make(clock, { ...OFF, signature: 'on' });
        await on.presence.tick();
        clock.t += 3 * 3_600_000;
        await on.presence.tick();
        assert.equal(on.calls.filter(c => c.startsWith('sig:')).length, 1);
        clock.t += 2 * 86_400_000;
        await on.presence.tick();
        assert.equal(on.calls.filter(c => c.startsWith('sig:')).length, 1, '3 天内不再改');

        const logs: string[] = [];
        const bad = createPresence({
            flags: { ...OFF, signature: 'on' }, transport: { setSignature: async () => { throw new Error('接口不可用'); } },
            schedule, likeTargets: [], dir: tmp(), now: () => clock.t, log: m => logs.push(m),
        });
        await bad.tick();
        clock.t += 3 * 3_600_000;
        await bad.tick();
        clock.t += 7 * 3_600_000;
        await bad.tick();
        assert.equal(logs.filter(l => l.includes('改个性签名失败')).length, 1, logs.join('|'));
    });

    test('说说：试运行写草稿不发、不用掉图；开着发出去（好友可见）带图并用掉；一天一次', async () => {
        const evening = findDay(22, 40, t => Boolean(qzonePlan(dayOf(t), isWeekend(t))));
        const composed: (string | undefined)[] = [];
        const compose: PresenceOptions['composeQzone'] = async ({ photoFile }) => { composed.push(photoFile); return { text: '今天的云好看', withPhoto: Boolean(photoFile) }; };

        const dry = make({ t: evening }, { ...OFF, qzone: 'dryRun' }, { composeQzone: compose });
        mkdirSync(join(dry.dir, 'photos'), { recursive: true });
        writeFileSync(join(dry.dir, 'photos', 'a.jpg'), 'x');
        await dry.presence.tick();
        await dry.presence.tick();
        assert.deepEqual(dry.calls, [], '试运行不发');
        assert.equal(composed.length, 1, '一天一次');
        assert.match(readFileSync(join(dry.dir, 'drafts.md'), 'utf8'), /说说（草稿，没发）[\s\S]*今天的云好看[\s\S]*配图：a\.jpg/);
        const draftState = JSON.parse(readFileSync(join(dry.dir, 'presence.json'), 'utf8')) as { photosUsed: string[] };
        assert.deepEqual(draftState.photosUsed, [], '草稿不用掉图');

        composed.length = 0;
        const on = make({ t: evening }, { ...OFF, qzone: 'on' }, { composeQzone: compose });
        mkdirSync(join(on.dir, 'photos'), { recursive: true });
        writeFileSync(join(on.dir, 'photos', 'a.jpg'), 'x');
        await on.presence.tick();
        assert.deepEqual(on.calls, ['qzone:今天的云好看|1|4']);
        const saved = JSON.parse(readFileSync(join(on.dir, 'presence.json'), 'utf8')) as { photosUsed: string[]; qzone: { tid: string }[] };
        assert.deepEqual(saved.photosUsed, ['a.jpg']);
        assert.equal(saved.qzone[0]!.tid, 'tid1');
        assert.ok(existsSync(join(on.dir, 'presence.json')));
    });

    test('说说：所有人可见的配置发 ugcRight 1；写不出合格的（返回空）就这天不发，记一行', async () => {
        const evening = findDay(22, 40, t => Boolean(qzonePlan(dayOf(t), isWeekend(t))));
        const pub = make({ t: evening }, { ...OFF, qzone: 'on', qzoneVisibility: 'public' }, { composeQzone: async () => ({ text: '随手一条', withPhoto: false }) });
        await pub.presence.tick();
        assert.deepEqual(pub.calls, ['qzone:随手一条|0|1']);
        const none = make({ t: evening }, { ...OFF, qzone: 'on' }, { composeQzone: async () => undefined });
        await none.presence.tick();
        assert.deepEqual(none.calls, []);
        assert.ok(none.logs.some(l => l.includes('没写出合格的')), none.logs.join('|'));
    });
});

describe('她知道自己在 QQ 上的样子（ADR 0083）', () => {
    const now = at(11, 5, 20, 0);
    test('签名（真改了的）和 3 天内真发的说说各一句；草稿、试运行、太久以前的不算；什么都没有返回 undefined', () => {
        assert.equal(describeSelf({ qzone: [] }, now), undefined);
        assert.equal(describeSelf({ signature: { text: '困', draft: true }, qzone: [{ at: now - 3_600_000, text: '草稿', mode: 'dryRun' }] }, now), undefined);
        const line = describeSelf({ signature: { text: '土豆又胖了' }, qzone: [{ at: at(11, 4, 21, 30), text: '今天的云好看', photo: 'a.jpg', tid: 't', mode: 'on' }] }, now)!;
        assert.match(line, /个性签名现在是「土豆又胖了」/);
        assert.match(line, /昨天晚上发了一条说说「今天的云好看」，配了一张图/);
        assert.match(line, /^\[你在 QQ 上的样子（.*没写的别编）：/);
        assert.match(describeSelf({ qzone: [{ at: at(11, 5, 15, 0), text: '随手', mode: 'on' }] }, now)!, /今天下午发了一条说说「随手」/);
        assert.match(describeSelf({ qzone: [{ at: at(11, 3, 15, 0), text: '随手', mode: 'on' }] }, now)!, /2 天前发了一条说说/);
        assert.equal(describeSelf({ qzone: [{ at: at(11, 1, 15, 0), text: '太久以前', mode: 'on' }] }, now), undefined, '超过 3 天不提');
    });
});
