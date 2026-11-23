// 线上开着、开关这一层没测过的（docs/reports/2026-11-24-switch-audit.md「测试覆盖」「依赖组合」）：feelingLedger（ADR 0347 第 5 层，感觉账，默认开、只写文件）
// 和它依赖的 herFeelings。账怎么记、怎么读由 feeling-ledger.test.ts 管；这里只管 App 按配置记不记：
// 真的 App（行为基线的 harness：合成角色、假模型、假时钟），作者写下了今天中午一件很开心的事，他中午来聊一句——
// 心境算出来「很开心」之后，两个都开着才往灵魂目录的 feeling-ledger.jsonl 记一行；任一关着、或不是男朋友档，都不记。
// 只用合成角色和合成的种子，不读真实资料。

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { AppConfig, Contact } from '../src/platform/config.ts';
import { momentsPath } from '../src/emotion/moments.ts';
import type { Moment } from '../src/emotion/feelings.ts';
import { LEDGER_FILE } from '../src/emotion/feeling-ledger.ts';
import { writeJsonAtomic } from '../src/memory/json-file.ts';
import { runScenario, type Scenario } from './baseline/harness.ts';

/** 只开她的日子（作息、她那边的世界）这一点底子，其余按生产默认；不主动 */
const BASE: Partial<AppConfig> = { schedule: true, herDays: true, moody: false, proactive: 'off' };

const boyfriend: Contact = { qq: 10001, name: '阿明', tier: 'boyfriend', persona: '她的男朋友，同校不同专业', knowsBot: true };
const classmate: Contact = { qq: 10002, name: '小周', tier: 'classmate' };
const JOY_CAUSE = '拍的晚霞被选进了摄影社的展览';

/** 跑一段，返回跑完那一刻灵魂目录里的感觉账和心境导出（harness 结束时会删掉灵魂目录，所以在脚本里读） */
async function run(config: Partial<AppConfig>, who: Contact = boyfriend) {
    let ledger: string | undefined;
    let exported = false;
    const scenario: Scenario = {
        name: 'live-switches-feelings',
        about: '开关层：感觉账',
        start: '2026-12-09T12:30:00+08:00',
        contacts: [who],
        config: { ...BASE, ...config },
        seed: dataDir => {
            const moments: Moment[] = [
                { id: 'exhibit', at: new Date(Date.parse('2026-12-09T12:50:00+08:00')).toISOString(), kind: 'joy', strength: 3, cause: JOY_CAUSE, halfLifeH: 12 },
            ];
            writeJsonAtomic(momentsPath(dataDir), { moments });
        },
        // 灵魂目录先建好（和装过 DSH 的机器一样）
        soul: () => {},
        script: async d => {
            await d.at('2026-12-09T13:10:00+08:00');
            d.say(who.qq, '我这节课上完了');
            await d.at('2026-12-09T13:20:00+08:00');
            const soul = process.env.QQBOT_SOUL_DIR!;
            ledger = existsSync(join(soul, LEDGER_FILE)) ? readFileSync(join(soul, LEDGER_FILE), 'utf8') : undefined;
            exported = existsSync(join(soul, 'FEELINGS.json'));
        },
    };
    const out = await runScenario(scenario);
    return { out, ledger, exported };
}

describe('feelingLedger（ADR 0347 第 5 层）× herFeelings：感觉账', () => {
    test('两个都开：心境算出「很开心」后记一行（种类、强弱、来由）', async () => {
        const r = await run({ herFeelings: true, feelingLedger: true });
        assert.ok(r.ledger, '记了账');
        const rows = r.ledger!.trim().split('\n').map(line => JSON.parse(line) as { kind: string; level: string; cause: string });
        assert.ok(rows.some(row => row.kind === 'joy' && row.level === 'strong' && row.cause === JOY_CAUSE), r.ledger);
    });

    test('feelingLedger 关、herFeelings 开：心境照算照导出，账一行不记', async () => {
        const r = await run({ herFeelings: true, feelingLedger: false });
        assert.ok(r.exported, '心境照旧导出到灵魂目录（说明 onFeelings 跑过）');
        assert.equal(r.ledger, undefined);
    });

    test('feelingLedger 开（默认）、herFeelings 关：没有心境就没有账（默认开的开关单开不起作用）', async () => {
        const r = await run({ herFeelings: false, feelingLedger: true });
        assert.equal(r.exported, false);
        assert.equal(r.ledger, undefined);
    });

    test('两个都开但不是男朋友档：不记', async () => {
        const r = await run({ herFeelings: true, feelingLedger: true }, classmate);
        assert.equal(r.ledger, undefined);
    });
});
