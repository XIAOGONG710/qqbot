// 存在感（ADR 0083）、主动戳他（ADR 0087）、刷 B 站（ADR 0084）的一周预览：把开关全开，假时钟每分钟走一次，看他的 QQ 上这几天会看到什么，给人决定「要不要开」。
// 用法：node src/sim/presence-preview.ts [起始日 YYYY-MM-DD，默认 2026-11-02] [天数，默认 7]
// 只读：用卡上的作息、真的签名池和频率规则；说说的文字由模型现写，B 站视频要现取，这里只标「说说」「B 站视频」；
// 聊天按「一直安静、最后一条是她说的」算（所以戳他的次数是上限）。状态文件写在临时目录，跑完删掉；不碰线上数据，不连 NapCat。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createVideoBrowsing, type BiliFetch } from '../bilibili.ts';
import { createPresence } from '../presence.ts';
import { loadCharacterCard } from '../st/card.ts';

const [fromText = '2026-11-02', daysText = '7'] = process.argv.slice(2);
const [y, m, d] = fromText.split('-').map(Number);
const days = Number(daysText);
const card = loadCharacterCard(resolve(import.meta.dirname, '../../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = card.schedule!;
const MINUTE = 60_000;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const clock = { t: new Date(y!, m! - 1, d!, 0, 0).getTime() };
const end = clock.t + days * 86_400_000;
const dir = mkdtempSync(join(tmpdir(), 'qqbot-presence-preview-'));

type Entry = { t: number; text: string };
const log: Entry[] = [];
const note = (text: string): void => { log.push({ t: clock.t, text }); };
const clockText = (t: number) => { const date = new Date(t); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };

const popular = Array.from({ length: 80 }, (_, i) => ({
    bvid: `BV1${String(i).padStart(9, '0')}`, aid: 1000 + i, title: `视频${i}`, desc: '-', owner: { name: 'UP' }, tname: '搞笑', stat: { view: 100000, like: 5000 }, duration: 200,
}));
const fetchStub: BiliFetch = async url => ({ ok: true, status: 200, text: async () => JSON.stringify(url.includes('/popular') ? { code: 0, data: { list: popular } } : { code: 0, data: { replies: [] } }) });
const STATUS_NAMES: Record<string, string> = { '10/0': '在线', '30/0': '离开', '50/0': '忙碌', '10/1028': '听歌中' };

const presence = createPresence({
    flags: { onlineStatus: true, profileLikes: true, signature: 'on', qzone: 'on', qzoneVisibility: 'friends', pokeOut: true },
    transport: {
        setOnlineStatus: async (status, ext) => note(`状态→${STATUS_NAMES[`${status}/${ext}`] ?? `${status}/${ext}`}`),
        sendLike: async (_qq, times) => note(`资料卡点了 ${times} 个赞`),
        setSignature: async text => note(`签名→「${text}」`),
        postQzone: async () => { note('发了一条说说（文字由模型现写）'); return 'tid'; },
        pokeFriend: async () => note('戳了你一下'),
    },
    schedule, likeTargets: [1], pokeTargets: [1], canPokeOut: () => true, dir: join(dir, 'presence'), now: () => clock.t, log: () => {},
    composeQzone: async () => ({ text: '说说', withPhoto: false }),
});
const browsing = createVideoBrowsing({
    mode: 'on', target: { qq: 1, name: '宝宝' }, schedule, dir: join(dir, 'bili'), now: () => clock.t, log: () => {}, fetch: fetchStub,
    initiate: async request => { request.commit(['（她说一句感受）']); return { result: 'sent', parts: ['（她说一句感受）'], messageIds: [1] }; },
    sendLink: async () => note('发来一个 B 站视频（一句感受 + 链接）'),
});

for (; clock.t < end; clock.t += MINUTE) {
    await presence.tick();
    await browsing.tick();
}
rmSync(dir, { recursive: true, force: true });

console.log(`# 存在感一周预览 ${fromText} 起 ${days} 天（开关全开；聊天一直安静，所以戳他是上限）\n`);
let counts = { status: 0, like: 0, sig: 0, qzone: 0, poke: 0, bili: 0 };
for (let i = 0; i < days; i++) {
    const start = new Date(y!, m! - 1, d! + i).getTime();
    const day = log.filter(entry => entry.t >= start && entry.t < start + 86_400_000);
    const date = new Date(start);
    console.log(`## ${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} 周${WEEKDAYS[date.getDay()]}`);
    for (const entry of day) {
        console.log(`- ${clockText(entry.t)} ${entry.text}`);
        if (entry.text.startsWith('状态')) counts.status++;
        else if (entry.text.startsWith('资料卡')) counts.like++;
        else if (entry.text.startsWith('签名')) counts.sig++;
        else if (entry.text.includes('说说')) counts.qzone++;
        else if (entry.text.startsWith('戳')) counts.poke++;
        else counts.bili++;
    }
    console.log();
}
console.log(`共：状态变化 ${counts.status} 次（平均每天 ${(counts.status / days).toFixed(1)}）、点赞 ${counts.like} 天、换签名 ${counts.sig} 次、说说 ${counts.qzone} 条、戳你 ${counts.poke} 次（上限）、B 站视频 ${counts.bili} 个`);
counts = { status: 0, like: 0, sig: 0, qzone: 0, poke: 0, bili: 0 };
