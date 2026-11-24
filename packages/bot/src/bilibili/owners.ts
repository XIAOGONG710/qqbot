import { join } from 'node:path';
import type { Executor } from '../executor/executor.ts';
import type { Transport } from '../platform/app.ts';
import type { AppConfig } from '../platform/config.ts';
import type { TierCard } from '../platform/contact.ts';
import type { Log } from '../platform/log.ts';
import type { ChatHistory } from '../memory/history.ts';
import { describeError } from '../memory/transient-io.ts';
import { asleepSince } from '../life/bedtime.ts';
import { readingActivities } from '../life/her-days.ts';
import { herPlanActivities } from '../life/her-plans.ts';
import { stateAt, type Schedule } from '../life/schedule.ts';
import { createVideoBrowsing, dmMessageId, type BiliFetch, type CommentOptions, type DmOptions, type VideoBrowsing, type VideoBrowsingOptions } from './bilibili.ts';
import { realRequest, type BiliAccount, type BiliRequest } from './bilibili-account.ts';
import { createAccountSource } from './bilibili-account-source.ts';
import { BILIBILI_RISK, createBreaker, guardRequest } from './platform-breaker.ts';
import { commentComposer, replyComposer } from './bilibili-comment.ts';
import { createReplyWatcher, type ReplyOptions, type ReplyWatcher } from './bilibili-replies.ts';
import { createRiskMonitor, type RiskMonitor } from './bilibili-risk.ts';

// 她在 B 站的那几样（ADR 0084 / 0089 / 0090 / 0147）：她的 B 站号（凭证来源 + 风控熔断）、刷视频发给他（评论、私信）、
// 风险转私信、回复她评论下面的话。原来都在 app.ts 里，ADR 0336 第 6 步原样搬到这里（`bilibiliOwners(deps)`）；
// 第一次连上、醒来时由 App 调 startOwners，停法仍由 App 登记（lifetime.own：browsing / risk / replies）。
// 会变的「停没停」改成现取；聊天记录、回复器、账号装饰（时间线 / 认识的人）由 App 建好交进来。
export interface BilibiliOwnersDeps {
    config: AppConfig;
    stopped: () => boolean;
    log: Log;
    worldNow: () => number;
    cardFor: (tier: string) => TierCard;
    /** 她的世界用的那张卡（作息、在读的书）；herDays 关时没有 */
    worldCard: TierCard['character'] | undefined;
    bedtimes: (schedule: Schedule, now: number) => readonly number[];
    exec: Pick<Executor, 'llm'>;
    chatHistory: Pick<ChatHistory, 'append'>;
    transport: Pick<Transport, 'sendPrivateImage' | 'sendPrivateText'>;
    responders: ReadonlyMap<number, { initiate: VideoBrowsingOptions['initiate'] }>;
    /** 账号来源外面再包一层（时间线、认识的人） */
    decorateAccounts: (source: () => Promise<BiliAccount | undefined>) => (() => Promise<BiliAccount | undefined>);
    /** 她自己账号的请求守卫（停止时等在途的请求） */
    ownAccountGuard: (request: BiliRequest) => BiliRequest;
    /** 测试注入的假请求 / 假 fetch；没有就用真的 */
    bilibiliRequest: BiliRequest | undefined;
    bilibiliFetch: BiliFetch | undefined;
}

export interface BilibiliOwners {
    /** 她的 B 站号：按需打开，bilibili 关着时没有 */
    accountSource(): (() => Promise<BiliAccount | undefined>) | undefined;
    /** 刷视频、回复评论各自启动（已经起了的不重起） */
    startOwners(): void;
    /** 停下各自的（停止时等它们收尾） */
    stopBrowsing(): Promise<void> | undefined;
    stopRisk(): Promise<void> | undefined;
    stopReplies(): Promise<void> | undefined;
}

export function bilibiliOwners(deps: BilibiliOwnersDeps): BilibiliOwners {
    const { config, stopped, log, worldNow, cardFor, worldCard, bedtimes, exec, chatHistory, transport, responders, decorateAccounts, ownAccountGuard, bilibiliRequest, bilibiliFetch } = deps;
    /** 她刷 B 站、挑一个真视频发给他（ADR 0084，配置 bilibili）：只发给男朋友档的第一个人；第一次连上才起 */
    let browsing: VideoBrowsing | undefined;

    /** 公开的地方（说说、B 站评论）用最低隐私档的卡来写：陌生人档，没有就同学档；两张都读不了返回 undefined */
    function lowestTierCard(): TierCard | undefined {
        for (const tier of ['stranger', 'classmate']) {
            try { return cardFor(tier); } catch { /* 试下一档 */ }
        }
        return undefined;
    }

    /** 她的 B 站号（ADR 0089，跟着 bilibili）：按需打开，凭证文件换了（重新扫码）就自动换上；细节在 bilibili-account-source.ts */
    let accountSource: (() => Promise<BiliAccount | undefined>) | undefined;
    function bilibiliAccountSource(): (() => Promise<BiliAccount | undefined>) | undefined {
        if ((config.bilibili ?? 'off') === 'off') return undefined;
        // 刷视频和回复评论共用一个来源：凭证只读一次、失败只记一次日志
        // 真实请求外面包一层持久熔断（ADR 0147）：碰到 B 站的风控信号就整体停，要人在本机 `npm run platform -w @qqbot/bot -- resume bilibili --acknowledge-account-risk` 才恢复；测试注入的假请求不包
        accountSource ??= decorateAccounts(createAccountSource({ dataDir: config.dataDir, request: bilibiliRequest ?? ownAccountGuard(guardRequest(realRequest, createBreaker({ dataDir: config.dataDir, platform: 'bilibili', log }), BILIBILI_RISK)), now: worldNow, log: message => { if (!stopped()) log(message); } }));
        return accountSource;
    }

    /** 分享之后在视频下评论并 @ 他（ADR 0089，跟着 bilibili）：没配好就记一行日志、不评论 */
    function bilibiliCommentOptions(): CommentOptions | undefined {
        const mode = config.bilibili ?? 'off';
        if (mode === 'off') return undefined;
        if (!config.bilibiliAtName || config.bilibiliAtUid <= 0) {
            log('刷 B 站：bilibili 开着，但没填 bilibiliAtName / bilibiliAtUid（要 @ 的人），不评论');
            return undefined;
        }
        const lowest = lowestTierCard();
        if (!lowest) {
            log('刷 B 站：陌生人档和同学档的卡都读不了，不评论');
            return undefined;
        }
        return {
            mode,
            at: { name: config.bilibiliAtName, uid: config.bilibiliAtUid },
            ...(config.bilibiliCommentKeywords.length ? { keywords: config.bilibiliCommentKeywords } : {}),
            compose: commentComposer({
                character: { name: lowest.character.name, description: lowest.character.description, personality: lowest.character.personality, banned: lowest.character.banned },
                generate: messages => (exec.llm({ purpose: 'background', config: { ...config.llm, temperature: 1.1 }, messages }, log)),
                log,
            }),
        };
    }

    /** 在 B 站给他发私信、QQ 上只提醒一句（ADR 0089，跟着 bilibili）：没配好就记一行日志、不发 */
    function bilibiliDmOptions(): DmOptions | undefined {
        const mode = config.bilibili ?? 'off';
        if (mode === 'off') return undefined;
        if (config.bilibiliAtUid <= 0) {
            log('刷 B 站：bilibili 开着，但没填 bilibiliAtUid（收私信的人的 B 站 uid），不发私信');
            return undefined;
        }
        return { mode, uid: config.bilibiliAtUid };
    }

    function startBrowsing(): void {
        const mode = config.bilibili ?? 'off';
        if (browsing || mode === 'off') return;
        const target = config.contacts.find(c => c.tier === 'boyfriend');
        if (!target || !worldCard?.schedule) {
            log('刷 B 站：没有男朋友档的联系人或没有作息，不启动');
            return;
        }
        const qq = target.qq;
        const account = bilibiliAccountSource();
        const comment = bilibiliCommentOptions();
        const dm = bilibiliDmOptions();
        const gate = comment ? bilibiliRisk() : undefined;
        browsing = createVideoBrowsing({
            mode,
            ...(account ? { account } : {}),
            ...(account && comment ? { comment } : {}),
            ...(gate ? { risk: gate } : {}),
            ...(account && dm ? {
                dm,
                // 私信不在 QQ 上，要自己记进聊天记录：他问起「哪个视频」时她知道自己发过什么
                recordDm: (text, video, at) => { chatHistory.append(qq, { time: new Date(at).toISOString(), role: 'assistant', content: `[B 站私信] ${text}（《${video.title}》）`, messageId: dmMessageId(at) }); },
            } : {}),
            target: { qq, name: target.name },
            schedule: worldCard.schedule,
            extraFree: config.herDays ? [...readingActivities(worldCard.books), ...herPlanActivities(config.dataDir, new Date(), log)] : [],
            dir: join(config.dataDir, 'presence'),
            now: worldNow, log,
            saidSleep: now => Boolean(asleepSince(worldCard.schedule!, bedtimes(worldCard.schedule!, now), new Date(now))),
            fetch: bilibiliFetch ?? ((url, init) => fetch(url, init)),
            initiate: request => responders.get(qq)!.initiate(request),
            // 真链接作为下一条发出去；聊天记录里连标题一起记，她之后知道自己发过什么
            sendLink: async (video, signal) => {
                if (stopped() || signal?.aborted) return;
                // 这台 QQ（NapCat 里的版本）太旧，json 卡片一律提示「版本过低」，所以不发卡片：
                // 先发封面图，再发「标题 + 链接」，QQ 自己会把链接展开成预览。
                if (transport.sendPrivateImage && video.cover) {
                    let imageId: number | undefined;
                    try { imageId = await transport.sendPrivateImage(qq, video.cover, '[视频封面]'); } catch { /* 未确认封面，不伪造已发送事实。 */ }
                    if (imageId !== undefined) chatHistory.append(qq, { time: new Date(worldNow()).toISOString(), role: 'assistant', content: `[分享视频封面]《${video.title}》`, messageId: imageId });
                }
                if (stopped() || signal?.aborted) return;
                const messageId = await transport.sendPrivateText(qq, `${video.title}
${video.link}`);
                chatHistory.append(qq, { time: new Date(worldNow()).toISOString(), role: 'assistant', content: `[分享视频]《${video.title}》${video.link}`, messageId });
            },
        });
        browsing.start();
        log(`刷 B 站：${(config.bilibili ?? 'off') === 'dryRun' ? '只写草稿（不发）' : '开'}，发给 ${target.name}；一周最多 3 个，${account ? '用她的 B 站号按口味搜、读字幕，搜不到再读 B 站热门榜' : '读 B 站热门榜（公开接口，不登录）'}${account && dm ? `；改在 B 站给他发私信（${dm.mode === 'dryRun' || (config.bilibili ?? 'off') === 'dryRun' ? '只写草稿' : '真发'}），QQ 上只提醒一句` : ''}${account && comment ? `；${comment.keywords?.length ? `按话题（${comment.keywords.join('、')}）自己找视频` : '分享后在视频下'}评论并 @ ${config.bilibiliAtName}（${comment.mode === 'dryRun' || (config.bilibili ?? 'off') === 'dryRun' ? '只写草稿' : '真发'}）` : ''}`);
    }

    /**
     * 风险转私信（ADR 0090）：公开评论或回复开着时，每 15 分钟看一次她的系统通知；评论 / 回复被拦、评论发出去看不到、收到违规警告类的通知，
     * 立刻停公开发言并私信告诉他。评论和回复共用一个，没开公开发言或没填他的 uid 就没有
     */
    let risk: RiskMonitor | undefined;
    function bilibiliRisk(): RiskMonitor | undefined {
        if (stopped()) return undefined;
        if (risk) return risk;
        if ((config.bilibili ?? 'off') === 'off') return undefined;
        const account = bilibiliAccountSource();
        if (!account || config.bilibiliAtUid <= 0) return undefined;
        risk = createRiskMonitor({ account, uid: config.bilibiliAtUid, dir: join(config.dataDir, 'presence'), now: worldNow, log });
        risk.start();
        log('B 站风险：公开评论 / 回复开着，每 15 分钟看一次她的系统通知；评论或回复被拦、评论发出去看不到、收到违规或警告通知时，立刻停公开发言并私信告诉他（这条私信不受私信试运行开关管）');
        return risk;
    }

    /** 回复别人回在她评论下面的话（ADR 0090，跟着 bilibili）：没配好就记一行日志、不回；和刷视频各自启动（只要有评论就会有回复，不管分享开没开） */
    let replies: ReplyWatcher | undefined;
    function bilibiliReplyOptions(): ReplyOptions | undefined {
        const mode = config.bilibili ?? 'off';
        if (mode === 'off') return undefined;
        const account = bilibiliAccountSource();
        if (!account) {
            log('回复 B 站评论：她的 B 站号没打开，不回复');
            return undefined;
        }
        if (config.bilibiliAtUid <= 0) {
            log('回复 B 站评论：bilibili 开着，但没填 bilibiliAtUid（先回谁），不回复');
            return undefined;
        }
        const schedule = worldCard?.schedule;
        const lowest = lowestTierCard();
        if (!lowest) {
            log('回复 B 站评论：陌生人档和同学档的卡都读不了，不回复');
            return undefined;
        }
        const extraFree = config.herDays && worldCard ? [...readingActivities(worldCard.books), ...herPlanActivities(config.dataDir, new Date(), log)] : [];
        const gate = bilibiliRisk();
        return {
            mode, account, userUid: config.bilibiliAtUid,
            ...(gate ? { risk: gate } : {}),
            compose: replyComposer({
                character: { name: lowest.character.name, description: lowest.character.description, personality: lowest.character.personality, banned: lowest.character.banned },
                generate: (messages, signal) => {
                    signal?.throwIfAborted();
                    const scoped: Log = message => { if (!stopped() && !signal?.aborted) log(message); };
                    return exec.llm({ purpose: 'background', config: { ...config.llm, temperature: 1.1 }, messages, signal }, scoped);
                },
                log: message => { if (!stopped()) log(message); },
            }),
            dir: join(config.dataDir, 'presence'),
            now: worldNow, log,
            // 睡着、上课、说过「睡了」时不看不回；没有作息就一直方便
            ...(schedule ? {
                awake: (now: number) => {
                    const kind = stateAt(schedule, new Date(now), extraFree).activity.kind;
                    return (kind === 'free' || kind === 'between') && !asleepSince(schedule, bedtimes(schedule, now), new Date(now));
                },
            } : {}),
        };
    }

    function startReplies(): void {
        if (stopped() || replies) return;
        const options = bilibiliReplyOptions();
        if (!options) return;
        replies = createReplyWatcher(options);
        replies.start();
        log(`回复 B 站评论：${options.mode === 'dryRun' ? '只写草稿（不发）' : '开'}；每 10 分钟看一次「回复我的」，先回他，其次挑有价值的，一天最多 5 条（他的不算），问 AI / 真人的、骂人的、广告一律不回；有价值的回复另存真人语料（presence/bilibili-corpus.jsonl）`);
    }

    // A critical public-action state failure must not reset its quotas or bypass
    // its risk gate, nor reject the whole host's connection callback.
    function startBilibiliOwners(): void {
        for (const start of [startBrowsing, startReplies]) {
            if (stopped()) return;
            try { start(); }
            catch (error) {
                try { log(`B 站后台状态不可用，保留原文件并暂停本项启动（${describeError(error)}）`); }
                catch { /* Diagnostics cannot authorize a public action. */ }
            }
        }
    }

    return {
        accountSource: bilibiliAccountSource,
        startOwners: startBilibiliOwners,
        stopBrowsing: () => browsing?.stop(),
        stopRisk: () => risk?.stop(),
        stopReplies: () => replies?.stop(),
    };
}
