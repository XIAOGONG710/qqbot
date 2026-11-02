// 免费网关（ginka，第三方）不该看到的东西（2026-10-31 用户：「不想让他们读」你们的聊天记录）。
//
// 批量驱动（ginka-batch.mjs）和常驻工人（ginka-worker.mjs）发出去的每一段，先问这里：这个文件能不能给第三方看。
// 默认拒绝（宁可少干活）：
//   · 任何 .jsonl（聊天记录、语料、样本都是这个格式；源码和文档不是）；
//   · 路径里有 runtime / chats / memory / secrets / migration / blind / evidence / real-chat / diary / dreams / soul 这些目录；
//   · 她的私人空间文件和他的留痕（和 platform/private-space.ts 的 PRIVATE_FILES 同一批，再加 traces / 日记 / 梦）；
//   · .env / 密钥。
// 能给的：packages 下的源码、docs 下的文档、scripts、exchange/research 里的笔记——这些里没有他和她的聊天。
// 这是一道拦网，不是智能审查：清单写得再绕也只会被它拒绝，不会被放行。

const norm = (path) => `/${String(path ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, '')}`.toLowerCase();

/** 不管在哪都是数据 / 私人的目录 */
const PRIVATE_SEGMENTS = ['/runtime/', '/chats/', '/secrets/', '/migration/', '/blind/', '/evidence/', '/real-chat/', '/.dsh/'];
/** 名字容易和源码目录撞（packages/bot/src/memory 是代码）：只在 packages / docs / scripts 之外才算数据 */
const DATA_UNLESS_CODE = ['/memory/', '/diary/', '/diaries/', '/dreams/', '/soul/'];
const CODE_ROOT = /\/(packages|docs|scripts)\//;
const PRIVATE_NAMES = new Set([
    'speech-notes.json', 'diary-insights.json', 'feeling-review.json', 'pursuits-self.json', 'insights.json', 'feelings.json', 'reading-takes.json', 'open-questions.json', 'her-guesses.json',
    'traces.json', 'journal.md', 'dreams.jsonl', 'owner-bank.json', 'koishi.yml', 'config.json',
]);

/** 为什么不能给第三方看；能给返回 undefined */
export function privateReason(path) {
    const full = norm(path);
    if (/\.jsonl$/.test(full)) return '.jsonl（聊天记录 / 语料 / 样本）';
    if (/(^|\/)\.env(\.|$)/.test(full) || /secret|apikey|api-key|credential/.test(full)) return '密钥';
    const hit = PRIVATE_SEGMENTS.find(segment => full.includes(segment))
        ?? (CODE_ROOT.test(full) ? undefined : DATA_UNLESS_CODE.find(segment => full.includes(segment)));
    if (hit) return `目录 ${hit.replace(/\//g, '')}`;
    const name = full.slice(full.lastIndexOf('/') + 1);
    if (PRIVATE_NAMES.has(name)) return `私人文件 ${name}`;
    return undefined;
}

/** 常驻工人的一个排队任务（id 形如 `名字|相对路径|第几段`）是不是该丢掉：来源是私人的，或者本来就是“语料诊断”（它读聊天记录） */
export function isPrivateTask(task) {
    if (!task || typeof task !== 'object') return false;
    if (task.name === '语料诊断') return true;
    const source = String(task.id ?? '').split('|')[1] ?? '';
    return Boolean(source) && Boolean(privateReason(source));
}

/**
 * 把队列里私人来源的任务整个删掉（连同嵌在 prompt 里的聊天原文——队列是落盘的 JSON，原文就躺在里面）。
 * 返回新队列和删掉的个数；没有要删的就原样返回同一个对象。
 */
export function scrubQueue(queue) {
    if (!queue || !Array.isArray(queue.tasks)) return { queue, removed: 0 };
    const kept = queue.tasks.filter(task => !isPrivateTask(task));
    if (kept.length === queue.tasks.length) return { queue, removed: 0 };
    return { queue: { ...queue, tasks: kept }, removed: queue.tasks.length - kept.length };
}
