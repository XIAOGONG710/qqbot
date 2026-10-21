// Crude CONTENT-level shares of a turn's first bubble (what the reply does), for her new/old code vs real human samples. Numbers only.
// usage: node content-stats.cjs <sim batch dir> ...   (human reference is read from the exchange research samples)
const fs = require('node:fs');
const path = require('node:path');
const PUSHBACK = /^(不是|不行|不要|不用|不会|不能|不好笑|不聊|没你|没有|没啥|少来|想得美|随你|哪有|谁|凭什么|什么叫|你才|那不行|别|切|哼|才不|并非|自己|你这|你是不是|问这个|算你)/;
const ASKS = /[？?]\s*$|咋啦|怎么了|干嘛|干啥|为什么|为啥|什么意思|说什么|啥意思/;
const ACK = /^(嗯|好|行|哦|噢|对|是|哈|真的|笑死|懂了|知道了|ok|OK|可以|没事|在呢|收到|来了|到)/;
const LAUGH = /哈|hh|笑死|xswl|233|草|乐/;
const chars = text => [...text.replace(/\[[^\]]{1,6}\]/g, '#')].length;

function shares(openers) {
    const n = openers.length || 1;
    const p = re => `${Math.round(100 * openers.filter(text => re.test(text)).length / n)}%`;
    return `n=${openers.length}  驳回/嘴硬开头 ${p(PUSHBACK)}  追问/反问 ${p(ASKS)}  附和/应一声 ${p(ACK)}  带笑 ${p(LAUGH)}  ≤2 字 ${Math.round(100 * openers.filter(text => chars(text) <= 2).length / n)}%`;
}

function simOpeners(root) {
    const out = [];
    for (const scenario of fs.readdirSync(root)) {
        const sd = path.join(root, scenario);
        if (!fs.statSync(sd).isDirectory()) continue;
        for (const run of fs.readdirSync(sd)) {
            const file = path.join(sd, run, 'chats', '10001.jsonl');
            if (!fs.existsSync(file)) continue;
            let prev = 'user';
            for (const row of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))) {
                if (row.role === 'assistant' && prev === 'user') out.push(row.content.trim());
                prev = row.role;
            }
        }
    }
    return out;
}

function humanOpeners() {
    const base = 'C:/Users/XG/Desktop/Project/qqbot-exchange/exchange/research/2026-10-real-chat';
    const files = ['samples.jsonl', 'v2/samples-b1.jsonl', 'v2/samples-b2.jsonl', 'v2/samples-b3.jsonl'];
    const out = [];
    for (const f of files) {
        for (const line of fs.readFileSync(path.join(base, f), 'utf8').split(/\r?\n/).filter(Boolean)) {
            const turns = (JSON.parse(line).turns ?? []).filter(t => Array.isArray(t.bubbles) && t.bubbles.length);
            // 每一轮的第一个气泡（上一轮是另一个人说的），第一轮不算（没有上文）
            for (let i = 1; i < turns.length; i++) if (turns[i].who !== turns[i - 1].who) out.push(String(turns[i].bubbles[0]).trim());
        }
    }
    return out;
}

console.log('真人（情侣截图里的接话）  ', shares(humanOpeners()));
for (const root of process.argv.slice(2)) console.log(path.basename(root).replace(/^\d+-\d+-/, '').padEnd(24), shares(simOpeners(root)));
