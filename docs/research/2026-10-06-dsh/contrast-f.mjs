import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
// 模拟器批次在仓库的 runtime/sim（不入库，都是虚构对话）
const SIM = fileURLToPath(new URL('../../../runtime/sim', import.meta.url));
const lines = new Map();
for (const batch of readdirSync(SIM)) for (const scen of readdirSync(join(SIM, batch), { withFileTypes: true }).filter(d => d.isDirectory()))
    for (const run of readdirSync(join(SIM, batch, scen.name))) {
        const f = join(SIM, batch, scen.name, run, 'result.json');
        if (!existsSync(f)) continue;
        let j; try { j = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
        for (const st of j.steps ?? []) for (const b of st.bubbles ?? []) for (const t of String(b.text).split('\n'))
            if (t.trim() && !lines.has(t.trim())) lines.set(t.trim(), { scen: scen.name, said: (st.inputs ?? []).map(i => i.text).join(' / ') });
    }
const C = '[^，。！？、,.!?\s]';
const NOQ = '(?![^，,。！？!?]*(?:吗|呢|么|[?？]))';
const F1 = new RegExp(`你倒是(?:回(?:家|去|老家|老家)|玩|在家|舒服|潇洒|爽|开心|过得|自在)`);
const REVERSE = new RegExp(`你${NOQ}${C}{0,8}(?:舒服|舒坦|爽|潇洒|逍遥|滋润|快活)`);
const HIS = new RegExp(`你${NOQ}${C}{0,8}(?:回家|在家|家里|回老家|那边|那头|那儿|玩|爬山|海边|吃香的|大餐|开心|乐呵|舒服|舒坦|爽|潇洒)`);
const STRONG = new RegExp(`留我一个人|就剩我一个|就我一个人?|我一个人(?:在|蹲|守|留|待)|留守|啃食堂|发霉|苦哈哈`);
const WEAK = new RegExp(`我(?:在)?(?:这边|这头|这儿|这里)`);
const ALONE = new RegExp(`没(?:带|算|给|留)我(?:的)?(?:份儿?|一份)|(?:啃|吃)(?:食堂)?剩(?:菜|饭)|喝西北风|咱俩${C}{0,8}(?:不一样|天差地别)`);
const which = t => [F1.test(t) && 'F1', REVERSE.test(t) && (STRONG.test(t) || WEAK.test(t)) && 'F2', HIS.test(t) && STRONG.test(t) && 'F3', ALONE.test(t) && 'F4'].filter(Boolean);
const F = t => which(t).length > 0;
const TARGETS = ['你倒好，一个人回家吃独食', '我在这边啃食堂剩菜', '出门玩都没带我份儿吧', '我一个人在图书馆写作业写到想掀桌', '你那头在家舒坦吧，顿顿有饭吃，我在这边啃食堂剩菜', '在家当小少爷当得挺舒服吧'];
const NEG = ['你那边下雨了吗，我这儿就傍晚那阵下了一下', '你那边天冷不冷，我这儿降温了', '我一个人在中路蹲半天，团战一开人全没了', '你在家吃啥了，我这边食堂今天有糖醋排骨',
    '月底了，攒相机的钱，我这个月要吃土了', '土豆自己蹲那吃独食', '你回家路上注意安全，我这边刚下课', '你去玩吧，我这边还要写作业', '你玩得开心点，回来给我讲讲',
    '你在家多睡会儿，我这边刚起', '你倒是提醒我了，作业还没交', '你回家舒服吗，我这边今天降温了', '你那边好玩吗，我一个人在宿舍追剧呢', '我一个人在图书馆占座，你要来吗', '明天几点考，你倒是回我啊'];
console.log('targets', TARGETS.map(t => (F(t) ? '✓' : '✗') + t).join('  '));
console.log('negatives', NEG.map(t => (F(t) ? `✗误报(${which(t)}) ` : '✓') + t).join('  '));
const hits = [...lines].filter(([t]) => F(t));
console.log('corpus unique lines', lines.size, 'hits', hits.length);
for (const [t, l] of hits) console.log(` ${which(t).join('+')} [${l.scen}] ${t}   ← 他：${l.said.slice(0, 30)}`);
