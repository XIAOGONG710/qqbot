import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { parseAppConfig, type BotConfig } from '../src/config.ts';
import { loadTierCard } from '../src/contact.ts';
import { reviewReply } from '../src/exit-check.ts';
import type { StoredMessage } from '../src/history.ts';
import { parseVoiceLine } from '../src/media.ts';
import { createResponder, type ResponderDeps, type VoiceMade } from '../src/responder.ts';
import { stateAt, type Schedule } from '../src/schedule.ts';
import { commandSong, discardClip, localSpeech, localSpeechProblem, runJsonProcess, sweepClips, type SongRequest, type SynthRequest, type SynthResult } from '../src/tts.ts';
import {
    chooseVoice, countVoices, describeVoice, heSentVoice, historyOfVoice, readVoiceTag, recordMs, singable, singAsText, speakable, voiceAsked, whyNotNow,
    SING_MARK, VOICE_GAP_MS, VOICE_MAX_PER_DAY, type VoiceTurn,
} from '../src/voice.ts';

// ADR 0140：开口说话、唱歌。纯函数 + 本机引擎（假的子进程）+ 回复器 + 模拟器里走一遍
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-voice-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const local = (h: number, m = 0) => new Date(2026, 10, 11, h, m).getTime();

describe('voiceAsked：他明着要什么', () => {
    test('要语音：发个语音 / 想听你声音 / 说句话我听听 / 语音一下', () => {
        for (const text of ['发个语音', '给我发条语音呗', '想听你的声音', '我想听听你声音', '说句话给我听', '来个语音', '语音一下吧', '录个音给我']) assert.equal(voiceAsked(text), 'voice', text);
    });

    test('要唱歌：唱首歌 / 唱两句 / 想听你唱 / 哼个歌；唱 > 语音', () => {
        for (const text of ['唱首歌给我听', '你给我唱个歌吧', '想听你唱歌', '唱两句', '哼个歌听听', '给我唱', '来首歌']) assert.equal(voiceAsked(text), 'sing', text);
        assert.equal(voiceAsked('发个语音唱首歌'), 'sing');
    });

    test('不是在要：他自己唱 / 说别人唱 / 问会不会 / 平常提到语音', () => {
        for (const text of ['我唱歌给你听', '我来唱一首', '刚才去KTV唱歌了', '他唱歌好听', '你会唱歌吗', '你唱歌好听吗', '你发语音干嘛', '我在上课不方便语音', '今天好冷', '']) assert.equal(voiceAsked(text), undefined, text);
    });
});

describe('readVoiceTag：回复开头的标签', () => {
    test('开头的 <voice> / <sing> 拿掉并返回种类（大小写、空格不论）', () => {
        assert.deepEqual(readVoiceTag('<voice>\n好啊我马上下来'), { kind: 'voice', text: '好啊我马上下来' });
        assert.deepEqual(readVoiceTag('  < SING >第一句\n第二句'), { kind: 'sing', text: '第一句\n第二句' });
        assert.deepEqual(readVoiceTag('<voice> 想你了'), { kind: 'voice', text: '想你了' });
    });

    test('别处出现的标签一律去掉，不返回种类；没有标签原样', () => {
        assert.deepEqual(readVoiceTag('好啊<voice>真的'), { text: '好啊真的' });
        assert.deepEqual(readVoiceTag('今天好冷'), { text: '今天好冷' });
        assert.deepEqual(readVoiceTag('<voice>\n晚安</voice>'), { kind: 'voice', text: '晚安' });
    });
});

describe('speakable / singable：念得出来的字', () => {
    test('去掉小黄脸、括号动作、表情符号、～、网址、贴纸标签；哈哈哈哈压成三个', () => {
        assert.equal(speakable(['哈哈哈哈哈哈哈你好烦呀～[捂脸]', '（笑）真的😂']), '哈哈哈你好烦呀，真的');
        assert.equal(speakable(['看这个 https://b23.tv/abc 好玩', '<sticker:0123456789ab>']), '看这个 好玩');
    });

    test('几条拼成一句：句末没标点的补逗号；省略号换逗号；重复的叹号问号压成一个', () => {
        assert.equal(speakable(['我刚到宿舍', '你呢']), '我刚到宿舍，你呢');
        assert.equal(speakable(['等一下……我想想']), '等一下，我想想');
        assert.equal(speakable(['真的假的？？？', '太好了！！！']), '真的假的？太好了！');
    });

    test('太短 / 太长 / 全是符号：念不出来，返回 undefined', () => {
        assert.equal(speakable(['嗯']), undefined);
        assert.equal(speakable(['[捂脸]', '～～']), undefined);
        assert.equal(speakable(['啊'.repeat(5), '好']), '啊啊啊，好');
        assert.equal(speakable(['长'.repeat(120)]), undefined);
        assert.ok(speakable(['长'.repeat(90)]));
    });

    test('唱的词：每行一句，去掉 ♪ 和括号；超过 4 行 / 某行超过 18 字 / 没有词：undefined', () => {
        assert.deepEqual(singable(['♪ 小星星亮晶晶', '（轻声）挂在天上看着你']), ['小星星亮晶晶', '挂在天上看着你']);
        assert.deepEqual(singable(['第一句\n第二句\n第三句']), ['第一句', '第二句', '第三句']);
        assert.equal(singable(['一一', '二二', '三三', '四四', '五五']), undefined);
        assert.equal(singable(['这一行实在是太长了太长了太长了太长了太长了']), undefined);
        assert.equal(singable(['～', '[捂脸]']), undefined);
    });

    test('聊天记录里的写法和他发来的语音同一种，parseVoiceLine 读得回来；唱歌带（唱歌）标记；录的时间有上下限', () => {
        const spoken = historyOfVoice('voice', 5.6, '好啊我马上下来');
        assert.equal(spoken, '[语音 6秒：好啊我马上下来]');
        assert.deepEqual(parseVoiceLine(spoken), { seconds: 6, text: '好啊我马上下来' });
        assert.equal(historyOfVoice('sing', 13.2, ['词一', '词二']), `[语音 13秒：${SING_MARK}词一／词二]`);
        assert.equal(recordMs(0.5), 2000);
        assert.equal(recordMs(6), 7200);
        assert.equal(recordMs(100), 25_000);
        assert.deepEqual(singAsText(['词一', '词二']), ['♪ 词一', '♪ 词二']);
    });
});

describe('方不方便出声', () => {
    const schedule: Schedule = loadTierCard(join(resolve(import.meta.dirname, '../../..'), 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend').character.schedule!;

    test('夜里宿舍（23:00–07:30）不出声，在家不受限；睡觉、被吵醒不出声', () => {
        assert.match(whyNotNow({ now: local(23, 30), history: [] })!, /室友/);
        assert.match(whyNotNow({ now: local(6, 50), history: [] })!, /室友/);
        assert.equal(whyNotNow({ now: local(23, 30), history: [], home: true }), undefined);
        assert.equal(whyNotNow({ now: local(21, 0), history: [] }), undefined);
        assert.equal(whyNotNow({ now: local(7, 30), history: [] }), undefined);
        assert.match(whyNotNow({ now: local(21, 0), history: [], woken: true })!, /吵醒/);
        const sleeping = { ...stateAt(schedule, new Date(2026, 10, 11, 4, 0)) };
        assert.match(whyNotNow({ now: local(21, 0), history: [], state: sleeping })!, /睡觉/);
    });

    test('上课、图书馆自习的空闲活动不出声；别的空闲活动可以', () => {
        const free = (text: string) => ({ ...stateAt(schedule, new Date(2026, 10, 11, 15, 0)), activity: { kind: 'free' as const, text } });
        assert.match(whyNotNow({ now: local(15), history: [], state: free('在图书馆赶作业') })!, /图书馆/);
        assert.equal(whyNotNow({ now: local(15), history: [], state: free('窝在床上刷手机') }), undefined);
        const inClass = { ...stateAt(schedule, new Date(2026, 10, 11, 15, 0)), activity: { kind: 'class' as const, lesson: { kind: 'hard' as const, start: new Date(), end: new Date() } } };
        assert.match(whyNotNow({ now: local(15), history: [], state: inClass })!, /上课/);
    });
});

describe('chooseVoice：这一轮给不给选项', () => {
    const her = (content: string, h: number, m = 0): StoredMessage => ({ time: new Date(local(h, m)).toISOString(), role: 'assistant', content });
    const him = (content: string, h: number, m = 0): StoredMessage => ({ time: new Date(local(h, m)).toISOString(), role: 'user', content });
    const turn = (patch: Partial<VoiceTurn> = {}): VoiceTurn => ({ now: local(21, 0), history: [], said: '在干嘛', seed: 'x', canSing: false, ...patch });

    test('他明着要语音、她方便：提供，提示词里有 <voice>', () => {
        const choice = chooseVoice(turn({ said: '想听你的声音' }));
        assert.equal(choice.offer, 'voice');
        assert.equal(choice.asked, 'voice');
        assert.match(describeVoice(choice, '宝宝')!, /宝宝想听你的声音.*<voice>/s);
    });

    test('他明着要语音、她不方便：不提供，提示词里说原因并要她别说“发不了”', () => {
        const choice = chooseVoice(turn({ said: '发个语音', now: local(23, 40) }));
        assert.equal(choice.offer, undefined);
        assert.match(choice.blocked!, /室友/);
        const line = describeVoice(choice, '宝宝')!;
        assert.match(line, /不方便（夜里宿舍室友在睡/);
        assert.match(line, /别说“发不了”/);
        assert.doesNotMatch(line, /<voice>/);
    });

    test('他要唱歌：没有唱歌引擎就不提供（原因写在提示词里）；有引擎才提供 <sing>，一天最多两次', () => {
        const none = chooseVoice(turn({ said: '唱首歌给我听' }));
        assert.equal(none.offer, undefined);
        assert.equal(none.blocked, '有点害羞，不想唱');
        const sing = chooseVoice(turn({ said: '唱首歌给我听', canSing: true }));
        assert.equal(sing.offer, 'sing');
        assert.match(describeVoice(sing, '宝宝')!, /<sing>.*每行写一句你要唱的词/s);
        const sung = (h: number) => her(historyOfVoice('sing', 10, ['词']), h);
        const tired = chooseVoice(turn({ said: '再唱一首', canSing: true, history: [sung(10), sung(12)], now: local(21) }));
        assert.equal(tired.offer, undefined);
        assert.match(tired.blocked!, /唱过了/);
        const justNow = chooseVoice(turn({ said: '再唱一首', canSing: true, history: [her(historyOfVoice('sing', 10, ['词']), 20, 55)] }));
        assert.equal(justNow.blocked, '刚发过');
    });

    test('没人要时提供的由头不同，提示词的说法跟着变：他刚发了语音 / 他在撒娇说想她 / 平常', () => {
        const pickOffer = (patch: Partial<VoiceTurn>) => { for (let i = 0; i < 2000; i++) { const choice = chooseVoice(turn({ ...patch, share: 1, seed: `c${i}` })); if (choice.offer) return choice; } throw new Error('share 给 1 应该总提供'); };
        const after = pickOffer({ history: [him('[语音 5秒：在吗]', 20, 59)], said: '[语音 5秒：在吗]' });
        assert.equal(after.cue, 'afterVoice');
        assert.match(describeVoice(after, '宝宝')!, /刚给你发了条语音.*<voice>/s);
        const warm = pickOffer({ said: '我好想你啊' });
        assert.equal(warm.cue, 'warm');
        assert.match(describeVoice(warm, '宝宝')!, /撒娇、说想你.*<voice>/s);
        const plain = pickOffer({ said: '明天高数课你去不去' });
        assert.equal(plain.cue, undefined);
        assert.match(describeVoice(plain, '宝宝')!, /有由头才发/);
    });

    test('没人要：按概率提供；今天发够 2 条 / 距上一条不到 3 小时不提供；方便不方便先看', () => {
        const offered = (patch: Partial<VoiceTurn>) => Array.from({ length: 400 }, (_, i) => chooseVoice(turn({ ...patch, seed: `s${i}` })).offer === 'voice').filter(Boolean).length;
        const base = offered({});
        assert.ok(base > 4 && base < 45, `基础概率约 5%：${base}/400`);
        const afterVoice = offered({ history: [him('[语音 5秒：在吗]', 20, 59)], said: '[语音 5秒：在吗]' });
        assert.ok(afterVoice > 100, `他刚发了语音时高得多：${afterVoice}/400`);
        assert.equal(offered({ now: local(23, 30) }), 0);
        const voices = Array.from({ length: VOICE_MAX_PER_DAY }, (_, i) => her(historyOfVoice('voice', 5, '好'), 9 + i));
        assert.equal(offered({ history: voices, said: '[语音 5秒：在吗]' }), 0);
        const recent = [her(historyOfVoice('voice', 5, '好'), 21 - Math.floor(VOICE_GAP_MS / 3_600_000) + 1)];
        assert.equal(offered({ history: recent, said: '[语音 5秒：在吗]' }), 0);
    });

    test('skip 的轮次（危机、小别扭……）什么都不提供，连他要的也不给提示', () => {
        const choice = chooseVoice(turn({ said: '想听你的声音', skip: '危机回合' }));
        assert.deepEqual([choice.offer, choice.blocked, choice.asked], [undefined, undefined, undefined]);
        assert.equal(describeVoice(choice, '宝宝'), undefined);
    });

    test('数她发了几条：唱歌和说话分开数；跨天不算今天', () => {
        const history = [her(historyOfVoice('voice', 5, '好'), 9), her(historyOfVoice('sing', 9, ['词']), 10), her('普通文字', 11),
            { time: new Date(local(21) - 86_400_000).toISOString(), role: 'assistant' as const, content: historyOfVoice('voice', 5, '昨天') }];
        assert.equal(countVoices(history, local(21), 'voice').today, 1);
        assert.equal(countVoices(history, local(21), 'sing').today, 1);
        assert.equal(heSentVoice([him('哈哈', 20), him('[语音 3秒]', 20, 5)]), true);
        assert.equal(heSentVoice([him('[语音 3秒]', 20), her('好', 20, 1), him('哈哈', 20, 2)]), false);
    });
});

describe('出口检查：语音这一轮不拦「发你一条语音」', () => {
    const ask = async (reply: string, voiceSent: boolean) => reviewReply(reply, {
        banned: [], userName: '宝宝', ...(voiceSent ? { voiceSent: true } : {}), regenerate: async () => reply, log: () => undefined,
    });

    test('不是语音那一轮：「给你发条语音」照旧被拦（假装发语音）；是语音那一轮放行', async () => {
        const blocked = await ask('给你发条语音听听', false);
        assert.notEqual(blocked, '给你发条语音听听');
        assert.equal(await ask('给你发条语音听听', true), '给你发条语音听听');
        assert.equal(await ask('我念给你听', true), '我念给你听');
    });

    test('语音那一轮发照片、打电话的承诺照旧拦', async () => {
        assert.notEqual(await ask('我发你一张照片', true), '我发你一张照片');
        assert.notEqual(await ask('我们语音通话吧', true), '我们语音通话吧');
    });
});

describe('本机引擎：排队、清理', () => {
    const fake = (log: string[], delay = 0) => async (request: SynthRequest): Promise<SynthResult> => {
        log.push(`开始:${request.text}`);
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        log.push(`结束:${request.text}`);
        if (request.text.includes('坏')) return { ok: false, error: '模型没加载' };
        writeFileSync(request.out, 'RIFF');
        return { ok: true, seconds: 3.5, sampleRate: 24000 };
    };

    test('合成：文件放在 outDir，返回秒数；一次只跑一个（排队）；一个失败不影响后面的', async () => {
        const out = dir();
        const log: string[] = [];
        const engine = localSpeech({ engineDir: 'x', outDir: out, model: 'kokoro', speaker: 3, speed: 1, log: () => undefined, run: fake(log, 20) });
        const [a, b, c] = await Promise.allSettled([engine.synthesize('第一句'), engine.synthesize('坏的一句'), engine.synthesize('第三句')]);
        assert.deepEqual(log, ['开始:第一句', '结束:第一句', '开始:坏的一句', '结束:坏的一句', '开始:第三句', '结束:第三句']);
        assert.equal(a.status, 'fulfilled');
        assert.equal(b.status, 'rejected');
        assert.match(String((b as PromiseRejectedResult).reason), /模型没加载/);
        assert.equal(c.status, 'fulfilled');
        const clip = (a as PromiseFulfilledResult<{ file: string; seconds: number }>).value;
        assert.equal(clip.seconds, 3.5);
        assert.ok(clip.file.startsWith(out) && existsSync(clip.file));
        discardClip(clip);
        assert.equal(existsSync(clip.file), false);
        discardClip(undefined);
    });

    test('清残留：只删超过时限的 wav，别的文件不动', () => {
        const out = dir();
        const old = join(out, 'old.wav');
        const fresh = join(out, 'fresh.wav');
        const other = join(out, 'keep.txt');
        for (const file of [old, fresh, other]) writeFileSync(file, 'x');
        const past = new Date(Date.now() - 2 * 3_600_000);
        utimesSync(old, past, past);
        utimesSync(other, past, past);
        assert.equal(sweepClips(out, 3_600_000), 1);
        assert.deepEqual(readdirSync(out).sort(), ['fresh.wav', 'keep.txt']);
        assert.equal(sweepClips(join(out, '不存在'), 1), 0);
    });

    test('引擎装没装好：缺 sherpa-onnx-node / 缺模型都给出原因', () => {
        const root = dir();
        assert.match(localSpeechProblem(root, 'kokoro')!, /sherpa-onnx-node/);
        rmSync(root, { recursive: true, force: true });
    });
});

describe('回复器：语音这一步', () => {
    function setup(outcome: () => Promise<{ voice: VoiceMade } | { text: string[] } | undefined>, overrides: Partial<ResponderDeps> = {}) {
        const stored: StoredMessage[] = [];
        const events: string[] = [];
        let discarded = 0;
        const made = (): VoiceMade => ({ kind: 'voice', content: '[语音 4秒：好啊我马上下来]', seconds: 4, file: 'a.wav', discard: () => { discarded++; } });
        const deps: ResponderDeps = {
            userId: 1,
            history: { load: () => [...stored], append: (_id, m) => { stored.push(m); } },
            buildPrompt: chat => ({ messages: chat.map(m => ({ role: m.role, content: m.content })), activatedWorldInfo: [] }),
            generate: async () => '好啊\n我马上下来',
            clean: reply => reply.trim(),
            send: async (_id, text) => { events.push(`文字:${text}`); return 100 + events.length; },
            log: message => events.push(`日志:${message}`),
            sleep: async () => undefined,
            voice: {
                make: async parts => { events.push(`做:${parts.join('|')}`); const o = await outcome(); return o && 'voice' in o ? { voice: made() } : o; },
                send: async (_id, v) => { events.push(`语音:${v.file}`); return 700; },
            },
            ...overrides,
        };
        const responder = createResponder(deps);
        return { responder, stored, events, discarded: () => discarded };
    }
    const hear = async (s: ReturnType<typeof setup>) => { s.responder.receive('想听你声音', 5, new Date()); await s.responder.whenIdle(); await s.responder.whenQuiet(); };

    test('做成了：不发文字，发一条语音，聊天记录里是「[语音 4秒：……]」，音频删掉', async () => {
        const s = setup(async () => ({ voice: {} as VoiceMade }));
        await hear(s);
        assert.deepEqual(s.events.filter(e => !e.startsWith('日志:')), ['做:好啊|我马上下来', '语音:a.wav']);
        assert.deepEqual(s.stored.filter(m => m.role === 'assistant').map(m => [m.content, m.messageId]), [['[语音 4秒：好啊我马上下来]', 700]]);
        assert.equal(s.discarded(), 1);
    });

    test('做不成（返回 undefined / 出错）：照常发文字气泡', async () => {
        const none = setup(async () => undefined);
        await hear(none);
        assert.deepEqual(none.events.filter(e => !e.startsWith('日志:')), ['做:好啊|我马上下来', '文字:好啊', '文字:我马上下来']);
        const broken = setup(async () => { throw new Error('合成超时'); });
        await hear(broken);
        assert.deepEqual(broken.events.filter(e => !e.startsWith('日志:')), ['做:好啊|我马上下来', '文字:好啊', '文字:我马上下来']);
        assert.ok(broken.events.some(e => e.includes('语音没做出来（合成超时）')));
    });

    test('唱歌失败改发的词：当文字气泡发', async () => {
        const s = setup(async () => ({ text: ['♪ 词一', '♪ 词二'] }));
        await hear(s);
        assert.deepEqual(s.events.filter(e => e.startsWith('文字:')), ['文字:♪ 词一', '文字:♪ 词二']);
    });

    test('语音发不出去：改发文字，音频照样删；超时不重发（可能已经发出去了）', async () => {
        const stored: StoredMessage[] = [];
        const events: string[] = [];
        let discarded = 0;
        const make = (error: Error) => createResponder({
            userId: 1,
            history: { load: () => [...stored], append: (_id, m) => { stored.push(m); } },
            buildPrompt: chat => ({ messages: chat.map(m => ({ role: m.role, content: m.content })), activatedWorldInfo: [] }),
            generate: async () => '好啊\n我马上下来',
            clean: reply => reply.trim(),
            send: async (_id, text) => { events.push(`文字:${text}`); return 100 + events.length; },
            log: () => undefined, sleep: async () => undefined,
            voice: {
                make: async () => ({ voice: { kind: 'voice', content: '[语音 4秒：好]', seconds: 4, file: 'a.wav', discard: () => { discarded++; } } }),
                send: async () => { throw error; },
            },
        });
        const first = make(new Error('OneBot 调用失败 retcode 1200：转码失败'));
        first.receive('想听你声音', 5, new Date());
        await first.whenIdle(); await first.whenQuiet();
        assert.deepEqual(events, ['文字:好啊', '文字:我马上下来']);
        assert.equal(discarded, 1);
        events.length = 0; stored.length = 0;
        const second = make(new Error('OneBot 调用 send_private_msg 超时'));
        second.receive('想听你声音', 6, new Date());
        await second.whenIdle(); await second.whenQuiet();
        assert.deepEqual(events, [], '超时不重发文字');
        assert.equal(discarded, 2);
    });
});

describe('模拟器里走一遍', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const card = loadTierCard(join(root, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend');
    const llm: BotConfig['llm'] = { baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: '', extraBody: {} };
    const run = async (scenario: Record<string, unknown>, reply: string) => {
        const { runScenario } = await import('../src/sim/runner.ts');
        const { parseScenario } = await import('../src/sim/scenario.ts');
        const { DEFAULT_WORLD_INFO_SETTINGS } = await import('../src/st/world-info.ts');
        const prompts: string[] = [];
        const result = await runScenario(parseScenario({ name: '语音', tier: 'boyfriend', memory: false, ...scenario }), {
            runId: 'voice', dataDir: dir(), card, llm, prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
            generate: async messages => { prompts.push(messages.map(m => m.content).join('\n')); return reply; },
        });
        return { prompts, bubbles: result.steps.flatMap(step => step.bubbles.map(b => b.text)) };
    };

    test('他要语音、她方便、写了 <voice>：发一条语音，提示词里有那一行；<voice> 不会出现在文字里', async () => {
        const { prompts, bubbles } = await run({ voice: true, start: '2026-11-11T20:00:00+08:00', steps: [{ say: '想听你的声音' }] }, '<voice>\n喂，我在呢，刚洗完澡，头发还没干');
        assert.ok(prompts.at(-1)!.includes('想听你的声音。你现在方便说话'));
        assert.equal(bubbles.length, 1);
        assert.match(bubbles[0]!, /^\[语音 \d+秒：喂，我在呢，刚洗完澡，头发还没干\]$/);
    });

    test('没写 <voice>（她不想发）：照常发文字；开关没开：提示词里没有那一行，写了 <voice> 也只是文字', async () => {
        const typed = await run({ voice: true, start: '2026-11-11T20:00:00+08:00', steps: [{ say: '想听你的声音' }] }, '不要，丢人');
        assert.deepEqual(typed.bubbles, ['不要，丢人']);
        const off = await run({ start: '2026-11-11T20:00:00+08:00', steps: [{ say: '想听你的声音' }] }, '<voice>\n喂，我在呢');
        assert.ok(off.prompts.every(p => !p.includes('想听你的声音。你现在方便说话')));
        assert.deepEqual(off.bubbles, ['喂，我在呢']);
    });

    test('夜里宿舍：他要语音时她不方便，提示词里说原因；就算她写了 <voice> 也当文字发', async () => {
        const { prompts, bubbles } = await run({ voice: true, start: '2026-11-11T23:50:00+08:00', steps: [{ say: '发个语音给我' }] }, '<voice>\n室友都睡了，明天吧');
        assert.ok(prompts.at(-1)!.includes('可你现在不方便（夜里宿舍室友在睡'));
        assert.deepEqual(bubbles, ['室友都睡了，明天吧']);
    });

    test('唱歌：有引擎写了 <sing> 就发“唱”的语音；没引擎不提供，写了也当文字', async () => {
        const sung = await run({ voice: true, sing: true, start: '2026-11-11T20:00:00+08:00', steps: [{ say: '唱首歌给我听' }] }, '<sing>\n小星星亮晶晶\n挂在天上看着你');
        assert.match(sung.bubbles[0]!, new RegExp(`^\\[语音 \\d+秒：${SING_MARK}小星星亮晶晶／挂在天上看着你\\]$`));
        const none = await run({ voice: true, start: '2026-11-11T20:00:00+08:00', steps: [{ say: '唱首歌给我听' }] }, '<sing>\n小星星亮晶晶');
        assert.ok(none.prompts.at(-1)!.includes('可你现在不方便（有点害羞，不想唱'));
        assert.ok(none.prompts.at(-1)!.includes('别编嗓子哑、感冒'));
        assert.deepEqual(none.bubbles, ['小星星亮晶晶']);
    });

    test('太长念不出来：照旧发文字气泡', async () => {
        const long = '这是一段很长很长的话，'.repeat(12);
        const { bubbles } = await run({ voice: true, start: '2026-11-11T20:00:00+08:00', steps: [{ say: '想听你的声音' }] }, `<voice>\n${long}`);
        assert.ok(bubbles.every(b => !b.startsWith('[语音')) && bubbles.length >= 1);
    });
});

describe('内存保护、外接唱歌引擎、配置', () => {
    test('可用内存不够就不起合成进程（抛错，回复器会改发文字）', async () => {
        let ran = 0;
        const engine = localSpeech({ engineDir: 'x', outDir: dir(), model: 'kokoro', speaker: 3, speed: 1, log: () => undefined, available: () => 300 * 1024 * 1024, run: async () => { ran++; return { ok: true, seconds: 1, sampleRate: 24000 }; } });
        await assert.rejects(engine.synthesize('你好呀'), /可用内存只有 300 MB/);
        assert.equal(ran, 0);
    });

    test('外接唱歌命令：把词、曲风、写到哪、最长几秒交给它；它写好 wav 才算成；失败 / 没写文件都抛错', async () => {
        const out = dir();
        const requests: SongRequest[] = [];
        const ok = commandSong({ command: ['node', 'sing.mjs'], outDir: out, log: () => undefined, run: async (_command, request) => { requests.push(request); writeFileSync(request.out, 'RIFF'); return { ok: true, seconds: 12.5 }; } });
        const clip = await ok.sing(['第一句', '第二句']);
        assert.equal(clip.seconds, 12.5);
        assert.ok(existsSync(clip.file) && clip.file.startsWith(out));
        assert.deepEqual(requests[0]!.lines, ['第一句', '第二句']);
        assert.match(requests[0]!.style, /a cappella/);
        assert.equal(requests[0]!.maxSeconds, 25);
        discardClip(clip);

        const failing = commandSong({ command: ['x'], outDir: out, log: () => undefined, run: async () => ({ ok: false, error: '额度用完了' }) });
        await assert.rejects(failing.sing(['词']), /额度用完了/);
        const liar = commandSong({ command: ['x'], outDir: out, log: () => undefined, run: async () => ({ ok: true, seconds: 3 }) });
        await assert.rejects(liar.sing(['词']), /没有写出音频文件/);
    });

    test('runJsonProcess：真起一个子进程，stdin 进 JSON、stdout 最后一行出 JSON；退出了没结果 / 超时都报错', async () => {
        const script = join(dir(), 'echo.mjs');
        writeFileSync(script, "let s='';for await (const c of process.stdin) s+=c;const r=JSON.parse(s);console.log('噪声');console.log(JSON.stringify({ok:true,seconds:r.n*2}));");
        assert.deepEqual(await runJsonProcess(process.execPath, [script], { n: 21 }, 10_000, '测试'), { ok: true, seconds: 42 });
        const silent = join(dir(), 'silent.mjs');
        writeFileSync(silent, 'process.exit(3)');
        const quiet = await runJsonProcess(process.execPath, [silent], {}, 10_000, '测试');
        assert.equal(quiet.ok, false);
        assert.match((quiet as { error: string }).error, /测试进程退出 3，没有结果/);
        const slow = join(dir(), 'slow.mjs');
        writeFileSync(slow, 'setTimeout(()=>{}, 60000)');
        const late = await runJsonProcess(process.execPath, [slow], {}, 300, '测试');
        assert.match((late as { error: string }).error, /测试超时/);
    });

    test('配置：voice 默认关；voiceEngine / songEngine 可不写，写了校验', () => {
        const repoRoot = resolve(import.meta.dirname, '../../..');
        const base = { llm: { baseUrl: 'https://api.deepseek.com', model: 'm' }, characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json', contacts: [{ qq: 1, name: '阿明', tier: 'boyfriend' }] };
        const env = { QQBOT_LLM_API_KEY: 'k' };
        const plain = parseAppConfig(base, repoRoot, env);
        assert.equal(plain.voice, false);
        assert.equal('voiceEngine' in plain, false);
        assert.equal('songEngine' in plain, false);
        const set = parseAppConfig({ ...base, voice: true, voiceEngine: { model: 'melo', speaker: 0 }, songEngine: { command: ['node', 'sing.mjs'] } }, repoRoot, env);
        assert.equal(set.voice, true);
        assert.deepEqual(set.voiceEngine, { model: 'melo', speaker: 0, speed: 1, timeoutMs: 90_000 });
        assert.deepEqual(set.songEngine, { command: ['node', 'sing.mjs'], timeoutMs: 180_000 });
        assert.throws(() => parseAppConfig({ ...base, voiceEngine: { model: 'gpt' } }, repoRoot, env), /voiceEngine\.model/);
        assert.throws(() => parseAppConfig({ ...base, songEngine: { command: [] } }, repoRoot, env), /songEngine\.command/);
        assert.throws(() => parseAppConfig({ ...base, songEngine: { command: 'node sing.mjs' } }, repoRoot, env), /songEngine\.command/);
    });
});
