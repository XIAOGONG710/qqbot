// 状态文件兼容检查（ADR 0070 第 13 项）：用新代码里真正的读取函数，去读一份线上数据目录的副本，看有没有哪个文件会被拒绝。
// 关键状态（行动队列、生活事件账、需要锚点、危机状态、档位）校验失败时程序会拒绝启动——
// 所以上线新代码之前必须先在线上数据的副本上跑一遍，不能等重启时才发现。
// 只读：先把数据目录复制到临时目录再检查，隔离坏文件时的挪动只发生在副本上。

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionQueue } from '../world/action-queue.ts';
import { createCrisisState } from '../emotion/crisis-state.ts';
import { ChatHistory } from '../memory/history.ts';
import { readLifeEvents } from '../world/life-events.ts';
import { loadNeedsAnchor } from '../life/needs.ts';
import { TierRecord } from '../memory/tier-record.ts';
import { readProactiveState } from '../proactive/proactive-state.ts';
import { readPromiseState } from '../life/promise-state.ts';
import { readWeatherStore } from '../world/weather.ts';
import { readAirQualityStore } from '../world/air-quality.ts';
import { readDaylightStore } from '../world/daylight.ts';
import { readCalendarStore } from '../world/calendar.ts';

export interface StateCheck { name: string; file: string; ok: boolean; detail: string }

export function checkStates(dataDir: string, now: Date = new Date()): StateCheck[] {
    const copy = mkdtempSync(join(tmpdir(), 'qqbot-state-check-'));
    try {
        // 表情图片和日志不是状态，不用复制
        cpSync(dataDir, copy, { recursive: true, filter: source => !/[\\/](stickers|logs)([\\/]|$)/.test(source) });
        const checks: StateCheck[] = [];
        const run = (name: string, file: string, work: (log: (message: string) => void) => string | void) => {
            const path = join(copy, file);
            if (!existsSync(path)) {
                checks.push({ name, file, ok: true, detail: '没有这个文件（按空状态开始）' });
                return;
            }
            const logs: string[] = [];
            try {
                const detail = work(message => logs.push(message)) ?? '读取通过';
                const quarantined = logs.find(line => line.includes('挪到'));
                checks.push({ name, file, ok: !quarantined, detail: quarantined ? `会被隔离后从头开始：${quarantined.slice(0, 160)}` : detail });
            } catch (error) {
                checks.push({ name, file, ok: false, detail: `会拒绝启动：${(error instanceof Error ? error.message : String(error)).slice(0, 200)}` });
            }
        };
        run('档位记录', 'tiers.json', () => { new TierRecord(join(copy, 'tiers.json')); });
        run('危机状态', 'crisis.json', log => { createCrisisState(copy, log); });
        run('行动队列', join('world', 'action-queue.json'), log => { actionQueue(join(copy, 'world', 'action-queue.json'), log); });
        run('生活事件账', join('world', 'events.json'), log => `${readLifeEvents(join(copy, 'world', 'events.json'), log).length} 条事件`);
        run('需要锚点', join('world', 'needs-anchor.json'), log => { loadNeedsAnchor(join(copy, 'world', 'needs-anchor.json'), now, log); });

        const chatDir = join(copy, 'chats');
        if (existsSync(chatDir)) {
            for (const name of readdirSync(chatDir).filter(file => file.endsWith('.jsonl'))) {
                const qq = Number(name.replace('.jsonl', ''));
                run(`聊天记录 ${qq}`, join('chats', name), log => {
                    const messages = new ChatHistory(copy, log).load(qq);
                    const lines = readFileSync(join(chatDir, name), 'utf8').split('\n').filter(line => line.trim()).length;
                    const skipped = lines - messages.length;
                    return skipped > 0 ? `${messages.length} 条可用，${skipped} 行会被跳过` : `${messages.length} 条`;
                });
            }
        }
        // 其余只确认是合法 JSON（它们各自的读取函数在对应模块里，坏了会隔离后重建）
        for (const dir of ['memory', 'proactive', 'promises', 'weather', 'air-quality', 'daylight', 'calendar']) {
            const folder = join(copy, dir);
            if (!existsSync(folder)) continue;
            for (const name of readdirSync(folder).filter(file => file.endsWith('.json'))) {
                run(`${dir}/${name}`, join(dir, name), () => {
                    const path = join(folder, name);
                    if (dir === 'proactive' && /^[1-9]\d*-[a-z_]+\.json$/.test(name)) { readProactiveState(path); return '主动消息 v1 schema 通过'; }
                    if (dir === 'promises' && /^[1-9]\d*-[a-z_]+\.json$/.test(name)) { readPromiseState(path); return '承诺 v1 schema 通过'; }
                    if (dir === 'weather' && /^(jinan|qingdao)\.json$/.test(name)) { readWeatherStore(path, undefined, 'throw'); return '天气缓存 schema 通过'; }
                    if (dir === 'air-quality' && /^(jinan|qingdao)\.json$/.test(name)) { readAirQualityStore(path, undefined, 'throw'); return '空气质量缓存 schema 通过'; }
                    if (dir === 'daylight' && /^(jinan|qingdao)\.json$/.test(name)) { readDaylightStore(path, undefined, 'throw'); return '日照缓存 schema 通过'; }
                    if (dir === 'calendar' && name === 'calendar.json') { readCalendarStore(path, undefined, 'throw'); return '法定日历缓存 schema 通过'; }
                    JSON.parse(readFileSync(path, 'utf8'));
                    return '仅 JSON 语法通过（未做运行时 schema 校验）';
                });
            }
        }
        return checks;
    } finally {
        rmSync(copy, { recursive: true, force: true });
    }
}
