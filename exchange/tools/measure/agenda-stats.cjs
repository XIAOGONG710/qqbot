// Re-measure DSH's three numbers (2026-10-21 aliveness README) with its definitions, on real couple samples (girl side, boyfriend relation) and on her replays.
// turn = consecutive bubbles of one speaker; own-agenda = the turn contains 「我」 and shares no two-char word with the previous turn of the other side;
// question = a bubble ends with ？/? or 吗/呢/吧 (or contains ？); ack-only = <=3 chars after stripping punctuation and made of acknowledgement characters.
const fs = require('node:fs');
const path = require('node:path');
const chars = text => [...text.replace(/\[[^\]]{1,30}\]/g, '')];
const bigrams = text => { const c = chars(text.replace(/[\s\p{P}\p{S}]/gu, '')); const set = new Set(); for (let i = 0; i + 1 < c.length; i++) set.add(c[i] + c[i + 1]); return set; };
const shares = (a, b) => { const sb = bigrams(b); for (const g of bigrams(a)) if (sb.has(g)) return true; return false; };
const ACK = /^[嗯哦噢啊好行对是的呀哈诶欸嘿哇哎唉额呃嗷]+$/u;

function measure(pairs) {
    let agenda = 0, question = 0, ack = 0, comfort = 0;
    for (const { prev, turn } of pairs) {
        const text = turn.join('');
        if (text.includes('我') && !shares(text, prev.join(''))) agenda++;
        if (turn.some(b => /[？?]\s*$/.test(b.trim()) || /[吗呢吧]\s*$/.test(b.trim()) || /[？?]/.test(b))) question++;
        const bare = text.replace(/[\s\p{P}\p{S}]/gu, '');
        if (chars(bare).length <= 3 && ACK.test(bare)) ack++;
        if (/抱抱|不哭|别哭|没事|别难过|心疼|摸摸|乖/.test(text)) comfort++;
    }
    const n = pairs.length || 1;
    const p = x => `${Math.round(1000 * x / n) / 10}%`;
    return `n=${pairs.length}  自带议程 ${p(agenda)}  带问句 ${p(question)}  只应一声 ${p(ack)}  安抚词 ${p(comfort)}`;
}

function humanPairs() {
    const base = 'C:/Users/XG/Desktop/Project/qqbot-exchange/exchange/research/2026-10-real-chat';
    const out = [];
    for (const f of ['samples.jsonl', 'v2/samples-b1.jsonl', 'v2/samples-b2.jsonl', 'v2/samples-b3.jsonl']) {
        for (const line of fs.readFileSync(path.join(base, f), 'utf8').split(/\r?\n/).filter(Boolean)) {
            const seg = JSON.parse(line);
            if (seg.relation !== 'boyfriend') continue;
            const turns = (seg.turns ?? []).filter(t => Array.isArray(t.bubbles) && t.bubbles.length);
            for (let i = 1; i < turns.length; i++) if (turns[i].who === seg.her && turns[i - 1].who !== seg.her) out.push({ prev: turns[i - 1].bubbles.map(String), turn: turns[i].bubbles.map(String) });
        }
    }
    return out;
}

function simPairs(root) {
    const out = [];
    for (const sc of fs.readdirSync(root)) {
        const sd = path.join(root, sc);
        if (!fs.statSync(sd).isDirectory()) continue;
        for (const run of fs.readdirSync(sd)) {
            const file = path.join(sd, run, 'chats', '10001.jsonl');
            if (!fs.existsSync(file)) continue;
            const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
            let prev = [], cur = [], who = '';
            const flush = () => { if (who === 'assistant' && cur.length && prev.length) out.push({ prev, turn: cur }); };
            for (const r of rows) {
                if (r.role !== who) { flush(); if (who) prev = who === 'user' ? cur : prev; cur = []; who = r.role; }
                cur.push(r.content);
            }
            flush();
        }
    }
    return out;
}

console.log('真人（情侣聊天截图，女方一侧）  ', measure(humanPairs()));
for (const root of process.argv.slice(2)) console.log(path.basename(root).replace(/^\d+-\d+-/, '').padEnd(28), measure(simPairs(root)));
