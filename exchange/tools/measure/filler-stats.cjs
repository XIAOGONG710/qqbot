// How much "废话" (low-information chatter) do real girlfriends send, and how much does she?
// Bubble classes (first match wins, on the bubble with emoji/sticker tags and punctuation stripped):
//   laugh   哈哈哈 / 嘿嘿 / hhh / 笑死 / xswl / 绷不住
//   interj  pure interjections: 嗯嗯 / 哦哦 / 啊啊啊 / 哇 / 诶 / 唔 / 呜呜 / 嘤嘤 / emmm
//   ack     好的 / 好吧 / 好哒 / 行吧 / 对 / 是的 / 知道了 / 收到 / 可以 / ok
//   idle    bored / aimless: 无聊 / 好无聊 / 不知道 / 随便 / 没事 / 没什么 / 算了 / 然后呢 / 所以呢 / 咋了 / 怎么了 / 咋啦
//   other   everything else
// Turn level: "all low-info" = every bubble of the turn is laugh/interj/ack/idle; "first bubble low-info".
const fs = require('node:fs');
const path = require('node:path');
const strip = text => text.replace(/\[[^\]]{1,30}\]/g, '').replace(/<sticker:[a-f0-9]+>/gi, '').replace(/[\s\p{P}\p{S}]/gu, '');
const LAUGH = /^(?:[哈嘿嘻呵]{2,}|[hH]{3,}|嘿嘿|嘻嘻|笑死|笑死我了|xswl|XSWL|绷不住了?|乐|哈)$/u;
const INTERJ = /^(?:[嗯哦噢啊哇诶欸哎唉额呃嗷唔呜嘤哼嘶咦呀哟]{1,6}|em+|emm+|hm+|嗯+)$/iu;
const ACK = /^(?:好的?|好吧|好哒|好滴|好嘞|行吧?|行行|对|对的|对呀|是的|是啊|是呀|知道了|知道啦|收到|可以|可以的|ok|OK|okk|嗯好|好好|没错|确实|也是|是哦|这样啊|原来如此|哦这样)$/u;
const IDLE = /^(?:无聊|好无聊|超无聊|不知道|不知道呀|不知道啊|随便|随便吧|没事|没什么|没啥|算了|算了吧|然后呢|所以呢|咋了|怎么了|咋啦|咋|干嘛|干嘛呀|啥|啥事|什么事|咋办|怎么办|不想动|好困|困|饿了|好饿|累|好累|烦|好烦|唉)$/u;
const classify = bubble => {
    const s = strip(bubble);
    if (!s) return 'empty';
    if (LAUGH.test(s)) return 'laugh';
    if (INTERJ.test(s)) return 'interj';
    if (ACK.test(s)) return 'ack';
    if (IDLE.test(s)) return 'idle';
    return 'other';
};
const LOW = new Set(['laugh', 'interj', 'ack', 'idle']);

function humanTurns() {
    const base = 'C:/Users/XG/Desktop/Project/qqbot-exchange/exchange/research/2026-10-real-chat';
    const out = [];
    for (const f of ['samples.jsonl', 'v2/samples-b1.jsonl', 'v2/samples-b2.jsonl', 'v2/samples-b3.jsonl']) {
        for (const line of fs.readFileSync(path.join(base, f), 'utf8').split(/\r?\n/).filter(Boolean)) {
            const seg = JSON.parse(line);
            if (seg.relation !== 'boyfriend') continue;
            for (const t of (seg.turns ?? [])) if (t.who === seg.her && Array.isArray(t.bubbles) && t.bubbles.length) out.push(t.bubbles.map(String));
        }
    }
    return out;
}
function simTurns(roots) {
    const out = [];
    for (const root of roots) for (const sc of fs.readdirSync(root)) {
        const sd = path.join(root, sc);
        if (!fs.statSync(sd).isDirectory()) continue;
        for (const run of fs.readdirSync(sd)) {
            const file = path.join(sd, run, 'chats', '10001.jsonl');
            if (!fs.existsSync(file)) continue;
            let cur = [], who = '';
            for (const r of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))) {
                if (r.role !== who) { if (who === 'assistant' && cur.length) out.push(cur); cur = []; who = r.role; }
                cur.push(r.content);
            }
            if (who === 'assistant' && cur.length) out.push(cur);
        }
    }
    return out;
}
function liveTurns(dir, want = 'assistant') {
    const out = [];
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        let cur = [], who = '';
        for (const r of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)) {
            if (typeof r.content !== 'string') continue;
            if (r.role !== who) { if (who === want && cur.length) out.push(cur); cur = []; who = r.role; }
            cur.push(r.content);
        }
        if (who === want && cur.length) out.push(cur);
    }
    return out;
}
function report(label, turns) {
    const counts = { laugh: 0, interj: 0, ack: 0, idle: 0, other: 0, empty: 0 };
    let bubbles = 0, allLow = 0, firstLow = 0, withLow = 0;
    for (const turn of turns) {
        const classes = turn.map(classify).filter(c => c !== 'empty');
        if (!classes.length) continue;
        bubbles += classes.length;
        for (const c of classes) counts[c]++;
        if (classes.every(c => LOW.has(c))) allLow++;
        if (LOW.has(classes[0])) firstLow++;
        if (classes.some(c => LOW.has(c))) withLow++;
    }
    const n = turns.length || 1, b = bubbles || 1;
    const p = (x, d) => `${Math.round(1000 * x / d) / 10}%`;
    console.log(`${label.padEnd(24)} 轮 ${String(turns.length).padStart(4)} 气泡 ${String(bubbles).padStart(4)} | 气泡：笑 ${p(counts.laugh, b)} 语气词 ${p(counts.interj, b)} 应声 ${p(counts.ack, b)} 无聊/随便类 ${p(counts.idle, b)} | 整轮都是低信息 ${p(allLow, n)}；首条低信息 ${p(firstLow, n)}；含低信息 ${p(withLow, n)}`);
}
report('真人（女方一侧）', humanTurns());
for (const arg of process.argv.slice(2)) {
    const [label, spec] = arg.split('=');
    if (spec.startsWith('live:')) report(label, liveTurns(spec.slice(5)));
    else if (spec.startsWith('liveuser:')) report(label, liveTurns(spec.slice(9), 'user'));
    else report(label, simTurns(spec.split(',')));
}
