// 前后一致性检查（ADR 0119，只读工具，不进运行时）：把她说过的话和当时的账对一对，找她“说的和账上对不上”的地方。
// 为什么：一天上线十几个改动、模拟都是几轮的短场景，看不到“跨天”的毛病——比如她下午说在上课其实没课、说下雨其实没下、同一句话三天里说了三遍。
// 只用规则（正则 + 账），不调模型：命中的只是“该人工看一眼”的线索，不是定论（比如“等下课”说的是将来，不算在上课）。
// 输出：每条规则命中几次 + 每条规则最多几条例子（时间 + 她那句话的前 24 个字）；她的话可以出现（她是机器人），他的话一个字不出现。

import { stateAt, type Schedule } from '.././life/schedule.ts';

export interface SaidRow { time: number; role: 'user' | 'assistant'; text: string }

export type ConsistencyRule = 'class_but_free' | 'at_dorm_on_holiday' | 'rain_but_dry' | 'dry_but_rain' | 'greeting_time' | 'same_line_many_days';

export interface Finding { rule: ConsistencyRule; time: number; text: string }

export const RULE_LABELS: Record<ConsistencyRule, string> = {
    class_but_free: '说在上课，账上这会儿没课',
    at_dorm_on_holiday: '说在宿舍，账上这会儿在放假（不在学校）',
    rain_but_dry: '说在下雨，账上这个钟头没下',
    dry_but_rain: '说没下雨，账上这个钟头在下',
    greeting_time: '问候和钟点对不上（中午以后说早安 / 傍晚以前说晚安，且不是回他的）',
    same_line_many_days: '同一句话在 3 天以上都说过（口头禅 / 复读）',
};

const IN_CLASS = /(?:正)?在上课|上着课|课上呢|在课上|上课呢/;
const CLASS_FUTURE_OR_PAST = /等下课|下课|上完课|刚上完|没上课|不上课|要上课|去上课|上课去|逃课|翘课|上课前|上课时/;
const AT_DORM = /在宿舍|回宿舍|窝宿舍|宿舍里/;
const RAIN_NOW = /(?:在|正)下雨|下雨了|雨下(?:得|着)|淋雨/;
const NO_RAIN = /没下雨|不下雨|雨停了|雨停|没雨/;
const MORNING = /^(?:早安|早呀|早啊|早上好|早$|早～|早~)/;
const NIGHT = /^(?:晚安|睡了|先睡了)/;

const clean = (text: string) => text.replace(/\s+/g, '').slice(0, 24);

export interface CheckInput {
    rows: readonly SaidRow[];
    schedule: Schedule;
    /** 某一刻的下雨情况（账上）：不给就不查下雨这两条 */
    rainAt?: (time: number) => boolean | undefined;
}

export function checkConsistency(input: CheckInput): Finding[] {
    const found: Finding[] = [];
    const hers = input.rows.filter(row => row.role === 'assistant' && row.text.trim());
    for (const row of hers) {
        const text = row.text;
        const date = new Date(row.time);
        const state = stateAt(input.schedule, date);
        if (IN_CLASS.test(text) && !CLASS_FUTURE_OR_PAST.test(text) && state.activity.kind !== 'class') found.push({ rule: 'class_but_free', time: row.time, text: clean(text) });
        if (AT_DORM.test(text) && state.holiday) found.push({ rule: 'at_dorm_on_holiday', time: row.time, text: clean(text) });
        const raining = input.rainAt?.(row.time);
        if (raining !== undefined) {
            if (RAIN_NOW.test(text) && !NO_RAIN.test(text) && !raining) found.push({ rule: 'rain_but_dry', time: row.time, text: clean(text) });
            if (NO_RAIN.test(text) && raining) found.push({ rule: 'dry_but_rain', time: row.time, text: clean(text) });
        }
    }
    // 问候和钟点：她先开口的（上一条不是他的）才算——回他的“早”可以是任何时候
    for (let i = 0; i < input.rows.length; i++) {
        const row = input.rows[i]!;
        if (row.role !== 'assistant' || (i > 0 && input.rows[i - 1]!.role === 'user')) continue;
        const hour = new Date(row.time).getHours();
        const text = row.text.trim();
        if ((MORNING.test(text) && hour >= 12 && hour < 24) || (NIGHT.test(text) && hour >= 6 && hour < 18)) found.push({ rule: 'greeting_time', time: row.time, text: clean(text) });
    }
    // 同一句话（去标点空白，≥ 5 个字）在 3 个不同的日子里都说过
    const byLine = new Map<string, { days: Set<string>; first: number; text: string }>();
    for (const row of hers) {
        const key = row.text.replace(/[\s，。！？、…～~,.!?]/g, '');
        if ([...key].length < 5 || /^<|^\[/.test(row.text.trim()) || /^她发了/.test(row.text.trim())) continue;
        const d = new Date(row.time);
        const entry = byLine.get(key) ?? { days: new Set<string>(), first: row.time, text: clean(row.text) };
        entry.days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
        byLine.set(key, entry);
    }
    for (const entry of byLine.values()) if (entry.days.size >= 3) found.push({ rule: 'same_line_many_days', time: entry.first, text: entry.text });
    return found.sort((a, b) => a.time - b.time);
}

/** 汇总成文字：每条规则命中几次、最多 perRule 条例子 */
export function describeFindings(findings: readonly Finding[], total: number, perRule = 4): string {
    const lines = [`# 前后一致性检查（她的话 ${total} 条；线索不是定论，要人工看一眼）`];
    for (const rule of Object.keys(RULE_LABELS) as ConsistencyRule[]) {
        const hits = findings.filter(f => f.rule === rule);
        lines.push(`\n## ${RULE_LABELS[rule]}：${hits.length} 处`);
        for (const hit of hits.slice(0, perRule)) lines.push(`- ${new Date(hit.time).toLocaleString('zh-CN', { hour12: false })}　${hit.text}`);
    }
    return `${lines.join('\n')}\n`;
}
