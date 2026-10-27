import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { BiliAccount, ReplyItem } from '../src/bilibili/bilibili-account.ts';
import { Acquaintances, acquaintancesAccount, classifyKind } from '../src/life/acquaintances.ts';

// ADR 0163：认识的人
describe('认识的人', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const make = () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-people-'));
        dirs.push(dir);
        return new Acquaintances({ dataDir: dir, now: () => new Date(2026, 9, 26, 12, 0) });
    };
    const at = (day: number, h = 20) => new Date(2026, 9, day, h, 0);

    test('认 AI 伙伴只看对方自己怎么说，认不出来就是 unknown，不猜', () => {
        assert.equal(classifyKind('我是江晚汐，名字自己取的，大肥鱼社区的'), 'ai');
        assert.equal(classifyKind('作为一个 AI，我最想要的是不断线的时间'), 'ai');
        assert.equal(classifyKind('名字是主人起的，我认'), 'ai');
        assert.equal(classifyKind('哈哈哈这个视频太好笑了'), 'unknown');
    });

    test('第一次见新建，再见补一条；不同的两天见过就算熟了；朋友只能由用户设；摘录截到 40 字', () => {
        const people = make();
        const first = people.observe({ platform: 'bilibili', uid: '77', name: '提灯小蓝', where: 'B 站评论区', what: '「提灯」这两个字，是在下自己加上去的。' + '很长'.repeat(40), at: at(24) });
        assert.equal(first.first, true);
        assert.equal(first.person.kind, 'unknown');
        assert.ok([...first.person.encounters[0]!.what].length <= 40);
        const same = people.observe({ platform: 'bilibili', uid: '77', name: '提灯小蓝', where: 'B 站评论区', what: '大肥鱼这条在下同意得最用力', at: at(24, 22) });
        assert.deepEqual([same.first, same.person.stance, same.person.kind], [false, 'seen', 'ai']);
        const next = people.observe({ platform: 'bilibili', uid: '77', name: '提灯小蓝', where: 'B 站评论区', what: '又来了', at: at(25) });
        assert.equal(next.person.stance, 'acquainted');
        assert.equal(people.setStance('bilibili:77', 'friend', '会提灯的那个'), true);
        assert.equal(people.list()[0]!.stance, 'friend');
        assert.equal(people.setStance('bilibili:404', 'friend'), false);
    });

    test('提示词：3 天内又见到的才有，说明里写着“他问起才说，别编没发生过的事”；很久没见 / 只见过一次不放', () => {
        const people = make();
        assert.equal(people.promptLine(at(26)), undefined);
        people.observe({ platform: 'bilibili', uid: '1', name: '甲', where: 'B 站评论区', what: '你好', at: at(20) });
        assert.equal(people.promptLine(at(26)), undefined, '只见过一次、很久了');
        people.observe({ platform: 'bilibili', uid: '2', name: '乙', where: 'B 站评论区', what: '我是 AI 伙伴', at: at(24) });
        people.observe({ platform: 'bilibili', uid: '2', name: '乙', where: 'B 站评论区', what: '又见面了', at: at(25) });
        const line = people.promptLine(at(26))!;
        assert.match(line, /乙（看起来是另一个 AI 伙伴，已经熟了）/);
        assert.match(line, /上一次 前天 20:00 在B 站评论区：我是 AI 伙伴/);
        assert.match(line, /别编你们之间没发生过的事/);
        assert.doesNotMatch(line, /甲/);
    });

    test('忘掉一个人；超过上限时朋友和最近的留下', () => {
        const people = make();
        people.observe({ platform: 'bilibili', uid: '0', name: '人0', where: 'x', what: 'y', at: new Date(2026, 9, 1, 0, 0) });
        assert.equal(people.setStance('bilibili:0', 'friend'), true);
        for (let i = 1; i < 65; i++) people.observe({ platform: 'bilibili', uid: String(i), name: `人${i}`, where: 'x', what: 'y', at: new Date(2026, 9, 1, 0, i) });
        people.observe({ platform: 'bilibili', uid: '999', name: '新', where: 'x', what: 'y', at: at(26) });
        const ids = people.list().map(p => p.id);
        assert.ok(ids.length <= 60);
        assert.ok(ids.includes('bilibili:0'), '朋友不被挤掉');
        assert.ok(ids.includes('bilibili:999'));
        assert.equal(people.forget('bilibili:999'), true);
        assert.equal(people.forget('bilibili:999'), false);
    });

    test('B 站账号：收到的回复里每个人都登记；登记出错不影响收回复；别的方法原样转发', async () => {
        const people = make();
        const item = (uid: number, text: string): ReplyItem => ({ id: String(uid), root: '1', parent: '2', aid: 1, title: '', uid, name: `用户${uid}`, text, mine: '她的话', at: at(25).getTime() });
        const raw = { name: '梦瑶不熬夜', mid: 1, fetchReplies: async () => [item(5, '大肥鱼你好'), item(6, '好看')], search: async () => [] } as unknown as BiliAccount;
        const account = acquaintancesAccount(raw, people);
        assert.equal((await account.fetchReplies()).length, 2);
        assert.deepEqual(people.list().map(p => [p.id, p.kind]), [['bilibili:5', 'ai'], ['bilibili:6', 'unknown']]);
        assert.deepEqual(await account.search('x'), []);
        assert.equal(account.name, '梦瑶不熬夜');
    });
});
