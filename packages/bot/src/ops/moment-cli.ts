// node src/ops/moment-cli.ts list|add|remove [--dir <数据目录>]（作者写下的事，ADR 0102）
//   list                         列出现有的事，和它们此刻在她心里还剩多重
//   add --id <名字> --kind <joy|relief|worry|sad|annoyed|tired> --strength <1|2|3> --cause "<她能说出口的一句事实>" [--at "2026-10-25 20:00"|now] [--half-life <小时>]
//   remove <id>
// 写的是 <数据目录>/moments.json（默认 runtime/bot）；文件由作者管，代码和模型都不往里写。强度：1 小事，2 明显，3 大事。
// 来由要像她自己能说的一句事实（“高数小测没考好”），不要写她的情绪或台词；事情是作者定的，别让她经历作者没批准的大事。

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../memory/json-file.ts';
import { appraisals, FEELING_KINDS, FEELING_NAME, feelingsAt, validMoments, type Moment } from '../emotion/feelings.ts';
import { momentsPath } from '../emotion/moments.ts';
import { calendarDate, stateTimestamp } from '../memory/state-schema.ts';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
class CommandError extends Error {}

function run(): void {
    const values = new Map<string, string>();
    const flags = new Set(['--dir', '--id', '--kind', '--strength', '--cause', '--at', '--half-life']);
    const positional: string[] = [];
    for (let i = 1; i < args.length; i++) {
        const key = args[i]!;
        if (!key.startsWith('--')) { positional.push(key); continue; }
        const value = args[++i];
        if (!flags.has(key) || values.has(key) || !value || value.startsWith('--')) throw new CommandError('用法错误：选项必须有且只有一个值');
        values.set(key, value);
    }
    const one = (name: string) => values.get(name);
    const dir = resolve(process.env.INIT_CWD ?? process.cwd(), one('--dir') ?? resolve(repoRoot, 'runtime/bot'));
    const path = momentsPath(dir);
    const command = args[0];
    if ((command === 'remove' && positional.length !== 1) || (command !== 'remove' && positional.length)) throw new CommandError('用法错误：多余或缺少参数');

    function withWriter(work: () => void): void {
        let database: DatabaseSync | undefined; let locked = false;
        try {
            mkdirSync(dir, { recursive: true });
            try { database = new DatabaseSync(resolve(dir, 'moments.coordination.sqlite'), { timeout: 50 }); database.exec('BEGIN IMMEDIATE'); locked = true; }
            catch (error) {
                const code = (error as { errcode?: number }).errcode;
                if (typeof code === 'number' && [5, 6].includes(code & 0xff)) throw new CommandError('作者事件写入暂时繁忙，请稍后重试');
                throw new CommandError('作者事件协调文件不可用；请停止写者并检查，原文件未重建');
            }
            work();
        } finally {
            // JSON是唯一提交点；释放故障不能把已成功发布改判成应重试。
            if (locked) { try { database!.exec('ROLLBACK'); } catch { /* close仍会释放正常连接。 */ } }
            if (database) { try { database.close(); } catch { /* 不覆盖业务结果或原异常。 */ } }
        }
    }

    function save(state: { moments: Moment[]; [key: string]: unknown }): void {
        try { writeJsonAtomic(path, state); }
        catch (error) {
            let committed = false;
            try { committed = JSON.stringify(load()) === JSON.stringify(state); } catch { /* 保留原写入失败。 */ }
            if (!committed) throw error;
        }
    }

    function load(): { moments: Moment[]; [key: string]: unknown } {
        let parsed: unknown;
        let text: string;
        try { text = readFileSync(path, 'utf8'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { moments: [] };
            throw new CommandError('作者事件文件读取失败；原文件未修改');
        }
        try { parsed = JSON.parse(text); }
        catch { throw new CommandError('作者事件文件格式错误；原文件未修改'); }
        if (!validMoments(parsed)) throw new CommandError('作者事件文件格式不对；原文件未修改');
        return parsed;
    }
    const show = (at: string) => new Date(at).toLocaleString('zh-CN', { hour12: false });

    function momentTime(text: string): Date | undefined {
        if (text === 'now') return new Date();
        const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
        if (!match || !calendarDate(match[1]!) || (match[2] !== undefined && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59))) return undefined;
        const at = new Date(text.replace(' ', 'T'));
        if (!Number.isFinite(at.getTime()) || !stateTimestamp(at.toISOString())) return undefined;
        // 本地时刻不能悄悄跨过DST缺口/整日跳过；带明确偏移的瞬时按其偏移解释。
        if (match[2] !== undefined && match[5] === undefined) {
            const [year, month, day] = match[1]!.split('-').map(Number);
            if (at.getFullYear() !== year || at.getMonth() + 1 !== month || at.getDate() !== day || at.getHours() !== Number(match[2]) || at.getMinutes() !== Number(match[3]) || at.getSeconds() !== Number(match[4] ?? 0)) return undefined;
        }
        return at;
    }

    if (command === 'list') {
        const { moments } = load();
        if (!moments.length) console.log('还没有作者写下的事');
        const now = Date.now();
        for (const moment of moments) {
            const felt = feelingsAt(appraisals({ now, history: [], moments: [moment] }), now)[0];
            console.log(`${moment.id}  ${show(moment.at)}  ${FEELING_NAME[moment.kind]}·${['', '小事', '明显', '大事'][moment.strength]}  ${moment.cause}  → 此刻${felt ? `${felt.level === 'strong' ? '很重' : felt.level === 'clear' ? '明显' : '快散了'}` : '已经散了'}`);
        }
    } else if (command === 'add') {
        const id = one('--id');
        const kind = one('--kind');
        const strength = Number(one('--strength'));
        const cause = one('--cause');
        const atText = one('--at') ?? 'now';
        const at = momentTime(atText);
        const halfLife = one('--half-life');
        if (!id || !kind || !FEELING_KINDS.includes(kind as never) || ![1, 2, 3].includes(strength) || !cause || !at) {
            console.error(`用法：add --id <名字> --kind <${FEELING_KINDS.join('|')}> --strength <1|2|3> --cause "<一句事实>" [--at "2026-10-25 20:00"|now] [--half-life <小时>]`);
            process.exit(2);
        }
        const moment = { id, at: at.toISOString(), kind, strength, cause, ...(halfLife ? { halfLifeH: Number(halfLife) } : {}) };
        withWriter(() => {
            const state = load(); const { moments } = state;
            if (moments.some(existing => existing.id === id)) { console.error(`已经有叫 ${id} 的了；先 remove 再 add`); process.exit(2); }
            const next = [...moments, moment as Moment];
            if (!validMoments({ moments: next })) { console.error('这条不合格（来由 2–60 字，id 只能是字母数字下划线横线）'); process.exit(2); }
            save({ ...state, moments: next });
            console.log(`记下了：${id}（${show(moment.at)}，${FEELING_NAME[moment.kind as Moment['kind']]}，来由：${cause}）`);
        });
    } else if (command === 'remove') {
        const id = positional[0];
        withWriter(() => {
            const state = load(); const { moments } = state;
            if (!id || !moments.some(moment => moment.id === id)) { console.error(`没有叫 ${id} 的`); process.exit(2); }
            save({ ...state, moments: moments.filter(moment => moment.id !== id) });
            console.log(`删掉了：${id}`);
        });
    } else {
        console.error('用法：moment-cli.ts list | add ... | remove <id>');
        process.exit(2);
    }
}

try { run(); }
catch (error) {
    console.error(error instanceof CommandError ? error.message : '作者事件文件操作失败；请检查存储后重试');
    process.exitCode = 2;
}
