// 拿提示词指纹清单（<数据目录>/logs/prompt-manifest-<日期>.jsonl，packages/bot/src/platform/prompt-manifest.ts）核对 SELF.json（ADR 0347 第 2 层）：
// SELF 的每一行和他最近一次 QQ 提示词「此刻」块里同一个槽的那一段，sha256 是不是一样。只读，不改任何东西；只输出槽名和对不对得上，**从不输出正文**。
// 两边是不同时刻算的（SELF 每 5 分钟刷新，清单是他上一次说话时的）：时间、状态这种跟着钟走的槽对不上不一定是错，看两边的时刻。
//
// 用法：node scripts/prompt-manifest-diff.mjs <数据目录> [--self <SELF.json 路径>] [--qq <他的 QQ>]
//   数据目录是 Koishi 配置里的 dataDir（线上是 runtime/bot-shadow）；SELF.json 默认在灵魂目录（QQBOT_SOUL_DIR，默认 ~/.dsh/linmengyao）；
//   --qq 不给就用清单里最近一次回他 / 主动找他的那一份。全部一致退出码 0，否则 1。

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST_FILE = /^prompt-manifest-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const sha256 = text => createHash('sha256').update(String(text), 'utf8').digest('hex');

/** 清单里最近的一份（按文件日期、文件里的先后）：给了 qq 只看他的；只认回他 / 主动找他（reply / initiate）——想一想不是聊天的提示词，群里开口 / 审稿重写 / 挑候选（v2）没有「此刻」块的段落 */
export function latestManifest(logsDir, { qq } = {}) {
    let names = [];
    try { names = readdirSync(logsDir).filter(name => MANIFEST_FILE.test(name)).sort(); } catch { return undefined; }
    for (const name of names.reverse()) {
        let lines = [];
        try { lines = readFileSync(join(logsDir, name), 'utf8').split('\n').filter(line => line.trim()); } catch { continue; }
        for (const line of lines.reverse()) {
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (!entry || !Array.isArray(entry.pieces) || (entry.kind !== 'reply' && entry.kind !== 'initiate')) continue;
            if (qq !== undefined && entry.qq !== qq) continue;
            return entry;
        }
    }
    return undefined;
}

/** 按槽分组、保持先后 */
const bySlot = items => {
    const map = new Map();
    for (const item of items) map.set(item.slot, [...(map.get(item.slot) ?? []), item]);
    return map;
};

/**
 * 逐槽比：SELF 的第 i 行和提示词「此刻」块里同一个槽的第 i 段比 sha256。
 * selfSlots 是 SELF 会导出的槽（slots.ts 的 SELF_SLOTS）：提示词里有、SELF 里没有的这些槽记「只在提示词」；别的槽不管。
 * 结果只有槽名、第几段和状态：一致 / 不一致 / 只在 SELF / 只在提示词 / 提示词里被预算挤掉
 */
export function compareSelf(self, manifest, selfSlots) {
    const wanted = new Set(selfSlots);
    const lines = bySlot((self?.lines ?? []).filter(line => line && typeof line.slot === 'string' && typeof line.text === 'string'));
    const pieces = bySlot((manifest?.pieces ?? []).filter(piece => piece.list === 'now' && wanted.has(piece.slot)));
    const order = [...selfSlots, ...[...lines.keys()].filter(slot => !wanted.has(slot))];
    const rows = [];
    for (const slot of order) {
        const mine = lines.get(slot) ?? [];
        const theirs = pieces.get(slot) ?? [];
        for (let i = 0; i < Math.max(mine.length, theirs.length); i++) {
            const line = mine[i];
            const piece = theirs[i];
            const status = !piece ? 'only-self' : !line ? 'only-prompt' : piece.omitted ? 'omitted' : sha256(line.text) === piece.sha256 ? 'match' : 'mismatch';
            rows.push({ slot, index: i, status, ...(piece?.module ? { module: piece.module } : {}) });
        }
    }
    return { rows, selfAt: self?.at, manifestAt: manifest?.at, qq: manifest?.qq, kind: manifest?.kind };
}

const LABEL = { match: '一致', mismatch: '不一致', 'only-self': '只在 SELF', 'only-prompt': '只在提示词', omitted: '提示词里被预算挤掉' };
const KIND = { reply: '回他', initiate: '主动找他' };

/** 给人看的结果：只有槽名、模块、状态和两边的时刻 */
export function describe(result) {
    const out = ['提示词指纹清单 vs SELF.json（只比 sha256，不显示正文）', `清单：${result.manifestAt ?? '?'} ${KIND[result.kind] ?? result.kind ?? ''}（QQ ${result.qq ?? '?'}）；SELF：${result.selfAt ?? '?'}`];
    for (const row of result.rows) out.push(`  ${LABEL[row.status].padEnd(6, '　')} ${row.slot}${row.index ? ` #${row.index + 1}` : ''}${row.module ? `（${row.module}）` : ''}`);
    const counts = Object.entries(LABEL).map(([key, label]) => [label, result.rows.filter(row => row.status === key).length]).filter(([, n]) => n);
    out.push(`合计：${counts.length ? counts.map(([label, n]) => `${label} ${n}`).join('，') : '没有可比的槽'}`);
    if (result.rows.some(row => row.status !== 'match')) out.push('两边不是同一时刻算的：时间、状态这类跟着钟走的槽对不上，先看两边的时刻再下结论。');
    return out.join('\n');
}

async function main() {
    const args = process.argv.slice(2);
    const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const dataDir = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : undefined;
    if (!dataDir) {
        console.error('用法：node scripts/prompt-manifest-diff.mjs <数据目录> [--self <SELF.json 路径>] [--qq <他的 QQ>]');
        process.exit(2);
    }
    const selfPath = resolve(option('--self') ?? join(process.env.QQBOT_SOUL_DIR ?? join(homedir(), '.dsh', 'linmengyao'), 'SELF.json'));
    const qqText = option('--qq');
    let self;
    try { self = JSON.parse(readFileSync(selfPath, 'utf8')); } catch (error) {
        console.error(`读不了 SELF.json（${selfPath}）：${error instanceof Error ? error.message : String(error)}`);
        process.exit(2);
    }
    const manifest = latestManifest(join(dataDir, 'logs'), qqText ? { qq: Number(qqText) } : {});
    if (!manifest) {
        console.error(`${join(dataDir, 'logs')} 里没有提示词指纹清单${qqText ? `（QQ ${qqText}）` : ''}：他还没跟她说过话，或者宿主没开清单`);
        process.exit(2);
    }
    const { SELF_SLOTS } = await import(pathToFileURL(resolve(import.meta.dirname, '../packages/bot/src/interpreter/slots.ts')).href);
    const result = compareSelf(self, manifest, SELF_SLOTS);
    console.log(describe(result));
    process.exit(result.rows.length && result.rows.every(row => row.status === 'match') ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
