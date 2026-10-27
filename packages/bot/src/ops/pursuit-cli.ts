// node src/ops/pursuit-cli.ts list|add|step|status [--dir <数据目录>]（她的追求，ADR 0104；文件由作者管，代码和模型都不往里写）
//   list                                         列出现有的（内置两条 + 你加的 / 改的），和它们的状态
//   add --id <名字> --title "<一句话>" --why "<她为什么想要，用她会说的话的方向>" [--steps "第一步;第二步;第三步"]
//   step <id> <第几步>                            标这一步做完了（记当前时刻）
//   status <id> <active|paused|dropped|done>     暂停 / 放下 / 做完 / 恢复；内置的 courses、camera 也这样改
// 写的是 <数据目录>/pursuits.json（默认 runtime/bot）。别替她定一个作者没说过的未来：毕业以后做什么、家里的期待这类悬着的问题不是追求。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../memory/json-file.ts';
import { BUILTIN_PURSUITS, mergePursuits, pursuitsPath, validPursuits, type Pursuit, type PursuitStatus } from '../life/pursuits.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const one = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), one('--dir') ?? resolve(repoRoot, 'runtime/bot'));
const path = pursuitsPath(dir);
const command = args[0];
const STATUS: Record<PursuitStatus, string> = { active: '在做', paused: '暂停', dropped: '放下了', done: '做完了' };

function load(): Pursuit[] {
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!validPursuits(parsed)) throw new Error(`${path} 格式不对，先别改它，看一眼里面写了什么`);
    return parsed.pursuits;
}
const save = (list: Pursuit[]) => {
    if (!validPursuits({ pursuits: list })) { console.error('这样改不合格（id 只能是字母数字下划线横线；标题 2–30 字；步骤 2–40 字、最多 12 步）'); process.exit(2); }
    writeJsonAtomic(path, { pursuits: list });
};

if (command === 'list') {
    for (const item of mergePursuits(load())) {
        console.log(`${item.id}  [${STATUS[item.status]}]${item.builtin ? '（内置）' : ''}  ${item.title}  —— ${item.why}`);
        item.steps?.forEach((step, index) => console.log(`    ${index + 1}. ${step.text}${step.doneAt ? `  ✔ ${new Date(step.doneAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`));
    }
} else if (command === 'add') {
    const id = one('--id');
    const title = one('--title');
    const why = one('--why') ?? '';
    const steps = (one('--steps') ?? '').split(/[;；]/).map(text => text.trim()).filter(Boolean).map(text => ({ text }));
    if (!id || !title) { console.error('用法：add --id <名字> --title "<一句话>" --why "<为什么>" [--steps "第一步;第二步"]'); process.exit(2); }
    const list = load();
    if (list.some(item => item.id === id) || BUILTIN_PURSUITS.some(item => item.id === id)) { console.error(`已经有叫 ${id} 的了；要改状态用 status`); process.exit(2); }
    save([...list, { id, title, why, status: 'active', ...(steps.length ? { steps } : {}) }]);
    console.log(`记下了：${id}（${title}）`);
} else if (command === 'step') {
    const id = args[1];
    const index = Number(args[2]) - 1;
    const list = load();
    const target = list.find(item => item.id === id);
    if (!target?.steps?.[index]) { console.error('没有这一步（只能标你自己加的、带步骤的追求；内置的进度从她做过的事里来）'); process.exit(2); }
    target.steps[index]!.doneAt = new Date().toISOString();
    save(list);
    console.log(`标了：${id} 第 ${index + 1} 步做完了`);
} else if (command === 'status') {
    const id = args[1];
    const status = args[2] as PursuitStatus;
    if (!id || !(['active', 'paused', 'dropped', 'done'] as const).includes(status)) { console.error('用法：status <id> <active|paused|dropped|done>'); process.exit(2); }
    const list = load();
    const found = list.find(item => item.id === id);
    if (found) found.status = status;
    else {
        const base = BUILTIN_PURSUITS.find(item => item.id === id);
        if (!base) { console.error(`没有叫 ${id} 的`); process.exit(2); }
        list.push({ id: base!.id, title: base!.title, why: base!.why, status });
    }
    save(list);
    console.log(`改了：${id} → ${STATUS[status]}`);
} else {
    console.error('用法：pursuit-cli.ts list | add ... | step <id> <n> | status <id> <状态>');
    process.exit(2);
}
