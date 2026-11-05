/**
 * M31 本地文档修订探针；正式正确行为回归另在 packages/bot/test/。
 * 从仓库根执行：node docs/reviews/repro/memory-recall-progress.mjs
 * 仅使用临时合成聊天和假 API，无网络、无真实角色卡或 runtime 读取。
 * 两种场景均断言稳定文档已遮盖；假API按同步覆盖模型执行。
 * 不用此探针证明真实服务异步顺序、派生模型修订或彻底遗忘。
 */
import assert from 'node:assert/strict';
import { basename, dirname, join, resolve } from 'node:path';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { LongTermMemory, OPEN_EPISODE_STEP } from '../../../packages/bot/src/memory/long-term.ts';
import { ChatHistory, RECALLED_TEXT } from '../../../packages/bot/src/memory/history.ts';
import { EPISODE_GAP_MS, splitEpisodes } from '../../../packages/bot/src/memory/episodes.ts';

const now = Date.parse('2026-11-05T12:30:00Z');
const contact = { qq: 10001, tier: 'classmate' };
const names = { char: 'Synthetic Character', user: 'Synthetic User' };
const marker = 'SYNTHETIC_WITHDRAWN_SECRET';
const prefix = 'qqbot-recall-progress-';

async function reproduce(queued) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const history = new ChatHistory(dir), documents = new Map(), calls = [];
    let release, started = false, first, second;
    const ready = new Promise(resolveReady => { release = resolveReady; });
    const api = {
        putBank: async () => { if (queued && !started) { started = true; await ready; } },
        retain: async (bank, item) => {
            calls.push({ bank, id: item.document_id, containsWithdrawn: item.content.includes(marker) });
            // 假供应商按稳定文档 ID 覆盖，排除“供应商不支持覆盖”这一额外因素。
            documents.set(`${bank}/${item.document_id}`, structuredClone(item));
        },
        getMentalModel: async () => undefined,
        createMentalModel: async () => {}, updateMentalModel: async () => {},
        refreshMentalModel: async () => '', recall: async () => [],
    };
    const memory = new LongTermMemory({ api, dir, bankPrefix: 'synthetic', recallTimeoutMs: 100,
        log() {}, now: () => now, common: true });
    try {
        for (let i = 0; i < OPEN_EPISODE_STEP; i++) history.append(contact.qq, {
            role: 'user', content: i === 15 ? marker : `synthetic message ${i}`,
            time: new Date(now - 15 * 60_000 + i * 1000).toISOString(), messageId: i + 1,
        });
        const initial = history.load(contact.qq), episode = splitEpisodes(initial)[0];
        assert.equal(initial.some(message => message.role === 'assistant'), false);
        assert.equal(splitEpisodes(initial).length, 1);
        assert.ok(now - episode.end.getTime() < EPISODE_GAP_MS, '必须是尚未结束的片段');
        first = memory.sync(contact, names, initial);
        if (queued) {
            const end = Date.now() + 2000;
            while (!started) { assert.ok(Date.now() < end, '等待假 API 超时'); await new Promise(resolveWait => setTimeout(resolveWait, 2)); }
        } else await first;

        const before = calls.length;
        assert.equal(history.recall(contact.qq, 16), true);
        const redacted = history.load(contact.qq);
        assert.equal(redacted[15].content, RECALLED_TEXT);
        assert.equal(redacted.length, initial.length);
        second = memory.sync(contact, names, redacted);
        release();
        await Promise.all([first, second]);

        const own = [...documents].filter(([key]) => key.startsWith(`${memory.bankId(contact)}/`));
        const common = [...documents].filter(([key]) => key.startsWith(`${memory.commonBankId()}/`));
        assert.equal(own.length, 1); assert.equal(common.length, 1);
        assert.ok(!own[0][1].content.includes(marker), '私人文档必须覆盖已撤回正文');
        assert.ok(!common[0][1].content.includes(marker), '公共文档必须覆盖已撤回正文');
        assert.ok(own[0][1].content.includes(RECALLED_TEXT));
        assert.ok(common[0][1].content.includes(RECALLED_TEXT));
        assert.equal(calls.length, queued ? 2 : 4);
        if (queued) assert.ok(calls.every(call => !call.containsWithdrawn), '未派发旧快照不能晚提交');
        console.log(JSON.stringify({ diagnostic: 'M31-local-revision-verified',
            case: queued ? 'queued snapshot held during withdrawal' : 'previously retained open episode withdrawn',
            openEpisode: true, assistantReplies: 0, messageCount: redacted.length, historyRedacted: true,
            retainCallsBeforeRecall: before, totalRetainCalls: calls.length, ownStillOriginal: false, commonStillOriginal: false }));
    } finally {
        release();
        await Promise.allSettled([first, second]);
        await memory.stop();
        // 递归清理前验证解析后的绝对目标是本脚本创建的直接临时子目录。
        const target = resolve(dir);
        assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith(prefix));
        assert.equal(lstatSync(target).isSymbolicLink(), false);
        rmSync(target, { recursive: true, force: true });
    }
}

await reproduce(false);
await reproduce(true);
