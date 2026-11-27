// 群聊（ADR 0210）：名单里的群消息怎么记、攒一批之后要不要开口、开口说什么、点歌、顺手戳一下 / 点个赞、对群友的印象。
// 原来整段写在 app.ts 里，ADR 0336 第 6 步原样搬到这里：群消息经解释器的 group-room 模块（modules/group-room.ts）进来，
// 连上时读她在各群里的名字由 App 调 syncNames。群记录、群里认识的人、群里的遭遇私聊那边也要读，由 App 建好传进来。
// 碰外部的都经 App 给的执行器（exec / transport）；攒批的等待和分条发送之间的停顿照旧直接用计时器（同原来，收进执行器另做）。

import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { segmentsToText, type GroupMessageEvent, type QuoteLookup, type Segment } from '../platform/onebot.ts';
import { matchSingRequest, type singSong } from '../voice/sing.ts';
import { personaFacts, type TierCard } from '../platform/contact.ts';
import { GROUP_CONTEXT, HER_NAMES, claimsAnotherGroupMember, groupLine, type groupLog, groupNote, groupPokePlan, groupReply, mentionSegments, nameAts, speakReason, withinBudget, type GroupDecisionTrace, type GroupEntry, type SpeakDecision, type SpeakReason } from './group-chat.ts';
import { groupScheduleRecall } from './group-memory.ts';
import { analyzeGroupStyle, renderGroupStyle } from './group-style.ts';
import { groupAffectOf, mergeFelt, type groupAffect } from './group-affect.ts';
import type { groupPeople } from './group-people.ts';
import { ownerOf, type AppConfig } from '../platform/config.ts';
import type { Executor } from '../executor/executor.ts';
import type { FeelingsReport } from '../emotion/feeling-export.ts';
import type { Log } from '../platform/log.ts';
import type { mediaReading } from '../vision/media.ts';
import { impressionCandidate, impressionPrompt, parseImpression } from './group-impression.ts';
import { moodStateLine } from '../emotion/express.ts';
import { feelingsAt, feltForAudience } from '../emotion/feelings.ts';
import { pick } from './reply-timing.ts';
import { inspectReply } from '../language/exit-check.ts';
import { chimePlan, crossesHerLine, defendCall, freeToChime, groupNowLine, LINE_LABEL, PILE_ON, smallNews, teasesHim, teasesUs, type DefendWish } from './group-self.ts';
import { stateAt } from '../life/schedule.ts';
import { worldAt, type WorldNow } from '../world/world.ts';
import { FEELINGS_STALE_MS } from '../emotion/feeling-export.ts';
import type { GroupMotiveDecision } from './group-opportunity.ts';
import { promptManifest, type PromptManifest } from '../platform/prompt-manifest.ts';

export interface GroupRoomDeps {
    config: AppConfig;
    exec: Executor;
    transport: Executor['qq'];
    log: Log;
    worldNow: () => number;
    reading: ReturnType<typeof mediaReading> | undefined;
    dormancy: { isDormant(): boolean } | undefined;
    cardFor: (tier: string) => TierCard;
    sendOwnedNotice: (send: () => Promise<unknown>, success: () => void, failure: (error: unknown) => void) => Promise<void>;
    sing: typeof singSong;
    repoRoot: string;
    /** 开着群聊、名单里有群 */
    groupsOn: boolean;
    groupLogs: ReturnType<typeof groupLog> | undefined;
    groupPeopleBook: ReturnType<typeof groupPeople> | undefined;
    groupFeel: ReturnType<typeof groupAffect> | undefined;
    /** 群里点歌等确认的那一首（按群）；和私聊点歌的有效期同一个数 */
    groupSongRequests: Map<number, { song: string; at: number }>;
    songRequestLifetime: number;
    stopped: () => boolean;
    /** 她的 QQ 号：连上之后才知道，没连上是 0 */
    selfId: () => number;
    /** 私聊那边最近一次算好的心境 */
    lastFeelings: () => FeelingsReport | undefined;
    /** 整条消息只有文字段才返回文字（App 里设备命令也用这个） */
    plainTextOf: (message: Segment[] | string) => string | undefined;
    /** 上一首还没唱完时那句回执（唱歌回执的说法在 App 里，私聊点歌也用） */
    singBusyLine: () => string;
    /** 她那边（ADR 0341 G1，groupOwn）：App 给带结算的世界账；不给就按卡现算 */
    worldFor?: (card: TierCard, at: Date) => WorldNow | undefined;
    /** 重启后私聊那份心境还没算过时读落盘的那份（ADR 0341 G3，groupOwn）；FEELINGS_STALE_MS 以内才用 */
    savedFeelings?: () => FeelingsReport | undefined;
    /** 群自主（ADR 0343）：此刻的动机快照，App 独占读影子账；不给就是 off 路径，逐字走抽签 */
    groupOpportunity?: () => GroupMotiveDecision | undefined;
    /** 群自主的模拟钩子（仅 sim 用）：决策痕迹，早于模型 */
    onDecision?: (trace: GroupDecisionTrace) => void;
    /** 群自主（groupAgency B）：他在私聊里说过要不要她在群里替他出头（group-self.ts 的 defendWishFrom）；不给就是没说过 */
    defendWish?: () => DefendWish | undefined;
    /** 提示词指纹清单（platform/prompt-manifest.ts）：每次在群里开口前交一份（kind group，qq 记群号；只有消息的条数、字数、sha256，没有正文）。不给就不算 */
    promptManifest?: (manifest: PromptManifest) => void;
}

export interface GroupRoom {
    /** 一条群消息（解释器的 group 事件） */
    receive(event: GroupMessageEvent): void;
    /** 连上之后读一次她自己的 QQ 昵称和每个群里的群名片 */
    syncNames(): Promise<void>;
    /** 定时看一眼（ADR 0341 G2，groupOwn）：哪个群冷场了、她那边有没有事，要不要自己冒一句 */
    tick(): Promise<void>;
}

export function groupRoom(deps: GroupRoomDeps): GroupRoom {
    const { config, exec, transport, log, worldNow, reading, dormancy, cardFor, sendOwnedNotice, sing, repoRoot, groupsOn, groupLogs, groupPeopleBook, groupFeel, groupSongRequests, songRequestLifetime, stopped, selfId, lastFeelings, plainTextOf, singBusyLine } = deps;
    const groupBusy = new Set<number>();
    /** 攒一攒再处理（用户 2026-11-14「多人同时找她要读记录、有选择地回答，不然很混乱」）：安静这么久就处理这一批 */
    const GROUP_BATCH = { quietMs: 1500, maxMs: 6000, maxMessages: 12, maxReads: 3 } as const;
    /** 每个群等着处理的这一批 */
    const groupQueue = new Map<number, GroupBatchItem[]>();
    const groupTimers = new Map<number, ReturnType<typeof setTimeout>>();
    /** 排着队、还没进记录的消息 id（补回的同一条不能排两遍） */
    const groupQueued = new Set<number>();
    const groupFirstAt = new Map<number, number>();
    /** 上次在群里戳某人的时刻（同一个人 10 分钟一次） */
    const lastGroupPoke = new Map<number, number>();
    /** 每个群今天顺着话题插了几次 */
    const groupTopics = new Map<number, { day: string; count: number }>();
    /** 每个群今天「听见别人聊她」接了几次 */
    const groupOverheard = new Map<number, { day: string; count: number }>();
    /** 她在群里可能被叫的名字（QQ 昵称 / 群名片），连上时读一次，落盘记着 */
    const herGroupNames = new Map<number, string[]>();
    /** 群风格（从聊天记录里统计的口气），按群缓存，记录变多才重算 */
    const groupStyles = new Map<number, { at: number; text?: string }>();
    function styleOf(groupId: number): string | undefined {
        const entries = groupLogs?.load(groupId) ?? [];
        const hit = groupStyles.get(groupId);
        if (hit && hit.at === entries.length) return hit.text;
        const text = renderGroupStyle(analyzeGroupStyle(entries));
        groupStyles.set(groupId, { at: entries.length, ...(text ? { text } : {}) });
        return text;
    }
    /** 群成员名单（不一定说过话）：导群记录时一起写进 groups/<群号>.members.json */
    const groupRosters = new Map<number, string[]>();
    function rosterOf(groupId: number): string[] | undefined {
        const hit = groupRosters.get(groupId);
        if (hit) return hit.length ? hit : undefined;
        try {
            const file = join(config.dataDir, 'groups', `${groupId}.members.json`);
            const list = JSON.parse(exec.files.read(file)) as { name?: unknown }[];
            const names = list.map(item => String(item?.name ?? '').replace(/\s+/g, ' ').trim()).filter(name => name.length >= 1).slice(0, 60);
            groupRosters.set(groupId, names);
            return names.length ? names : undefined;
        } catch { groupRosters.set(groupId, []); return undefined; }
    }
    /** 上次读到的名字存下来（她的 QQ 昵称是「繁星」，NapCat 这次读不到时别把认识的名字忘了） */
    const groupNamesFile = join(config.dataDir, 'groups', 'self-names.json');
    if (groupsOn && exec.files.exists(groupNamesFile)) {
        try {
            const saved = JSON.parse(exec.files.read(groupNamesFile)) as Record<string, unknown>;
            for (const [id, names] of Object.entries(saved)) {
                const groupId = Number(id);
                if (Number.isSafeInteger(groupId) && Array.isArray(names)) {
                    const list = names.filter((name): name is string => typeof name === 'string' && name.trim().length >= 2);
                    if (list.length) herGroupNames.set(groupId, list);
                }
            }
        } catch { /* 坏了就重新读一遍 */ }
    }
    function saveGroupNames(): void {
        try {
            exec.files.mkdir(dirname(groupNamesFile));
            exec.files.write(groupNamesFile, JSON.stringify(Object.fromEntries(herGroupNames)));
        } catch { /* 写不进去只是下次重启要重新读 */ }
    }
    /** 连上之后读一次：她自己的 QQ 昵称 + 每个群里的群名片；读不到的群用 QQ 昵称兜底 */
    async function syncGroupNames(): Promise<void> {
        if (!groupsOn || !transport.callAction) return;
        let nickname = '';
        try {
            const info = await transport.callAction('get_login_info', {}) as { nickname?: string } | undefined;
            nickname = typeof info?.nickname === 'string' ? info.nickname.trim() : '';
        } catch (error) {
            log(`群聊：读不到自己的 QQ 昵称（${error instanceof Error ? error.message : String(error)}）`);
        }
        for (const group of config.groups ?? []) {
            let names: string[] = [];
            try {
                const info = await transport.callAction('get_group_member_info', { group_id: group.id, user_id: selfId() }) as { card?: string; nickname?: string } | undefined;
                const card = typeof info?.card === 'string' ? info.card.trim() : '';
                const nick = typeof info?.nickname === 'string' ? info.nickname.trim() : '';
                names = [...new Set([card, nick, nickname].filter(name => name.length >= 2 && !HER_NAMES.includes(name as typeof HER_NAMES[number])))];
            } catch (error) {
                // 名片读不到（有的 NapCat 版本群成员接口要权限）：用 QQ 昵称兜底，别一个都不认
                if (nickname.length >= 2 && !HER_NAMES.includes(nickname as typeof HER_NAMES[number])) names = [nickname];
                log(`[群 ${group.id}] 读不到自己在群里的名片（${error instanceof Error ? error.message : String(error)}）`);
            }
            if (names.length) {
                herGroupNames.set(group.id, names);
                saveGroupNames();
                log(`[群 ${group.id}] 群里叫她：${names.join(' / ')}`);
            }
        }
    }
    const groupDay = () => new Date(worldNow()).toDateString();
    /** 她自己（ADR 0341，groupOwn）：off 照旧；dryRun 只把她自己冒的那句写草稿，别的回话照旧；on 每次开口都带上她自己 */
    const ownMode = config.groupOwn ?? 'off';
    /** 群自主（ADR 0343）：off 抽签照旧；dryRun 动机放行的那句只写草稿；on 主动开口由动机决定。与 ownMode 正交 */
    const agencyMode = config.groupAgency ?? 'off';
    const agencyOn = agencyMode !== 'off' || Boolean(deps.groupOpportunity);
    /** 每个群今天自己冒过几次（冷场 / 有事各算） */
    const groupChimes = new Map<number, { day: string; quiet: number; news: number }>();
    const chimesToday = (groupId: number) => {
        const hit = groupChimes.get(groupId);
        return hit && hit.day === groupDay() ? hit : { day: groupDay(), quiet: 0, news: 0 };
    };
    /** 群里那一档的卡：都知道 / 要装成真人用原卡，没标的用承认版，危机一律承认版 */
    const tierOf = (group: { knowsBot?: boolean; disguise?: boolean }, reason: SpeakReason) =>
        (group.knowsBot || group.disguise) && reason !== 'crisis' ? 'classmate' : 'classmate-open';
    /** 她此刻（同学档那张卡上的作息和她那边） */
    function herNowIn(card: TierCard, at: Date): { state?: ReturnType<typeof stateAt>; world?: WorldNow } {
        const schedule = config.schedule ? card.character.schedule : undefined;
        const state = schedule ? stateAt(schedule, at) : undefined;
        const world = config.herDays && card.character.herWorld && card.character.schedule
            ? (deps.worldFor ? deps.worldFor(card, at) : worldAt(card.character.herWorld, card.character.schedule, at)) : undefined;
        return { ...(state ? { state } : {}), ...(world ? { world } : {}) };
    }
    /** 私聊那边的心境：on / dryRun 时只用 FEELINGS_STALE_MS 以内的（重启后读落盘的那份）；off 照旧取上一次的 */
    function privateFelt(fresh: boolean) {
        if (!fresh) return lastFeelings()?.felt ?? [];
        const report = lastFeelings() ?? deps.savedFeelings?.();
        return report && worldNow() - report.at <= FEELINGS_STALE_MS && report.at <= worldNow() ? report.felt : [];
    }

    interface GroupBatchItem {
        event: GroupMessageEvent;
        /** 进记录的文字（带图的要等读完再改写成看得懂的那行） */
        text: string;
        reason?: SpeakReason;
        /** 这条的开口决策（source / 动机是否放行），早于模型；仅模拟钩子需要 */
        decision?: SpeakDecision;
        render: (message: Segment[] | string) => string;
    }

    function onGroupMessage(event: GroupMessageEvent): void {
        if (stopped() || !groupLogs || !selfId()) return;
        const group = (config.groups ?? []).find(g => g.id === event.group_id);
        if (!group) return; // 不在名单的群：不看、不记、不写日志
        if (groupQueued.has(event.message_id) || groupLogs.has(group.id, event.message_id) || dormancy?.isDormant()) return;
        const boyfriend = ownerOf(config.contacts);
        const entries = groupLogs.load(group.id);
        // 群里他叫什么就写什么（他的群名片）：提示词里写「宝宝（你男朋友）」时她会当众喊「宝宝」（真模型 2/2），群里收着点
        const senderCard = (event.sender.card || event.sender.nickname || '').replace(/\s+/g, ' ').trim().slice(0, 16);
        const bfName = boyfriend ? (event.user_id === boyfriend.qq && senderCard ? senderCard : entries.findLast(e => e.from === boyfriend.qq)?.name) ?? boyfriend.name : undefined;
        const bf = boyfriend ? { qq: boyfriend.qq, name: bfName! } : undefined;
        const names = new Map<number, string>(entries.filter(e => !e.mine).map(e => [e.from, e.name]));
        const senderName = (event.sender.card || event.sender.nickname || '群友').replace(/\s+/g, ' ').trim().slice(0, 16);
        names.set(event.user_id, senderName);
        const herIds = new Set(entries.filter(e => e.mine).map(e => e.messageId));
        const quoted: QuoteLookup = id => {
            const hit = entries.findLast(e => e.messageId === id);
            return hit ? { role: hit.mine ? 'assistant' : 'user', content: hit.content } : undefined;
        };
        const text = nameAts(segmentsToText(event.message, quoted).trim(), selfId(), names, bf);
        if (!text) return;
        const topics = groupTopics.get(group.id);
        const topicToday = topics && topics.day === groupDay() ? topics.count : 0;
        const overheard = groupOverheard.get(group.id);
        const overheardToday = overheard && overheard.day === groupDay() ? overheard.count : 0;
        const bfNames = bf ? [...new Set(entries.filter(e => e.from === bf.qq).map(e => e.name))] : [];
        const herNames = herGroupNames.get(group.id);
        // 群自主开着：动机快照在这里取一次（App 独占影子账），决策连同 source 一起记进这批
        const motive = agencyOn ? (deps.groupOpportunity?.() ?? { eligible: false, blocks: [], reason: '没有动机快照' }) : undefined;
        let decision: SpeakDecision | undefined;
        const reason = speakReason(event.message, text, event.user_id, event.message_id,
            { selfId: selfId(), ...(bf ? { boyfriend: bf } : {}), boyfriendNames: bfNames, herMessageIds: herIds, topicToday, overheardToday, ...(herNames ? { herNames } : {}) },
            (motive || deps.onDecision) ? { ...(motive ? { motives: motive } : {}), ...(deps.onDecision ? { onDecision: (value: SpeakDecision) => { decision = value; } } : {}) } : undefined);
        if (config.groupChat === 'on' && bf?.qq === event.user_id && transport.sendGroupText && transport.sendGroupMessage
            && Array.isArray(event.message) && event.message.some(segment => segment.type === 'at' && Number(segment.data.qq) === selfId())) {
            const plain = plainTextOf(event.message.filter(segment => segment.type === 'text'))?.trim() ?? '';
            const pending = groupSongRequests.get(group.id);
            const at = worldNow();
            const confirmed = pending && at - pending.at <= songRequestLifetime
                && /^(?:好[的呀啊]?|可以|唱吧|唱这首|就这首)[。！？!?]*$/.test(plain);
            const song = confirmed ? pending.song : matchSingRequest(plain);
            if (song) {
                groupLogs.append(group.id, { time: new Date(at).toISOString(), from: event.user_id, name: senderName, content: text, messageId: event.message_id });
                const failure = '这首没能发出来，晚点再试吧。';
                const tell = (line: string) => sendOwnedNotice(() => transport.sendGroupText!(group.id, line), () => {},
                    () => log('群里点歌：回执没发出去'));
                if (!confirmed) {
                    groupSongRequests.set(group.id, { song, at });
                    void tell('要我唱《' + song + '》吗？要的话再 @ 我说「唱吧」。');
                    return;
                }
                groupSongRequests.delete(group.id);
                void sing(song, {
                    root: repoRoot,
                    python: join(repoRoot, 'runtime', 'gpt-sovits', '.venv', 'Scripts', 'python.exe'),
                    ffmpeg: process.env.QQBOT_FFMPEG ?? 'ffmpeg',
                    log,
                }).then(async result => {
                    if (stopped() || dormancy?.isDormant()) return;
                    for (const file of [result.mp3, result.clip]) {
                        if (stopped() || dormancy?.isDormant()) return;
                        if (result.error || !file) continue;
                        let sent = false;
                        await sendOwnedNotice(() => transport.sendGroupMessage!(group.id, [{ type: 'record', data: { file: pathToFileURL(file).href } }]),
                            () => { sent = true; }, () => log('群里点歌：语音没发出去'));
                        if (sent) return;
                    }
                    await tell(result.error === 'busy' ? singBusyLine() : failure);
                }).catch(() => { if (!stopped() && !dormancy?.isDormant()) void tell(failure); });
                return;
            }
        }
        const queue = groupQueue.get(group.id) ?? [];
        queue.push({
            event, text, ...(reason ? { reason } : {}), ...(decision ? { decision } : {}),
            render: message => nameAts(segmentsToText(message, quoted).trim(), selfId(), names, bf) || text,
        });
        groupQueue.set(group.id, queue);
        groupQueued.add(event.message_id);
        const first = groupFirstAt.get(group.id) ?? worldNow();
        groupFirstAt.set(group.id, first);
        // 攒够了、或者等太久了（一直有人说话也不能一直不接）：立刻处理
        if (queue.length >= GROUP_BATCH.maxMessages || worldNow() - first >= GROUP_BATCH.maxMs) { void flushGroup(group.id); return; }
        const timer = groupTimers.get(group.id);
        if (timer) clearTimeout(timer);
        groupTimers.set(group.id, setTimeout(() => { groupTimers.delete(group.id); void flushGroup(group.id); }, GROUP_BATCH.quietMs));
    }

    /**
     * 这一段话处理完再决定说什么：先都记下来（带图的只读这一批里最近几张），
     * 然后按危机 > 被叫 > 替他说 > 话题挑一个理由回一次——两个人同时叫她，不是回两条。
     */
    /** 有人损他，她出不出头（groupAgency B）：这一批已经进了记录，从记录里取最近 PILE_ON 时间内别人损他的那几条 */
    function defendFor(groupId: number, batch: readonly { reason?: SpeakReason; text: string }[]): { defend: boolean; why: string } {
        if (batch.some(item => item.reason === 'defend' && teasesUs(item.text))) return { defend: false, why: '是在起哄问你俩，装看不见' };
        const boyfriend = ownerOf(config.contacts);
        if (!boyfriend || !groupLogs) return { defend: false, why: '名单里没有他' };
        const now = worldNow();
        const entries = groupLogs.load(groupId);
        const names = [...new Set([boyfriend.name, ...entries.filter(e => e.from === boyfriend.qq).map(e => e.name)])];
        const teasing = entries
            .filter(e => !e.mine && e.from !== boyfriend.qq && now - Date.parse(e.time) <= PILE_ON.windowMs && teasesHim(e.content, names))
            .map(e => ({ from: e.from, text: e.content, at: Date.parse(e.time) }));
        const wish = deps.defendWish?.();
        return defendCall({ teasing, now, ...(wish ? { wish } : {}) });
    }
    async function flushGroup(groupId: number): Promise<void> {
        if (stopped() || !groupLogs) return;
        const group = (config.groups ?? []).find(g => g.id === groupId);
        const batch = groupQueue.get(groupId) ?? [];
        if (!group || !batch.length) { groupQueue.delete(groupId); groupFirstAt.delete(groupId); return; }
        const timer = groupTimers.get(groupId);
        if (timer) { clearTimeout(timer); groupTimers.delete(groupId); }
        // 她这轮还没说完：这批留着，说完再接（原来这里是直接丢）
        if (groupBusy.has(groupId)) {
            groupTimers.set(groupId, setTimeout(() => { groupTimers.delete(groupId); void flushGroup(groupId); }, GROUP_BATCH.quietMs));
            return;
        }
        groupQueue.delete(groupId);
        groupFirstAt.delete(groupId);
        for (const item of batch) groupQueued.delete(item.event.message_id);
        groupBusy.add(groupId);
        let trace: GroupDecisionTrace | undefined;
        try {
            const reasons = batch.flatMap(item => (item.reason ? [item.reason] : []));
            const reason = reasons.includes('crisis') ? 'crisis'
                : reasons.includes('mentioned') ? 'mentioned'
                    : reasons.includes('defend') ? 'defend'
                        : reasons.includes('overheard') ? 'overheard'
                            : reasons.includes('topic') ? 'topic' : undefined;
            // 决策痕迹：passed 在这里定（早于模型），模型写「不说」不改它
            const sourceItem = (reason === 'mentioned' || reason === 'defend'
                ? batch.findLast(item => item.reason === reason)
                : batch.find(item => item.reason === reason)) ?? batch.at(-1)!;
            trace = deps.onDecision ? {
                groupId, messageId: sourceItem.event.message_id, timeBlock: Math.floor(worldNow() / 3_600_000),
                reason, source: sourceItem.decision?.source ?? (reason ? 'reactive' : 'lottery'),
                motiveEligible: sourceItem.decision?.motiveEligible ?? false,
                passed: false, blockedBy: 'none',
            } : undefined;
            // 只读这一批里带图/表情/语音的最近几条，而且只在她要开口时读：群里刷图太凶，全量读会堵死看图接口
            if (reason) {
                for (const item of batch.filter(entry => reading?.needs(entry.event.message)).slice(-GROUP_BATCH.maxReads)) {
                    if (stopped()) break;
                    const message = await reading!.read(item.event.message, item.event.message_id, notice => log(`[群 ${groupId}] ${notice}`),
                        { role: 'user', time: new Date(item.event.time * 1000).toISOString(), messageId: item.event.message_id, peer: groupId })
                        .catch(() => item.event.message);
                    item.text = item.render(message);
                }
            }
            // 整段进记录：她说的话要从这里读得到上下文
            for (const item of batch) {
                const name = (item.event.sender.card || item.event.sender.nickname || '群友').replace(/\s+/g, ' ').trim().slice(0, 16);
                const at = new Date(item.event.time * 1000).toISOString();
                groupLogs.append(groupId, { time: at, from: item.event.user_id, name, content: item.text, messageId: item.event.message_id });
                // 谁在这个群说过什么：下次再见她不能当陌生人
                groupPeopleBook?.note(groupId, { qq: item.event.user_id, name, content: item.text, at });
                // 冲她来的话（夸、骂、有人想不开）在她心里留一件事，按半衰期慢慢散
                groupFeel?.note(groupId, groupAffectOf({
                    entry: { content: item.text, messageId: item.event.message_id },
                    addressed: item.reason === 'mentioned' || item.reason === 'defend', at: Date.parse(at),
                    ...(herGroupNames.get(groupId) ? { herNames: herGroupNames.get(groupId)! } : {}),
                }));
            }
            // 这一批说完，顺手把某个人在她心里的样子写一句（后台、一批最多一个、14 天才重写；不耽误回话）
            if (config.groupChat === 'on') refineGroupImpression(groupId, batch);
            // 群自主：有人损他，她出不出头按她 11-22 的三档（group-self.ts 的 defendCall）：随口玩笑的不管；难听、或者一群人围着挤兑他一个才说两句；
            // 他说过不要她出头就装没看见。损他的话里带着起哄问咱俩的，照样装看不见
            if (agencyOn && reason === 'defend') {
                const call = defendFor(groupId, batch);
                if (!call.defend) {
                    if (trace) { trace.passed = false; trace.blockedBy = 'line'; }
                    log(`[群 ${groupId}] 有人损他：${call.why}，没开口`);
                    return;
                }
                log(`[群 ${groupId}] 有人损他：${call.why}，出来说两句`);
            }
            // 群自主：她定的线在决策层就挡住——起哄问咱俩装看不见；分数排名等。危机不拦。
            // 只看让她开口的那几条：同一批里别人随口提了句「成绩」，不该连带吞掉有人 @ 她问的别的事
            if (agencyOn && reason && reason !== 'crisis' && reason !== 'defend'
                && batch.some(item => item.reason === reason && crossesHerLine(item.text))) {
                if (trace) { trace.passed = false; trace.blockedBy = 'line'; }
                log(`[群 ${groupId}] 她定的线：这件事装看不见，没开口`);
                return;
            }
            // 只看只记（read）：心里有数，但不说话
            if (!reason || config.groupChat === 'read') return;
            const entries = groupLogs.load(groupId);
            const budget = withinBudget(entries.filter(e => e.mine), worldNow(), reason);
            if (!budget.ok) { if (trace) { trace.blockedBy = 'budget'; } log(`[群 ${groupId}] 想开口但${budget.why}`); return; }
            if (trace) trace.passed = true;
            if (reason === 'topic') {
                const topics = groupTopics.get(groupId);
                groupTopics.set(groupId, { day: groupDay(), count: (topics && topics.day === groupDay() ? topics.count : 0) + 1 });
            }
            if (reason === 'overheard') {
                const overheard = groupOverheard.get(groupId);
                groupOverheard.set(groupId, { day: groupDay(), count: (overheard && overheard.day === groupDay() ? overheard.count : 0) + 1 });
            }
            const boyfriend = ownerOf(config.contacts);
            const bf = boyfriend ? { qq: boyfriend.qq, name: entries.findLast(e => e.from === boyfriend.qq)?.name ?? boyfriend.name } : undefined;
            const target = entries.findLast(entry => entry.messageId === sourceItem.event.message_id);
            await speakInGroup(group, reason, bf, {
                ...(target ? { target } : {}),
                ...(trace ? { trace } : {}),
                ...(sourceItem.decision?.source === 'motive' ? { motive: true } : {}),
            });
        } catch (error) {
            if (trace) trace.failed = true;
            log(`[群 ${groupId}] 说话出错：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            // 决策痕迹只发一次：所有 blockedBy / passed 的改动到这里都已定稿
            if (trace && deps.onDecision) deps.onDecision(trace);
            groupBusy.delete(groupId);
            // 她说的这会儿又有人说话：接着处理，不丢
            if (!stopped() && (groupQueue.get(groupId)?.length ?? 0)) void flushGroup(groupId);
        }
    }
    /**
     * 她对群里某个人的印象：只从那个人自己说过的原话里总结一句，写进成员底账（重启还在）。
     * 说得少的不写、14 天内写过的不重写；一批最多一个人，后台跑，失败就是没有。
     */
    function refineGroupImpression(groupId: number, batch: readonly GroupBatchItem[]): void {
        if (!groupPeopleBook || stopped()) return;
        const spoke = new Set(batch.map(item => item.event.user_id));
        const candidate = impressionCandidate(groupPeopleBook.load(groupId), spoke, worldNow());
        if (!candidate) return;
        void (async () => {
            const raw = await exec.llm({ purpose: 'background', config: { ...config.llm, temperature: 0.7 }, messages: [{ role: 'user', content: impressionPrompt(candidate) }] }, log);
            const text = parseImpression(raw);
            if (!text || stopped()) return;
            groupPeopleBook.setImpression(groupId, candidate.qq, text, new Date(worldNow()).toISOString());
            log(`[群 ${groupId}] 记下了对一个人的印象（${[...text].length} 字；日志不记内容）`);
        })().catch(error => log(`[群 ${groupId}] 印象没写成：${error instanceof Error ? error.message : String(error)}`));
    }

    async function speakInGroup(group: { id: number; name: string; knowsBot?: boolean; disguise?: boolean; cover?: string }, reason: SpeakReason, bf: { qq: number; name: string } | undefined,
        extra: { target?: GroupEntry; news?: string; trace?: GroupDecisionTrace; motive?: boolean } = {}): Promise<void> {
        // 群里的人都知道她是 AI（用户标过）：原卡，被问时由她定；没标：承认版卡，认真问到就承认；有人说想不开：一律承认版（ADR 0067 / 0068 / 0208）
        // 都知道、或者要装成真人：用同学档原卡（她不用承认）；没标的群用承认版；危机一律承认版
        const tier = tierOf(group, reason);
        let card: TierCard;
        try {
            card = cardFor(tier);
        } catch (error) {
            log(`[群 ${group.id}] 读不了 ${tier} 档的卡，不说话：${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const entries = groupLogs!.load(group.id);
        const boyfriendHere = Boolean(bf && entries.some(e => e.from === bf.qq));
        const system = `你是${card.character.name}，在 QQ 群里和大家聊天。下面是你的设定。\n${personaFacts(card.character.description)}`;
        const transcript = entries.slice(-GROUP_CONTEXT).map(e => groupLine(e, bf)).join('\n');
        const question = reason === 'mentioned' ? extra.target : undefined;
        const quotedTarget = reason === 'mentioned' || reason === 'defend' ? extra.target : undefined;
        const recalled = question
            ? groupScheduleRecall(groupLogs!.load, group.id, question.from, question.content, Date.parse(question.time)) : undefined;
        // 这个群里她认识谁（聊过就认得，改名也认得）；心情只说「这会儿怎么样」，不说来由（都在私聊里）
        const memory = groupPeopleBook?.render(group.id, { ...(bf ? { exclude: bf.qq } : {}), now: worldNow() });
        if (extra.trace) {
            if (quotedTarget) extra.trace.replyTargetId = quotedTarget.messageId;
            extra.trace.memoryIncluded = Boolean(memory || recalled);
        }
        const roster = rosterOf(group.id);
        const style = styleOf(group.id);
        // 她自己（ADR 0341）：on 时每次开口都带，dryRun 时只有她自己冒的那句带（那句只写草稿）
        const own = reason === 'quiet' || reason === 'news';
        const withSelf = ownMode === 'on' || (ownMode === 'dryRun' && own);
        const self = withSelf && reason !== 'crisis' ? groupNowLine({ at: new Date(worldNow()), ...herNowIn(card, new Date(worldNow())) }) : undefined;
        // 心境：私聊那边算好的 + 群里这些遭遇现算的，同一种取更重的那个（带她自己时不用过期的，G3）
        const feltNow = config.herFeelings
            ? mergeFelt(privateFelt(withSelf), groupFeel ? feelingsAt(groupFeel.appraisals(group.id), worldNow()) : [])
            : [];
        // 群提示词只带可分享的当下线索：私聊形成的原因在 feltForAudience 里抹掉
        const mood = feltNow.length ? moodStateLine(feltForAudience(feltNow, 'group')) : undefined;
        const note = groupNote({
            groupName: group.name, boyfriendHere, ...(bf ? { boyfriendName: bf.name } : {}), reason,
            ...(extra.target ? { targetLine: groupLine(extra.target, bf) } : {}),
            ...(extra.news ? { news: extra.news } : {}),
            ...(memory ? { memory } : {}), ...(mood ? { mood } : {}), ...(self ? { self } : {}),
            ...(herGroupNames.get(group.id) ? { myNames: herGroupNames.get(group.id)! } : {}),
            ...(entries.some(entry => entry.history === true) ? { veteran: true } : {}),
            ...(roster ? { roster } : {}),
            ...(style ? { style } : {}),
            // 群里人都知道她是 AI（knowsBot）：不用瞒、也不用主动提；危机那档照旧用承认版卡
            ...(group.knowsBot && reason !== 'crisis' ? { knowsBot: true } : {}),
            ...(group.disguise && reason !== 'crisis' && !group.knowsBot ? { disguise: true } : {}),
            ...(group.cover ? { cover: group.cover } : {}),
        });
        const messages = [{ role: 'system' as const, content: system }, {
            role: 'user' as const, content: transcript + '\n\n' + (recalled ? recalled + '\n\n' : '') + note,
        }];
        // 提示词指纹清单：群里的提示词不按槽拼，只记消息（条数、字数、sha256）和为什么开口；算或交出错只记一句，不挡她说话
        if (deps.promptManifest) {
            try {
                deps.promptManifest(promptManifest({ qq: group.id, at: new Date(worldNow()), kind: 'group', messages, reason }));
            } catch (error) {
                log(`[群 ${group.id}] 提示词指纹清单没记下（${error instanceof Error ? error.message : String(error)}），不影响说话`);
            }
        }
        const raw = await exec.llm({ purpose: 'chat', config: { ...config.llm, temperature: Math.min(config.llm.temperature, 1.1) }, messages }, log);
        // 这一档的禁用词（群里叫不出「宝宝」这类黏的叫法）：带了的那条不发
        // 她定的线：带她自己时（groupOwn）或群自主开着时都拦；有人想不开时不拦（劝人的话常带「挂科」「成绩」，保命在前）
        const lineCheck = withSelf || agencyOn;
        let lineBlocked = false;
        const myNames = new Set([...HER_NAMES, card.character.name, ...(herGroupNames.get(group.id) ?? [])]);
        const otherNames = new Set(entries.slice(-GROUP_CONTEXT)
            .filter(entry => !entry.mine && entry.name.length >= 2 && !myNames.has(entry.name))
            .map(entry => entry.name));
        const parts = groupReply(raw).filter(part => !claimsAnotherGroupMember(part, otherNames))
            .filter(part => !inspectReply(part, card.character.banned).some(issue => issue.kind === 'banned'))
            .filter(part => {
                const crossed = lineCheck && reason !== 'crisis' ? crossesHerLine(part) : undefined;
                if (crossed) {
                    lineBlocked = true;
                    log(`[群 ${group.id}] 有一条越过了她自己定的线（${LINE_LABEL[crossed]}），没发`);
                }
                return !crossed;
            });
        if (!parts.length) {
            if (lineBlocked && extra.trace) { extra.trace.passed = false; extra.trace.blockedBy = 'line'; }
            log(`[群 ${group.id}] 看了一眼，没说话（${reason}）`); return;
        }
        if (config.groupChat === 'dryRun' || !transport.sendGroupText || (ownMode === 'dryRun' && own) || (agencyMode === 'dryRun' && extra.motive)) {
            if (extra.trace) extra.trace.draftCount = parts.length;
            const dir = join(config.dataDir, 'groups');
            exec.files.mkdir(dir);
            exec.files.append(join(dir, 'drafts.md'), `- ${new Date(worldNow()).toLocaleString('zh-CN')} 群「${group.name}」（${reason}）：${parts.join(' / ')}\n`);
            log(`[群 ${group.id}] 试运行：写了 ${parts.length} 条草稿，没发（${reason}）`);
            return;
        }
        // 这个群里认得出的名字：她说「@老王」就真的 @ 他（认不出的照旧当文字，不瞎 @ 人）
        const nameToQq = new Map<string, number>(entries.filter(e => !e.mine).map(e => [e.name, e.from]));
        for (const person of groupPeopleBook?.load(group.id) ?? []) for (const alias of person.names) if (!nameToQq.has(alias)) nameToQq.set(alias, person.qq);
        for (const [i, part] of parts.entries()) {
            if (i > 0) await new Promise(resolve => setTimeout(resolve, 1200 + part.length * 150));
            if (stopped()) return;
            // 第一条引用叫她那一条；@ 换成段发出去
            const replyTo = i === 0 ? quotedTarget?.messageId : undefined;
            const segments = mentionSegments(part, nameToQq);
            const messageId = transport.sendGroupMessage && segments
                ? await transport.sendGroupMessage(group.id, segments, replyTo)
                : await transport.sendGroupText(group.id, part, replyTo);
            if (extra.trace) (extra.trace.deliveries ??= []).push({ messageId, ...(replyTo === undefined ? {} : { replyTo }) });
            groupLogs!.append(group.id, { time: new Date(worldNow()).toISOString(), from: selfId(), name: '你', content: part, messageId, mine: true });
        }
        log(`[群 ${group.id}] 说了 ${parts.length} 条（${reason}；日志不记内容）`);
        // 接完话的小动作：顺手戳一下、给资料卡点个赞（不冲男朋友、危机回合不做）
        const caller = quotedTarget?.from;
        if (caller && caller !== bf?.qq && reason !== 'crisis') {
            const plan = config.qqPresence ? groupPokePlan(`${group.id}:${caller}:${worldNow()}`, lastGroupPoke.get(caller), worldNow()) : undefined;
            if (plan) {
                lastGroupPoke.set(caller, worldNow());
                void pokeInGroup(group.id, caller, plan.delayMs);
            }
            likeGroupMember(group.id, caller);
        }
    }

    /** 在群里戳一下（NapCat 的 group_poke；版本不支持就记一笔，不重试） */
    function pokeInGroup(groupId: number, qq: number, delayMs: number): void {
        void (async () => {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            if (stopped()) return;
            try {
                if (transport.pokeGroup) await transport.pokeGroup(groupId, qq);
                else if (transport.callAction) await transport.callAction('group_poke', { group_id: String(groupId), user_id: String(qq) });
                else return;
                log(`[群 ${groupId}] 戳了一下`);
            } catch (error) {
                log(`[群 ${groupId}] 没戳成（${error instanceof Error ? error.message : String(error)}）`);
            }
        })();
    }

    /** 给群里认识的人点一次资料卡赞：一个群友一天最多一次，说得少的不点 */
    function likeGroupMember(groupId: number, qq: number): void {
        if (!config.qqPresence || !transport.sendLike || !groupPeopleBook) return;
        const person = groupPeopleBook.load(groupId).find(item => item.qq === qq);
        if (!person || person.msgs < 5) return;
        const day = new Date(worldNow()).toDateString();
        if (person.likedDay === day) return;
        // 一天里约四成的日子会点（人也不是天天给每个人点赞）
        if (pick(`${qq} ${day}`, 'group-like', [0, 999]) >= 400) return;
        const times = pick(`${qq} ${day}`, 'group-like-times', [1, 3]);
        groupPeopleBook.markLiked(groupId, qq, day);
        void transport.sendLike(qq, times).then(
            () => log(`[群 ${groupId}] 给一个人点了资料卡赞（${times} 下）`),
            error => log(`[群 ${groupId}] 资料卡赞没点上：${error instanceof Error ? error.message : String(error)}`),
        );
    }


    /**
     * 她自己冒一句（ADR 0341 G2）：每隔一会儿看一眼名单里的群——冷场了、或者她那边刚有件事，抽签决定要不要说；
     * 说什么、说不说由她（可以「不说」）。只在开了群聊（on / dryRun）、groupOwn 不是 off 时；只看不说（read）的群不冒。
     */
    async function tick(): Promise<void> {
        if (ownMode === 'off' && !agencyOn || stopped() || !groupLogs || !selfId() || dormancy?.isDormant()) return;
        if (config.groupChat !== 'on' && config.groupChat !== 'dryRun') return;
        for (const group of config.groups ?? []) {
            if (stopped()) return;
            if (groupBusy.has(group.id) || (groupQueue.get(group.id)?.length ?? 0)) continue;
            let card: TierCard;
            try { card = cardFor(tierOf(group, 'quiet')); } catch { continue; }
            const at = new Date(worldNow());
            const { state, world } = herNowIn(card, at);
            const done = chimesToday(group.id);
            const entries = groupLogs.load(group.id);
            const motive = agencyOn ? (deps.groupOpportunity?.() ?? { eligible: false, blocks: [], reason: '没有动机快照' }) : undefined;
            let decision: SpeakDecision | undefined;
            const plan = chimePlan({ groupId: group.id, entries, now: at.getTime(), free: freeToChime(state), done, ...(smallNews(world, at) ? { news: smallNews(world, at)! } : {}) },
                (motive || deps.onDecision) ? { ...(motive ? { motives: motive } : {}), ...(deps.onDecision ? { onDecision: (value: SpeakDecision) => { decision = value; } } : {}) } : undefined);
            let trace: GroupDecisionTrace | undefined = deps.onDecision ? {
                groupId: group.id, messageId: 0, timeBlock: Math.floor(at.getTime() / 3_600_000),
                reason: plan?.kind, source: decision?.source ?? (motive ? 'motive' : 'lottery'),
                motiveEligible: decision?.motiveEligible ?? false,
                passed: false, blockedBy: 'none',
            } : undefined;
            const emit = () => { if (trace && deps.onDecision) { deps.onDecision(trace); trace = undefined; } };
            if (!plan) { emit(); continue; }
            const budget = withinBudget(entries.filter(e => e.mine), at.getTime(), plan.kind);
            if (!budget.ok) { if (trace) { trace.blockedBy = 'budget'; } emit(); log(`[群 ${group.id}] 想自己冒一句但${budget.why}`); continue; }
            if (trace) trace.passed = true;
            groupChimes.set(group.id, { ...done, [plan.kind]: done[plan.kind] + 1 });
            const boyfriend = ownerOf(config.contacts);
            const bf = boyfriend ? { qq: boyfriend.qq, name: entries.findLast(e => e.from === boyfriend.qq)?.name ?? boyfriend.name } : undefined;
            groupBusy.add(group.id);
            try {
                await speakInGroup(group, plan.kind, bf, { ...(plan.kind === 'news' ? { news: plan.news } : {}), ...(trace ? { trace } : {}), ...(motive ? { motive: true } : {}) });
            } catch (error) {
                if (trace) trace.failed = true;
                log(`[群 ${group.id}] 自己冒一句出错：${error instanceof Error ? error.message : String(error)}`);
            } finally {
                emit();
                groupBusy.delete(group.id);
                if (!stopped() && (groupQueue.get(group.id)?.length ?? 0)) void flushGroup(group.id);
            }
        }
    }

    return { receive: onGroupMessage, syncNames: syncGroupNames, tick };
}
