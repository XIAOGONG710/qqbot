import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { segmentsToText } from '../src/onebot.ts';
import { fileText, shareText } from '../src/shares.ts';

const card = (value: object) => JSON.stringify(value);

describe('分享卡片、转发、文件在聊天记录里的写法（ADR 0080）', () => {
    test('小程序分享（B 站）：来源 + 内容标题，不带链接', () => {
        const raw = card({
            app: 'com.tencent.miniapp_01', prompt: '[QQ小程序]哔哩哔哩',
            meta: { detail_1: { appid: '1109937557', title: '哔哩哔哩', desc: '【原神】枫丹新角色PV', qqdocurl: 'https://b23.tv/abc123', preview: 'http://x/y.png' } },
        });
        assert.equal(shareText(raw), '[分享：哔哩哔哩《原神枫丹新角色PV》]');
        assert.doesNotMatch(shareText(raw), /https?:|b23/);
    });

    test('网页分享：站点名 + 文章标题；音乐：歌名 - 歌手', () => {
        assert.equal(shareText(card({ app: 'com.tencent.structmsg', prompt: '[分享]食堂新出的菜', meta: { news: { title: '食堂新出的菜', desc: '摘要', tag: '小红书', jumpUrl: 'https://x' } } })), '[分享：小红书《食堂新出的菜》]');
        assert.equal(shareText(card({ app: 'com.tencent.structmsg', view: 'music', prompt: '[分享]晴天', meta: { music: { title: '晴天', desc: '周杰伦', tag: 'QQ音乐' } } })), '[分享音乐：晴天 - 周杰伦]');
    });

    test('认不出结构：用卡片自带的通知栏那一行；再不行就「[分享]」；坏 JSON、不是对象都不抛', () => {
        assert.equal(shareText(card({ app: 'com.tencent.map', prompt: '[位置]济南大学西校区' })), '[位置：济南大学西校区]');
        assert.equal(shareText(card({ app: 'x', prompt: '一个卡片' })), '[分享：一个卡片]');
        assert.equal(shareText(card({ app: 'x' })), '[分享]');
        assert.equal(shareText('{坏的'), '[分享]');
        assert.equal(shareText(undefined), '[分享]');
        assert.equal(shareText('[1,2]'), '[分享]');
    });

    test('标题里的换行、方括号去掉，太长截短；只有标题或只有来源也能写', () => {
        const long = '很长'.repeat(50);
        const text = shareText(card({ app: 'com.tencent.structmsg', meta: { news: { title: `第一行\n[第二行]${long}`, tag: '' } } }));
        assert.match(text, /^\[分享：第一行 第二行很长/);
        assert.ok(text.length < 60, text);
        assert.equal(shareText(card({ app: 'com.tencent.structmsg', meta: { news: { tag: '知乎' } } })), '[分享：知乎]');
    });

    test('文件带文件名，转发写成聊天记录；segmentsToText 里文字和它们按顺序拼', () => {
        assert.equal(fileText('简历 终版.pdf'), '[文件：简历 终版.pdf]');
        assert.equal(fileText(undefined), '[文件]');
        assert.equal(segmentsToText([{ type: 'file', data: { file: 'a.docx', file_size: 10 } }]), '[文件：a.docx]');
        assert.equal(segmentsToText([{ type: 'forward', data: { id: '1' } }]), '[转发的聊天记录]');
        assert.equal(segmentsToText([
            { type: 'text', data: { text: '你看这个' } },
            { type: 'json', data: { data: card({ app: 'com.tencent.structmsg', meta: { news: { title: '标题', tag: '知乎' } } }) } },
        ]), '你看这个[分享：知乎《标题》]');
    });
});
