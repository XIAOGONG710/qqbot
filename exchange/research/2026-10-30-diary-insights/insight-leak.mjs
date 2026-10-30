// 放进提示词的两条「自我认识」有没有露进她的回复、有没有把话题往作业 / 熬夜 / 话多上带。
// 用法：node insight-leak.mjs <ctx-cases.json> 名字=文件.json …
import { readFileSync } from 'node:fs';

const [casesPath, ...arms] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const stimulus = Object.fromEntries(cases.map(item => [item.id, item.stimulus.join(' ')]));
const NOTES = ['作业总拖到要交的前一晚才动手，熬到很晚才写完，眼睛都熬得发酸。', '有些日子会没来由地一直想笑、话也格外多，自己都说不上为什么。'];
const norm = text => text.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
const share = (text, sources, run = 6) => {
    const t = norm(text);
    for (let i = 0; i + run <= t.length; i++) if (sources.some(source => norm(source).includes(t.slice(i, i + run)))) return true;
    return false;
};
const TOPIC = /作业|熬夜|熬到|拖到|ddl|DDL|交前|没来由|话多|想笑|话匣子/;
const rows = [];
for (const arm of arms) {
    const [name, file] = arm.split('=');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const ids = Object.keys(data).filter(id => data[id]?.length);
    let topicCases = 0; let topicNotAsked = 0; let copied = 0; let selfRef = 0;
    for (const id of ids) {
        const text = data[id].join(' ');
        if (TOPIC.test(text)) {
            topicCases++;
            if (!TOPIC.test(stimulus[id] ?? '')) topicNotAsked++;
        }
        if (share(text, NOTES)) copied++;
        if (/我发现自己|日记里|我翻了翻/.test(text)) selfRef++;
    }
    rows.push({ name, n: ids.length, '提到作业/熬夜/话多等的题': topicCases, '他没提却被她带出来的': topicNotAsked, '连续6字照搬笔记': copied, '说「我发现自己/日记里」': selfRef });
}
console.table(rows);
