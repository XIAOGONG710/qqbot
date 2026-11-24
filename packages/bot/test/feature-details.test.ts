import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FACT_CHECK_MODES } from '../src/language/fact-check.ts';
import { DEFAULTS, GROUP_AGENCY_MODES, GROUP_CHAT_MODES, GROUP_OWN_MODES, STICKER_MODES } from '../src/platform/config.ts';
import { FEATURES, featureDetail } from '../src/platform/features.ts';
import { WEB_MODES } from '../src/platform/web.ts';
import { PROACTIVE_MODES } from '../src/proactive/proactive.ts';
import { ACCOUNT_MODES, QQ_FRIEND_GATES } from '../src/social/account.ts';
import { PRESENCE_MODES } from '../src/social/presence.ts';
import { FESTIVAL_MODES } from '../src/world/festivals.ts';

// 功能总表也是控制台配置页的出处（ADR 0336 第 6 步）：Koishi 插件的开关那几项从这里取说明和下拉选项。
// 这里守住：几档模式的选项和代码里认的值一一对应（配置解析按代码里的表），默认值在选项里；该有说明的都有。
/** 每个几档模式的开关，代码里认哪几档 */
const MODES: Record<string, readonly string[]> = {
    webLookup: WEB_MODES, factCheck: FACT_CHECK_MODES, festivals: FESTIVAL_MODES, proactive: PROACTIVE_MODES, stickers: STICKER_MODES,
    groupChat: GROUP_CHAT_MODES, groupOwn: GROUP_OWN_MODES, groupAgency: GROUP_AGENCY_MODES, qqControl: ACCOUNT_MODES, qqFriendGate: QQ_FRIEND_GATES,
    ...Object.fromEntries(['bilibili', 'biliFeed', 'bilibiliDm', 'bilibiliReplies', 'bilibiliComment', 'qzone', 'deviceControl']
        .map(key => [key, PRESENCE_MODES])),
};
/** 配置页上本来就没写说明的开关 */
const NO_DETAIL = ['everydayLife'];

describe('功能总表里给配置页的那一份', () => {
    test('几档模式的开关都有选项，值和代码里认的一一对应（先后也一样），默认值是其中一档；开 / 关的没有选项', () => {
        for (const def of FEATURES) {
            if (def.kind !== 'mode') { assert.equal(def.modeLabels, undefined, `${def.key} 是开 / 关，不该有选项`); continue; }
            assert.ok(MODES[def.key], `${def.key}：在上面 MODES 里写明代码认哪几档`);
            assert.deepEqual(Object.keys(def.modeLabels ?? {}), [...MODES[def.key]!], def.key);
            assert.ok(Object.values(def.modeLabels!).every(label => label.trim()), `${def.key} 每一档都有说法`);
            assert.ok(MODES[def.key]!.includes((DEFAULTS as unknown as Record<string, string>)[def.key]!), `${def.key} 的默认值在选项里`);
        }
        assert.deepEqual(Object.keys(MODES).filter(key => FEATURES.find(def => def.key === key)?.kind !== 'mode'), []);
    });

    test('除了清单里的，每个开关都有配置页说明（完整的 detail，或模块那边的短说明拼出来的）', () => {
        assert.equal(featureDetail({ key: 'x', label: '名字', group: '说话', adr: '0001', description: '短说明' }), '**名字**（ADR 0001）：短说明');
        assert.equal(featureDetail({ key: 'x', label: '名字', group: '说话', adr: '0001', description: '短说明', detail: '完整' }), '完整');
        assert.deepEqual(FEATURES.filter(def => !featureDetail(def)?.trim()).map(def => def.key), NO_DETAIL);
    });
});
