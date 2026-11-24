import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULTS, parseAppConfig } from '../../bot/src/platform/config.ts';
import { BILIBILI, FACT_CHECK, FESTIVALS, GROUP_CHAT, PROACTIVE, QZONE, SILENCE_NOTICE, STICKERS, WEB_LOOKUP } from '../../bot/src/platform/modules.ts';
import { canonicalTimeZone } from '../../bot/src/platform/time-zone.ts';
import { Config, migrateThinking, mountMobileCompanion, thinkingBody, toAppConfigInput } from '../src/index.ts';
import type { CompanionWebSocketLike } from '@qqbot/mobile-companion/websocket';

const repoRoot = resolve(import.meta.dirname, '../../..');
const env = { QQBOT_LLM_API_KEY: 'k' };
const minimal = {
    contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }],
    llm: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
};
const fromKoishi = (config: object) => parseAppConfig(toAppConfigInput(Config(config as never)), repoRoot, env);

/** ADR 0009 之前控制台存下的写法（形状同 koishi.example.yml 的旧版，联系人是虚构的） */
const before0009 = {
    contacts: [
        { qq: 10001, name: '阿明', tier: 'boyfriend' },
        { qq: 10002, name: '同学甲', tier: 'classmate', persona: '网上认识的学长，比较熟' },
    ],
    llm: {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        temperature: 1.3,
        maxTokens: 4096,
        promptPostProcessing: 'semi',
        extraBody: '{"thinking":{"type":"disabled"}}',
    },
    prompt: { maxContext: 16384, pinExamples: true },
    memory: { enabled: true },
};
/** 同一份配置在 runtime/bot/config.json 里的写法 */
const before0009AsJson = {
    ...before0009,
    llm: { ...before0009.llm, extraBody: { thinking: { type: 'disabled' } } },
    memory: { baseUrl: 'http://127.0.0.1:8899' }, // 11-02 DSH 6c57e4f：默认端口 8888 → 8899（8888 被 Jupyter 占着）
    characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json',
};

describe('插件配置（控制台表单 → config.json 的形状 → parseAppConfig）', () => {
    test('qzone 使用模块说明（后面接并进来的签名、翻空间、刷好友动态、刷陌生人），保留三档和保存键', () => {
        const field = Config.list?.find(group => group.dict?.qzone)?.dict?.qzone;
        assert.ok(String(field?.meta.description).startsWith(`**${QZONE.label}**（ADR ${QZONE.adr}）：${QZONE.description}`));
        for (const old of ['signature', 'qzoneBrowse', 'qzonePeek', 'qzoneStrangers']) assert.ok(String(field?.meta.description).includes(`【原 \`${old}\`】`), old);
        assert.equal(DEFAULTS.qzone, 'off');
        const save = (value: object) => Config.simplify(Config(value as never));
        const omitted = save(minimal);
        for (const mode of ['off', 'dryRun', 'on'] as const) {
            const written = save({ ...minimal, qzone: mode });
            assert.deepEqual(written, mode === 'off' ? omitted : { ...omitted, qzone: mode });
            assert.equal(fromKoishi(written).qzone, mode);
            // 签名、翻空间、刷好友动态、刷陌生人跟着 qzone（开关合并）：app 只读 qzone，旧字段不在 AppConfig 里
            for (const old of ['signature', 'qzoneBrowse', 'qzonePeek', 'qzoneStrangers']) assert.equal(old in fromKoishi(written), false, old);
        }
    });

    test('bilibili 使用模块说明，保留三档和保存键', () => {
        const field = Config.list?.find(group => group.dict?.bilibili)?.dict?.bilibili;
        assert.ok(String(field?.meta.description).startsWith(`**${BILIBILI.label}**（ADR ${BILIBILI.adr}）：${BILIBILI.description}`));
        for (const old of ['bilibiliAccount', 'bilibiliDm', 'bilibiliReplies', 'bilibiliComment', 'acquaintances', 'biliStickers']) assert.ok(String(field?.meta.description).includes(`【原 \`${old}\`】`), old);
        assert.equal(DEFAULTS.bilibili, 'off');
        const save = (value: object) => Config.simplify(Config(value as never));
        const omitted = save(minimal);
        for (const mode of ['off', 'dryRun', 'on'] as const) {
            const written = save({ ...minimal, bilibili: mode });
            assert.deepEqual(written, mode === 'off' ? omitted : { ...omitted, bilibili: mode });
            assert.equal(fromKoishi(written).bilibili, mode);
            // 私信、回复、话题评论、账号、认识的人、B 站表情包跟着 bilibili，刷到视频分享跟着 watching（开关合并）：app 只读新键，旧字段不在 AppConfig 里
            const parsed = fromKoishi({ ...written, watching: true, stickers: 'send' });
            for (const old of ['bilibiliDm', 'bilibiliReplies', 'bilibiliComment', 'bilibiliAccount', 'acquaintances', 'biliStickers', 'biliFeed']) assert.equal(old in parsed, false, old);
            assert.equal(parsed.bilibili, mode);
        }
    });

    test('festivals 使用模块说明，保留三档和保存键', () => {
        const field = Config.list?.find(group => group.dict?.festivals)?.dict?.festivals;
        assert.equal(field?.meta.description, `**${FESTIVALS.label}**（ADR ${FESTIVALS.adr}）：${FESTIVALS.description}`);
        assert.equal(DEFAULTS.festivals, 'off');
        const save = (value: object) => Config.simplify(Config(value as never));
        const omitted = save(minimal);
        for (const mode of ['off', 'notes', 'greet'] as const) {
            const written = save({ ...minimal, festivals: mode });
            assert.deepEqual(written, mode === 'off' ? omitted : { ...omitted, festivals: mode });
            assert.equal(fromKoishi(written).festivals, mode);
        }
    });

    test('factCheck 使用模块说明，保留三档和保存键', () => {
        const field = Config.list?.find(group => group.dict?.factCheck)?.dict?.factCheck;
        assert.ok(String(field?.meta.description).startsWith(`**${FACT_CHECK.label}**（ADR ${FACT_CHECK.adr}）：${FACT_CHECK.description}`));
        assert.ok(String(field?.meta.description).includes('【原 `factHim`】'), '并进来的 factHim');
        assert.equal(DEFAULTS.factCheck, 'off');
        const save = (value: object) => Config.simplify(Config(value as never));
        const omitted = save(minimal);
        for (const mode of ['off', 'log', 'fix'] as const) {
            const written = save({ ...minimal, factCheck: mode });
            assert.deepEqual(written, mode === 'off' ? omitted : { ...omitted, factCheck: mode });
            assert.equal(fromKoishi(written).factCheck, mode);
        }
    });

    test('stickers 使用模块说明，保留三档和保存键', () => {
        const field = Config.list?.find(group => group.dict?.stickers)?.dict?.stickers;
        assert.equal(field?.meta.description, `**${STICKERS.label}**（ADR ${STICKERS.adr}）：${STICKERS.description}`);
        assert.equal(DEFAULTS.stickers, 'off');
        const save = (value: object) => Config.simplify(Config(value as never));
        const omitted = save(minimal);
        for (const mode of ['off', 'collect', 'send'] as const) {
            const written = save({ ...minimal, stickers: mode });
            assert.deepEqual(written, mode === 'off' ? omitted : { ...omitted, stickers: mode });
            assert.equal(fromKoishi(written).stickers, mode);
        }
    });

    test('proactive 使用模块说明，保留三档和保存键', () => {
        const field = Config.list?.find(group => group.dict?.proactive)?.dict?.proactive;
        assert.ok(String(field?.meta.description).startsWith(`**${PROACTIVE.label}**（ADR ${PROACTIVE.adr}）：${PROACTIVE.description}`));
        const timings = ['proactiveReach', 'proactiveInvite', 'proactiveAsk', 'comeBack', 'smallNews', 'proactiveRoom', 'hisReactions'] as const;
        for (const old of timings) assert.ok(String(field?.meta.description).includes(`【原 \`${old}\`】`), old);
        // 7 个时机跟着 proactive 开没开（开关合并）：app 只读 proactive，旧字段不在 AppConfig 里
        for (const mode of ['off', 'dryRun', 'on'] as const) for (const old of timings) assert.equal(old in fromKoishi({ ...minimal, proactive: mode }), false, `${mode} ${old}`);
        assert.equal(DEFAULTS.proactive, 'off');
        const save = (value: object) => Config.simplify(Config(value as never));
        const omitted = save(minimal);
        for (const mode of ['off', 'dryRun', 'on'] as const) {
            const written = save({ ...minimal, proactive: mode });
            assert.deepEqual(written, mode === 'off' ? omitted : { ...omitted, proactive: mode });
            assert.equal(fromKoishi(written).proactive, mode);
        }
    });

    test('webLookup 使用模块说明，保留三档和保存键', () => {
        const field = Config.list?.find(group => group.dict?.webLookup)?.dict?.webLookup;
        assert.equal(field?.meta.description, `**${WEB_LOOKUP.label}**（ADR ${WEB_LOOKUP.adr}）：${WEB_LOOKUP.description}`);
        assert.equal(DEFAULTS.webLookup, 'off');
        const save = (value: object) => Config.simplify(Config(value as never));
        const omitted = save(minimal);
        for (const mode of ['off', 'explicit', 'auto'] as const) {
            const written = save({ ...minimal, webLookup: mode });
            assert.deepEqual(written, mode === 'off' ? omitted : { ...omitted, webLookup: mode });
            assert.equal(fromKoishi(written).webLookup, mode);
        }
    });

    test('groupChat 表单使用模块说明，四档和 YAML 保存保持兼容', () => {
        const field = Config.list?.find(group => group.dict?.groupChat)?.dict?.groupChat;
        assert.equal(field?.meta.description, `**${GROUP_CHAT.label}**（ADR ${GROUP_CHAT.adr}）：${GROUP_CHAT.description}`);
        assert.deepEqual(field?.list?.map(option => option.meta.description), ['关', '只看只记，不说话', '只写草稿，不发', '开']);
        assert.equal(DEFAULTS.groupChat, 'off');
        const save = (value: object) => Config.simplify(Config(value as never));
        const omitted = save(minimal);
        for (const mode of ['off', 'read', 'dryRun', 'on'] as const) {
            const written = save({ ...minimal, groupChat: mode });
            assert.deepEqual(written, mode === 'off' ? omitted : { ...omitted, groupChat: mode });
            assert.equal(fromKoishi(written).groupChat, mode);
        }
    });

    test('silenceNotice 表单说明取自模块，YAML 仍省略默认 false、原键保存 true', () => {
        const schemas = Config.list?.flatMap(group => group.dict?.silenceNotice ? [group.dict.silenceNotice] : []) ?? [];
        assert.equal(schemas.length, 1);
        assert.equal(schemas[0]!.meta.description, `**${SILENCE_NOTICE.label}**（ADR ${SILENCE_NOTICE.adr}）：${SILENCE_NOTICE.description}`);
        assert.equal(DEFAULTS.silenceNotice, false);
        const yaml = createRequire(import.meta.url)('js-yaml') as { dump(value: unknown): string; load(text: string): object };
        const save = (value: object) => yaml.dump(Config.simplify(Config(value as never)));
        const omitted = save(minimal);
        assert.doesNotMatch(omitted, /^silenceNotice:/m);
        assert.equal(save({ ...minimal, silenceNotice: false }), omitted);
        const enabled = save({ ...minimal, silenceNotice: true });
        assert.match(enabled, /^silenceNotice: true$/m);
        assert.deepEqual(yaml.load(enabled), { ...yaml.load(omitted), silenceNotice: true });
        assert.equal(fromKoishi(yaml.load(omitted)).silenceNotice, false);
        assert.equal(fromKoishi(yaml.load(enabled)).silenceNotice, true);
    });

    test('名单的「别人提起时」（ADR 0016）照传；没填就没有', () => {
        const parsed = fromKoishi({
            ...minimal,
            contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' }, { qq: 10002, name: '鸽鸽', tier: 'classmate', intro: '网上认识的朋友' }],
        });
        assert.equal(parsed.contacts[1]!.intro, '网上认识的朋友');
        assert.equal(parsed.contacts[0]!.intro, undefined);
    });

    test('只填必填项：默认值和 config.json 留空时一样（默认值只有 config.ts 一份）', () => {
        const fromFile = parseAppConfig({ ...minimal, characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json' }, repoRoot, env);
        assert.deepEqual(fromKoishi(minimal), fromFile);
        assert.equal(fromFile.memory, undefined);
        assert.equal(fromFile.dataDir, resolve(repoRoot, 'runtime/bot'));
    });

    test('表单里显示的默认值就是 config.ts 的 DEFAULTS', () => {
        const config = Config({ ...minimal, memory: { enabled: true } } as never);
        assert.equal(config.llm.temperature, DEFAULTS.llm.temperature);
        assert.equal(config.llm.maxTokens, DEFAULTS.llm.maxTokens);
        assert.equal(config.llm.timeoutMs, DEFAULTS.llm.timeoutMs);
        assert.equal(config.llm.promptPostProcessing, DEFAULTS.llm.promptPostProcessing);
        assert.equal(config.llm.thinking, undefined);
        assert.equal(config.dsh.enabled, DEFAULTS.dsh.enabled);
        assert.equal(config.mobileCompanion.enabled, false);
        assert.equal(config.mobileCompanion.websocketPath, '/qqbot/companion');
        assert.equal(config.mobileCompanion.httpPath, '/qqbot/companion/http');
        assert.equal(config.prompt.maxContext, DEFAULTS.prompt.maxContext);
        assert.equal(config.prompt.pinExamples, DEFAULTS.prompt.pinExamples);
        assert.deepEqual(config.prompt.worldInfo, DEFAULTS.prompt.worldInfo);
        assert.equal(config.schedule, DEFAULTS.schedule);
        assert.equal(config.media, DEFAULTS.media);
        assert.equal(config.stickers, DEFAULTS.stickers);
        assert.equal(config.vision.enabled, false);
        assert.equal(config.moody, DEFAULTS.moody);
        assert.equal(config.speechCheck, DEFAULTS.speechCheck);
        assert.equal(config.herDays, DEFAULTS.herDays);
        assert.equal(config.autonomousLife, DEFAULTS.autonomousLife);
        assert.equal(config.projectChoice, undefined, '已并进 autonomousLife 的旧键在表单上没有默认值');
        assert.equal(config.proactive, DEFAULTS.proactive);
        assert.equal(config.aiPhotos, DEFAULTS.aiPhotos);
        assert.equal(config.dataDir, DEFAULTS.dataDir);
        assert.equal(config.memory.timeoutMs, DEFAULTS.memory.timeoutMs);
        assert.equal(config.memory.recallTimeoutMs, DEFAULTS.memory.recallTimeoutMs);
        assert.equal(config.memory.bankPrefix, DEFAULTS.memory.bankPrefix);
    });

    test('手机伴侣 WebSocket 只有显式开关和合法路径才会进入插件配置', () => {
        const configured = Config({ ...minimal, mobileCompanion: { enabled: true, websocketPath: '/private/companion-v1', httpPath: '/private/companion-http' } } as never);
        assert.equal(configured.mobileCompanion.enabled, true);
        assert.equal(configured.mobileCompanion.websocketPath, '/private/companion-v1');
        assert.equal(configured.mobileCompanion.httpPath, '/private/companion-http');
        assert.throws(() => Config({ ...minimal, mobileCompanion: { enabled: true, websocketPath: 'http://0.0.0.0' } } as never));
        assert.throws(() => Config({ ...minimal, mobileCompanion: { enabled: true, httpPath: 'http://0.0.0.0' } } as never));
        assert.throws(() => Config({ ...minimal, mobileCompanion: { enabled: true, httpPath: `/${'x'.repeat(111)}` } } as never));
    });

    test('ADR 0009 之前存下的写法照常能读，解析结果和 config.json 一样', () => {
        assert.deepEqual(fromKoishi(before0009), parseAppConfig(before0009AsJson, repoRoot, env));
    });

    test('写回 koishi.yml（schema.simplify，loader 和控制台的「按 JSON 编辑」都用它）再读出来，配置不变', () => {
        const samples = [
            minimal,
            before0009,
            { ...before0009, llm: { ...before0009.llm, thinking: 'high', extraBody: '{"top_p":0.9}', timeoutMs: 60_000 } },
            { ...minimal, memory: { enabled: true, baseUrl: 'http://127.0.0.1:9999', recallTimeoutMs: 5000 }, prompt: { worldInfo: { depth: 4, caseSensitive: true } } },
            { ...minimal, memory: { enabled: false }, schedule: false, dataDir: 'runtime/bot-test' },
            { ...minimal, proactive: 'dryRun' },
            { ...minimal, aiPhotos: true },
            { ...minimal, moody: false },
            { ...minimal, speechCheck: false },
            { ...minimal, herDays: false },
            { ...minimal, media: false },
            { ...minimal, stickers: 'collect' },
            { ...minimal, stickers: 'send' },
            { ...minimal, vision: { enabled: true, model: 'deepseek-flash', timeoutMs: 6000 } },
        ];
        for (const sample of samples) {
            const config = Config(sample as never);
            assert.deepEqual(Config(Config.simplify(config) as never), config, JSON.stringify(sample));
        }
    });

    test('主动消息（ADR 0011）：旧的配置没有这一项时是关；试运行、开照样传过去；写错报错', () => {
        assert.equal(fromKoishi(minimal).proactive, 'off');
        assert.equal(fromKoishi(before0009).proactive, 'off');
        assert.equal(fromKoishi({ ...minimal, proactive: 'dryRun' }).proactive, 'dryRun');
        assert.equal(fromKoishi({ ...minimal, proactive: 'on' }).proactive, 'on');
        assert.throws(() => Config({ ...minimal, proactive: 'yes' } as never));
        // 等于默认值时不写进 koishi.yml
        assert.equal('proactive' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('DSH 顾问（ADR 0223）：默认关闭，打开后写入核心配置，关闭时不写回', () => {
        assert.equal(fromKoishi(minimal).dsh.enabled, false);
        assert.equal(fromKoishi({ ...minimal, dsh: { enabled: true } }).dsh.enabled, true);
        assert.equal('dsh' in (Config.simplify(Config(minimal as never)) as object), false);
        assert.deepEqual((Config.simplify(Config({ ...minimal, dsh: { enabled: true } } as never)) as { dsh: { enabled: boolean } }).dsh, { enabled: true });
        const independent = fromKoishi({ ...minimal, dsh: { enabled: true, baseUrl: 'https://dsh.example/v1', model: 'dsh-model', timeoutMs: 12_000 } });
        assert.deepEqual(independent.dsh, { enabled: true, baseUrl: 'https://dsh.example/v1', model: 'dsh-model', timeoutMs: 12_000 });
        assert.throws(() => parseAppConfig({ ...toAppConfigInput(Config(minimal as never)), dsh: { enabled: true, baseUrl: ' ' } }, repoRoot, env), /dsh.baseUrl/);
        assert.throws(() => parseAppConfig({ ...toAppConfigInput(Config(minimal as never)), dsh: { enabled: true, timeoutMs: 0 } }, repoRoot, env), /dsh.timeoutMs/);
    });

    test('删掉的开关（减法单子 11-24，二.1–二.3）还写在线上 koishi.yml 里：表单照样能读、能写回，交给核心时不带它们，配置和没写一样', () => {
        const leftovers = {
            shortReplies: true, hisHours: true, photoShares: true, reactions: true, foodPhotos: true, unlistedFriends: true, ownerPeek: true,
            shape: true, shapeAgenda: true, shapeFiller: true, shapeFeel: true, shapeSplit: true, shapeAsk: true, shapeLong: true, texture: true, tailCap: true, idioms: true, exemplars: true,
            realTransport: { enabled: true, endpoint: 'https://transport.example.test/status?city=all', source: '城市公共交通' },
        };
        const config = Config({ ...minimal, ...leftovers } as never);
        const input = toAppConfigInput(config);
        for (const key of Object.keys(leftovers)) assert.equal(key in input, false, key);
        assert.deepEqual(fromKoishi({ ...minimal, ...leftovers }), fromKoishi(minimal));
        // 表单读进来时还留着这些键，控制台下次保存（schema.simplify）就把它们从 koishi.yml 里抹掉；抹不抹都不影响
        for (const key of Object.keys(leftovers)) assert.equal(key in (Config.simplify(config) as object), false, key);
        assert.deepEqual(fromKoishi(Config.simplify(config) as object), fromKoishi(minimal));
    });

    test('听语音、看图（ADR 0052）：旧的配置没有这一项时是开；关了照样传过去；等于默认值时不写进 koishi.yml', () => {
        assert.equal(fromKoishi(minimal).media, true);
        assert.equal(fromKoishi(before0009).media, true);
        assert.equal(fromKoishi({ ...minimal, media: false }).media, false);
        assert.equal('media' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('公共节日（ADR 0076）：默认 off；notes / greet 分开；写错报错；默认值不写回 yml', () => {
        assert.equal(fromKoishi(minimal).festivals, 'off');
        assert.equal(fromKoishi(before0009).festivals, 'off');
        assert.equal(fromKoishi({ ...minimal, festivals: 'notes' }).festivals, 'notes');
        assert.equal(fromKoishi({ ...minimal, festivals: 'greet' }).festivals, 'greet');
        assert.throws(() => Config({ ...minimal, festivals: true } as never));
        assert.equal('festivals' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('正在输入（ADR 0077）：默认关；开了才进配置；默认值不写回 yml', () => {
        assert.equal(fromKoishi(minimal).typingStatus, false);
        assert.equal(fromKoishi(before0009).typingStatus, false);
        assert.equal(fromKoishi({ ...minimal, typingStatus: true }).typingStatus, true);
        assert.equal('typingStatus' in (Config.simplify(Config(minimal as never)) as object), false);
    });
    test('回复节奏（ADR 0075）：默认关；开了才进配置；默认值不写回 yml', () => {
        for (const key of ['rhythm'] as const) {
            assert.equal(fromKoishi(minimal)[key], false, key);
            assert.equal(fromKoishi(before0009)[key], false, key);
            assert.equal(fromKoishi({ ...minimal, [key]: true })[key], true, key);
            assert.equal(key in (Config.simplify(Config(minimal as never)) as object), false, key);
        }
    });
    test('图片表情（ADR 0063）：旧配置默认关；collect/send 分开；默认值不写回 yml', () => {
        assert.equal(fromKoishi(minimal).stickers, 'off');
        assert.equal(fromKoishi(before0009).stickers, 'off');
        assert.equal(fromKoishi({ ...minimal, stickers: 'collect' }).stickers, 'collect');
        assert.equal(fromKoishi({ ...minimal, stickers: 'send' }).stickers, 'send');
        assert.throws(() => Config({ ...minimal, stickers: true } as never));
        assert.equal('stickers' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('DeepSeek 看图（ADR 0055）：默认关；打开后填默认接口和模型，复用 LLM key', () => {
        assert.equal(fromKoishi(minimal).vision, undefined);
        const parsed = fromKoishi({ ...minimal, vision: { enabled: true } });
        assert.deepEqual(parsed.vision, {
            provider: 'deepseek',
            baseUrl: DEFAULTS.vision.baseUrl,
            model: DEFAULTS.vision.model,
            timeoutMs: DEFAULTS.vision.timeoutMs,
        });
        assert.equal(parsed.llm.apiKey, 'k');
        assert.equal((Config.simplify(Config(minimal as never)) as { vision?: { enabled?: boolean } }).vision?.enabled ?? false, false);
    });

    test('看心情不回（ADR 0013）：旧的配置没有这一项时是开；关了照样传过去；等于默认值时不写进 koishi.yml', () => {
        assert.equal(fromKoishi(minimal).moody, true);
        assert.equal(fromKoishi(before0009).moody, true);
        assert.equal(fromKoishi({ ...minimal, moody: false }).moody, false);
        assert.equal('moody' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('说话的毛病（ADR 0014）：旧的配置没有这一项时是开；关了照样传过去；等于默认值时不写进 koishi.yml', () => {
        assert.equal(fromKoishi(minimal).speechCheck, true);
        assert.equal(fromKoishi(before0009).speechCheck, true);
        assert.equal(fromKoishi({ ...minimal, speechCheck: false }).speechCheck, false);
        assert.equal('speechCheck' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('她自己的日子（ADR 0015）：旧的配置没有这一项时是开；关了照样传过去；等于默认值时不写进 koishi.yml', () => {
        assert.equal(fromKoishi(minimal).herDays, true);
        assert.equal(fromKoishi(before0009).herDays, true);
        assert.equal(fromKoishi({ ...minimal, herDays: false }).herDays, false);
        assert.equal('herDays' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('戳一戳（ADR 0079）：旧配置没有这一项时是关；开了照样传过去；等于默认值时不写进 koishi.yml', () => {
        assert.equal(fromKoishi(minimal).pokes, false);
        assert.equal(fromKoishi(before0009).pokes, false);
        assert.equal(fromKoishi({ ...minimal, pokes: true }).pokes, true);
        assert.equal('pokes' in (Config.simplify(Config(minimal as never)) as object), false);
        assert.equal('pokeBack' in fromKoishi({ ...minimal, pokes: true, pokeBack: true }), false, '戳回去跟着 pokes（开关合并），app 只读 pokes');
        assert.equal('pokeBack' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('撤回（ADR 0082）：旧配置没有这一项时是关；开了照样传过去；等于默认值时不写进 koishi.yml', () => {
        assert.equal(fromKoishi(minimal).recalls, false);
        assert.equal(fromKoishi(before0009).recalls, false);
        assert.equal(fromKoishi({ ...minimal, recalls: true }).recalls, true);
        assert.equal('recalls' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('存在感（ADR 0083）：旧配置没有这些项时全是关；开了照样传过去；等于默认值时不写进 koishi.yml；写错的模式报错', () => {
        // 已读、在线状态、点赞并进 qqSurface / qqPresence（开关合并）
        for (const key of ['qqSurface', 'qqPresence'] as const) {
            assert.equal(fromKoishi(minimal)[key], false, key);
            assert.equal(fromKoishi(before0009)[key], false, key);
            assert.equal(fromKoishi({ ...minimal, [key]: true })[key], true, key);
            assert.equal(key in (Config.simplify(Config(minimal as never)) as object), false, key);
        }
        assert.equal(fromKoishi(minimal).bilibili, 'off');
        assert.equal(fromKoishi({ ...minimal, bilibili: 'dryRun' }).bilibili, 'dryRun');
        assert.throws(() => Config({ ...minimal, bilibili: 'maybe' } as never));
        assert.equal(fromKoishi(minimal).qzone, 'off');
        assert.equal(fromKoishi(minimal).qzoneVisibility, 'friends');
        assert.equal(fromKoishi({ ...minimal, signature: 'on', qzoneBrowse: 'on', qzonePeek: 'on', qzoneStrangers: 'on', qzone: 'on', qzoneVisibility: 'public' }).qzone, 'on');
        // 签名只写草稿、空间开着：新键表达不了，拒绝启动（不悄悄把签名改成真改，审查 2026-11-25 发现 1）
        assert.throws(() => fromKoishi({ ...minimal, signature: 'dryRun', qzone: 'on' }), /新键表达不了.*signature=dryRun/);
        assert.equal(fromKoishi({ ...minimal, qzoneVisibility: 'public' }).qzoneVisibility, 'public');
        assert.throws(() => Config({ ...minimal, qzone: 'maybe' } as never));
        assert.throws(() => parseAppConfig({ ...toAppConfigInput(Config(minimal as never)), qzone: 'maybe' }, repoRoot, env), /qzone/);
    });

    test('没人聊天时她一件件过日子（ADR 0040）：旧配置没有这一项时是关；开了照样传过去', () => {
        assert.equal(fromKoishi(minimal).autonomousLife, false);
        assert.equal(fromKoishi({ ...minimal, autonomousLife: true }).autonomousLife, true);
        assert.equal('autonomousLife' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('项目选择（ADR 0056）：并进 autonomousLife（开关合并）；yml 里还写着旧键时照旧认，默认值不写回 yml', () => {
        assert.equal(fromKoishi(minimal).autonomousLife, false);
        assert.throws(() => fromKoishi({ ...minimal, projectChoice: true }), /新键表达不了/);
        assert.equal('projectChoice' in fromKoishi({ ...minimal, autonomousLife: true, projectChoice: true, lifeInPrompt: true }), false);
        assert.equal(fromKoishi({ ...minimal, autonomousLife: true, projectChoice: true, lifeInPrompt: true }).autonomousLife, true);
        assert.equal('projectChoice' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('最近几轮 + 要点（ADR 0043）：旧配置没有这两项时是关、全名单；开了照样传过去', () => {
        assert.equal(fromKoishi(minimal).contextTurns, 0);
        assert.deepEqual(fromKoishi(minimal).contextContacts, []);
        const on = fromKoishi({ ...minimal, contextTurns: 10, contextContacts: [10001] });
        assert.equal(on.contextTurns, 10);
        assert.deepEqual(on.contextContacts, [10001]);
        assert.equal('contextTurns' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('长期记忆打开时才有 memory；世界书只覆盖填了的项', () => {
        const parsed = fromKoishi({ ...minimal, prompt: { worldInfo: { depth: 4 } }, memory: { enabled: true } });
        assert.deepEqual(parsed.memory, { baseUrl: 'http://127.0.0.1:8899', timeoutMs: 30_000, recallTimeoutMs: 3000, bankPrefix: 'linmengyao' });
        assert.equal(parsed.prompt.worldInfo.depth, 4);
        assert.equal(parsed.prompt.worldInfo.budgetPercent, 25);
        assert.equal(fromKoishi({ ...minimal, memory: { enabled: false, baseUrl: 'http://x' } }).memory, undefined);
    });

    test('写错的地方报错：extraBody 不是 JSON 对象、档位不存在、QQ 号重复、必填项是空白', () => {
        assert.throws(() => toAppConfigInput(Config({ ...minimal, llm: { ...minimal.llm, extraBody: '{thinking' } } as never)), /llm\.extraBody/);
        assert.throws(() => toAppConfigInput(Config({ ...minimal, llm: { ...minimal.llm, extraBody: '[]' } } as never)), /JSON 对象/);
        assert.throws(() => Config({ ...minimal, contacts: [{ qq: 1, name: 'a', tier: 'unlisted' }] } as never));
        assert.throws(() => fromKoishi({ ...minimal, contacts: [{ qq: 1, name: 'a', tier: 'classmate' }, { qq: 1, name: 'b', tier: 'known' }] }), /重复/);
        assert.throws(() => Config({ ...minimal, llm: { ...minimal.llm, model: ' ' } } as never));
    });
});

describe('手机伴侣 WebSocket 挂载', () => {
    test('默认不挂载；DSH 关闭或 server 不存在时只记录原因', () => {
        const calls: string[] = [];
        let mounted = 0;
        const server = { ws: (_path: string, _callback: (socket: CompanionWebSocketLike) => void) => { mounted++; return { close: () => undefined }; } };
        const log = (message: string) => calls.push(message);
        assert.equal(mountMobileCompanion(server, undefined, { enabled: false, websocketPath: '/qqbot/companion' }, log), undefined);
        assert.equal(mountMobileCompanion(server, undefined, { enabled: true, websocketPath: '/qqbot/companion' }, log), undefined);
        assert.equal(mountMobileCompanion(undefined, {} as never, { enabled: true, websocketPath: '/qqbot/companion' }, log), undefined);
        assert.equal(mounted, 0);
        assert.equal(calls.length, 2);
        let closed = 0;
        const stop = mountMobileCompanion({ ws: (_path, _callback) => ({ close: () => { closed++; } }) }, { runtime: {} } as never, { enabled: true, websocketPath: '/qqbot/companion' }, log);
        assert.ok(stop);
        stop();
        assert.equal(closed, 1);

        let posts = 0;
        let gets = 0;
        const postHandlers: Array<(...args: any[]) => unknown> = [];
        const httpServer = {
            ws: (_path: string, _callback: (socket: CompanionWebSocketLike) => void) => ({ close: () => undefined }),
            post: (_path: string, callback: (ctx: unknown) => Promise<void>) => { posts++; postHandlers.push(callback as (...args: any[]) => unknown); return {}; },
            get: (_path: string, _callback: (ctx: unknown) => Promise<void>) => { gets++; return {}; },
        };
        const httpLog: string[] = [];
        const httpStop = mountMobileCompanion(httpServer, { runtime: {}, media: {} } as never, { enabled: true, websocketPath: '/qqbot/companion', httpPath: '/qqbot/companion/http' }, message => httpLog.push(message));
        assert.ok(httpStop);
        assert.equal(posts, 2);
        assert.equal(gets, 2);
        assert.equal(httpLog.some(message => message.includes('HTTPS envelope')), true);
        assert.equal((postHandlers[1] as unknown as Record<symbol, unknown>)[Symbol.for('noParseBody')], true);
    });
});

describe('思考控件（ADR 0009 A4）', () => {
    test('关 / 低 / 高 / 最高 对应 DeepSeek 的 thinking 和 reasoning_effort；不选就都不传', () => {
        assert.deepEqual(thinkingBody('off'), { thinking: { type: 'disabled' } });
        assert.deepEqual(thinkingBody('max'), { thinking: { type: 'enabled' }, reasoning_effort: 'max' });
        const withThinking = (thinking: string | undefined, extraBody = '{"top_p":0.9}') =>
            fromKoishi({ ...minimal, llm: { ...minimal.llm, thinking, extraBody } }).llm.extraBody;
        assert.deepEqual(withThinking('low'), { top_p: 0.9, thinking: { type: 'enabled' }, reasoning_effort: 'low' });
        assert.deepEqual(withThinking(undefined), { top_p: 0.9 });
    });

    test('控件选了值，其他参数里又写了 thinking / reasoning_effort：报错', () => {
        const both = (extraBody: string) => toAppConfigInput(Config({ ...minimal, llm: { ...minimal.llm, thinking: 'off', extraBody } } as never));
        assert.throws(() => both('{"thinking":{"type":"disabled"}}'), /只|不要再写/);
        assert.throws(() => both('{"reasoning_effort":"low"}'), /不要再写/);
    });

    test('旧写法迁移到控件：请求体不变，写回 koishi.yml 时不留空的其他参数', () => {
        const old = Config(before0009 as never);
        const migrated = migrateThinking(old)!;
        assert.equal(migrated.llm.thinking, 'off');
        assert.equal(migrated.llm.extraBody, '{}');
        assert.deepEqual(parseAppConfig(toAppConfigInput(migrated), repoRoot, env), parseAppConfig(toAppConfigInput(old), repoRoot, env));
        // loader 写回时按 Schema 去掉等于默认值的项（schema.simplify）
        const written = Config.simplify(migrated) as { llm: Record<string, unknown> };
        assert.equal(written.llm.thinking, 'off');
        assert.equal('extraBody' in written.llm, false);
        assert.equal(migrateThinking(Config(written as never)), undefined, '迁移一次就够');
    });

    test('只迁移能一一对上的写法，其余原样留在 JSON 里', () => {
        const migrate = (extraBody: string, thinking?: string) => migrateThinking(Config({ ...minimal, llm: { ...minimal.llm, extraBody, thinking } } as never));
        const high = migrate('{"thinking":{"type":"enabled"},"reasoning_effort":"high","top_p":0.9}')!;
        assert.equal(high.llm.thinking, 'high');
        assert.deepEqual(JSON.parse(high.llm.extraBody), { top_p: 0.9 });
        assert.equal(migrate('{"thinking":{"type":"enabled"}}'), undefined, '没写强度：迁过去会多传 reasoning_effort');
        assert.equal(migrate('{"reasoning_effort":"low"}'), undefined);
        assert.equal(migrate('{"thinking":{"type":"disabled","budget":1}}'), undefined);
        assert.equal(migrate('{"thinking":{"type":"disabled"}}', 'low'), undefined, '控件已经选了');
        assert.equal(migrate('{bad'), undefined);
    });
});

test('实例模板 koishi.example.yml 里的 qqbot 一节能读，不需要迁移', () => {
    const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };
    const example = yaml.load(readFileSync(resolve(repoRoot, 'packages/koishi-app/koishi.example.yml'), 'utf8')) as { plugins: { qqbot: object } };
    const config = Config(example.plugins.qqbot as never);
    assert.equal(migrateThinking(config), undefined);
    assert.equal(fromKoishi(example.plugins.qqbot).contacts.length, 1);
});

describe('她的时区（ADR 0331）：控制台里自由选择', () => {
    test('不写是上海；下拉里任何一个时区都能选并原样进配置；列表之外的 IANA 名走「其他」手填也行', () => {
        assert.equal(fromKoishi(minimal).timeZone, 'Asia/Shanghai');
        for (const zone of ['Asia/Tokyo', 'America/St_Johns', 'Pacific/Kiritimati', 'UTC']) {
            assert.equal(fromKoishi({ ...minimal, timeZone: zone }).timeZone, zone);
        }
        // 老别名不在 Node 的规范列表里，但仍是合法的 IANA 名；存下来的是规范写法
        assert.equal(fromKoishi({ ...minimal, timeZone: 'Asia/Calcutta' }).timeZone, canonicalTimeZone('Asia/Calcutta'));
    });

    test('表单校验放行任意字符串（交给 parseAppConfig 报清楚的错），写错的时区不会静默变成上海', () => {
        assert.doesNotThrow(() => Config({ ...minimal, timeZone: 'Mars/Olympus' } as never));
        assert.throws(() => fromKoishi({ ...minimal, timeZone: 'Mars/Olympus' }), /不是认识的时区/);
    });
});
