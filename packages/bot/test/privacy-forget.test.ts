import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { botRunning, exportContact, forgetContact, type ForgetApi } from '../src/memory/privacy-forget.ts';
import { HindsightError } from '../src/memory/hindsight.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

/** 全是虚构的：一个联系人 10001 的专属文件、一个混合日志，和别人 10002 的文件 */
function fixture() {
    const base = mkdtempSync(join(tmpdir(), 'qqbot-forget-'));
    dirs.push(base);
    const dir = join(base, 'bot');
    for (const sub of ['chats', 'memory', 'logs']) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, 'chats', '10001.jsonl'), '{"content":"虚构的话"}\n');
    writeFileSync(join(dir, 'chats', '10002.jsonl'), '{"content":"别人的话"}\n');
    writeFileSync(join(dir, 'memory', '10001-boyfriend.json'), JSON.stringify({ bankId: 'demo-private', retained: { e1: 2 }, common: { e1: 2 }, personModel: 'v1' }));
    writeFileSync(join(dir, 'logs', '2026-10-13.log'), '[10001] 收到消息\n[10002] 另一人\n');
    return { base, dir };
}

function fakeApi() {
    const calls: string[] = [];
    const api: ForgetApi = {
        deleteBank: async id => { calls.push(`bank:${id}`); },
        deleteDocument: async (bank, id) => { calls.push(`doc:${bank}:${id}`); },
        deleteMentalModel: async (bank, id) => { calls.push(`model:${bank}:${id}`); },
    };
    return { api, calls };
}

describe('联系人数据导出与遗忘（ADR 0070 第 9 项）', () => {
    test('导出：只复制这个联系人的专属文件并附清单，原文件不动', () => {
        const { base, dir } = fixture();
        const { dir: out, files } = exportContact(dir, 10001, join(base, 'export'), new Date('2026-10-13T10:00:00Z'));
        assert.deepEqual(files.map(file => file.replaceAll('\\', '/')).sort(), ['chats/10001.jsonl', 'memory/10001-boyfriend.json']);
        assert.equal(readFileSync(join(out, 'chats', '10001.jsonl'), 'utf8'), '{"content":"虚构的话"}\n');
        assert.equal(existsSync(join(out, 'chats', '10002.jsonl')), false);
        assert.ok(existsSync(join(out, 'audit.json')));
        assert.ok(existsSync(join(dir, 'chats', '10001.jsonl')), '导出不删原文件');
    });

    test('默认只演练：列出会动的东西，什么都不动，也不碰 Hindsight', async () => {
        const { base, dir } = fixture();
        const { api, calls } = fakeApi();
        const result = await forgetContact(dir, 10001, { apply: false, trashDir: join(base, 'trash'), commonBank: 'demo-common', api });
        assert.equal(result.applied, false);
        assert.deepEqual(result.plan.move.map(file => file.replaceAll('\\', '/')).sort(), ['chats/10001.jsonl', 'memory/10001-boyfriend.json']);
        assert.deepEqual(result.plan.leave.map(item => item.path.replaceAll('\\', '/')), ['logs/2026-10-13.log']);
        assert.deepEqual(result.plan.hindsight.banks, ['demo-private']);
        assert.equal(result.plan.hindsight.documents.length, 1);
        assert.ok(existsSync(join(dir, 'chats', '10001.jsonl')));
        assert.deepEqual(calls, []);
    });

    test('--apply：本地专属文件移进回收目录（能挪回去），Hindsight 的公共文档、印象模型、私人库都删；混合日志和别人的文件不动', async () => {
        const { base, dir } = fixture();
        const { api, calls } = fakeApi();
        const result = await forgetContact(dir, 10001, { apply: true, trashDir: join(base, 'trash'), commonBank: 'demo-common', api, now: new Date('2026-10-13T10:00:00Z'), isAlive: () => false });
        assert.equal(result.applied, true);
        assert.equal(existsSync(join(dir, 'chats', '10001.jsonl')), false);
        assert.ok(existsSync(join(result.trash!, 'chats', '10001.jsonl')), '回收目录里还在');
        assert.ok(existsSync(join(result.trash!, 'forget-report.json')));
        assert.ok(existsSync(join(dir, 'chats', '10002.jsonl')), '别人的不动');
        assert.ok(existsSync(join(dir, 'logs', '2026-10-13.log')), '混合日志不碰');
        assert.deepEqual(calls.map(call => call.split(':')[0]), ['doc', 'model', 'bank']);
        assert.deepEqual(result.failures, []);
        assert.equal(result.deleted.banks[0], 'demo-private');
    });

    test('bot 还在跑（锁被活着的进程持有）就拒绝执行；Hindsight 删除失败会记下来、不假装成功', async () => {
        const { base, dir } = fixture();
        writeFileSync(join(dir, 'bot.lock'), '4242');
        assert.equal(botRunning(dir, pid => pid === 4242), 4242);
        assert.equal(botRunning(dir, () => false), undefined);
        await assert.rejects(() => forgetContact(dir, 10001, { apply: true, trashDir: join(base, 'trash'), commonBank: 'c', isAlive: () => true }), /还在运行/);
        assert.ok(existsSync(join(dir, 'chats', '10001.jsonl')), '拒绝时什么都没动');
        const failing: ForgetApi = {
            deleteBank: async () => { throw new HindsightError('SYNTHETIC_PRIVATE_SERVER_BODY', 503); },
            deleteDocument: async () => {},
            deleteMentalModel: async () => {},
        };
        const result = await forgetContact(dir, 10001, { apply: true, trashDir: join(base, 'trash'), commonBank: 'c', api: failing, isAlive: () => false });
        assert.equal(result.failures.length, 1);
        assert.match(result.failures[0]!, /私人记忆库 demo-private 失败：HTTP 503/);
        assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_SERVER_BODY/);
        assert.deepEqual(result.deleted.banks, []);
    });
});
