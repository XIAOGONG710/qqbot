import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adrMap, liveValues, mergedLive, onOff, readAdr } from './adr-map.mjs';

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

test('{ enabled } 对象看 enabled；被 fewerRules 强制关掉的标出来', () => {
    assert.equal(onOff({ enabled: true, baseUrl: 'x' }), '开');
    assert.equal(onOff({ enabled: false }), '关');
    const files = [{ name: '0091-shape.md', text: '# ADR 0091：形状\n' }, { name: '0223-dsh.md', text: '# ADR 0223：dsh\n' }];
    const features = [{ key: 'shape', adr: '0091' }, { key: 'dsh', adr: '0223' }];
    const md = adrMap(files, features, { shape: true, dsh: { enabled: true } }, '', new Set(['shape']));
    assert.match(md, /`shape` 关（被 fewerRules 关掉）/);
    assert.match(md, /`dsh` 开/);
});

test('开关合并：旧键挂在新键下面；快照里还写着旧键时，新键的线上值从旧键算', () => {
    const files = [{ name: '0083-presence.md', text: '# ADR 0083：存在感\n' }, { name: '0142-control.md', text: '# ADR 0142：控制面\n' }];
    const features = [{ key: 'qzone', adr: '0083', absorbs: [{ key: 'signature', adr: '0083' }, { key: 'qzoneBrowse', adr: '0142' }] }];
    const merges = [{ key: 'qzone', legacy: ['signature', 'qzoneBrowse'] }];
    const mergeInput = (input, defaults) => ({ ...input, qzone: input.qzone ?? defaults.qzone });
    const live = mergedLive({ signature: 'on', qzoneBrowse: 'on', qzone: 'on' }, merges, { qzone: 'off' }, mergeInput);
    const md = adrMap(files, features, live);
    assert.match(md, /\| \[0083\]\(0083-presence\.md\) \| 存在感 \|  \| `qzone`（原 `signature`） 开 \|/);
    assert.match(md, /\| \[0142\]\(0142-control\.md\) \| 控制面 \|  \| `qzone`（原 `qzoneBrowse`） 开 \|/);
    // 新起名字的组：快照里只有旧键，新键的值由合并表算出来
    const renamed = mergedLive({ lampA: true }, [{ key: 'lamp', legacy: ['lampA'] }], { lamp: false }, input => ({ ...input, lamp: input.lampA === true }));
    assert.equal(renamed.lamp, true);
    assert.equal(mergedLive({ other: 1 }, [{ key: 'lamp', legacy: ['lampA'] }], {}, input => ({ ...input, lamp: false })).lamp, undefined, '都没写：照旧「默认」');
});
