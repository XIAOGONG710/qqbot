import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adrMap, liveValues, readAdr } from './adr-map.mjs';

test('读 ADR 头：标题去掉编号前缀，状态去加粗、截断、竖线换掉', () => {
    const { title, status } = readAdr('# ADR 0129：她知道梗 | 网上\n\n- 状态：**已实现，未上线**（2026-10-23）\n');
    assert.equal(title, '她知道梗 / 网上');
    assert.equal(status, '已实现，未上线（2026-10-23）');
    assert.ok(readAdr(`# ADR 0001：x\n- 状态：${'很'.repeat(100)}\n`).status.endsWith('…'));
    assert.deepEqual(readAdr('# 没编号的标题\n'), { title: '没编号的标题', status: '' });
});

test('开关按 adr 字段挂上，线上值以快照为准；同号两份标出来', () => {
    const files = [
        { name: '0129-memes.md', text: '# ADR 0129：梗\n- 状态：未上线\n' },
        { name: '0224-a.md', text: '# ADR 0224：甲\n' },
        { name: '0224-b.md', text: '# ADR 0224：乙\n' },
    ];
    const features = [{ key: 'memes', adr: '0129' }, { key: 'biliFeed', adr: '0129' }, { key: 'other', adr: '0001' }];
    const md = adrMap(files, features, { memes: true, biliFeed: 'off' }, 'exchange/live/x.yaml');
    assert.match(md, /\| \[0129\]\(0129-memes\.md\) \| 梗 \| 未上线 \| `memes` 开、`biliFeed` 关 \|/);
    assert.match(md, /同一个编号有两份的\*\*：0224（0224-a\.md、0224-b\.md）/);
    assert.doesNotMatch(md, /`other`/);
    assert.match(adrMap(files, features, {}), /`memes` 默认/);
    assert.match(adrMap(files, features, undefined), /\| `memes`、`biliFeed` \|/);
});

test('快照取 qqbot 插件那一块', () => {
    assert.deepEqual(liveValues('plugins:\n  server:a:\n    port: 1\n  qqbot:b:\n    contacts: []\n    memes: true\n'), { contacts: [], memes: true });
});
