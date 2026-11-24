// 群聊模拟（ADR 0341 G0）：在合成角色、合成群上跑真实的 App，几个合成群友按剧本说话，记下她开口几次、为什么开口、说了什么。
// 模拟器（run.ts）只有私聊；这里补群聊，给「群里她太被动」量一把尺子，之后改群聊（G1 / G2）拿它对比。
// 真实时间（群里攒批的 1.5 秒照常起作用）；QQ 是假的（发出去的只记下来）；模型：给了 generate 用假的（测试），不给就用配置里的真模型。
// 不碰长期记忆、真实天气、网页、B 站、设备、DSH——配置从生产默认值起，只换上模型和提示词设置。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, type Transport } from '../platform/app.ts';
import { DEFAULTS, type AppConfig } from '../platform/config.ts';
import type { GroupMessageEvent } from '../platform/onebot.ts';
import type { GroupDecisionTrace } from '../social/group-chat.ts';
import type { GroupMotiveDecision } from '../social/group-opportunity.ts';

export const GROUP_SIM = { self: 20000, groupId: 555, boyfriendQq: 10001, firstMemberQq: 30001 } as const;

export interface GroupStep {
    /** 谁说的：members 里的名字，或者 boyfriend 的名字 */
    from: string;
    say: string;
    /** 这一句 @ 她 */
    atHer?: boolean;
    /** 说完等几秒再说下一句（默认 2；小于 1.5 秒的几句会被她攒成一批） */
    pause?: number;
}

export interface GroupScenario {
    about: string;
    group: { name: string; knowsBot?: boolean };
    /** 他在群里的群名片（名单里的男朋友档） */
    boyfriend: string;
    /** 别的群友的群名片 */
    members: string[];
    steps: GroupStep[];
}

export interface GroupLine { at: string; who: string; text: string; mine: boolean }

export interface GroupRun {
    lines: GroupLine[];
    /** 群聊相关的日志（「说了 N 条（理由）」「看了一眼，没说话」「想开口但……」） */
    logs: string[];
    /** 她说了几次（一次可以是几条） */
    spoke: number;
    /** 按开口理由数 */
    reasons: Record<string, number>;
    /** 开口决策痕迹（早于模型）；只给了模拟钩子时才有 */
    decisions: GroupDecisionTrace[];
}

export interface GroupRunOptions {
    /** 模型、提示词设置等从这里取（run.ts 用 runtime/bot/config.json）；数据目录、名单、群、连网的开关都会被这里换掉 */
    base: Pick<AppConfig, 'llm' | 'prompt'> & Partial<AppConfig>;
    /** 合成角色卡（含 {tier}） */
    characterCard: string;
    /** 测试用：假模型 */
    generate?: (messages: readonly { role: string; content: string }[]) => Promise<string>;
    /** 最后一句说完，多久没有新动静算结束（毫秒，默认 20 秒）；最多再等 maxWaitMs（默认 180 秒） */
    idleMs?: number;
    maxWaitMs?: number;
    /** 群友消息的起始编号（默认 6000）。插话抽签按消息编号定，多次跑要换编号，否则每次抽到的签一样 */
    firstMessageId?: number;
    log?: (line: string) => void;
    /** 群自主（ADR 0343，仅 sim 用）：替换 App 从影子账取的动机快照，构造「放行 / 潜水」样本 */
    motiveOverride?: GroupMotiveDecision;
    /** 群自主（仅 sim 用）：每条开口决策的观测，早于模型 */
    onDecision?: (trace: GroupDecisionTrace) => void;
    /** 群自主（仅 sim 用）：给群聊决策一个假时钟，timeBlock 由它决定 */
    now?: () => number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function groupSimConfig(dataDir: string, scenario: GroupScenario, options: GroupRunOptions): AppConfig {
    const { memory: _memory, vision: _vision, ...defaults } = DEFAULTS;
    return {
        ...defaults,
        herFeelings: options.base.herFeelings ?? true,
        llm: options.base.llm,
        prompt: options.base.prompt,
        ...(options.base.deliberateModel ? { deliberateModel: options.base.deliberateModel } : {}),
        dsh: { enabled: false },
        characterCard: options.characterCard,
        contacts: [{ qq: GROUP_SIM.boyfriendQq, name: scenario.boyfriend, tier: 'boyfriend', knowsBot: true }],
        realWeather: false,
        proactive: 'off',
        dataDir,
        ...(options.base.timeZone ? { timeZone: options.base.timeZone } : {}),
        groupChat: 'on',
        ...(options.base.groupAgency ? { groupAgency: options.base.groupAgency } : {}),
        ...(options.motiveOverride && !options.base.groupAgency ? { groupAgency: 'on' as const } : {}),
        groups: [{ id: GROUP_SIM.groupId, name: scenario.group.name, ...(scenario.group.knowsBot ? { knowsBot: true } : {}) }],
    } as AppConfig;
}

export async function runGroupScenario(scenario: GroupScenario, options: GroupRunOptions): Promise<GroupRun> {
    const qqOf = new Map<string, number>([[scenario.boyfriend, GROUP_SIM.boyfriendQq], ...scenario.members.map((name, i) => [name, GROUP_SIM.firstMemberQq + i] as const)]);
    for (const step of scenario.steps) if (!qqOf.has(step.from)) throw new Error(`剧本里的「${step.from}」不在 boyfriend / members 里`);
    const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-group-sim-'));
    // 她在本机的灵魂目录不能用真的：App 起停会删 STATE.json、读 JOURNAL / LIFE / 评价 / 拒绝这些真实资料
    // （baseline/harness.ts 同样处理）。指到临时目录里还不存在的路径——和没装过 DSH 的机器一样，跑完恢复、删掉。
    const home = mkdtempSync(join(tmpdir(), 'qqbot-group-sim-home-'));
    const soulDirBefore = process.env.QQBOT_SOUL_DIR;
    process.env.QQBOT_SOUL_DIR = join(home, 'soul');
    const lines: GroupLine[] = [];
    const logs: string[] = [];
    const decisions: GroupDecisionTrace[] = [];
    let lastActivity = Date.now();
    const mine = (text: string) => { lines.push({ at: new Date().toISOString(), who: '她', text, mine: true }); lastActivity = Date.now(); };
    let nextId = 9000;
    const transport: Transport = {
        sendPrivateText: async () => nextId++,
        friendHistory: async () => [],
        sendGroupText: async (_groupId, text) => { mine(text); return nextId++; },
        sendGroupMessage: async (_groupId, segments) => {
            mine(segments.map(s => (s.type === 'at' ? `@${String(s.data.qq)}` : s.type === 'text' ? String(s.data.text ?? '') : `[${s.type}]`)).join(''));
            return nextId++;
        },
        callAction: async () => ({} as never),
    };
    try {
        const app = startApp({
            config: groupSimConfig(dataDir, scenario, options),
            transport,
            log: line => {
                options.log?.(line);
                if (line.startsWith(`[群 ${GROUP_SIM.groupId}]`)) { logs.push(line); lastActivity = Date.now(); }
            },
            ...(options.generate ? { pipeline: { generate: async messages => options.generate!(messages), settle: { quietMs: 0, maxMs: 0 } } } : {}),
            // 模拟钩子只在这里传，线上不传：off 路径一个字段都不多
            ...(options.motiveOverride || options.onDecision || options.now || (options.base.groupAgency && options.base.groupAgency !== 'off') ? {
                groupAgencyHooks: {
                    ...(options.motiveOverride ? { motiveOverride: options.motiveOverride } : {}),
                    ...(options.now ? { now: options.now } : {}),
                    onDecision: (trace: GroupDecisionTrace) => { decisions.push(trace); options.onDecision?.(trace); },
                },
            } : {}),
        });
        try {
            await app.connected(GROUP_SIM.self);
            let messageId = options.firstMessageId ?? 6000;
            for (const step of scenario.steps) {
                const from = qqOf.get(step.from)!;
                const segments = [
                    ...(step.atHer ? [{ type: 'at', data: { qq: String(GROUP_SIM.self) } }, { type: 'text', data: { text: ' ' } }] : []),
                    { type: 'text', data: { text: step.say } },
                ];
                const event: GroupMessageEvent = {
                    post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: GROUP_SIM.self, user_id: from, group_id: GROUP_SIM.groupId,
                    message_id: messageId++, time: Math.floor(Date.now() / 1000), message: segments as GroupMessageEvent['message'],
                    raw_message: step.say, sender: { user_id: from, card: step.from, nickname: step.from },
                };
                lines.push({ at: new Date().toISOString(), who: step.from, text: `${step.atHer ? '@她 ' : ''}${step.say}`, mine: false });
                app.receiveGroup(event);
                lastActivity = Date.now();
                await sleep((step.pause ?? 2) * 1000);
            }
            const idleMs = options.idleMs ?? 20_000, deadline = Date.now() + (options.maxWaitMs ?? 180_000);
            while (Date.now() - lastActivity < idleMs && Date.now() < deadline) await sleep(Math.min(500, idleMs));
        } finally {
            await app.stop();
        }
    } finally {
        rmSync(dataDir, { recursive: true, force: true });
        if (soulDirBefore === undefined) delete process.env.QQBOT_SOUL_DIR;
        else process.env.QQBOT_SOUL_DIR = soulDirBefore;
        rmSync(home, { recursive: true, force: true });
    }
    const reasons: Record<string, number> = {};
    let spoke = 0;
    for (const line of logs) {
        const said = /说了 \d+ 条（([a-z]+)/.exec(line);
        if (said) { spoke++; reasons[said[1]!] = (reasons[said[1]!] ?? 0) + 1; }
    }
    return { lines, logs, spoke, reasons, decisions };
}

/** 一次的记录：按时间排好的群聊，她说的标出来；后面附群聊日志 */
export function renderGroupRun(scenario: GroupScenario, run: GroupRun): string {
    const transcript = run.lines.map(line => `- ${line.at.slice(11, 19)} ${line.mine ? '**她**' : line.who}：${line.text}`).join('\n');
    const reasons = Object.entries(run.reasons).map(([reason, n]) => `${reason} ${n}`).join('、') || '无';
    return [`# ${scenario.group.name}`, '', scenario.about, '', `她开口 ${run.spoke} 次（${reasons}）`, '', '## 群聊', '', transcript, '', '## 日志', '', ...run.logs.map(line => `- ${line}`), ''].join('\n');
}
