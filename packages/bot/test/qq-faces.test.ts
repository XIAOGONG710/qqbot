import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { startApp, type Transport } from '../src/app.ts';
import type { AppConfig } from '../src/config.ts';
import { faceContext, FACE_WINDOW, FACE_WINDOW_MAX, FACE_WINDOW_MAX_DISTANT, inspectReply, MAX_FACES, reviewReply, rewriteNote, tidyFaces, type FaceContext } from '../src/exit-check.ts';
import { ChatHistory, type StoredMessage } from '../src/history.ts';
import { segmentsToText, type MessageEvent } from '../src/onebot.ts';
import { FACE_NAMES, faceText, facesIn, onlyFaces, SENDABLE_FACES, textToSegments } from '../src/qq-faces.ts';
import { isAck, isReaction, moodySkip } from '../src/reply-timing.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { SENSITIVE_ON, useSensitiveSwitch } from '../src/sensitive.ts';

// 这个文件里的测试靠日志里的原文来断言模块的行为；日志默认不写原文的那条由 log-bodies.test.ts 管
useSensitiveSwitch(SENSITIVE_ON);

const repoRoot = resolve(import.meta.dirname, '../../..');
const face = (id: number | string) => ({ type: 'face', data: { id: String(id) } });
const text = (t: string) => ({ type: 'text', data: { text: t } });

describe('QQ 小黄脸：他发的（ADR 0051）', () => {
    test('face 段按 id 换成名字，查不到的照旧「[表情]」', () => {
        assert.equal(faceText('264'), '[捂脸]');
        assert.equal(faceText(264), '[捂脸]');
        assert.equal(faceText('5'), '[流泪]', '超级表情的流泪也认得');
        assert.equal(faceText('179'), '[doge]');
        for (const id of ['9999', '', undefined, null, 'abc', '392']) assert.equal(faceText(id), '[表情]', String(id));
    });
    test('消息段转文本：文字和小黄脸拼在一起（补回、Koishi 插件都走这里）', () => {
        assert.equal(segmentsToText([text('笑死'), face(264), face(182)]), '笑死[捂脸][笑哭]');
        assert.equal(segmentsToText([face(5)]), '[流泪]');
        assert.equal(segmentsToText([text('嗯'), face(9999)]), '嗯[表情]');
        assert.equal(segmentsToText([{ type: 'face', data: {} }]), '[表情]');
    });
    test('只剩小黄脸照旧算反应；带了别的话、问号脸不算', () => {
        for (const t of ['[捂脸]', '哈哈哈[笑哭]', '[大哭]', '[doge][doge]', '[表情]', '[动画表情]', '好的[OK]', '[666]']) assert.equal(isReaction(t), true, t);
        for (const t of ['[问号脸]', '[疑问]', '在吗[捂脸]', '今天好累[大哭]', '你说呢[doge]']) assert.equal(isReaction(t), false, t);
        assert.equal(isAck('[捂脸]'), true);
        assert.equal(isAck('晚安[睡]'), true);
    });
    test('正聊着他只回了「[捂脸]」：看心情不回照旧能挑中', () => {
        const at = (s: number) => new Date(Date.UTC(2026, 9, 10, 6, 0, s)).toISOString();
        // 找一个会被挑中的 id（按 id 定）
        const id = Array.from({ length: 200 }, (_, i) => i + 1).find(i => moodySkip([
            { time: at(0), role: 'assistant', content: '哈哈' }, { time: at(10), role: 'user', content: '哈哈哈', messageId: i },
        ], 1, 0.5))!;
        const history: StoredMessage[] = [{ time: at(0), role: 'assistant', content: '哈哈' }, { time: at(10), role: 'user', content: '[捂脸]', messageId: id }];
        assert.ok(moodySkip(history, 1, 0.5));
        assert.equal(moodySkip([history[0]!, { ...history[1]!, content: '[问号脸]' }], 1, 0.5), undefined);
    });
});

describe('QQ 小黄脸：她发的（ADR 0051）', () => {
    test('白名单的「[捂脸]」发成 face 段，和文字拼成一条；白名单外的方括号原样当文字', () => {
        assert.deepEqual(textToSegments('哈哈[捂脸]你也太逗了'), [text('哈哈'), face(264), text('你也太逗了')]);
        assert.deepEqual(textToSegments('[拥抱]'), [face(49)]);
        assert.deepEqual(textToSegments('晚安[睡]'), [text('晚安'), face(8)]);
        assert.deepEqual(textToSegments('[ok]好'), [face(124), text('好')], '不分大小写');
        assert.deepEqual(textToSegments('[狗头]哈哈[流泪]'), [text('[狗头]哈哈[流泪]')], '流泪是超级表情，不在白名单');
        assert.deepEqual(textToSegments('矩阵 [1 2; 3 4]'), [text('矩阵 [1 2; 3 4]')]);
        assert.deepEqual(textToSegments(''), [text('')]);
    });
    test('白名单：都在 NapCat 的表里、名字对得上，发出去再读回来是同一句（补回她自己发的不会变样）', () => {
        const names = Object.keys(SENDABLE_FACES);
        assert.ok(names.length >= 12 && names.length <= 20, `十几个（实际 ${names.length}）`);
        for (const [name, id] of Object.entries(SENDABLE_FACES)) assert.equal(FACE_NAMES[id], name, name);
        for (const line of ['哈哈[捂脸]', '[笑哭][笑哭]', '好嘞[OK]你先忙', '[doge]']) {
            assert.equal(segmentsToText(textToSegments(line)), line, line);
        }
    });
    test('卡上写的名字都在白名单里；男朋友档写全了，同学档只写几个不亲近的', () => {
        const listed = (tier: 'boyfriend' | 'classmate') => {
            const { description } = JSON.parse(readFileSync(join(repoRoot, `characters/linmengyao/st/linmengyao-${tier}.json`), 'utf8')).data as { description: string };
            const line = description.split('\n').find(l => l.includes('小黄脸'));
            assert.ok(line, `${tier} 卡上有小黄脸那一句`);
            return [...line.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]!);
        };
        assert.deepEqual(listed('boyfriend'), Object.keys(SENDABLE_FACES));
        const classmate = listed('classmate');
        assert.ok(classmate.length > 0 && classmate.length < Object.keys(SENDABLE_FACES).length);
        for (const name of classmate) assert.ok(name in SENDABLE_FACES, name);
        for (const close of ['拥抱', '飞吻', '爱心']) assert.ok(!classmate.includes(close), close);
    });
});

describe('出口检查：小黄脸（ADR 0051）', () => {
    const none: FaceContext = { recent: [], serious: false };
    test('白名单外的方括号直接去掉；去掉就什么都不剩的留着交给重写', () => {
        assert.deepEqual(tidyFaces('哈哈[狗头]', none), { reply: '哈哈', notes: ['QQ 里没有的表情「[狗头]」'] });
        assert.equal(tidyFaces('[抱抱] 不哭了\n[表情]', none).reply, '不哭了');
        assert.equal(tidyFaces('[狗头]', none).reply, '[狗头]');
        assert.equal(tidyFaces('[狗头]！', none).reply, '[狗头]！');
        assert.deepEqual(inspectReply('[狗头]', []).map(i => [i.kind, i.face, i.match]), [['face', 'unknown', '[狗头]']]);
        assert.deepEqual(inspectReply('哈哈[捂脸]', []), []);
        assert.deepEqual(inspectReply('[Start a new Chat]', []).map(i => i.kind), ['script'], '提示词结构照旧按编对话算');
    });
    test('白名单的统一成正式写法', () => {
        assert.equal(tidyFaces('好[ok]', none).reply, '好[OK]');
        assert.equal(tidyFaces('【捂脸】笑死', none).reply, '[捂脸]笑死');
        assert.equal(tidyFaces('【重点】', none).reply, '【重点】');
    });
    test(`一次回复里超过 ${MAX_FACES} 个只留第一个`, () => {
        assert.deepEqual(tidyFaces('[捂脸][捂脸]\n哈哈[笑哭]', none), { reply: '[捂脸]\n哈哈', notes: ['一次回复里 3 个小黄脸，只留第一个'] });
        assert.equal(tidyFaces('哈哈[捂脸]\n你也是[doge]', none).reply, '哈哈[捂脸]\n你也是[doge]');
    });
    test(`她最近 ${FACE_WINDOW} 次回复里已经带了 ${FACE_WINDOW_MAX} 次，这次的去掉；整条只有表情的不去`, () => {
        const note = `最近 ${FACE_WINDOW} 次回复里已经带了 ${FACE_WINDOW_MAX} 次，这次的不带`;
        const pair: FaceContext = { recent: ['哈哈[捂脸]', '好吧\n[委屈]'], serious: false };
        assert.deepEqual(tidyFaces('那我先去洗澡了[偷笑]', pair), { reply: '那我先去洗澡了', notes: [note] }, '连着三次都带不会有');
        assert.equal(tidyFaces('[偷笑]', pair).reply, '[偷笑]');
        const spread = ['[捂脸]', '嗯', '在呢', '好吧[委屈]', '去吧', '哈哈'];
        assert.equal(tidyFaces('那我先去洗澡了[偷笑]', { recent: spread, serious: false }).reply, '那我先去洗澡了', '隔开的两次也算');
        assert.equal(tidyFaces('那我先去洗澡了[偷笑]', { recent: [...spread.slice(1), '好'], serious: false }).reply, '那我先去洗澡了[偷笑]', '早的那次出了窗口');
        assert.equal(tidyFaces('那我先去洗澡了[偷笑]', { recent: ['哈哈', '好吧\n[委屈]'], serious: false }).reply, '那我先去洗澡了[偷笑]', '只带过一次');
        // 不熟的档位：窗口里带过一次就不带
        assert.deepEqual(tidyFaces('那我先去洗澡了[偷笑]', { recent: ['哈哈', '好吧\n[委屈]'], windowMax: FACE_WINDOW_MAX_DISTANT, serious: false }),
            { reply: '那我先去洗澡了', notes: [`最近 ${FACE_WINDOW} 次回复里已经带了 1 次，这次的不带`] });
    });
    test('他在认真说事、她整条只回了表情：要重写；他只是「哈哈」时不管', () => {
        assert.equal(onlyFaces('[拥抱]'), true);
        assert.equal(onlyFaces('[拥抱][拥抱]。'), true);
        assert.equal(onlyFaces('抱抱[拥抱]'), false);
        assert.deepEqual(inspectReply('[拥抱]', [], undefined, undefined, { recent: [], serious: true }).map(i => i.face), ['only']);
        assert.deepEqual(inspectReply('[拥抱]', [], undefined, undefined, { recent: [], serious: false }), []);
        const note = rewriteNote('[拥抱]', inspectReply('[拥抱]', [], undefined, undefined, { recent: [], serious: true }), '宝宝');
        assert.match(note, /「\[拥抱\]」宝宝在认真跟你说事，你只回了个表情；用话回宝宝/);
    });
    test('上下文：她最近几次回复（连着的几条算一次）、她上次回复之后他说的是不是只是反应', () => {
        const m = (role: 'user' | 'assistant', content: string, i: number): StoredMessage => ({ time: new Date(Date.UTC(2026, 9, 10, 6, i)).toISOString(), role, content });
        const history = [m('assistant', '早[睡]', 0), m('user', '早', 1), m('assistant', '在吗', 2), m('assistant', '[捂脸]', 3), m('user', '哈哈哈[笑哭]', 4)];
        assert.deepEqual(faceContext(history), { recent: ['早[睡]', '在吗\n[捂脸]'], windowMax: FACE_WINDOW_MAX, serious: false });
        assert.equal(faceContext(history, 'boyfriend').windowMax, FACE_WINDOW_MAX);
        assert.equal(faceContext(history, 'girl_friend').windowMax, FACE_WINDOW_MAX);
        for (const tier of ['known', 'classmate', 'stranger', 'unlisted'] as const) assert.equal(faceContext(history, tier).windowMax, FACE_WINDOW_MAX_DISTANT, tier);
        assert.equal(faceContext([...history, m('user', '晚安', 5)]).serious, false);
        assert.equal(faceContext([...history, m('user', '今天面试没过', 5)]).serious, true);
        assert.equal(faceContext([...history, m('user', '[大哭]', 5)]).serious, false);
        assert.equal(faceContext([m('user', '在干嘛', 0)]).serious, true);
    });

    const run = async (first: string, rewrites: string[], faces?: FaceContext) => {
        const notes: string[] = [];
        const logs: string[] = [];
        const reply = await reviewReply(first, {
            banned: [], userName: '阿明', ...(faces ? { faces } : {}),
            regenerate: async note => { notes.push(note); return rewrites.shift() ?? assert.fail('不该再重写'); },
            log: l => logs.push(l),
        });
        return { reply, notes, logs };
    };
    test('流水线：能去掉的直接去掉、不重写，日志记一行', async () => {
        const r = await run('哈哈[狗头][捂脸]', []);
        assert.equal(r.reply, '哈哈[捂脸]');
        assert.deepEqual(r.notes, []);
        assert.deepEqual(r.logs, ['出口检查：小黄脸——QQ 里没有的表情「[狗头]」，去掉']);
    });
    test('流水线：他认真说事只回了表情，重写；重写还是只有表情就照发', async () => {
        const serious = { recent: [], serious: true };
        const ok = await run('[拥抱]', ['怎么啦\n跟我说说'], serious);
        assert.equal(ok.reply, '怎么啦\n跟我说说');
        assert.equal(ok.notes.length, 1);
        assert.match(ok.notes[0]!, /你只回了个表情/);
        const still = await run('[拥抱]', ['[拥抱][拥抱]'], serious);
        assert.equal(still.reply, '[拥抱][拥抱]');
        assert.match(still.logs.at(-1)!, /重写后仍有.*只回了表情.*照发/);
    });
    test('流水线：整条只有白名单外的表情，重写；还是这样就删掉那一行（发不出去）', async () => {
        const fixed = await run('[狗头]', ['你又来[doge]']);
        assert.equal(fixed.reply, '你又来[doge]');
        assert.match(fixed.notes[0]!, /QQ 里没有「\[狗头\]」这个表情，发不出去/);
        const still = await run('[狗头]', ['[狗头]']);
        assert.equal(still.reply, '');
    });
});

describe('QQ 小黄脸：编排（ADR 0051）', () => {
    const dirs: string[] = [];
    after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

    test('他发的小黄脸按名字进聊天记录；她回的发出去时 [捂脸] 变 face 段，白名单外的去掉，记录里存原文', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-faces-'));
        dirs.push(dataDir);
        const config: AppConfig = {
            llm: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
            prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
            characterCard: join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'),
            contacts: [{ qq: 10001, name: '宝宝', tier: 'boyfriend' }],
            unlistedFriends: false, schedule: false, moody: false, speechCheck: false, herDays: false, autonomousLife: false, projectChoice: false, lifeInPrompt: false, grievance: false, npcAsks: false, pokes: false, pokeBack: false, pokeOut: false, readReceipts: false, bilibili: 'off', bilibiliAccount: false, bilibiliComment: 'off', bilibiliDm: 'off', bilibiliAtName: '', bilibiliAtUid: 0, reactions: false, onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', recalls: false, feedbackCommands: false, realWeather: false, festivals: 'off', typingStatus: false, selfRecall: false, rhythm: false, shortReplies: false, media: false,
            candidates: 1, contextTurns: 0, contextContacts: [], proactive: 'off', dataDir,
        };
        const sent: { text: string; segments: ReturnType<typeof textToSegments> }[] = [];
        const prompts: string[] = [];
        const transport: Transport = {
            // 和 onebot.ts、Koishi 插件一样：发的时候转成段
            sendPrivateText: async (_userId, t) => { sent.push({ text: t, segments: textToSegments(t) }); return 900 + sent.length; },
            friendHistory: async () => { throw new Error('消息不存在'); },
        };
        const app = startApp({
            config, transport, log: () => {},
            pipeline: {
                generate: async messages => { prompts.push(JSON.stringify(messages)); return '笑死[捂脸][狗头]\n你也太惨了'; },
                settle: { quietMs: 0, maxMs: 0 },
            },
        });
        try {
            const event: MessageEvent = {
                post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 1,
                time: Math.floor(Date.now() / 1000), message: [text('今天又迟到了'), face(264)], raw_message: '', sender: { user_id: 10001 },
            };
            app.receive(event);
            const deadline = Date.now() + 3000;
            while (sent.length < 2) {
                if (Date.now() > deadline) assert.fail('等不到回复');
                await new Promise(r => setTimeout(r, 10));
            }
        } finally {
            app.stop();
        }
        assert.ok(prompts[0]!.includes('今天又迟到了[捂脸]'), '模型看到的是名字');
        assert.deepEqual(sent.map(s => s.text), ['笑死[捂脸]', '你也太惨了']);
        assert.deepEqual(sent[0]!.segments, [text('笑死'), face(264)]);
        assert.deepEqual(new ChatHistory(dataDir).load(10001).map(m => `${m.role}:${m.content}`), ['user:今天又迟到了[捂脸]', 'assistant:笑死[捂脸]', 'assistant:你也太惨了']);
        assert.deepEqual(facesIn('笑死[捂脸]').sendable, ['[捂脸]']);
    });

    test('QQ 不收 face 段：去掉表情再发一次纯文字，日志记一行；超时不重发', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-faces-'));
        dirs.push(dataDir);
        const config: AppConfig = {
            llm: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
            prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
            characterCard: join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'),
            contacts: [{ qq: 10001, name: '宝宝', tier: 'boyfriend' }, { qq: 10002, name: '阿杰', tier: 'boyfriend' }],
            unlistedFriends: false, schedule: false, moody: false, speechCheck: false, herDays: false, autonomousLife: false, projectChoice: false, lifeInPrompt: false, grievance: false, npcAsks: false, pokes: false, pokeBack: false, pokeOut: false, readReceipts: false, bilibili: 'off', bilibiliAccount: false, bilibiliComment: 'off', bilibiliDm: 'off', bilibiliAtName: '', bilibiliAtUid: 0, reactions: false, onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', recalls: false, feedbackCommands: false, realWeather: false, festivals: 'off', typingStatus: false, selfRecall: false, rhythm: false, shortReplies: false, media: false,
            candidates: 1, contextTurns: 0, contextContacts: [], proactive: 'off', dataDir,
        };
        const sent: string[] = [];
        const attempts: string[] = [];
        const logs: string[] = [];
        const transport: Transport = {
            sendPrivateText: async (userId, t) => {
                attempts.push(`${userId}:${t}`);
                if (textToSegments(t).some(s => s.type === 'face')) throw new Error(userId === 10002 ? 'Timeout: send_private_msg' : 'retcode 1200');
                sent.push(`${userId}:${t}`);
                return 900 + sent.length;
            },
            friendHistory: async () => { throw new Error('消息不存在'); },
        };
        const app = startApp({
            config, transport, log: line => logs.push(line),
            pipeline: { generate: async () => '笑死[捂脸]', settle: { quietMs: 0, maxMs: 0 } },
        });
        try {
            for (const [qq, id] of [[10001, 1], [10002, 2]] as const) {
                app.receive({
                    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: qq, message_id: id,
                    time: Math.floor(Date.now() / 1000), message: [text('今天又迟到了')], raw_message: '', sender: { user_id: qq },
                } as MessageEvent);
            }
            const deadline = Date.now() + 3000;
            while (sent.length < 1 || !attempts.some(a => a.startsWith('10002:'))) {
                if (Date.now() > deadline) assert.fail('等不到发送');
                await new Promise(r => setTimeout(r, 10));
            }
        } finally {
            app.stop();
        }
        assert.deepEqual(sent, ['10001:笑死'], '去掉表情再发');
        assert.ok(logs.some(l => l.includes('带小黄脸的消息没发出去（retcode 1200），去掉表情再发一次')));
        assert.deepEqual(attempts.filter(a => a.startsWith('10002:')), ['10002:笑死[捂脸]'], '超时不重发');
    });
});
