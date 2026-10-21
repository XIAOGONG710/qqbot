// Print, for every run under the given sim dirs, the turns whose prompt carried the 「带自己的小事」 line: his words and her bubbles.
// Usage: node agenda-turns.cjs <simDir>... ; prints a summary (turn count, how many replies contain a fact from 她那边 words) and the pairs.
const fs = require('node:fs');
const path = require('node:path');
const FACT_WORDS = /土豆|猫|相机|作业|快递|笔记本|攒|存了|钱|生活费|喂|下楼|食堂|室友|课|实验|宿舍|外卖|奶茶|洗衣|考试|雨|天气|冷|热|降温/;
let turns = 0, withFact = 0, asks = 0;
const out = [];
for (const root of process.argv.slice(2)) {
    for (const sc of fs.readdirSync(root)) {
        const sd = path.join(root, sc);
        if (!fs.statSync(sd).isDirectory()) continue;
        for (const run of fs.readdirSync(sd)) {
            const file = path.join(sd, run, 'report.md');
            if (!fs.existsSync(file)) continue;
            const blocks = fs.readFileSync(file, 'utf8').split(/\n(?=- `[^`]*` \*\*对方\*\*：)/);
            for (const block of blocks) {
                const his = /\*\*对方\*\*：(.*)/.exec(block)?.[1];
                if (!his) continue;
                if (!block.includes('回完顺带说一句你自己的事')) continue;
                const hers = [...block.matchAll(/^- `[^`]*` 她：(.*)$/gm)].map(m => m[1]);
                if (!hers.length) continue;
                turns++;
                const text = hers.join(' / ');
                if (FACT_WORDS.test(text)) withFact++;
                if (/[？?]/.test(text)) asks++;
                out.push(`${sc}/${run}  他：${his}\n    她：${text}`);
            }
        }
    }
}
console.log(`agenda-marked turns: ${turns}; replies that mention a 她那边 topic: ${withFact} (${Math.round(1000 * withFact / (turns || 1)) / 10}%); replies with a question mark: ${asks}`);
console.log(out.join('\n'));
