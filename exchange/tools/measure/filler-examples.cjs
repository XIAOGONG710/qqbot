const fs = require('node:fs');
const path = require('node:path');
const strip = t => t.replace(/\[[^\]]{1,30}\]/g, '').replace(/[\s\p{P}\p{S}]/gu, '');
const LOW = /^(?:[哈嘿嘻呵]{2,}|[hH]{3,}|嘿嘿|嘻嘻|笑死|xswl|绷不住了?|[嗯哦噢啊哇诶欸哎唉额呃嗷唔呜嘤哼嘶咦呀哟]{1,6}|em+|emm+|好的?|好吧|好哒|行吧?|对|对的|是的|知道了|收到|可以|ok|没错|确实|也是|是哦|这样啊|无聊|好无聊|不知道|随便|没事|没什么|算了|然后呢|所以呢|咋了|怎么了|咋啦|啥|好困|困|好饿|饿了|累|好累|烦|好烦|唉)$/iu;
const base = 'C:/Users/XG/Desktop/Project/qqbot-exchange/exchange/research/2026-10-real-chat';
const rows = [];
for (const f of ['samples.jsonl', 'v2/samples-b1.jsonl', 'v2/samples-b2.jsonl', 'v2/samples-b3.jsonl']) {
    for (const line of fs.readFileSync(path.join(base, f), 'utf8').split(/\r?\n/).filter(Boolean)) {
        const seg = JSON.parse(line);
        if (seg.relation !== 'boyfriend') continue;
        const turns = (seg.turns ?? []).filter(t => Array.isArray(t.bubbles) && t.bubbles.length);
        for (let i = 1; i < turns.length; i++) {
            if (turns[i].who !== seg.her || turns[i - 1].who === seg.her) continue;
            const bs = turns[i].bubbles.map(String);
            if (bs.some(b => LOW.test(strip(b)))) rows.push(`他：${turns[i - 1].bubbles.join(' / ').slice(0, 50)}\n  她：${bs.join(' / ').slice(0, 70)}`);
        }
    }
}
console.log(rows.length); console.log(rows.join('\n'));
