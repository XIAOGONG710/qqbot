import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseDmMessages } from '../src/bilibili-account.ts';
import { videoNewsCard, videoShareCard, type BiliVideo } from '../src/bilibili.ts';

const video: BiliVideo = { bvid: 'BV1xx411c7mD', aid: 1, title: '楼下三花的一天', desc: '', owner: '小雨', category: '喵星人', views: 10, likes: 1, duration: 60, link: 'https://www.bilibili.com/video/BV1xx411c7mD', cover: 'https://i0.hdslb.com/a.jpg' };

describe('B 站私信读取 + 分享卡片（ADR 0168）', () => {
    test('私信：区分她/他、解析 JSON 正文、图片占位、按时间排序', () => {
        const messages = parseDmMessages({
            messages: [
                { msg_key: 2, sender_uid: 1820254296, content: '{"content":"看了吗"}', timestamp: 1760000200 },
                { msg_key: 1, sender_uid: 3747573363903633, content: '{"content":"给你发个视频"}', timestamp: 1760000100 },
                { msg_key: 3, sender_uid: 1820254296, content: '{"type":2}', timestamp: 1760000300 },
            ],
        }, 3747573363903633);
        assert.equal(messages.length, 3);
        assert.equal(messages[0]!.text, '给你发个视频');
        assert.equal(messages[0]!.fromMe, true);
        assert.equal(messages[1]!.fromMe, false);
        assert.equal(messages[2]!.text, '[图片]');
        assert.deepEqual(messages.map(message => message.at), [1760000100000, 1760000200000, 1760000300000]);
    });

    test('坏消息跳过；不是数组返回空', () => {
        assert.deepEqual(parseDmMessages({}, 1), []);
        assert.deepEqual(parseDmMessages({ messages: [null, { msg_key: '' }] }, 1), []);
    });

    test('分享卡片：B 站小程序结构，带标题 / 封面 / 跳转链接', () => {
        const card = JSON.parse(videoShareCard(video)) as { app: string; prompt: string; meta: { detail_1: { desc: string; preview: string; jumpUrl: string; appid: number } } };
        assert.equal(card.app, 'com.tencent.miniapp_01');
        assert.match(card.prompt, /楼下三花的一天/);
        assert.equal(card.meta.detail_1.desc, '楼下三花的一天');
        assert.equal(card.meta.detail_1.preview, video.cover);
        assert.equal(card.meta.detail_1.jumpUrl, video.link);
        assert.equal(card.meta.detail_1.appid, 100951776);
    });

    test('新闻卡片：structmsg，旧 QQ 也认', () => {
        const card = JSON.parse(videoNewsCard(video)) as { app: string; meta: { news: { title: string; preview: string; jumpUrl: string; tag: string } } };
        assert.equal(card.app, 'com.tencent.structmsg');
        assert.equal(card.meta.news.title, '楼下三花的一天');
        assert.equal(card.meta.news.tag, '哔哩哔哩');
        assert.equal(card.meta.news.jumpUrl, video.link);
        assert.equal(card.meta.news.preview, video.cover);
    });

    test('没有封面也能出卡片（preview 空串）', () => {
        const card = JSON.parse(videoShareCard({ ...video, cover: undefined })) as { meta: { detail_1: { preview: string } } };
        assert.equal(card.meta.detail_1.preview, '');
    });
});
