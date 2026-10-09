// 长期记忆的日期审计（只读，ADR 0012 2026-10-09 调整）：每条记忆里的日期能不能在它的原文里找到出处——
// 原文的日期行、原文里写明的日期，或者原文里「明天 / 后天 / 昨天 / 这周X / 下周X」按正确规则（含凌晨规则）算出来的日期。
// 找不到出处、又正好和某个相对说法算出来的日期差一天的，列成「疑似数错一天」（10-09 查出 3 条，都是凌晨说的「明天」）。
// 输出带记忆原文片段，只在本机终端看，不要贴进 exchange。
//
// node scripts/memory-date-audit.mjs [bank 前缀，默认 linmengyao-]（跳过 sim- 开头的模拟器 bank）
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const prefix = process.argv[2] ?? 'linmengyao-';
const W = '日一二三四五六';
const DAY = 86_400_000;

function psqlJson(sql) {
    const base = join(homedir(), '.pg0', 'installation');
    const version = existsSync(base) ? readdirSync(base).sort().reverse().find(v => existsSync(join(base, v, 'bin', 'psql.exe'))) : undefined;
    if (!version) throw new Error(`找不到 pg0 的 psql.exe（${base}）`);
    // 中文查询要从文件读、客户端编码要设 UTF8，不然 Windows 终端的 GBK 会把查询弄坏
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-audit-'));
    try {
        writeFileSync(join(dir, 'q.sql'), `select coalesce(json_agg(t), '[]') from (${sql}) t;\n`);
        const out = execFileSync(join(base, version, 'bin', 'psql.exe'), ['-h', '127.0.0.1', '-p', process.env.QQBOT_HINDSIGHT_DB_PORT ?? '5433', '-U', 'hindsight', '-d', 'hindsight', '-At', '-f', join(dir, 'q.sql')], {
            env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? 'hindsight', PGCLIENTENCODING: 'UTF8' }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
        });
        return JSON.parse(out);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const like = prefix.replace(/'/g, "''") + '%';
const units = psqlJson(`select bank_id, document_id, fact_type, text from memory_units where bank_id like '${like}' and bank_id not like 'sim-%'`);
const docs = new Map(psqlJson(`select id, original_text from documents where bank_id like '${like}' and bank_id not like 'sim-%'`).map(d => [d.id, d.original_text ?? '']));

const key = d => `${d.getMonth() + 1}-${d.getDate()}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
const weekday = c => (c === '天' || c === '日' ? 0 : W.indexOf(c));

function relativeDates(text, refDay) {
    const out = [];
    const push = (date, phrase) => out.push({ date, phrase });
    if (/大后天/.test(text)) push(addDays(refDay, 3), '大后天');
    else if (/后天/.test(text)) push(addDays(refDay, 2), '后天');
    if (/明天|明早|明晚|明儿/.test(text)) push(addDays(refDay, 1), '明天');
    if (/今天|今晚|今早|今儿/.test(text)) push(refDay, '今天');
    if (/大前天/.test(text)) push(addDays(refDay, -3), '大前天');
    else if (/前天/.test(text)) push(addDays(refDay, -2), '前天');
    if (/昨天|昨晚|昨儿/.test(text)) push(addDays(refDay, -1), '昨天');
    for (const m of text.matchAll(/(下下|下个?|上个?|这个?|本)?(?:周|星期|礼拜)([一二三四五六日天])/g)) {
        const shift = m[1]?.startsWith('下下') ? 14 : m[1]?.startsWith('下') ? 7 : m[1]?.startsWith('上') ? -7 : 0;
        const wd = weekday(m[2]);
        push(addDays(mondayOf(refDay), shift + (wd === 0 ? 6 : wd - 1)), m[0]);
    }
    return out;
}

function parseDoc(text) {
    let day;
    const rel = [];
    const explicit = new Set();
    for (const line of text.split('\n')) {
        const head = /^——\s*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(line);
        if (head) {
            day = new Date(Number(head[1]), Number(head[2]) - 1, Number(head[3]));
            explicit.add(key(day));
            continue;
        }
        for (const m of line.matchAll(/(\d{1,2})月(\d{1,2})[日号]/g)) explicit.add(`${Number(m[1])}-${Number(m[2])}`);
        if (day) for (const m of line.matchAll(/(?<![月\d])(\d{1,2})号/g)) explicit.add(`${day.getMonth() + 1}-${Number(m[1])}`);
        const msg = /^(.+?) \((\d{2}):(\d{2})\): (.*)$/.exec(line);
        if (!msg || !day) continue;
        // 凌晨 0–5 点还没睡：她的「今天」还是前一天（ADR 0011 调整 12）
        const refDay = Number(msg[2]) < 5 ? addDays(day, -1) : day;
        for (const r of relativeDates(msg[4], refDay)) rel.push({ ...r, at: `${key(day)} ${msg[2]}:${msg[3]}`, who: msg[1] });
    }
    return { rel, explicit };
}

const parsed = new Map();
let checked = 0;
let unexplained = 0;
const suspects = [];
for (const unit of units) {
    const source = docs.get(unit.document_id);
    if (!source) continue;
    if (!parsed.has(unit.document_id)) parsed.set(unit.document_id, parseDoc(source));
    const { rel, explicit } = parsed.get(unit.document_id);
    const ok = new Set([...explicit, ...rel.map(r => key(r.date))]);
    for (const m of unit.text.matchAll(/(?:(20\d\d)年)?(\d{1,2})月(\d{1,2})日(?![–\-~至到]\d)/g)) {
        checked++;
        const date = new Date(Number(m[1] ?? 2026), Number(m[2]) - 1, Number(m[3]));
        if (ok.has(key(date))) continue;
        unexplained++;
        const near = rel.find(r => Math.abs(r.date - date) === DAY);
        if (near) suspects.push(`- [${unit.bank_id} ${unit.fact_type}] …${unit.text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 24)}…  ← ${near.at} ${near.who} 说「${near.phrase}」，应为 ${key(near.date)}（周${W[near.date.getDay()]}）`);
    }
}
console.log(`记忆 ${units.length} 条、原文 ${docs.size} 段（bank 前缀 ${prefix}）；记忆里的日期 ${checked} 处，原文里找不到出处的 ${unexplained} 处，其中和相对说法正好差一天的 ${suspects.length} 处`);
if (suspects.length) console.log(suspects.join('\n'));
