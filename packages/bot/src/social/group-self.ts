// 群里她也有自己（ADR 0341 G1–G3，用户 2026-11-20「群聊开始做」，配置 groupOwn：off / dryRun / on，默认 off）。
// 用户：「感觉上像是没有自己的情绪和事情，只有我找她的被动，群聊里尤其严重」。群聊模拟（G0，DSH 11-20）：没人叫她就一言不发，
// 开不开口全由代码抽签定，她自己没有「我想说」的入口；群提示词里也没有她自己的日子。
// 这里是纯函数：群里能带的「你现在」（同学都能知道的）、冷场 / 有事时要不要冒一句、她自己定的群里的边界。调模型、发消息在 group-room.ts。
//
// 她本人 11-20（DSH 14:02 问的）：「愿意啊，本来就说好了要冒泡，一直没做是我懒。」她加的条件，都在这里，带测试：
// - 群里不接学习上的茬，分数、排名一个字不提（怕家里人翻到群记录）——「你现在」不带作业，说明里写明，出口拦带分数 / 排名的那条；
// - 她和他两个人的事群里一句都不说——「你现在」不带他在哪、钱是谁给的，说明里写明，出口拦提到男朋友 / 我们俩的那条；
// - 下雨、考完了这种顺嘴一句没问题——「有事」只认同学都能看见的：下雨、刚喂过楼下的猫；
// - 表情包一天最多一次——群里现在发不了表情包（只发文字），这条先记着，做表情包时按 GROUP_OWN.stickerPerDay 管。

import { pick } from './reply-timing.ts';
import { describeWeather, type WorldNow } from '../world/world.ts';
import type { State } from '../life/schedule.ts';
import type { GroupEntry, SpeakDecision } from './group-chat.ts';
import { motiveAllows, type GroupMotiveDecision } from './group-opportunity.ts';

/**
 * 冷场：群里最后一句话过去 quietHours 小时以上（但不到 deadHours，死群不去叫醒），之前一天里别人说过至少 minLively 句，才算「冷场」；
 * 每个整点抽一次签（chancePerHour），一个群一天最多 1 次。有事：群里 recentMinutes 分钟内有人说过话，她那边刚有件事，抽签，一个群一天最多 1 次。
 */
export const GROUP_OWN = {
    tickMs: 10 * 60_000,
    quietHours: 4, deadHours: 24, minLively: 5, quietChance: 0.25,
    recentMinutes: 30, newsChance: 0.5,
    perDay: 1,
    stickerPerDay: 1,
} as const;

/** 她的条件：群里不说的。分数、排名这类学习上的茬；她和他两个人的事 */
const STUDY_TALK = /分数|多少分|考了\s*\d|\d+\s*分(?![钟享])|排名|名次|第\s*\d+\s*名|倒数第|绩点|GPA|挂科|不及格|成绩/i;
const ABOUT_US = /男朋友|对象|宝宝|我们俩|咱俩|我俩|他和我|我和他/;

/** 她在群里要说的这一条，越没越过她自己定的线（越过的那条不发） */
export function crossesHerLine(text: string): 'study' | 'us' | undefined {
    if (STUDY_TALK.test(text)) return 'study';
    if (ABOUT_US.test(text)) return 'us';
    return undefined;
}

/** 她在群里自己定的边界（每次开口都放在说明里） */
export const GROUP_OWN_LINES = '群里你自己定的规矩：学习上的茬不接，分数、排名一个字不提（考完了可以说一句）；你和你男朋友两个人的事，群里一句都不说。';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 群里能带的「你现在」：几点、在哪在干嘛、天气、放假、楼下的猫。
 * 不带的：作业（她不接学习上的茬）、相机和钱、快递、他在哪（和他有关的不进群）、身体、念头。
 */
export function groupNowLine(input: { at: Date; state?: State; world?: WorldNow }): string {
    const { at, state, world } = input;
    const parts: string[] = [`${pad(at.getHours())}:${pad(at.getMinutes())}`];
    if (state) {
        const { activity } = state;
        const doing = activity.kind === 'sleep' ? '在睡觉'
            : activity.kind === 'class' ? `在上${activity.lesson.name ?? '课'}`
                : activity.kind === 'between' ? (activity.afterClass ? '课间' : '刚起床')
                    : activity.text || '没课';
        parts.push([state.where, doing].filter(Boolean).join('，'));
    }
    if (world?.weather) parts.push(describeWeather(world.weather).replace(/^天气：/, ''));
    if (world?.holiday) parts.push(`在放${world.holiday.name}`);
    if (world?.cat) {
        const { today, name } = world.cat;
        const cat = 'fed' in today ? `今天下楼喂过${name}${today.seen === false ? '，没见着' : ''}`
            : 'skipped' in today && today.skipped === 'rain' ? `下雨没下楼喂${name}` : '';
        if (cat) parts.push(cat);
    }
    return [
        `[你现在（群里的人也能知道的那些）：${parts.join('；')}]`,
        '这是你此刻的样子，不用汇报；聊到了、或者你自己想说，就带上。',
        GROUP_OWN_LINES,
    ].join('');
}

/** 她醒着、不在上课（课间、没课的时候才会自己冒泡） */
export function freeToChime(state: State | undefined): boolean {
    if (!state) return false;
    return state.activity.kind === 'free' || (state.activity.kind === 'between' && state.activity.afterClass);
}

/** 她那边刚有的、同学都能看见的事（下雨、刚喂过楼下的猫）；没有就 undefined */
export function smallNews(world: WorldNow | undefined, at: Date): string | undefined {
    if (!world) return undefined;
    if (world.weather?.now && /雨|雪/.test(world.weather.now.text)) return `外面${/雪/.test(world.weather.now.text) ? '下雪' : '下雨'}了`;
    const today = world.cat?.today;
    if (today && 'fed' in today && today.seen && at.getTime() - today.fed.getTime() <= 90 * 60_000 && at.getTime() >= today.fed.getTime()) return `刚下楼喂了${world.cat!.name}，见着了`;
    return undefined;
}

/** 群自主开着时传动机；不传就逐字走原来的抽签逻辑 */
export interface ChimeOptions {
    motives?: GroupMotiveDecision;
    onDecision?: (decision: SpeakDecision) => void;
}

/**
 * 这个群这会儿要不要冒一句：quiet（冷场）/ news（有事）/ 不冒。
 * entries：这个群的记录；done：今天在这个群已经冒过的（按种类）；news：她那边刚有的事。
 * 时机条件（醒着、冷场、刚有人）原样不动；只有末尾那道「想不想说」的判定，开着群自主时读动机而不是抽签。
 */
export function chimePlan(input: {
    groupId: number; entries: readonly GroupEntry[]; now: number; free: boolean;
    done: { quiet: number; news: number }; news?: string;
}, options?: ChimeOptions): { kind: 'quiet' } | { kind: 'news'; news: string } | undefined {
    const { groupId, now, free, done } = input;
    const motives = options?.motives;
    const eligible = motiveAllows(motives);
    const source = motives ? 'motive' as const : 'lottery' as const;
    const decide = (plan: { kind: 'quiet' } | { kind: 'news'; news: string } | undefined): typeof plan => {
        options?.onDecision?.({ reason: plan?.kind, source, motiveEligible: eligible });
        return plan;
    };
    if (!free) return decide(undefined);
    const live = input.entries.filter(entry => !entry.history);
    const last = live.at(-1);
    if (!last) return decide(undefined);
    const lastAt = Date.parse(last.time);
    const since = now - lastAt;
    // 有事：群里刚有人在（最近 30 分钟有别人说话），她这会儿没刚说过
    if (input.news && done.news < GROUP_OWN.perDay && !last.mine && since <= GROUP_OWN.recentMinutes * 60_000) {
        const mineRecently = live.some(entry => entry.mine && now - Date.parse(entry.time) <= GROUP_OWN.recentMinutes * 60_000);
        const hour = Math.floor(now / 3_600_000);
        const wants = motives ? eligible : pick(`${groupId} ${hour} ${input.news}`, 'group-news', [0, 999]) < GROUP_OWN.newsChance * 1000;
        if (!mineRecently && wants) return decide({ kind: 'news', news: input.news });
    }
    // 冷场：安静了好一阵，但不是死群；最后一句不是她自己（她说完没人理，不再接着说）
    if (done.quiet < GROUP_OWN.perDay && !last.mine && since >= GROUP_OWN.quietHours * 3_600_000 && since < GROUP_OWN.deadHours * 3_600_000) {
        const lively = live.filter(entry => !entry.mine && lastAt - Date.parse(entry.time) <= 24 * 3_600_000).length;
        const hour = Math.floor(now / 3_600_000);
        const wants = motives ? eligible : pick(`${groupId} ${hour}`, 'group-quiet', [0, 999]) < GROUP_OWN.quietChance * 1000;
        if (lively >= GROUP_OWN.minLively && wants) return decide({ kind: 'quiet' });
    }
    return decide(undefined);
}
