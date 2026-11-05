import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitEpisodes, episodeTranscript, localIso, type Episode } from '../src/memory/episodes.ts';
import { clarity, lastTouched } from '../src/memory/fading.ts';
import { localDate } from '../src/local-date.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import type { RecallResult } from '../src/memory/hindsight.ts';
import { spawnSync } from 'node:child_process';

const fact = (extra: Partial<RecallResult>): RecallResult => ({ id: 'synthetic', text: '合成记忆事实', ...extra });
const msg = (time: string, content = '合成正文'): StoredMessage => ({ time, role: 'user', content });

test('无效日记/周记/阶段ID日期不滚动，回退合法事件时间；没有合法时间仍undefined', () => {
    for (const document_id of ['diary:2026-02-30', 'week:2026-02-31', 'phase:合成阶段:2026-11-31']) {
        assert.equal(lastTouched(fact({ document_id })), undefined);
        const mentioned_at = '2026-10-10T12:00:00Z';
        assert.equal(lastTouched(fact({ document_id, mentioned_at }))!.toISOString(), mentioned_at.replace('Z', '.000Z'));
    }
});

test('Hindsight无效ISO日历时间不被Date.parse滚成另一日并盖过合法来源', () => {
    const touched = lastTouched(fact({ occurred_start: '2026-02-30T12:00:00Z', mentioned_at: '2026-02-20T12:00:00Z' }));
    assert.equal(touched!.toISOString(), '2026-02-20T12:00:00.000Z');
});

test('整日跳过仍按civil日数淡化，8天/31天不是经过的7/30个24小时', () => {
    const previous = process.env.TZ;
    try {
        process.env.TZ = 'Pacific/Apia';
        for (const [then, now, expected] of [
            [localDate(2011, 11, 23, 12), localDate(2011, 11, 31, 12), 'vague'],
            [localDate(2011, 11, 1, 12), localDate(2012, 0, 1, 12), 'forgotten'],
        ] as const) assert.equal(clarity(fact({ mentioned_at: then.toISOString() }), { now, heard: '', ignore: [] }), expected);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('split/transcript对坏时间明确安全失败，不生成ep-NaN或伪造自动滚动日期', () => {
    for (const time of ['not-a-date', '2026-02-30T12:00:00Z']) {
        assert.throws(() => splitEpisodes([msg(time, 'PRIVATE_BAD_EPISODE')]), error => !String(error).includes('PRIVATE_BAD_EPISODE'));
        const episode: Episode = { id: 'ep-1', start: new Date(1), end: new Date(1), messages: [msg(time)] };
        assert.throws(() => episodeTranscript(episode, { user: '合成用户', char: '合成角色' }));
    }
});

test('合法低年及OneBot源秒倒置保持发生顺序和既有document ID，不排序或改锚点', () => {
    const first = localDate(99, 10, 10, 12, 0, 0, 600).toISOString();
    const earlier = localDate(99, 10, 10, 12, 0).toISOString();
    const later = localDate(99, 10, 10, 13).toISOString();
    const episodes = splitEpisodes([msg(first, '先收到助手ACK'), msg(earlier, '后收到源秒消息'), msg(later, '下一段')]);
    assert.equal(episodes.length, 2); assert.equal(episodes[0]!.id, `ep-${Date.parse(first)}`);
    assert.deepEqual(episodes[0]!.messages.map(m => m.content), ['先收到助手ACK', '后收到源秒消息']);
    assert.equal(episodes[0]!.start.getFullYear(), 99);
    assert.ok(!episodeTranscript(episodes[0]!, { user: '合成用户', char: '合成角色' }).includes('1999年'));
});

test('localIso只发布支持的本地及UTC四位瞬时，现代与低年合法输出仍准确', () => {
    const previous = process.env.TZ;
    try {
        process.env.TZ = 'Asia/Shanghai';
        for (const date of [new Date(NaN), localDate(10000, 0, 1, 12), localDate(0, 0, 1, 0)]) assert.throws(() => localIso(date));
        for (const date of [localDate(99, 0, 1, 12), localDate(2026, 10, 5, 12)]) {
            const encoded = localIso(date); assert.match(encoded, /^\d{4}-/);
            assert.equal(Date.parse(encoded), Math.floor(date.getTime() / 1000) * 1000);
        }
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('实体是否至少2代码点不全展开大字符串，48MiB子进程正常完成并保留emoji语义', () => {
    const module = new URL('../src/memory/fading.ts', import.meta.url).href;
    const code = `import { clarity } from ${JSON.stringify(module)};
      const base = {id:'synthetic',text:'合成旧事实',mentioned_at:'2020-01-01T00:00:00Z'};
      const options = {now:new Date('2026-11-05T12:00:00Z'),heard:'',ignore:[]};
      console.log(JSON.stringify([
        clarity({...base,entities:['测'.repeat(6_000_000)]},options),
        clarity({...base,entities:['😀']},{...options,heard:'😀'}),
        clarity({...base,entities:['😀😀']},{...options,heard:'😀😀'}),
      ]));`;
    const child = spawnSync(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024 });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr.slice(0, 400));
    assert.deepEqual(JSON.parse(child.stdout), ['forgotten', 'forgotten', 'recognized']);
});
