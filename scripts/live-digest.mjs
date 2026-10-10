// 线上日报（长期计划第 12 节第 1 周 P2「线上观测指标」）：从 Koishi 的日志里数一天的回复、气泡、延迟、出口检查、记忆、世界书、主动消息，
// 只出数字和类别，不出聊天原文和 QQ 号（联系人按档位称呼）。
//
// node scripts/live-digest.mjs [YYYY-MM-DD，默认今天] [日志目录，默认 runtime/koishi/data/logs]
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = process.argv[2] ?? localDay(new Date());
const logDir = resolve(process.argv[3] ?? join(root, 'runtime', 'koishi', 'data', 'logs'));
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error('用法：node scripts/live-digest.mjs [YYYY-MM-DD] [日志目录]');
    process.exit(1);
}

// 日志文件按启动那天命名，一个文件可能跨天：读前一天和这一天的，按每行的时间筛
const [y, m, d] = day.split('-').map(Number);
const before = localDay(new Date(y, m - 1, d - 1));
const files = readdirSync(logDir).filter((name) => name.startsWith(`${day}-`) || name.startsWith(`${before}-`)).sort();
const entries = [];
for (const name of files) {
    for (const line of readFileSync(join(logDir, name), 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let o;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        const at = new Date(o.timestamp);
        if (Number.isNaN(at.getTime()) || localDay(at) !== day) continue;
        entries.push({ at, type: o.type, name: o.name, text: String(o.content ?? '').replace(/\x1b\[[0-9;]*m/g, '') });
    }
}
entries.sort((a, b) => a.at - b.at);

const count = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const top = (map, limit = 12) => [...map].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, v]) => `${k} ${v}`).join('、') || '无';
const quantile = (xs, q) => {
    if (xs.length === 0) return undefined;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const secs = (ms) => (ms === undefined ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${(ms / 60_000).toFixed(1)} 分`);

const tiers = new Map(); // qq → 档位
const people = new Map();
const person = (qq) => {
    if (!people.has(qq)) {
        people.set(qq, { received: 0, replies: 0, bubbles: new Map(), toSeen: [], toReply: [], regenerated: 0, wrappedUp: 0, interrupted: 0, pending: undefined, seen: undefined });
    }
    return people.get(qq);
};
const intents = new Map();
const lengths = new Map();
const exitChecks = new Map();
let rewrittenOk = 0;
const scenes = new Map();
const memory = { recalls: 0, recallFailed: 0, commonFailed: 0, writeFailed: 0, sameThing: 0, submitted: 0 };
const proactiveSent = new Map();
const proactiveSkipped = new Map();
// 听语音、看图（ADR 0052 / 0055）：media.ts 每读一段记一行
const media = { voiceOk: 0, voiceFailed: 0, ocrText: 0, ocrNone: 0, visionOk: 0, visionFailed: 0 };
const background = { promises: 0, followUpsAdded: 0, followUpsAsked: 0, followUpsMissed: 0, followUpsDropped: 0, diary: [], modelRetries: 0, replyFailed: 0 };
const starts = [];
let napcatDrops = 0;
const problems = new Map();

const ROSTER = /名单：(.*)；/;
const SEEN = /(正聊着|冷场，过一会儿才看到|在睡觉，起床后看到|在上课，下课后看到|[^，]+)，(\d{2}):(\d{2}):(\d{2}) 看到$/;

for (const { at, type, name, text } of entries) {
    if (name === 'app' && text.startsWith('Koishi/')) starts.push(at);
    if (type !== 'info' && type !== 'success') count(problems, `${name} ${type}：${text.replace(/\d{5,}/g, '…').slice(0, 40)}`);
    if (name !== 'qqbot') continue;
    const roster = ROSTER.exec(text);
    if (roster) {
        for (const [, qq, tier] of roster[1].matchAll(/(\d+)（[^，]*，(\w+)）/g)) tiers.set(qq, tier);
        continue;
    }
    if (text.startsWith('NapCat 连接断开')) napcatDrops++;
    if (text.startsWith('她的日记：') && text.includes('已写')) background.diary.push(text.replace(/（.*$/, '').replace('她的日记：', ''));
    const tagged = /^\[(\d+)\] (.*)$/s.exec(text);
    if (!tagged) continue;
    const [, qq, body] = tagged;
    const p = person(qq);
    if (body.startsWith('收到：')) {
        p.received++;
        p.pending ??= at;
    } else if (SEEN.test(body) && p.pending) {
        const [, , hh, mm, ss] = SEEN.exec(body);
        let seen = new Date(at.getFullYear(), at.getMonth(), at.getDate(), Number(hh), Number(mm), Number(ss));
        if (seen < p.pending) seen = new Date(seen.getTime() + 86_400_000);
        p.seen ??= seen;
    } else if (body.startsWith('已回复')) {
        p.replies++;
        const n = Number(/^已回复（(\d+) 条）/.exec(body)?.[1] ?? 1);
        count(p.bubbles, n >= 4 ? '4+' : String(n));
        if (p.pending) {
            p.toReply.push(at - p.pending);
            if (p.seen) p.toSeen.push(p.seen - p.pending);
        }
        p.pending = undefined;
        p.seen = undefined;
    } else if (body.startsWith('生成期间收到新消息')) p.regenerated++;
    else if (body.startsWith('她已经收尾')) p.wrappedUp++;
    else if (body.startsWith('发送中途对方插话')) p.interrupted++;
    else if (body.startsWith('这一轮有意图：')) count(intents, body.slice(7).split(/[，；]/)[0]);
    else if (body.startsWith('这一轮说话：')) count(lengths, body.slice(6));
    else if (body.startsWith('出口检查：')) {
        if (body.includes('重写后通过')) rewrittenOk++;
        else count(exitChecks, /最近(说|用)过/.test(body) ? '重复' : /怪对方/.test(body) ? '怪对方没说' : /助手腔/.test(body) ? '助手腔' : /做不到/.test(body) ? '做不到的事' : /禁用/.test(body) ? '禁用词' : /算账/.test(body) ? '算账' : '其他');
    } else if (/命中世界书 /.test(body)) {
        const hit = /命中世界书 ([^，]*)/.exec(body)[1];
        if (hit !== '无') for (const s of hit.split('、')) count(scenes, s.replace(/（.*）/, ''));
    }
    if (body.startsWith('听语音：转出')) media.voiceOk++;
    if (body.startsWith('听语音：没转出来')) media.voiceFailed++;
    if (body.startsWith('看图：上面有')) media.ocrText++;
    if (body.startsWith('看图：没认出字')) media.ocrNone++;
    if (body.startsWith('看图：看图模型说了')) media.visionOk++;
    if (body.startsWith('看图：看图模型没看出来')) media.visionFailed++;
    if (body.startsWith('召回长期记忆')) {
        memory.recalls++;
        memory.sameThing += Number(/同一件事多的 (\d+)/.exec(body)?.[1] ?? 0);
    }
    if (body.startsWith('记忆召回失败')) memory.recallFailed++;
    if (body.startsWith('公共记忆召回失败')) memory.commonFailed++;
    if (body.startsWith('记忆写入失败')) memory.writeFailed++;
    if (body.startsWith('记忆：片段')) memory.submitted++;
    if (body.startsWith('主动找他（') && /）（\d+ 条）：|）：(?!生成)/.test(body)) count(proactiveSent, /^主动找他（([^（]+)/.exec(body)[1]);
    if (body.startsWith('主动：') && body.includes('不发：')) count(proactiveSkipped, body.split('不发：')[1]);
    if (body.startsWith('她答应的事：记下')) background.promises++;
    if (body.startsWith('待跟进：记下')) background.followUpsAdded++;
    if (/^待跟进：(试运行里)?问过了/.test(body)) background.followUpsAsked++;
    if (body.startsWith('待跟进：她没问出口')) background.followUpsMissed++;
    if (body.includes('是冲着她的事，不记')) background.followUpsDropped++;
    if (body.startsWith('模型接口连接失败')) background.modelRetries++;
    if (body.startsWith('回复失败')) background.replyFailed++;
}

const out = [];
out.push(`# 线上日报 ${day}`, '');
out.push(`- 日志：${files.join('、') || '没有'}，这一天 ${entries.length} 行`);
out.push(`- Koishi 启动 ${starts.length} 次${starts.length ? `（${starts.map((t) => t.toTimeString().slice(0, 5)).join('、')}）` : ''}；NapCat 断开 ${napcatDrops} 次`);
out.push('', '## 每个联系人', '');
out.push('| 档位 | 收到 | 回复 | 气泡 1 / 2 / 3 / 4+ | 收到→看到 中位 / p90 | 收到→回复 中位 / p90 | 带新消息重生成 | 她收尾后不回 | 发送中途被插话 |');
out.push('| --- | ---: | ---: | --- | --- | --- | ---: | ---: | ---: |');
for (const [qq, p] of people) {
    if (p.received === 0 && p.replies === 0) continue;
    const b = ['1', '2', '3', '4+'].map((k) => p.bubbles.get(k) ?? 0).join(' / ');
    out.push(`| ${tiers.get(qq) ?? '名单外'} | ${p.received} | ${p.replies} | ${b} | ${secs(quantile(p.toSeen, 0.5))} / ${secs(quantile(p.toSeen, 0.9))} | ${secs(quantile(p.toReply, 0.5))} / ${secs(quantile(p.toReply, 0.9))} | ${p.regenerated} | ${p.wrappedUp} | ${p.interrupted} |`);
}
out.push('', '## 生成', '');
out.push(`- 意图行：${top(intents)}`);
out.push(`- 长短：${top(lengths)}`);
out.push(`- 出口检查介入：${top(exitChecks)}；重写后通过 ${rewrittenOk}`);
out.push(`- 世界书命中：${top(scenes)}`);
out.push('', '## 听语音、看图', '');
out.push(`- 语音转出 ${media.voiceOk}、没转出 ${media.voiceFailed}；图上认出字 ${media.ocrText}、没认出 ${media.ocrNone}；看图模型看出 ${media.visionOk}、没看出 ${media.visionFailed}`);
out.push('', '## 记忆', '');
out.push(`- 召回 ${memory.recalls} 次（同一件事多的合计 ${memory.sameThing}）；召回失败 ${memory.recallFailed}、公共记忆召回失败 ${memory.commonFailed}、写入失败 ${memory.writeFailed}；片段提交 ${memory.submitted}`);
out.push(`- 日记：${background.diary.join('、') || '没写'}`);
out.push('', '## 主动消息', '');
out.push(`- 发出：${top(proactiveSent)}`);
out.push(`- 不发：${top(proactiveSkipped)}`);
out.push('', '## 后台', '');
out.push(`- 她答应的事记下 ${background.promises}；待跟进记下 ${background.followUpsAdded}、问过 ${background.followUpsAsked}、没问出口 ${background.followUpsMissed}、冲着她的不记 ${background.followUpsDropped}`);
out.push(`- 模型连接重试 ${background.modelRetries}、回复失败 ${background.replyFailed}`);
out.push('', '## 警告和错误', '');
out.push(problems.size ? [...problems].map(([k, v]) => `- ${k}（${v}）`).join('\n') : '- 无');
console.log(out.join('\n'));
