import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { experiencesFromLife, experiencesFromWatched, Tastes, type Experience, type Taste } from '../src/life/tastes.ts';

// ADR 0162：偏好从经历里长出来，每条带证据
describe('口味', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const day = (n: number) => new Date(2026, 9, 26 - n, 15, 0).toISOString();
    const experiences: Experience[] = [
        ...Array.from({ length: 5 }, (_, i): Experience => ({ ref: `g${i}`, at: day(i + 1), kind: '休闲', text: '打独立游戏' })),
        { ref: 'p1', at: day(2), kind: '休闲', text: '刷摄影区' },
        { ref: 'f1', at: day(3), kind: '吃饭', text: '食堂的鱼香肉丝', outcome: 'bad' },
    ];
    function make(answers: string[], extra: Partial<ConstructorParameters<typeof Tastes>[0]> = {}) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-tastes-'));
        dirs.push(dir);
        const changes: string[] = [];
        let clock = new Date(2026, 9, 26, 12, 0).getTime();
        const asked: string[] = [];
        const tastes = new Tastes({
            dataDir: dir, experiences: () => experiences, now: () => new Date(clock),
            ask: async (_system, user) => { asked.push(user); return answers.shift() ?? '[]'; },
            onChange: (t: Taste, kind) => changes.push(`${kind}:${t.name}`), ...extra,
        });
        return { tastes, asked, changes, advance: (hours: number) => { clock += hours * 3_600_000; } };
    }

    test('有证据的偏好记下来，带着引用的经历；提示词里放“自己慢慢发现的口味”', async () => {
        const { tastes, changes } = make(['[{"name":"独立游戏","stance":"like","strength":2,"why":"这两周玩了五次","refs":["g0","g1","g2"]}]']);
        assert.equal(await tastes.reflect(), 1);
        const [taste] = tastes.list();
        assert.deepEqual([taste!.name, taste!.stance, taste!.strength, taste!.evidence.map(e => e.ref)], ['独立游戏', 'like', 2, ['g0', 'g1', 'g2']]);
        assert.deepEqual(changes, ['new:独立游戏']);
        const line = tastes.promptLine()!;
        assert.match(line, /喜欢独立游戏（这两周玩了五次）/);
        assert.match(line, /不是设定/);
        assert.match(line, /具体是哪个游戏、哪道菜.*别编/);
    });

    test('不合格的丢掉：引用了清单里没有的编号、喜欢只有一条证据、没有理由、名字太短、带括号；不喜欢一条证据就够', async () => {
        const answers = JSON.stringify([
            { name: '摄影', stance: 'like', strength: 2, why: '常刷', refs: ['p1', 'p9'] },
            { name: '游戏', stance: 'like', strength: 2, why: '', refs: ['g0', 'g1'] },
            { name: '食', stance: 'like', strength: 1, why: '好吃', refs: ['g0', 'g1'] },
        ]);
        const a = make([answers]);
        assert.equal(await a.tastes.reflect(), 0);
        assert.deepEqual(a.tastes.list(), []);
        const b = make([JSON.stringify([{ name: '食堂鱼香肉丝', stance: 'dislike', strength: 1, why: '难吃，没吃完', refs: ['f1'] }, { name: '[乱]', stance: 'like', strength: 1, why: 'x', refs: ['g0', 'g1'] }])]);
        assert.equal(await b.tastes.reflect(), 1);
        assert.deepEqual(b.tastes.list().map(t => [t.name, t.stance]), [['食堂鱼香肉丝', 'dislike']]);
    });

    test('一天最多回头看一次；经历太少（不到 6 件）不看；模型出错不记', async () => {
        const { tastes, asked, advance } = make(['[]', '[]']);
        await tastes.reflect();
        await tastes.reflect();
        assert.equal(asked.length, 1);
        advance(21);
        await tastes.reflect();
        assert.equal(asked.length, 2);
        const few = make([], { experiences: () => experiences.slice(0, 3) });
        assert.equal(await few.tastes.reflect(), 0);
        assert.equal(few.asked.length, 0);
        const broken = make([], { ask: async () => { throw new Error('连不上'); } });
        assert.equal(await broken.tastes.reflect(), 0);
    });

    test('同方向补证据加强；相反的偏好要至少 2 条新证据才翻', async () => {
        const first = JSON.stringify([{ name: '独立游戏', stance: 'like', strength: 1, why: '玩得多', refs: ['g0', 'g1'] }]);
        const more = JSON.stringify([{ name: '独立游戏', stance: 'like', strength: 3, why: '一直在玩', refs: ['g1', 'g2', 'g3'] }]);
        const flipOne = JSON.stringify([{ name: '独立游戏', stance: 'dislike', strength: 2, why: '腻了', refs: ['f1'] }]);
        const flipTwo = JSON.stringify([{ name: '独立游戏', stance: 'dislike', strength: 2, why: '腻了', refs: ['f1', 'p1'] }]);
        const { tastes, advance, changes } = make([first, more, flipOne, flipTwo]);
        await tastes.reflect();
        advance(21); await tastes.reflect();
        assert.deepEqual([tastes.list()[0]!.strength, tastes.list()[0]!.evidence.length], [3, 4]);
        advance(21); await tastes.reflect();
        assert.equal(tastes.list()[0]!.stance, 'like', '只有 1 条新证据不翻');
        advance(21); await tastes.reflect();
        assert.equal(tastes.list()[0]!.stance, 'dislike');
        assert.deepEqual(changes, ['new:独立游戏', 'update:独立游戏', 'update:独立游戏']);
    });

    test('生活账 / 看过的视频 → 经历：只收休闲 吃饭 读书 项目，没做成的标结果不好', () => {
        const list = experiencesFromLife([
            { id: 'a', kind: 'leisure', startedAt: day(1), subject: '打独立游戏', result: 'succeeded' },
            { id: 'b', kind: 'study', startedAt: day(1), subject: '作业', result: 'succeeded' },
            { id: 'c', kind: 'work_on_project', startedAt: day(1), subject: '修片', result: 'interrupted' },
            { id: 'd', kind: 'eat', startedAt: day(1), result: 'succeeded' },
        ]);
        assert.deepEqual(list.map(e => [e.ref, e.kind, e.outcome]), [['a', '休闲', undefined], ['c', '项目', 'bad']]);
        assert.deepEqual(experiencesFromWatched([{ bvid: 'BV1', title: '貂蝉教学', day: '2026-10-24' }]).map(e => [e.ref, e.kind]), [['BV1', '看视频']]);
    });
});
