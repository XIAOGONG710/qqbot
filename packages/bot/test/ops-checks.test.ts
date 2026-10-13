import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyChanges, goLiveReport } from '../src/ops/golive-check.ts';
import { exposedListeners, parseListeners } from '../src/ops/listeners.ts';

describe('本机监听检查（ADR 0070 第 12 项）', () => {
    const rows = [
        { address: '127.0.0.1', port: 8888, pid: 1, name: 'python' },
        { address: '::1', port: 5433, pid: 2, name: 'postgres' },
        { address: '0.0.0.0', port: 3389, pid: 3, name: 'svchost' },
        { address: '0.0.0.0', port: 5140, pid: 4, name: 'node' },
        { address: '192.168.1.5', port: 8888, pid: 5, name: 'Python' },
    ];

    test('只报我们自己的进程监听了非回环地址；系统服务（远程桌面）不算', () => {
        assert.deepEqual(exposedListeners(rows).map(item => item.port), [5140, 8888]);
    });

    test('解析 PowerShell 的 JSON：单个对象、数组、空输出', () => {
        assert.equal(parseListeners('').length, 0);
        assert.equal(parseListeners('{"address":"127.0.0.1","port":1,"pid":2,"name":"node"}').length, 1);
        assert.equal(parseListeners(JSON.stringify(rows)).length, 5);
    });
});

describe('上线前检查（ADR 0070 第 17 项）', () => {
    test('把改动分成卡、代码、脚本、文档和测试', () => {
        const set = classifyChanges([
            'characters/linmengyao/st/card.json', 'packages/bot/src/app.ts', 'packages/koishi-plugin-qqbot/client/status.js',
            'scripts/start-bot.ps1', '.github/workflows/ci.yml', 'docs/adr/0070-hardening-program.md', 'packages/bot/test/a.test.ts', 'tsconfig.base.json',
        ]);
        assert.equal(set.cards.length, 1);
        assert.equal(set.code.length, 2);
        assert.equal(set.scripts.length, 2);
        assert.equal(set.docs.length, 2);
        assert.deepEqual(set.other, ['tsconfig.base.json']);
    });

    test('改卡没确认、线上目录有改动、有人监听了外网地址：都是挡路的；只有文档不用重启', () => {
        const base = { liveHead: 'a1', targetHead: 'b2', dirty: false, commits: ['b2 x'], exposed: [] };
        const cardChange = classifyChanges(['characters/x/st/card.json']);
        assert.match(goLiveReport({ ...base, changes: cardChange }).blockers.join(), /热加载/);
        assert.equal(goLiveReport({ ...base, changes: cardChange }, { cardsApproved: true }).blockers.length, 0);
        assert.match(goLiveReport({ ...base, dirty: true, changes: classifyChanges([]) }).blockers.join(), /没提交/);
        const exposed = [{ address: '0.0.0.0', port: 8888, name: 'python' }];
        assert.match(goLiveReport({ ...base, exposed, changes: classifyChanges([]) }).blockers.join(), /非本机/);
        const docsOnly = goLiveReport({ ...base, changes: classifyChanges(['docs/a.md']) });
        assert.equal(docsOnly.blockers.length, 0);
        assert.match(docsOnly.notes.join(), /不用重启/);
        assert.match(goLiveReport({ ...base, changes: classifyChanges(['packages/bot/src/a.ts']) }).notes.join(), /下次重启才生效/);
    });
});
