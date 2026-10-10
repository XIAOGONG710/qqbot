import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig, parseAppConfig } from '../src/config.ts';
import { MEDIA_TIMEOUTS } from '../src/media.ts';
import { currentTierHistory, TierRecord } from '../src/tier-record.ts';
import { ChatHistory, type StoredMessage } from '../src/history.ts';
import { isPrivateFriendMessage, segmentsToText, type MessageEvent } from '../src/onebot.ts';
import { unlistedName } from '../src/app.ts';
import type { PromptResult } from '../src/prompt.ts';
import { cleanUpReply, splitReply } from '../src/reply.ts';
import { createResponder, DEFAULT_SETTLE, PART_GAP_MS, RETRY_AFTER_MS, type InitiateRequest, type ReplyTiming, type ResponderDeps } from '../src/responder.ts';

const names = { user: '阿明', char: '林梦瑶' };

describe('回复清理（同 ST cleanUpMessage 默认设置）', () => {
    test('去掉行首的“角色名:”和首尾空白', () => {
        assert.equal(cleanUpReply('林梦瑶: 在呢  \n', names), '在呢');
        assert.equal(cleanUpReply('嗯\n林梦瑶: 干嘛', names), '嗯\n干嘛');
    });
    test('以对方名字开头的整条作废，中途出现的截断', () => {
        assert.equal(cleanUpReply('阿明: 我来替你说', names), '');
        assert.equal(cleanUpReply('好呀\n阿明: 那走吧', names), '好呀');
    });
    test('按行拆成几条，空行和行首尾空白去掉', () => {
        assert.deepEqual(splitReply('躺着呢 刷土豆的照片\n\n  怎么了嘛 \r\n这么晚'), ['躺着呢 刷土豆的照片', '怎么了嘛', '这么晚']);
        assert.deepEqual(splitReply('\n \n'), []);
    });
    test('超过 5 行按顺序合并成 5 条，字数最多的那条尽量短；5 行以内不变（ADR 0006）', () => {
        const five = ['一', '二', '三', '四', '五'];
        assert.deepEqual(splitReply(five.join('\n')), five);
        const lines = ['aaaa', 'b', 'c', 'dd', 'e', 'ffff', 'g', 'hh'];
        const bubbles = splitReply(lines.join('\n'));
        assert.equal(bubbles.length, 5);
        assert.deepEqual(bubbles.join('\n').split('\n'), lines);
        assert.equal(Math.max(...bubbles.map(b => b.replaceAll('\n', '').length)), 4);
        assert.deepEqual(splitReply(lines.join('\n'), 3).length, 3);
    });
});

describe('OneBot 消息', () => {
    test('消息段转文本：文字原样，表情包用名字，其他用占位符', () => {
        assert.equal(segmentsToText([
            { type: 'reply', data: { id: '1' } },
            { type: 'text', data: { text: '你看' } },
            { type: 'image', data: { summary: '[动画表情]', url: 'x' } },
            { type: 'image', data: { summary: '' } },
            { type: 'face', data: { id: '9999' } },
            { type: 'record', data: {} },
            { type: 'poke', data: {} },
        ]), '你看[动画表情][图片][表情][语音][poke]');
        assert.equal(segmentsToText('纯文本'), '纯文本');
    });
    test('名单外的人用 QQ 昵称称呼，没有昵称叫「对方」', () => {
        assert.equal(unlistedName(' 小周 '), '小周');
        assert.equal(unlistedName(''), '对方');
        assert.equal(unlistedName(undefined), '对方');
    });

    test('只认直接私聊（sub_type friend），群临时会话和群消息不算', () => {
        const base = { post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 1 };
        assert.equal(isPrivateFriendMessage(base as never), true);
        assert.equal(isPrivateFriendMessage({ ...base, sub_type: 'group' } as never), false);
        assert.equal(isPrivateFriendMessage({ ...base, message_type: 'group' } as never), false);
        assert.equal(isPrivateFriendMessage({ ...base, post_type: 'message_sent' } as never), false);
    });
});

describe('聊天记录', () => {
    test('按联系人分文件追加，读回时跳过写坏的行', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-history-'));
        try {
            const history = new ChatHistory(dir);
            history.append(1, { time: 't1', role: 'user', content: '在吗', messageId: 10 });
            history.append(2, { time: 't2', role: 'user', content: '别人' });
            appendFileSync(join(dir, 'chats', '1.jsonl'), '{"time":"t3","ro');
            assert.deepEqual(history.load(1), [{ time: 't1', role: 'user', content: '在吗', messageId: 10 }]);
            assert.equal(history.load(2).length, 1);
            assert.deepEqual(history.load(3), []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('回复调度', () => {
    function setup(overrides: Partial<ResponderDeps> = {}) {
        const stored: StoredMessage[] = [];
        const sent: string[] = [];
        const prompts: string[][] = [];
        const logs: string[] = [];
        const gaps: number[] = [];
        let release: () => void = () => {};
        const deps: ResponderDeps = {
            userId: 1,
            history: { load: () => [...stored], append: (_id, m) => { stored.push(m); } },
            buildPrompt: chat => {
                prompts.push(chat.map(m => `${m.role}:${m.content}`));
                return { messages: chat.map(m => ({ role: m.role, content: m.content })), activatedWorldInfo: [] } satisfies PromptResult;
            },
            // 第一次生成卡住，直到测试 release，用来模拟生成期间又来消息
            generate: () => new Promise(resolve => { release = () => resolve(` 回复${sent.length + 1} `); }),
            clean: reply => reply.trim(),
            send: async (_id, text) => { sent.push(text); return 100 + sent.length; },
            log: message => logs.push(message),
            sleep: async ms => { gaps.push(ms); },
            ...overrides,
        };
        return { responder: createResponder(deps), stored, sent, prompts, logs, gaps, release: () => release() };
    }

    const tick = () => new Promise(r => setImmediate(r));

    test('生成期间又来消息：丢掉这次生成，带上新消息重新生成，只发一条', async () => {
        const { responder, stored, sent, prompts, release } = setup();
        responder.receive('在吗', 1, new Date());
        await tick();
        responder.receive('人呢', 2, new Date());
        responder.receive('？', 3, new Date());
        release();
        await tick();
        release();
        await responder.whenIdle();

        assert.deepEqual(prompts, [['user:在吗'], ['user:在吗', 'user:人呢', 'user:？']]);
        assert.deepEqual(sent, ['回复1']);
        assert.deepEqual(stored.map(m => `${m.role}:${m.content}`), ['user:在吗', 'user:人呢', 'user:？', 'assistant:回复1']);
        assert.equal(stored[3]!.messageId, 101);
    });

    test('对方一直在发：最多重新生成 2 次，之后照常发出，再回复没看到的那条', async () => {
        const { responder, sent, prompts, release } = setup();
        responder.receive('1', 1, new Date());
        for (let i = 2; i <= 4; i++) {
            await tick();
            responder.receive(String(i), i, new Date());
            release();
        }
        await tick();
        await tick();
        release();
        await responder.whenIdle();
        assert.deepEqual(prompts.map(p => p.at(-1)), ['user:1', 'user:2', 'user:3', 'assistant:回复1']);
        assert.deepEqual(prompts[3], ['user:1', 'user:2', 'user:3', 'user:4', 'assistant:回复1']);
        assert.deepEqual(sent, ['回复1', '回复2']);
    });

    test('发送之后才到的消息会再触发一次回复', async () => {
        const { responder, sent, release } = setup();
        responder.receive('在吗', 1, new Date());
        await tick();
        release();
        await responder.whenIdle();
        responder.receive('人呢', 2, new Date());
        await tick();
        release();
        await responder.whenIdle();
        assert.deepEqual(sent, ['回复1', '回复2']);
    });

    test('模型出错时不发送、不记录回复，下一条消息照常处理', async () => {
        let calls = 0;
        const { responder, stored, sent, logs } = setup({
            generate: async () => {
                calls++;
                if (calls === 1) throw new Error('模型接口返回 500');
                return '好了';
            },
        });
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(sent, []);
        assert.ok(logs.some(l => l.includes('回复失败：模型接口返回 500')));

        responder.receive('？', 2, new Date());
        await responder.whenIdle();
        assert.deepEqual(sent, ['好了']);
        assert.deepEqual(stored.map(m => m.content), ['在吗', '？', '好了']);
    });

    /** 等待由测试放行：记下每次等多久 */
    function manualSleep() {
        const waits: { ms: number; release: () => void }[] = [];
        const sleep = (ms: number) => new Promise<void>(resolve => { waits.push({ ms, release: resolve }); });
        return { waits, sleep };
    }

    test('回复失败：隔 1 分钟、5 分钟各再试一次，都失败就等对方下一条消息；之后 catchUp（主动消息的时机）再回一次', async () => {
        let calls = 0;
        const { waits, sleep } = manualSleep();
        const { responder, sent, logs } = setup({
            retryAfterMs: RETRY_AFTER_MS,
            sleep,
            generate: async () => {
                if (++calls <= 3) throw new Error('模型接口请求失败（UND_ERR_CONNECT_TIMEOUT）');
                return '刚看到';
            },
        });
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        assert.equal(calls, 1);
        for (const [i, wait] of waits.entries()) {
            wait.release();
            await tick();
            await responder.whenIdle();
            assert.equal(calls, i + 2);
        }
        assert.deepEqual(waits.map(w => w.ms), [60_000, 300_000]);
        assert.deepEqual(sent, []);
        assert.deepEqual(
            logs.filter(l => l.startsWith('回复失败')).map(l => l.slice(l.lastIndexOf('，') + 1)),
            ['1 分钟后再试', '5 分钟后再试', '等对方下一条消息再回'],
        );
        assert.equal(responder.status().phase, 'idle');
        responder.catchUp();
        await tick();
        await responder.whenIdle();
        assert.deepEqual(sent, ['刚看到']);
    });

    test('等着再试时对方发了新消息：照常回复、重新计次，之前排定的那次作废', async () => {
        let calls = 0;
        const { waits, sleep } = manualSleep();
        const { responder, sent } = setup({
            retryAfterMs: RETRY_AFTER_MS,
            sleep,
            generate: async () => { if (++calls <= 2) throw new Error('断网'); return '好了'; },
        });
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        responder.receive('人呢', 2, new Date());
        await responder.whenIdle();
        assert.equal(calls, 2);
        assert.deepEqual(waits.map(w => w.ms), [60_000, 60_000]);

        waits[0]!.release();
        await tick();
        await responder.whenIdle();
        assert.equal(calls, 2);

        waits[1]!.release();
        await tick();
        await responder.whenIdle();
        assert.equal(calls, 3);
        assert.deepEqual(sent, ['好了']);
    });

    test('多行回复拆成几条依次发，每条单独记录', async () => {
        const { responder, stored, sent, gaps } = setup({ generate: async () => '土豆是猫啊\n\n你能不能上点心\n我拍好多张呢' });
        responder.receive('土豆是什么', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(sent, ['土豆是猫啊', '你能不能上点心', '我拍好多张呢']);
        assert.deepEqual(gaps, [PART_GAP_MS, PART_GAP_MS]);
        assert.deepEqual(stored.map(m => `${m.role}:${m.content}:${m.messageId}`), [
            'user:土豆是什么:1', 'assistant:土豆是猫啊:101', 'assistant:你能不能上点心:102', 'assistant:我拍好多张呢:103',
        ]);
    });

    test('当前对话动作可以把这一轮压成两条，和作息的一条上限取更小的', async () => {
        const reply = '第一条\n第二条\n第三条\n第四条';
        const first = setup({
            buildPrompt: chat => ({ messages: chat.map(m => ({ role: m.role, content: m.content })), activatedWorldInfo: [], maxBubbles: 2 }),
            generate: async () => reply,
        });
        first.responder.receive('难过', 1, new Date());
        await first.responder.whenIdle();
        assert.equal(first.sent.length, 2);

        const second = setup({
            timing: { whenSeen: (_history, at) => ({ at, reason: '上课', maxBubbles: 1 }), typingMs: () => 0, skip: () => undefined },
            buildPrompt: chat => ({ messages: chat.map(m => ({ role: m.role, content: m.content })), activatedWorldInfo: [], maxBubbles: 2 }),
            generate: async () => reply,
        });
        second.responder.receive('难过', 1, new Date());
        await second.responder.whenIdle();
        assert.equal(second.sent.length, 1);
    });

    test('decorate（ADR 0024 打错字再改口）：拆好条之后改，发出去和记下来的都是改过的', async () => {
        const { responder, stored, sent } = setup({
            generate: async () => '我应该明天去\n你早点睡',
            decorate: parts => [parts[0]!.replace('应该', '因该'), '*应该', ...parts.slice(1)],
        });
        responder.receive('你哪天去', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(sent, ['我因该明天去', '*应该', '你早点睡']);
        assert.deepEqual(stored.filter(m => m.role === 'assistant').map(m => m.content), sent);
    });

    test('拆条发送中途对方插话：剩下的不发，已发的照常记录，接着回复新消息', async () => {
        let replies = 0;
        let onGap: () => void = () => {};
        const { responder, stored, sent, prompts, logs } = setup({
            generate: async () => (++replies === 1 ? '第一条\n第二条\n第三条' : '回你了'),
            sleep: async () => { onGap(); },
        });
        onGap = () => { onGap = () => {}; responder.receive('等下', 2, new Date()); };
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(sent, ['第一条', '回你了']);
        assert.deepEqual(stored.map(m => `${m.role}:${m.content}`), ['user:在吗', 'assistant:第一条', 'user:等下', 'assistant:回你了']);
        assert.deepEqual(prompts[1], ['user:在吗', 'assistant:第一条', 'user:等下']);
        assert.ok(logs.some(l => l.includes('剩下 2 条不发')));
    });

    /** 假时钟：sleep 挂起，由测试决定醒来时的时间 */
    function clock() {
        let t = 0;
        let wake: ((at: number) => void) | undefined;
        const asked: number[] = [];
        return {
            now: () => t,
            sleep: (ms: number) => new Promise<void>(resolve => {
                asked.push(ms);
                wake = at => { t = at; wake = undefined; resolve(); };
            }),
            set: (at: number) => { t = at; },
            /** 让正在等的 sleep 在 at 时刻醒来 */
            wakeAt: async (at: number) => { assert.ok(wake, '没有在等'); wake(at); await tick(); },
            asked,
        };
    }

    test('连发合并：对方停下 4 秒才生成，几条一起回', async () => {
        const c = clock();
        const { responder, prompts, sent } = setup({ now: c.now, sleep: c.sleep, settle: DEFAULT_SETTLE, generate: async () => '下楼干嘛' });
        responder.receive('刚才下楼', 1, new Date());
        await tick();
        c.set(500);
        responder.receive('看到一只猫', 2, new Date());
        c.set(1000);
        responder.receive('好像是土豆', 3, new Date());
        await c.wakeAt(4000); // 离最后一条才 3 秒，再等 1 秒
        assert.deepEqual(prompts, []);
        await c.wakeAt(5000);
        await responder.whenIdle();
        assert.deepEqual(c.asked, [4000, 1000]);
        assert.deepEqual(prompts, [['user:刚才下楼', 'user:看到一只猫', 'user:好像是土豆']]);
        assert.deepEqual(sent, ['下楼干嘛']);
    });

    test('连发合并：对方一直在发，从第一条算起最多等 12 秒', async () => {
        const c = clock();
        const { responder, prompts } = setup({ now: c.now, sleep: c.sleep, settle: DEFAULT_SETTLE, generate: async () => '好' });
        responder.receive('0', 1, new Date());
        await tick();
        for (let i = 1; i <= 11; i++) {
            c.set(i * 1000);
            responder.receive(String(i), i + 1, new Date());
            await c.wakeAt(i * 1000 + 1); // 每次醒来都刚收到新消息，接着等
        }
        c.set(11999);
        await c.wakeAt(12000);
        await responder.whenIdle();
        assert.equal(prompts.length, 1);
        assert.deepEqual(prompts[0], ['user:0', 'user:1', 'user:2', 'user:3', 'user:4', 'user:5', 'user:6', 'user:7', 'user:8', 'user:9', 'user:10', 'user:11']);
    });

    test('补回之后的 catchUp 不等待', async () => {
        const c = clock();
        const { responder, sent, stored } = setup({ now: c.now, sleep: c.sleep, settle: DEFAULT_SETTLE, generate: async () => '刚看到' });
        stored.push({ time: 't', role: 'user', content: '在吗', messageId: 1 });
        responder.catchUp();
        await responder.whenIdle();
        assert.deepEqual(sent, ['刚看到']);
        assert.deepEqual(c.asked, []);
    });

    test('发到一半失败：已发出的照常记录，失败写进日志', async () => {
        let sends = 0;
        const { responder, stored, logs } = setup({
            generate: async () => '一\n二',
            send: async () => { if (++sends === 2) throw new Error('NapCat 未连接'); return 100 + sends; },
        });
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(stored.map(m => `${m.role}:${m.content}`), ['user:在吗', 'assistant:一']);
        assert.ok(logs.some(l => l.includes('回复失败：NapCat 未连接')));
    });

    test('catchUp：不记新消息，按现有记录回复一次；没有没回的消息时什么都不做', async () => {
        const { responder, stored, sent } = setup({ generate: async () => '刚看到' });
        stored.push({ time: 't', role: 'user', content: '在吗', messageId: 1 });
        responder.catchUp();
        await responder.whenIdle();
        assert.deepEqual(sent, ['刚看到']);
        assert.equal(stored.filter(m => m.role === 'user').length, 1);

        responder.catchUp();
        await responder.whenIdle();
        assert.deepEqual(sent, ['刚看到']);
    });

    test('清理后为空：当场再生成一次；还是空就不发，算回复失败（有 retryAfterMs 时过一会儿再试）', async () => {
        let calls = 0;
        const { responder, sent, logs } = setup({ generate: async () => { calls++; return '阿明: 替他说话'; }, clean: r => cleanUpReply(r, names) });
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        assert.equal(calls, 2);
        assert.deepEqual(sent, []);
        assert.ok(logs.includes('模型回复清理后为空，重新生成一次'));
        assert.ok(logs.includes('回复失败：模型回复清理后为空'));
    });

    test('模型返回空串，再生成一次有正文就照常发', async () => {
        let calls = 0;
        const { responder, sent } = setup({ generate: async () => (++calls === 1 ? '' : '在呢') });
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        assert.equal(calls, 2);
        assert.deepEqual(sent, ['在呢']);
    });

    // ---------- 回复时机（ADR 0007） ----------

    /** 等到点：由测试放行，或者被中止（来了新消息） */
    function manualWait() {
        const waits: { at: number; release: () => void }[] = [];
        const waitUntil = (at: number, signal: AbortSignal) => new Promise<void>(resolve => {
            waits.push({ at, release: resolve });
            signal.addEventListener('abort', () => resolve());
        });
        return { waits, waitUntil };
    }
    const timingWith = (overrides: Partial<ReplyTiming>): ReplyTiming => ({
        whenSeen: (history, at) => (history.at(-1)?.role === 'user' ? { at, reason: '正聊着' } : undefined),
        typingMs: () => 0,
        skip: () => undefined,
        ...overrides,
    });

    test('到点才看到：等的时候来了新消息就重算（同一个时刻不重复写日志），看到之后一起生成一次', async () => {
        let t = 1_000_000;
        const seeAt = t + 60_000;
        const { waits, waitUntil } = manualWait();
        const { responder, sent, prompts, logs } = setup({
            now: () => t,
            waitUntil,
            timing: timingWith({ whenSeen: history => (history.at(-1)?.role === 'user' ? { at: seeAt, reason: '冷场，过一会儿才看到' } : undefined) }),
            generate: async () => '好',
        });
        responder.receive('在吗', 1, new Date(t));
        await responder.whenQuiet();
        assert.deepEqual(prompts, []);
        assert.equal(waits.length, 1);
        assert.equal(waits[0]!.at, seeAt);

        responder.receive('人呢', 2, new Date(t));
        await tick();
        assert.equal(waits.length, 2, '新消息中止了等待，重算后接着等');
        assert.equal(logs.filter(l => l.includes('看到')).length, 1);

        t = seeAt;
        waits[1]!.release();
        await responder.whenIdle();
        assert.deepEqual(prompts, [['user:在吗', 'user:人呢']]);
        assert.deepEqual(sent, ['好']);
    });

    test('状态（控制台用，ADR 0010）：等着看到时是 waiting 和几点、为什么；回完回到 idle；失败后是 retry 和几点再试', async () => {
        let t = 1_000_000;
        const seeAt = t + 60_000;
        const { waits, waitUntil } = manualWait();
        const { responder } = setup({
            now: () => t,
            waitUntil,
            timing: timingWith({ whenSeen: history => (history.at(-1)?.role === 'user' ? { at: seeAt, reason: '在上课' } : undefined) }),
            generate: async () => '好',
        });
        assert.deepEqual(responder.status(), { phase: 'idle', failures: 0 });
        responder.receive('在吗', 1, new Date(t));
        await responder.whenQuiet();
        assert.deepEqual(responder.status(), { phase: 'waiting', seenAt: seeAt, reason: '在上课', failures: 0 });
        t = seeAt;
        waits[0]!.release();
        await responder.whenIdle();
        assert.deepEqual(responder.status(), { phase: 'idle', failures: 0 });

        const { waits: retries, sleep } = manualSleep();
        const failing = setup({ now: () => t, retryAfterMs: RETRY_AFTER_MS, sleep, generate: async () => { throw new Error('断网'); } });
        failing.responder.receive('在吗', 1, new Date(t));
        await failing.responder.whenIdle();
        assert.deepEqual(failing.responder.status(), { phase: 'retry', retryAt: t + 60_000, reason: '回复失败：断网', failures: 1 });
        failing.responder.stop();
        assert.equal(failing.responder.status().phase, 'idle');
        assert.equal(retries.length, 1);
    });

    test('她已经收尾、对方只回了附和：不生成；之后说了别的照常回，带上那句附和', async () => {
        const { responder, sent, prompts, logs } = setup({
            timing: timingWith({ skip: history => (history.at(-1)?.content === '嗯' ? '她已经收尾，对方只回了附和，不回' : undefined) }),
            generate: async () => '七点',
        });
        responder.receive('嗯', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(prompts, []);
        assert.ok(logs.includes('她已经收尾，对方只回了附和，不回'));

        responder.receive('你明天几点起', 2, new Date());
        await responder.whenIdle();
        assert.deepEqual(prompts, [['user:嗯', 'user:你明天几点起']]);
        assert.deepEqual(sent, ['七点']);
    });

    test('没回的那串（看心情，ADR 0013）留在状态里；之后要回了就清掉', async () => {
        const t = 1_000_000;
        const { responder, sent, prompts } = setup({
            now: () => t,
            timing: timingWith({ skip: history => (history.at(-1)?.content === '哈哈' ? '看心情没回' : undefined) }),
            generate: async () => '笑什么',
        });
        responder.receive('哈哈', 1, new Date(t));
        await responder.whenIdle();
        assert.deepEqual(prompts, []);
        assert.deepEqual(responder.status(), { phase: 'idle', failures: 0, skipped: { at: t, reason: '看心情没回' } });
        responder.receive('人呢', 2, new Date(t));
        await responder.whenIdle();
        assert.deepEqual(prompts, [['user:哈哈', 'user:人呢']]);
        assert.deepEqual(sent, ['笑什么']);
        assert.deepEqual(responder.status(), { phase: 'idle', failures: 0 });
    });

    test('被吵醒：生成时告诉提示词，最多回 1 条（多行合成一条）', async () => {
        const contexts: { woken?: boolean }[] = [];
        const { responder, sent, logs } = setup({
            timing: timingWith({ whenSeen: (_h, at) => ({ at, reason: '睡着了，被连着来的消息吵醒', woken: true, maxBubbles: 1 }) }),
            buildPrompt: (chat, context) => {
                contexts.push(context);
                return { messages: chat.map(m => ({ role: m.role, content: m.content })), activatedWorldInfo: [] };
            },
            generate: async () => '干嘛呀\n睡了',
        });
        responder.receive('醒醒', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(contexts, [{ woken: true }]);
        assert.deepEqual(sent, ['干嘛呀\n睡了']);
        assert.ok(logs.includes('睡着了，被连着来的消息吵醒'));
    });

    test('打字：第一条在「看到 + 打字时间」发出，生成花掉的时间算在里面；之后每条隔这一条的打字时间', async () => {
        let t = 0;
        const { responder, sent, gaps } = setup({
            now: () => t,
            sleep: async ms => { gaps.push(ms); t += ms; },
            timing: timingWith({ typingMs: text => text.length * 1000 }),
            generate: async () => { t += 1500; return 'abc\nde'; },
        });
        responder.receive('在吗', 1, new Date(0));
        await responder.whenIdle();
        assert.deepEqual(sent, ['abc', 'de']);
        assert.deepEqual(gaps, [1500, 2000]);
    });

    // ---------- 停下（Koishi 插件停用、改配置重启，ADR 0008） ----------

    test('stop：正等着到点看到时停下，不再生成；之后收到的不记、不回', async () => {
        const { waits, waitUntil } = manualWait();
        const { responder, stored, prompts, sent } = setup({
            waitUntil,
            timing: timingWith({ whenSeen: (history, at) => (history.at(-1)?.role === 'user' ? { at: at + 60_000, reason: '冷场' } : undefined) }),
            generate: async () => '好',
        });
        responder.receive('在吗', 1, new Date());
        await responder.whenQuiet();
        assert.equal(waits.length, 1);
        responder.stop();
        await responder.whenIdle();
        responder.receive('人呢', 2, new Date());
        responder.catchUp();
        await responder.whenIdle();
        assert.deepEqual(prompts, []);
        assert.deepEqual(sent, []);
        assert.deepEqual(stored.map(m => m.content), ['在吗']);
    });

    test('stop：生成期间停下，生成完的回复不发，失败也不再试', async () => {
        const { responder, sent, logs, release } = setup({ retryAfterMs: RETRY_AFTER_MS });
        responder.receive('在吗', 1, new Date());
        await tick();
        responder.stop();
        release();
        await responder.whenIdle();
        assert.deepEqual(sent, []);
        assert.ok(logs.includes('已停止，这次生成的回复不发'));
        assert.ok(!logs.some(l => l.includes('后再试')));
    });

    test('stop：拆条发送中途停下，剩下的不发，已发的照常记录', async () => {
        let onGap: () => void = () => {};
        const { responder, stored, sent, logs } = setup({
            generate: async () => '一\n二\n三',
            sleep: async () => { onGap(); },
        });
        onGap = () => { onGap = () => {}; responder.stop(); };
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(sent, ['一']);
        assert.deepEqual(stored.map(m => `${m.role}:${m.content}`), ['user:在吗', 'assistant:一']);
        assert.ok(logs.includes('已停止，剩下 2 条不发'));
    });

    describe('主动找他（ADR 0011）', () => {
        const request = (patch: Partial<InitiateRequest> = {}): InitiateRequest & { committed: string[][] } => {
            const committed: string[][] = [];
            return { label: '早安（起床后 12 分钟）', note: '[这次是你主动找他：早安]', topic: '他最近在忙什么', maxBubbles: 2, dryRun: false, commit: parts => { committed.push(parts); }, committed, ...patch };
        };

        test('发出去、记进聊天记录；先 commit 再发；最多 2 条；提示词里带着说明', async () => {
            const notes: ({ note: string; topic: string } | undefined)[] = [];
            const order: string[] = [];
            const { responder, stored, sent } = setup({
                generate: async () => '早\n醒了没\n今天好冷\n多穿点',
                buildPrompt: (chat, context) => {
                    notes.push(context.initiate);
                    return { messages: chat.map(m => ({ role: m.role, content: m.content })), activatedWorldInfo: [] };
                },
                send: async (_id, text) => { order.push(`send:${text}`); sent.push(text); return 100 + sent.length; },
            });
            const req = request({ commit: parts => { order.push(`commit:${parts.length}`); } });
            const outcome = await responder.initiate(req);
            // 4 行按顺序合并成 2 条（reply.ts）
            assert.deepEqual(outcome, { result: 'sent', parts: ['早\n醒了没', '今天好冷\n多穿点'], messageIds: [101, 102] });
            assert.deepEqual(order, ['commit:2', 'send:早\n醒了没', 'send:今天好冷\n多穿点']);
            assert.deepEqual(notes, [{ note: '[这次是你主动找他：早安]', topic: '他最近在忙什么' }]);
            assert.deepEqual(stored.map(m => `${m.role}:${m.content}`), ['assistant:早\n醒了没', 'assistant:今天好冷\n多穿点']);
            assert.equal(responder.status().phase, 'idle');
        });

        test('试运行：生成、commit，不发、不记', async () => {
            const { responder, stored, sent } = setup({ generate: async () => '早' });
            const req = request({ dryRun: true });
            assert.deepEqual(await responder.initiate(req), { result: 'dryRun', parts: ['早'] });
            assert.deepEqual(req.committed, [['早']]);
            assert.deepEqual(sent, []);
            assert.deepEqual(stored, []);
        });

        test('正在回消息、有没回的消息时不主动；生成的是空的也不发、不再生成', async () => {
            const busy = setup();
            busy.responder.receive('在吗', 1, new Date());
            assert.deepEqual(await busy.responder.initiate(request()), { result: 'skipped', reason: '正在回消息' });
            await tick();
            busy.release();
            await busy.responder.whenIdle();

            const pending = setup();
            pending.stored.push({ time: new Date().toISOString(), role: 'user', content: '在吗', messageId: 1 });
            assert.deepEqual(await pending.responder.initiate(request()), { result: 'skipped', reason: '有没回的消息，回复就好' });

            // 按「不回」处理过的（看心情没回的「哈哈」，ADR 0013）不挡
            const moody = setup({ generate: async () => '在干嘛', timing: timingWith({ skip: history => (history.at(-1)?.content === '哈哈' ? '看心情没回' : undefined) }) });
            moody.stored.push({ time: new Date().toISOString(), role: 'user', content: '哈哈', messageId: 1 });
            assert.equal((await moody.responder.initiate(request())).result, 'sent');

            let calls = 0;
            const empty = setup({ generate: async () => { calls++; return '  '; } });
            const req = request();
            assert.deepEqual(await empty.responder.initiate(req), { result: 'skipped', reason: '生成的是空的' });
            assert.equal(calls, 1);
            assert.deepEqual(req.committed, []);
        });

        test('生成中他来了消息：草稿不发、不 commit，接着照常回他', async () => {
            const { responder, stored, sent, release } = setup();
            const req = request();
            const pendingOutcome = responder.initiate(req);
            await tick();
            responder.receive('早啊', 1, new Date());
            release();
            assert.deepEqual(await pendingOutcome, { result: 'skipped', reason: '生成期间他来了消息，草稿不发，照常回他' });
            assert.deepEqual(req.committed, []);
            await tick();
            release();
            await responder.whenIdle();
            assert.equal(sent.length, 1);
            assert.deepEqual(stored.map(m => m.role), ['user', 'assistant']);
        });

        test('生成出错、发送出错：failed，不再试', async () => {
            const broken = setup({ generate: async () => { throw new Error('连接超时'); } });
            assert.deepEqual(await broken.responder.initiate(request()), { result: 'failed', reason: '生成失败：连接超时' });

            const offline = setup({ generate: async () => '早', send: async () => { throw new Error('NapCat 未连接'); } });
            const req = request();
            assert.deepEqual(await offline.responder.initiate(req), { result: 'failed', reason: '发送失败：NapCat 未连接' });
            assert.deepEqual(req.committed, [['早']], '发之前已经记过：断线后不会重发');
            assert.deepEqual(offline.stored, []);
        });
    });
});

describe('配置', () => {
    function withConfig(config: unknown, env: Record<string, string>) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-config-'));
        const path = join(dir, 'config.json');
        writeFileSync(path, JSON.stringify(config));
        try {
            return loadConfig(dir, { QQBOT_CONFIG: path, ...env });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
    const valid = {
        onebot: { url: 'ws://127.0.0.1:3001/' },
        llm: { baseUrl: 'https://example.com/v1', model: 'm' },
        characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json',
        contacts: [{ qq: 123456, name: '阿明', tier: 'boyfriend' }],
    };

    test('密钥只从环境变量读取，其余默认值同 ST 默认预设', () => {
        const config = withConfig(valid, { QQBOT_LLM_API_KEY: 'k', QQBOT_ONEBOT_TOKEN: 't' });
        assert.equal(config.llm.apiKey, 'k');
        assert.equal(config.onebot.token, 't');
        assert.equal(config.llm.temperature, 1);
        assert.equal(config.llm.maxTokens, 300);
        assert.equal(config.prompt.worldInfo.depth, 2);
        assert.equal(config.prompt.pinExamples, false);
        assert.equal(config.llm.promptPostProcessing, '');
        assert.deepEqual(config.llm.extraBody, {});
    });

    test('听语音、看图（ADR 0052/0055）：默认只听语音和 OCR；DeepSeek 看图复用 LLM key', () => {
        const env = { QQBOT_LLM_API_KEY: 'k' };
        assert.equal(withConfig(valid, env).media, true);
        assert.equal(withConfig({ ...valid, media: false }, env).media, false);
        assert.equal(withConfig(valid, env).vision, undefined);
        assert.throws(() => withConfig({ ...valid, media: 'yes' }, env), /media 应为 true 或 false/);
        const vision = withConfig({ ...valid, vision: { provider: 'deepseek', model: 'deepseek-flash' } }, env).vision!;
        assert.deepEqual(vision, { provider: 'deepseek', model: 'deepseek-flash', timeoutMs: MEDIA_TIMEOUTS.vision });
        assert.throws(() => withConfig({ ...valid, vision: { provider: 'qwen-vl', model: 'qwen-vl-max' } }, env), /vision\.provider「qwen-vl」不认识：应为 deepseek 之一/);
    });

    test('最近几轮 + 要点（ADR 0043）：默认关；轮数 0–40、灰度名单是 QQ 号数组', () => {
        const env = { QQBOT_LLM_API_KEY: 'k' };
        assert.equal(withConfig(valid, env).contextTurns, 0);
        assert.deepEqual(withConfig(valid, env).contextContacts, []);
        const on = withConfig({ ...valid, contextTurns: 10, contextContacts: [123] }, env);
        assert.equal(on.contextTurns, 10);
        assert.deepEqual(on.contextContacts, [123]);
        assert.throws(() => withConfig({ ...valid, contextTurns: 41 }, env), /contextTurns/);
        assert.throws(() => withConfig({ ...valid, contextContacts: ['123'] }, env), /contextContacts/);
    });

    test('后处理方式和额外请求参数要合法', () => {
        const withLlm = (llm: object) => withConfig({ ...valid, llm: { ...valid.llm, ...llm } }, { QQBOT_LLM_API_KEY: 'k' });
        const config = withLlm({ promptPostProcessing: 'semi', extraBody: { thinking: { type: 'disabled' } } });
        assert.equal(config.llm.promptPostProcessing, 'semi');
        assert.deepEqual(config.llm.extraBody, { thinking: { type: 'disabled' } });
        assert.throws(() => withLlm({ promptPostProcessing: 'single' }), /promptPostProcessing/);
        assert.throws(() => withLlm({ extraBody: [] }), /extraBody/);
    });

    test('缺少 API key 或白名单不对时报错', () => {
        assert.throws(() => withConfig(valid, {}), /QQBOT_LLM_API_KEY/);
        const withContacts = (contacts: unknown) => withConfig({ ...valid, contacts }, { QQBOT_LLM_API_KEY: 'k' });
        assert.throws(() => withContacts([{ qq: '123', name: 'a', tier: 'boyfriend' }]), /contacts\[0\]\.qq/);
        assert.throws(() => withContacts([]), /contacts/);
        assert.throws(() => withContacts([{ qq: 1, name: 'a', tier: 'boyfriend' }, { qq: 1, name: 'b', tier: 'classmate' }]), /重复/);
        const twins = [{ qq: 1, name: '宝宝', tier: 'boyfriend' }, { qq: 2, name: '宝宝', tier: 'boyfriend' }];
        assert.deepEqual(withContacts(twins).contacts.map(c => c.qq), [1, 2]);
    });

    test('联系人的人设描述可选，必须是字符串，空串当作没有', () => {
        const withContacts = (contacts: unknown) => withConfig({ ...valid, contacts }, { QQBOT_LLM_API_KEY: 'k' });
        const [a, b, c] = withContacts([
            { qq: 1, name: '小王', tier: 'classmate', persona: '同专业，坐你后排' },
            { qq: 2, name: '小李', tier: 'classmate' },
            { qq: 3, name: '小张', tier: 'classmate', persona: '' },
        ]).contacts;
        assert.equal(a!.persona, '同专业，坐你后排');
        assert.equal(b!.persona, undefined);
        assert.equal(c!.persona, undefined);
        assert.throws(() => withContacts([{ qq: 1, name: 'a', tier: 'classmate', persona: 1 }]), /contacts\[0\]\.persona/);
    });

    test('每个联系人要有档位，unlisted 不能写在名单里；角色卡路径要带 {tier}；名单外好友默认回复', () => {
        const key = { QQBOT_LLM_API_KEY: 'k' };
        const withContacts = (contacts: unknown) => withConfig({ ...valid, contacts }, key);
        assert.equal(withContacts([{ qq: 1, name: 'a', tier: 'known' }]).contacts[0]!.tier, 'known');
        assert.throws(() => withContacts([{ qq: 1, name: 'a' }]), /contacts\[0\]\.tier/);
        assert.throws(() => withContacts([{ qq: 1, name: 'a', tier: 'unlisted' }]), /contacts\[0\]\.tier/);
        assert.throws(() => withConfig({ ...valid, characterCard: 'characters/linmengyao/st/linmengyao.json' }, key), /\{tier\}/);
        assert.equal(withConfig(valid, key).unlistedFriends, true);
        assert.equal(withConfig({ ...valid, unlistedFriends: false }, key).unlistedFriends, false);
        assert.equal(withConfig(valid, key).schedule, true);
        assert.equal(withConfig({ ...valid, schedule: false }, key).schedule, false);
    });

    test('Koishi 插件的配置没有 onebot 一节，同样校验、补默认值、按仓库根目录解析路径；独立入口仍要 onebot', () => {
        const { onebot: _, ...rest } = valid;
        const config = parseAppConfig(rest, 'C:/repo', { QQBOT_LLM_API_KEY: 'k' });
        assert.equal(config.llm.maxTokens, 300);
        assert.equal(config.characterCard, resolve('C:/repo', 'characters/linmengyao/st/linmengyao-{tier}.json'));
        assert.equal(config.dataDir, resolve('C:/repo', 'runtime/bot'));
        assert.equal('onebot' in config, false);
        assert.throws(() => parseAppConfig({ ...rest, contacts: [] }, 'C:/repo', { QQBOT_LLM_API_KEY: 'k' }), /contacts/);
        assert.throws(() => withConfig(rest, { QQBOT_LLM_API_KEY: 'k' }), /配置缺少 onebot/);
    });
});

describe('档位记录', () => {
    test('第一次只记下；档位不变不提示；换档时提示，降档时提醒清理聊天记录', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-tiers-'));
        try {
            const path = join(dir, 'tiers.json');
            const record = new TierRecord(path);
            assert.equal(record.update(1, 'boyfriend'), undefined);
            assert.equal(record.update(1, 'boyfriend'), undefined);
            assert.match(record.update(1, 'classmate')!, /从 boyfriend 降到 classmate.*chats\/1\.jsonl/);
            assert.match(new TierRecord(path).update(1, 'bestie')!, /从 classmate 变成 bestie/);
            assert.equal(new TierRecord(path).update(2, 'unlisted'), undefined);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('记下换档时间，补回漏掉的消息以它为下限；第一次记下的没有；读得懂只存档位名的旧文件', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-tiers-'));
        try {
            const path = join(dir, 'tiers.json');
            writeFileSync(path, JSON.stringify({ 1: 'boyfriend' }));
            const record = new TierRecord(path);
            assert.equal(record.since(1), undefined);
            assert.equal(record.update(1, 'boyfriend'), undefined, '旧格式也认得出档位没变');
            assert.match(record.update(1, 'classmate', new Date('2026-10-04T14:00:00Z'))!, /不从 QQ 补回/);
            assert.equal(new TierRecord(path).since(1)?.toISOString(), '2026-10-04T14:00:00.000Z');
            new TierRecord(path).update(2, 'classmate');
            assert.equal(new TierRecord(path).since(2), undefined, '第一次记下的联系人照旧补回');

            // 读聊天记录只看换档之后的
            const stored = new Map<number, { time: string; role: 'user'; content: string }[]>([
                [1, [{ time: '2026-10-04T13:00:00Z', role: 'user', content: '宝宝' }, { time: '2026-10-04T14:00:00Z', role: 'user', content: '触发换档的那条' },
                    { time: '2026-10-04T14:05:00Z', role: 'user', content: '同学你好' }]],
                [2, [{ time: '2026-10-04T13:00:00Z', role: 'user', content: '第一次' }]],
            ]);
            const view = currentTierHistory({ load: qq => stored.get(qq) ?? [], append: () => {} }, new TierRecord(path));
            // 名单外的人换档时，换档时间就是触发的那条消息的时间（main.ts），这条要留下
            assert.deepEqual(view.load(1).map(m => m.content), ['触发换档的那条', '同学你好']);
            assert.deepEqual(view.load(2).map(m => m.content), ['第一次']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('文件读坏了不当成空的：报错说明原因，不启动', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-tiers-'));
        try {
            const path = join(dir, 'tiers.json');
            writeFileSync(path, '{"1": {"tier": "classmate", "since"');
            assert.throws(() => new TierRecord(path), /tiers\.json 读不了.*换档前的消息重新进提示词/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
