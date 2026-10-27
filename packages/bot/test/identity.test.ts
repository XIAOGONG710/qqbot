import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { describeForPrompt, hashIdentityFiles, Identity, type CommitInfo, type GitProbe } from '../src/memory/identity.ts';

describe('设定账本：醒来核对（ADR 0157）', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    function setup() {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-identity-'));
        dirs.push(root);
        mkdirSync(join(root, 'characters/linmengyao/source'), { recursive: true });
        mkdirSync(join(root, 'characters/linmengyao/st'), { recursive: true });
        const persona = join(root, 'characters/linmengyao/source/persona.yml');
        const card = join(root, 'characters/linmengyao/st/linmengyao-boyfriend.json');
        writeFileSync(persona, 'name: 林梦瑶\n');
        writeFileSync(card, '{"v":1}');
        const git = { head: 'h1', commits: [] as CommitInfo[], dirty: [] as string[] };
        const probe: GitProbe = { head: () => git.head, commits: () => git.commits, dirty: () => git.dirty };
        let minute = 0;
        const identity = new Identity({ repoRoot: root, dataDir: join(root, 'data'), git: probe, now: () => new Date(2026, 9, 26, 0, minute++) });
        return { root, persona, card, git, identity };
    }
    const commit = (subject: string, files: string[]): CommitInfo => ({ hash: 'abcdef1234567', author: 'XIAOGONG710', date: '2026-10-25T21:00:00+08:00', subject, files });

    test('第一次建账；再醒来文件没变：记一条 wake，没有改动', () => {
        const { identity } = setup();
        assert.equal(identity.check().first, true);
        const again = identity.check();
        assert.deepEqual([again.first, again.changes.length, again.chain.ok], [false, 0, true]);
        assert.deepEqual(identity.ledger.read().map(e => e.kind), ['genesis', 'wake']);
    });

    test('设定改了且每个改动的文件都有提交说明、工作区干净：记 change，算有记录', () => {
        const { identity, persona, card, git } = setup();
        identity.check();
        writeFileSync(persona, 'name: 林梦瑶\nfunny: 搞笑女\n');
        writeFileSync(card, '{"v":2}');
        git.head = 'h2';
        git.commits = [commit('ADR 0154 人设微调：搞笑女、会想事情', ['characters/linmengyao/source/persona.yml', 'characters/linmengyao/st/linmengyao-boyfriend.json'])];
        const report = identity.check();
        assert.equal(report.changes.length, 1);
        assert.equal(report.changes[0]!.explained, true);
        assert.deepEqual(report.unexplained, []);
        assert.deepEqual(report.changes[0]!.files.map(f => f.kind), ['changed', 'changed']);
        assert.match(identity.status(), /人设微调：搞笑女/);
        assert.match(identity.status(), /没有「不知道谁改的」改动/);
    });

    test('改了但工作区里有没提交的改动：算没有登记原因，状态里点出来', () => {
        const { identity, persona, git } = setup();
        identity.check();
        writeFileSync(persona, 'name: 别的名字\n');
        git.dirty = ['characters/linmengyao/source/persona.yml'];
        const report = identity.check();
        assert.equal(report.unexplained.length, 1);
        assert.match(identity.status(), /没有登记原因的/);
        assert.match(describeForPrompt(report.changes), /1 处没有登记原因/);
    });

    test('文件新增 / 删除也记；记完之后再核对就没有新改动了（基线跟着走）', () => {
        const { identity, root, card, git } = setup();
        identity.check();
        writeFileSync(join(root, 'characters/linmengyao/st/new.json'), '{}');
        rmSync(card);
        git.commits = [commit('加一张卡', ['characters/linmengyao/st/new.json'])];
        const report = identity.check();
        assert.deepEqual(report.changes[0]!.files.map(f => f.kind).sort(), ['added', 'removed']);
        assert.equal(identity.check().changes.length, 0);
    });

    test('提示词里的背景：有没告诉她的改动才有；告诉过一次就不再放；说明里写着“他不问就别提”', () => {
        const { identity, persona, git } = setup();
        identity.check();
        assert.equal(identity.promptLine(), undefined);
        writeFileSync(persona, 'name: 林梦瑶\nx: 1\n');
        git.commits = [commit('ADR 0154 人设微调', ['characters/linmengyao/source/persona.yml'])];
        identity.check();
        const line = identity.promptLine()!;
        assert.match(line, /人设微调/);
        assert.match(line, /别主动提/);
        identity.markTold();
        assert.equal(identity.promptLine(), undefined);
    });

    test('账本被改过：核对时报「验不过」，状态里也说', () => {
        const { identity } = setup();
        identity.check();
        identity.check();
        const text = readFileSync(identity.ledger.path, 'utf8').replace('"unchanged":true', '"unchanged":false');
        writeFileSync(identity.ledger.path, text);
        assert.equal(identity.check().chain.ok, false);
        assert.match(identity.status(), /验不过/);
    });

    test('hashIdentityFiles：只算 yml / json / md，路径用斜杠、按名字排序', () => {
        const { root } = setup();
        writeFileSync(join(root, 'characters/linmengyao/source/skip.txt'), 'x');
        const files = hashIdentityFiles(root);
        assert.deepEqual(files.map(f => f.path), ['characters/linmengyao/source/persona.yml', 'characters/linmengyao/st/linmengyao-boyfriend.json']);
    });
});
