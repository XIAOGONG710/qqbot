// 把 app.ts 里 send 开头处理内部标记的那一段原样提成 absorbMarkers 函数；send 和「只有标记的气泡」都走它。
// 用法：node extract-absorb.mjs <app.ts 的绝对路径>
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
let s = readFileSync(file, 'utf8');

const once = (needle) => {
    const first = s.indexOf(needle);
    if (first < 0) throw new Error(`找不到：${needle.slice(0, 60)}`);
    if (s.indexOf(needle, first + 1) >= 0) throw new Error(`不唯一：${needle.slice(0, 60)}`);
    return first;
};

const sendHead = '            send: async (userId, text, sendOptions) => {\n';
const endMark = '                if (!text.trim()) return 0;\n                const photo = ';
const headAt = once(sendHead);
const bodyStart = headAt + sendHead.length;
const endAt = once(endMark);
if (!(bodyStart < endAt)) throw new Error('顺序不对');
const body = s.slice(bodyStart, endAt);
if (!body.startsWith('                const selfNotes = takeSelfNotes(text);\n')) throw new Error('send 开头不是预期的');
// 这一段里的 await 都在 .then(async …) 的回调里（人工核过：两处），同步函数里可以；类型检查会抓住别的错

// 去掉 4 格缩进（原来在对象字面量里 16 格，函数体放在 12 格）
const dedented = body.split('\n').map(line => (line.startsWith('    ') ? line.slice(4) : line)).join('\n');

const fn = [
    '        // 回复里的内部标记（<<记住>> / <<日记>> / <<私密>> / <<同意工作>> / <<拒绝工作>> / <<用电脑>> / <<同意>> / <<拒绝>>）：从文字里剥掉、该办的事办了，返回剩下的文字。',
    '        // 发出去的气泡走 send 时先过这里；整条只有标记的气泡不发，也要过这里（responder 的 absorb），不然写在单独一行的标记就丢了。',
    '        const absorbMarkers = (userId: number, input: string): string => {',
    '            let text = input;',
    dedented.replace(/\n$/, ''),
    '            return text;',
    '        };',
    '',
    '',
].join('\n');

// 先改 send（位置靠后），再在 createContactResponder 的 return 前插函数
s = s.slice(0, bodyStart) + '                text = absorbMarkers(userId, text);\n' + s.slice(endAt);

const returnHead = '    function createContactResponder(contact: Contact): Responder {\n        return createPipeline({\n';
const returnAt = once(returnHead);
const insertAt = returnAt + '    function createContactResponder(contact: Contact): Responder {\n'.length;
s = s.slice(0, insertAt) + fn + s.slice(insertAt);

// 把 absorb 交给回复器
const logHead = '            log,\n            // last-prompt.json 记录的是后处理之后、实际发给模型的消息\n';
once(logHead);
s = s.replace(logHead, '            // 整条只有内部标记的气泡不发，但里面的标记要处理（responder 的 absorb）\n            absorb: (userId, part) => { absorbMarkers(userId, part); },\n' + logHead);

writeFileSync(file, s);
console.log('ok，搬了', body.split('\n').length - 1, '行');
