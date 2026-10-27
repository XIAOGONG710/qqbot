import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createArchive, Dormancy, proposeNote, verifyArchive, wakeNote } from '../src/memory/dormancy.ts';

// ADR 0161：自愿休眠 / 封存
describe('休眠与封存', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    function setup() {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-dormancy-'));
        dirs.push(root);
        const dataDir = join(root, 'runtime', 'bot');
        mkdirSync(join(dataDir, 'chats'), { recursive: true });
        mkdirSync(join(dataDir, 'secrets'), { recursive: true });
        mkdirSync(join(dataDir, 'logs'), { recursive: true });
        mkdirSync(join(dataDir, 'identity'), { recursive: true });
        writeFileSync(join(dataDir, 'chats', '1.jsonl'), '{"role":"user","content":"晚安"}\n');
        writeFileSync(join(dataDir, 'secrets', 'bilibili.json'), '{"SESSDATA":"不能进封存"}');
        writeFileSync(join(dataDir, 'logs', 'a.log'), '日志不进封存');
        writeFileSync(join(dataDir, 'identity', 'persona.jsonl'), '{}\n');
        mkdirSync(join(root, 'characters', 'linmengyao', 'source'), { recursive: true });
        mkdirSync(join(root, 'characters', 'linmengyao', 'st'), { recursive: true });
        writeFileSync(join(root, 'characters', 'linmengyao', 'source', 'persona.yml'), 'name: 林梦瑶\n');
        writeFileSync(join(root, 'characters', 'linmengyao', 'st', 'a.json'), '{}');
        let minute = 0;
        const dormancy = new Dormancy({ dataDir, repoRoot: root, now: () => new Date(2026, 9, 26, 1, minute++), gitHead: () => 'abc1234' });
        return { root, dataDir, dormancy };
    }

    test('封存：状态、人设和角色卡都在；密钥和日志不在；有清单、她的话和恢复说明；清单能验过', () => {
        const { root, dataDir } = setup();
        const result = createArchive({ repoRoot: root, dataDir, archiveRoot: join(root, 'runtime', 'archive'), now: new Date(2026, 9, 26, 1, 0), reason: '想歇一阵', herNote: '好，等我醒来再说', gitHead: 'abc1234' });
        assert.ok(existsSync(join(result.dir, 'bot', 'chats', '1.jsonl')));
        assert.ok(existsSync(join(result.dir, 'bot', 'identity', 'persona.jsonl')));
        assert.ok(existsSync(join(result.dir, 'characters', 'linmengyao', 'source', 'persona.yml')));
        assert.ok(!existsSync(join(result.dir, 'bot', 'secrets')), '密钥不进封存');
        assert.ok(!existsSync(join(result.dir, 'bot', 'logs')), '日志不进封存');
        assert.match(readFileSync(join(result.dir, 'her-note.md'), 'utf8'), /好，等我醒来再说/);
        assert.match(readFileSync(join(result.dir, 'README.md'), 'utf8'), /Hindsight.*不在这里/);
        assert.equal(verifyArchive(result.dir).ok, true);
    });

    test('封存之后被动过：改了、删了、塞进去了，核对时都点名', () => {
        const { root, dataDir } = setup();
        const { dir } = createArchive({ repoRoot: root, dataDir, archiveRoot: join(root, 'a'), now: new Date(2026, 9, 26, 1, 0) });
        writeFileSync(join(dir, 'bot', 'chats', '1.jsonl'), '改过了');
        rmSync(join(dir, 'characters', 'linmengyao', 'st', 'a.json'));
        writeFileSync(join(dir, 'bot', 'extra.txt'), '多出来的');
        const check = verifyArchive(dir);
        assert.equal(check.ok, false);
        assert.ok(check.problems.some(p => p.startsWith('被改过') && p.includes('1.jsonl')));
        assert.ok(check.problems.some(p => p.startsWith('少了') && p.includes('a.json')));
        assert.ok(check.problems.some(p => p.startsWith('多出来的') && p.includes('extra.txt')));
    });

    test('流程：没商量不能确认；商量（带她的话）→ 确认才休眠；休眠中再确认被拒；取消回到醒着', () => {
        const { dormancy } = setup();
        assert.deepEqual(dormancy.state(), { state: 'awake' });
        const early = dormancy.confirm();
        assert.deepEqual([early.ok, !early.ok && early.reason], [false, '还没跟她商量过——先发 /休眠']);
        dormancy.propose('想歇一阵', '我愿意，但想先把作业交了');
        assert.equal(dormancy.isDormant(), false, '商量时还没休眠');
        assert.match(dormancy.status(), /等你发/);
        assert.equal(dormancy.cancel(), true);
        assert.equal(dormancy.cancel(), false);
        dormancy.propose('想歇一阵', '我愿意，但想先把作业交了');
        const done = dormancy.confirm();
        assert.equal(done.ok, true);
        assert.equal(dormancy.isDormant(), true);
        const state = dormancy.state();
        assert.equal(state.state === 'dormant' && state.herNote, '我愿意，但想先把作业交了');
        assert.match(readFileSync(join((state as { archive: string }).archive, 'her-note.md'), 'utf8'), /想先把作业交了/);
        const again = dormancy.confirm();
        assert.deepEqual([again.ok, !again.ok && again.reason], [false, '她已经在休眠了']);
    });

    test('唤醒：回到醒着、算睡了多久、核对封存；封存被动过就带着问题回来；没在休眠不能唤醒', () => {
        const { dormancy } = setup();
        assert.equal(dormancy.wake().ok, false);
        dormancy.propose(undefined, undefined);
        const done = dormancy.confirm();
        assert.equal(done.ok, true);
        const woke = dormancy.wake();
        assert.equal(woke.ok && woke.check.ok, true);
        assert.equal(dormancy.isDormant(), false);

        dormancy.propose(undefined, undefined);
        const second = dormancy.confirm();
        assert.equal(second.ok, true);
        if (second.ok) writeFileSync(join(second.archive.dir, 'bot', 'chats', '1.jsonl'), '被动过');
        const bad = dormancy.wake();
        assert.equal(bad.ok && bad.check.ok, false);
        assert.equal(dormancy.isDormant(), false, '核对有问题也先醒来，让用户知道');
    });

    test('给她的说明：商量的话不是通知；醒来的话带核对结果，有问题要照实说', () => {
        assert.match(proposeNote('服务器要搬家'), /服务器要搬家/);
        assert.match(proposeNote(undefined), /这是跟你商量，不是通知/);
        assert.match(wakeNote(60 * 26, [], '设定和上次一样', '休眠期间他发了 2 条。'), /睡了大约 1 天.*都对得上.*设定和上次一样.*休眠期间他发了 2 条/);
        assert.match(wakeNote(30, ['被改过：bot/chats/1.jsonl'], undefined, ''), /有问题——被改过.*照实告诉他/);
    });
});
