// 跨端人设来源（ADR 0353）：口气、逗人的分寸、桌面闲聊约定、桌面身份、称呼都从同一张卡的 extensions.qqbot.voice 读；
// 卡上没有用内置默认（改造前写死的那段），写了但这一档看不到（空串）就不放。只用合成角色卡。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { buildPrompt, QQ_PLAYFUL_STYLE, type ChatMessage } from '../src/language/prompt.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { CASUAL_CHAT_NOTE, desktopCallsHim, renderPersona } from '../src/st/persona-render.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { estimateTokens } from '../src/language/tokens.ts';
import { PLAYFUL_PERSONA } from '../../../dsh-plugins/dsh-linmengyao-memory/playful-persona.mjs';
import { syntheticCardPath, TIERS } from './fixtures/card.ts';

const root = resolve(import.meta.dirname, '../../..');
const herPrefixModule = createRequire(import.meta.url)(join(root, 'dsh-plugins/dsh-linmengyao-preset/her-prefix.cjs')) as {
    FALLBACK_PREFIX: string;
    cardDesktopIdentity: (file?: string) => string | undefined;
    herPrefix: (file?: string) => string;
};

type CardJson = { spec: string; data: Record<string, unknown> & { extensions: { qqbot: Record<string, unknown> & { voice?: Record<string, string> } } } };
const readCard = (tier: string, open = false): CardJson => JSON.parse(readFileSync(syntheticCardPath(tier, open), 'utf8')) as CardJson;
const withVoice = (card: CardJson, voice: Record<string, string> | undefined): CardJson => {
    const copy = structuredClone(card);
    if (voice === undefined) delete copy.data.extensions.qqbot.voice; else copy.data.extensions.qqbot.voice = voice;
    return copy;
};

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempCard = (card: CardJson): string => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-voice-'));
    dirs.push(dir);
    const file = join(dir, 'card.json');
    writeFileSync(file, JSON.stringify(card));
    return file;
};

function withPlayful<T>(fn: () => T): T {
    const original = process.env.QQBOT_PLAYFUL_PERSONA;
    process.env.QQBOT_PLAYFUL_PERSONA = '1';
    try {
        return fn();
    } finally {
        if (original === undefined) delete process.env.QQBOT_PLAYFUL_PERSONA; else process.env.QQBOT_PLAYFUL_PERSONA = original;
    }
}

const history: ChatMessage[] = [{ role: 'user', content: '该睡了' }];
const qqPrompt = (card: CardJson) => buildPrompt({
    character: parseCharacterCard(card),
    worldInfo: [],
    history,
    userName: '阿测',
    settings: { maxContext: 8192, maxTokens: 300, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
    countTokens: estimateTokens,
}).messages;

test('合成资料里 voice 段的值就是代码里的内置默认：生成的卡带上它，各端拿到的文字和改造前一字不差', () => {
    const boyfriend = readCard('boyfriend', true).data.extensions.qqbot.voice!;
    assert.equal(boyfriend.playful, PLAYFUL_PERSONA);
    assert.equal(boyfriend.qqPrivate, QQ_PLAYFUL_STYLE);
    assert.equal(boyfriend.desktopChat, CASUAL_CHAT_NOTE);
    assert.equal(boyfriend.callsHim, '宝宝');
    assert.equal(`${boyfriend.desktopIdentity}\n`, herPrefixModule.FALLBACK_PREFIX.replaceAll('林梦瑶', '测试角色'));
    // 桌面那三条只给男朋友档；QQ 那两条每档都有（和改造前一样，开关开着时每档私聊都放）
    for (const tier of TIERS) {
        const voice = readCard(tier).data.extensions.qqbot.voice!;
        assert.equal(voice.playful, PLAYFUL_PERSONA, tier);
        assert.equal(voice.qqPrivate, QQ_PLAYFUL_STYLE, tier);
        if (tier !== 'boyfriend') assert.deepEqual([voice.desktopChat, voice.desktopIdentity, voice.callsHim], ['', '', ''], tier);
    }
});

test('QQ 私聊：卡上有 voice 和没有 voice（内置默认）拼出的提示词逐条相同', () => {
    withPlayful(() => {
        for (const tier of TIERS) {
            const card = readCard(tier);
            assert.deepEqual(qqPrompt(card), qqPrompt(withVoice(card, undefined)), tier);
        }
    });
});

test('QQ 私聊只放逗人的分寸和 QQ 私聊的口气：卡上的文字原样用，空串不放也不退回内置默认，桌面那几条不读', () => {
    withPlayful(() => {
        const card = withVoice(readCard('boyfriend'), {
            playful: '【合成分寸】卡上的', qqPrivate: '【合成 QQ 口气】卡上的',
            desktopChat: '【合成桌面闲聊】', desktopIdentity: '【合成桌面身份】', callsHim: '合成称呼',
        });
        const text = qqPrompt(card).map(message => message.content).join('\n');
        assert.match(text, /【合成分寸】卡上的/);
        assert.equal(qqPrompt(card).at(-1)!.content, '【合成 QQ 口气】卡上的');
        assert.doesNotMatch(text, /合成桌面闲聊|合成桌面身份|合成称呼|你逗人的分寸|QQ 私聊里的口气/);
        const hidden = qqPrompt(withVoice(readCard('stranger'), { playful: '', qqPrivate: '' })).map(message => message.content).join('\n');
        assert.doesNotMatch(hidden, /你逗人的分寸|QQ 私聊里的口气/);
    });
    // 开关关着：卡上写了也不放
    const off = qqPrompt(withVoice(readCard('boyfriend'), { playful: '【合成分寸】卡上的', qqPrivate: '【合成 QQ 口气】卡上的' })).map(message => message.content).join('\n');
    assert.doesNotMatch(off, /合成分寸|合成 QQ 口气/);
});

test('DSH 桌面人设：闲聊约定读卡上的 desktopChat（没有用内置默认，空串不附），称呼读 callsHim；QQ 私聊的口气不进桌面', () => {
    const names = (card: CardJson) => ({ user: desktopCallsHim(card.data, '宝宝'), char: String(card.data.name) });
    const body = (text: string) => text.split('\n').slice(2).join('\n');
    const synthetic = readCard('boyfriend', true);
    const render = (card: CardJson) => body(renderPersona({ card: card.data, names: names(card) }));
    // 合成资料的值等于内置默认：和卡上没有 voice 时渲染得一模一样
    assert.equal(render(synthetic), render(withVoice(synthetic, undefined)));
    assert.ok(render(synthetic).includes(CASUAL_CHAT_NOTE));
    assert.doesNotMatch(render(synthetic), /QQ 私聊里的口气|你逗人的分寸/);
    const custom = withVoice(synthetic, { desktopChat: '【合成桌面闲聊】', qqPrivate: '【合成 QQ 口气】', callsHim: '合成称呼' });
    const customText = render(custom);
    assert.match(customText, /【合成桌面闲聊】/);
    assert.doesNotMatch(customText, /合成 QQ 口气|闲聊时直接接他刚才话里的一个细节/);
    assert.equal(names(custom).user, '合成称呼');
    assert.equal(names(withVoice(synthetic, { callsHim: '' })).user, '宝宝');
    assert.doesNotMatch(render(withVoice(synthetic, { desktopChat: '' })), /闲聊时直接接他刚才话里的一个细节/);
});

test('DSH preset 的身份前缀：组 preset 时读卡上的 desktopIdentity，卡不在、没写、空串都用改造前那段', () => {
    const { FALLBACK_PREFIX, cardDesktopIdentity, herPrefix } = herPrefixModule;
    // 内置默认就是 cordis.patch.yml 里 linmengyao 那一座的 prefix（YAML 的 | 块，末尾一个换行）
    const patch = readFileSync(join(root, 'dsh-plugins/dsh-linmengyao-preset/cordis.patch.yml'), 'utf8');
    const block = /prefix: \|\n((?: {16}.*\n)+)/.exec(patch)?.[1]?.split('\n').map(line => line.slice(16)).join('\n');
    assert.equal(block, FALLBACK_PREFIX);
    // presets.cjs 的四个模式都是现读，不再写死文字
    const presets = readFileSync(join(root, 'dsh-plugins/dsh-linmengyao-preset/presets.cjs'), 'utf8');
    assert.equal(presets.split('prefix: (require("./her-prefix.cjs").herPrefix()),').length - 1, 4);
    assert.ok(!presets.includes(JSON.stringify(FALLBACK_PREFIX)));
    assert.equal(herPrefix(join(tmpdir(), 'qqbot-voice-missing', 'card.json')), FALLBACK_PREFIX);
    assert.equal(herPrefix(syntheticCardPath('boyfriend', true)), `${readCard('boyfriend', true).data.extensions.qqbot.voice!.desktopIdentity}\n`);
    assert.equal(herPrefix(syntheticCardPath('classmate', true)), FALLBACK_PREFIX, '这一档看不到（空串）也不能没有身份');
    assert.equal(herPrefix(tempCard(withVoice(readCard('boyfriend', true), undefined))), FALLBACK_PREFIX);
    assert.equal(cardDesktopIdentity(tempCard(withVoice(readCard('boyfriend', true), { desktopIdentity: '  合成身份  ' }))), '合成身份');
    const original = process.env.QQBOT_PERSONA_CARD;
    try {
        process.env.QQBOT_PERSONA_CARD = tempCard(withVoice(readCard('boyfriend', true), { desktopIdentity: '合成身份' }));
        assert.equal(herPrefix(), '合成身份\n');
    } finally {
        if (original === undefined) delete process.env.QQBOT_PERSONA_CARD; else process.env.QQBOT_PERSONA_CARD = original;
    }
});

test('卡上的 voice 类型不对就报错', () => {
    const card = (voice: unknown) => ({ spec: 'chara_card_v2', data: { name: '合成', extensions: { qqbot: { voice } } } });
    assert.throws(() => parseCharacterCard(card(['x'])), /extensions\.qqbot\.voice 应为对象/);
    assert.throws(() => parseCharacterCard(card({ playful: 1 })), /voice\.playful 应为字符串/);
    assert.deepEqual(parseCharacterCard(card({ playful: '', other: 'x' })).voice, { playful: '' });
    assert.equal(parseCharacterCard({ spec: 'chara_card_v2', data: { name: '合成' } }).voice, undefined);
});
