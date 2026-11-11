import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { isPrivateTask, privateReason, scrubQueue } from '../../../scripts/ginka-guard.mjs';
import { PRIVATE_FILES } from '../src/platform/private-space.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');

describe('免费网关（第三方）不该看到的东西（用户 10-31：「不想让他们读」聊天记录）', () => {
    test('聊天记录、语料、样本（.jsonl）、runtime 数据、密钥：拒绝；Windows 路径和绝对路径也拦', () => {
        for (const path of [
            'runtime/bot-shadow/chats/100000001.jsonl',
            'C:\\Users\\XG\\Desktop\\qqbot-dsh-control\\runtime\\bot-shadow\\chats\\100000001.jsonl',
            'runtime/bot-shadow/exemplars/corpus.jsonl',
            'exchange/research/2026-10-real-chat/v2/samples.jsonl',
            'exchange/migration/vm-20261027/chats.txt',
            'runtime/bot-shadow/secrets/ginka.json',
            'runtime/bot-shadow/dreams/DREAMS.jsonl',
            '.env',
            'exchange/blind/2026-10-29-framework-ab/pairs.md',
        ]) assert.ok(privateReason(path), path);
    });

    test('她的私人空间文件、他的留痕、日记：不管放在哪都拒绝；和 PRIVATE_FILES 同一批', () => {
        for (const name of PRIVATE_FILES) assert.ok(privateReason(`some/where/${name}`), name);
        for (const name of ['traces.json', 'JOURNAL.md', 'owner-bank.json']) assert.ok(privateReason(`x/${name}`), name);
    });

    test('源码、文档、脚本、研究笔记：可以给（包括目录名撞上 memory / soul / dreams 的源码）', () => {
        for (const path of [
            'packages/bot/src/language/reply.ts',
            'packages/bot/src/memory/history.ts',
            'packages/bot/src/soul/outbox.ts',
            'packages/bot/src/life/dreams.ts',
            'C:/Users/XG/Desktop/qqbot-dsh-control/packages/bot/src/platform/contact.ts',
            'docs/adr/0207-open-questions.md',
            'scripts/ginka-batch.mjs',
            'exchange/research/2026-10-31-deliberate-note-ab.md',
        ]) assert.equal(privateReason(path), undefined, path);
    });

    test('常驻工人的排队任务：来源是聊天 / 语料 / 私人文件的，或者叫「语料诊断」的，整个丢掉；源码和 ADR 的留着', () => {
        const queue = {
            round: 3,
            tasks: [
                { id: '代码审阅|packages\\bot\\src\\language\\reply.ts|1', name: '代码审阅', status: 'pending' },
                { id: 'ADR 摘要|docs\\adr\\0207-open-questions.md|1', name: 'ADR 摘要', status: 'pending' },
                { id: '语料诊断|runtime\\bot-shadow\\chats\\100000001.jsonl|7', name: '语料诊断', status: 'pending', prompt: '宝宝：……（聊天原文）' },
                { id: '语料诊断|runtime\\bot-shadow\\exemplars\\corpus.jsonl|2', name: '语料诊断', status: 'done' },
                { id: '别的名字|runtime/bot-shadow/chats/x.jsonl|1', name: '别的名字', status: 'pending' },
            ],
        };
        assert.equal(isPrivateTask(queue.tasks[0]), false);
        assert.equal(isPrivateTask(queue.tasks[2]), true);
        const { queue: clean, removed } = scrubQueue(queue);
        assert.equal(removed, 3);
        assert.deepEqual(clean.tasks.map(task => task.name), ['代码审阅', 'ADR 摘要']);
        assert.equal(clean.round, 3, '其它字段原样');
        const again = scrubQueue(clean);
        assert.equal(again.removed, 0);
        assert.equal(again.queue, clean, '没有要删的就原样返回同一个对象');
        assert.deepEqual(scrubQueue(undefined), { queue: undefined, removed: 0 });
    });

    test('清单里不能再有读聊天 / runtime 的任务；常驻工人的补活里不能再有聊天记录和语料（改回去这里会红）', () => {
        for (const name of ['ginka-tasks.json', 'ginka-tasks-v2.json', 'ginka-tasks-v3.json']) {
            const tasks = JSON.parse(readFileSync(resolve(repoRoot, 'scripts', name), 'utf8')) as Array<{ name: string; files?: string[] }>;
            for (const task of tasks) for (const file of task.files ?? []) assert.equal(privateReason(file), undefined, `${name} / ${task.name} / ${file}`);
        }
        const worker = readFileSync(resolve(repoRoot, 'scripts/ginka-worker.mjs'), 'utf8');
        assert.ok(!/chats[\\/'",]|100000001|corpus\.jsonl/.test(worker.replace(/\/\/.*$/gm, '')), '补活里没有聊天记录 / 语料的路径');
        assert.ok(worker.includes('scrubQueue') && worker.includes('privateReason'), '工人开工前会清队列、补活会过守卫');
        const batch = readFileSync(resolve(repoRoot, 'scripts/ginka-batch.mjs'), 'utf8');
        assert.ok(batch.includes('privateReason(file)'), '批量驱动读文件前会过守卫');
    });
});
