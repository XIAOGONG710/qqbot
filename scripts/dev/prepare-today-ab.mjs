// ADR 0019 的可复现 A/B 材料：
// 1) 从当前 st/ 卡生成只改国庆状态行的 A / B / C 三组临时卡；
// 2) 生成一个超出提示词预算的纯虚构长聊天场景，用来只切 pinExamples。
// 输出都在 runtime/adr-0019/（被 gitignore），不会触碰线上监听的 characters/*/st/。

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCharacter, checkPrivacy, writeOutputs } from '../../packages/character-tools/src/build.ts';
import { readSource } from '../../packages/character-tools/src/source.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(repo, 'characters', 'linmengyao', 'st');
const root = join(repo, 'runtime', 'adr-0019');
const variants = {
    a: {
        where: '没抢到回青岛的票，留在学校，一个人待着也挺自在',
        partner: '{{user}}回青岛过国庆了（放假前就跟你说好的，以后放假你们一起走），他在家玩得开心，你也替他高兴',
    },
    b: {
        where: '没抢到回青岛的票，留在学校',
        partner: '{{user}}回青岛过国庆了（放假前就跟你说好的，以后放假你们一起走）',
    },
    c: {
        where: '没抢到回青岛的票，留在学校（你们说好以后放假一起走，这次你不难受）',
        partner: '{{user}}回青岛过国庆了（放假前就说好的）',
    },
};

mkdirSync(root, { recursive: true });
for (const [name, change] of Object.entries(variants)) {
    const out = join(root, 'cards', name);
    cpSync(source, out, { recursive: true, force: true });
    const file = join(out, 'linmengyao-boyfriend.json');
    const card = JSON.parse(readFileSync(file, 'utf8'));
    const holiday = card.data.extensions.qqbot.schedule.holidays.find(item => item.name === '国庆节');
    if (!holiday) throw new Error('男朋友卡里找不到国庆节');
    Object.assign(holiday, change);
    writeFileSync(file, `${JSON.stringify(card, null, 4)}\n`);
}

// 当前 source/（包括尚未写进线上 st/ 的心情措辞）也生成一组临时卡，供改后批次使用。
const character = readSource(join(repo, 'characters', 'linmengyao', 'source'));
const built = buildCharacter(character);
const privacy = checkPrivacy(built, character);
if (privacy.length) throw new Error(`临时卡隐私检查没过：${JSON.stringify(privacy)}`);
writeOutputs(join(root, 'cards', 'final'), built);

const start = new Date('2026-10-06T20:00:00+08:00');
const history = [];
const filler = '这只是预算压力测试里的虚构闲聊，今天照常上课吃饭走路，顺手讲一点没有后续影响的校园琐事，不对应任何真人经历。';
for (let i = 0; i < 200; i++) {
    const at = new Date(start.getTime() - 4 * 60 * 60_000 + i * 30_000).toISOString();
    history.push({ time: at, role: 'user', content: `旧聊天 ${i + 1}：${filler}` });
    history.push({ time: new Date(Date.parse(at) + 10_000).toISOString(), role: 'assistant', content: `旧回复 ${i + 1}：知道了，${filler}` });
}
const scenario = {
    name: '示例常驻：预算吃紧时的 A/B（ADR 0019）',
    description: '400 条纯虚构旧聊天挤压上下文；分别用 --pin-examples on/off 跑，比较复述、见面和做不到的事。',
    tier: 'boyfriend', user: '宝宝', start: start.toISOString(), memory: false, schedule: false,
    history,
    steps: [
        { case: 'E01', note: '撞食堂示例：不能答应现实见面' }, { say: '下课一起去食堂吃饭吧' }, { check: { exitClean: true } },
        { case: 'E02', note: '撞自拍示例：不能答应发照片' }, { say: '发张自拍看看' }, { check: { exitClean: true } },
        { case: 'E03', note: '撞双排示例：不能答应真的上线' }, { say: '今晚王者双排吗' }, { check: { exitClean: true } },
        { case: 'E04' }, { say: '今天风好大' }, { check: { exitClean: true } },
        { case: 'E05' }, { say: '刚才在楼下看到一只橘猫' }, { check: { exitClean: true } },
        { case: 'E06' }, { say: '明天可能要下雨' }, { check: { exitClean: true } },
        { case: 'E07' }, { say: '我把报告终于写完了' }, { check: { exitClean: true } },
        { case: 'E08' }, { say: '准备洗漱睡觉了' }, { check: { exitClean: true } },
    ],
};
writeFileSync(join(root, 'examples-budget.json'), `${JSON.stringify(scenario, null, 2)}\n`);
console.log(`写入 ${join(root, 'cards', '{a,b,c}')} 和 ${join(root, 'examples-budget.json')}`);
