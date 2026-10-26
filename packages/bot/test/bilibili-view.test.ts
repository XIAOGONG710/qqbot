import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { danmakuPeaks, parseDanmakuXml, parseView, viewNote } from '../src/bilibili-view.ts';

const viewJson = {
    bvid: 'BV1xx411c7mD', aid: 12345, title: '楼下三花的一天', desc: '随手拍的', duration: 301, pic: 'http://i0.hdslb.com/a.jpg',
    pages: [{ cid: 999 }],
    view_points: [
        { from: 0, to: 60000, content: '开场：蹲在门口' },
        { from: 60000, to: 180000, content: '吃饭和晒太阳' },
    ],
};

describe('看懂一个视频（ADR 0168）', () => {
    test('view：认标题 / 简介 / 时长 / cid / 章节', () => {
        const view = parseView(viewJson)!;
        assert.equal(view.bvid, 'BV1xx411c7mD');
        assert.equal(view.cid, 999);
        assert.equal(view.duration, 301);
        assert.deepEqual(view.chapters, [
            { from: 0, to: 60000, title: '开场：蹲在门口' },
            { from: 60000, to: 180000, title: '吃饭和晒太阳' },
        ]);
        assert.equal(parseView({}), undefined);
    });

    test('弹幕 XML：认时间 + 正文，转义还原，坏行跳过', () => {
        const points = parseDanmakuXml('<i><d p="1.5,1,25,16777215,0,0,0,0">哈哈&lt;3</d><d p="12,1,25,0"><![CDATA[前面高能]]></d><d p="x">坏行</d></i>');
        assert.equal(points.length, 2);
        assert.deepEqual(points[0], { at: 1.5, text: '哈哈<3' });
        assert.deepEqual(points[1], { at: 12, text: '前面高能' });
    });

    test('高能时刻：10 秒一桶，取前 3，样本去重且 ≤5 条', () => {
        const points = [
            ...Array.from({ length: 9 }, (_, i) => ({ at: 61 + i, text: `这里好笑${i}` })),
            ...Array.from({ length: 4 }, (_, i) => ({ at: 121 + i, text: '猫猫！' })),
            { at: 181, text: '结束' },
        ];
        const peaks = danmakuPeaks(points);
        assert.equal(peaks.length, 3);
        assert.equal(peaks[0]!.at, 60);
        assert.equal(peaks[0]!.count, 9);
        assert.equal(peaks[0]!.samples.length, 5);
        assert.equal(peaks[1]!.at, 120);
        assert.equal(peaks[2]!.at, 180);
    });

    test('给她的一段事实：有章节和弹幕就都写；没有就不编', () => {
        const note = viewNote(parseView(viewJson)!, danmakuPeaks([{ at: 65, text: '猫猫好可爱' }]));
        assert.match(note, /楼下三花的一天/);
        assert.match(note, /分段：0:00 开场：蹲在门口/);
        assert.match(note, /观众反应最强烈的几段/);
        assert.match(note, /猫猫好可爱/);
        const bare = viewNote(parseView({ bvid: 'BV1', title: '空的', duration: 60, pages: [] })!, []);
        assert.equal(bare.includes('分段：'), false);
        assert.equal(bare.includes('观众反应'), false);
    });
});
