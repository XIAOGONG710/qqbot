// 给她的 B 站号做一次体检（ADR 0089）：扫码登录后马上跑，当场知道真账号下搜索、读字幕通不通，不用等一周草稿才发现。
// 默认只读（nav、搜索、播放器字幕）；只有给了 dmUid 才会发一条私信——这是唯一写 B 站的动作，用来验证私信接口要不要签名、没关注时怎么被限制。
// 输出里只有数量、状态码和公开视频的标题，从不打印凭证。请求、睡眠、输出都注入，测试用假的。

import { BiliApiError, credentialPath, loadCredential, openAccount, type BiliAccount, type BiliRequest, type SubtitleResult } from './bilibili-account.ts';
import { SEARCH_KEYWORDS, type BiliVideo } from './bilibili.ts';

export interface ProbeDeps {
    request: BiliRequest;
    dataDir: string;
    now: () => number;
    out: (line: string) => void;
    sleep: (ms: number) => Promise<void>;
    /** 给了就真发一条测试私信到这个 uid；不给就不写任何东西 */
    dmUid?: number;
}

export interface ProbeResult {
    /** 登录有效、搜索拿到了视频、读字幕没有「要登录」；给了 dmUid 的话私信也发出去了 */
    ok: boolean;
    /** 能读到字幕的视频数 / 试了几个 */
    subtitles: { readable: number; tried: number };
    dm: 'skipped' | 'sent' | 'failed';
}

/** 试几个关键词、每个词看几个视频的字幕：够看出「搜索通不通」和「字幕读不读得到」，又不像在爬 */
const KEYWORDS_TRIED = 2;
const SUBTITLES_TRIED = 5;
const GAP_MS = 1_200;

export const PROBE_DM_TEXT = '（测试）这是她的号发来的第一条私信，收到就行，不用回。';

/** 错误 → 一行话：接口错误带上 code（风控 / 没登录 / csrf 一眼能认），其余只给消息 */
export const describeError = (error: unknown): string => {
    if (error instanceof BiliApiError) return error.message.includes(String(error.code)) ? error.message : `${error.message}（code ${error.code}）`;
    return error instanceof Error ? error.message : String(error);
};

export async function runProbe(deps: ProbeDeps): Promise<ProbeResult> {
    const { out } = deps;
    const result: ProbeResult = { ok: false, subtitles: { readable: 0, tried: 0 }, dm: 'skipped' };

    let credential;
    try {
        credential = loadCredential(credentialPath(deps.dataDir));
    } catch (error) {
        out(`凭证文件读不了：${describeError(error)}`);
        return result;
    }
    if (!credential) { out('还没有登录凭证，先运行登录命令'); return result; }

    let account: BiliAccount | undefined;
    try {
        account = await openAccount(deps.request, credential, { now: deps.now });
    } catch (error) {
        out(`问 B 站时出错（断网或风控，不代表凭证失效）：${describeError(error)}`);
        return result;
    }
    if (!account) { out('凭证已经失效（B 站说没登录），重新运行登录命令'); return result; }
    out(`① 登录有效：「${account.name}」（uid ${account.mid}）`);

    // ② 搜索：带登录态、带 WBI 签名的请求
    const found: BiliVideo[] = [];
    for (const keyword of SEARCH_KEYWORDS.slice(0, KEYWORDS_TRIED)) {
        try {
            const videos = await account.search(keyword);
            out(`② 搜「${keyword}」：${videos.length} 条${videos.length ? `，前三：${videos.slice(0, 3).map(video => `《${video.title.slice(0, 20)}》`).join('')}` : ''}`);
            for (const video of videos) if (!found.some(existing => existing.bvid === video.bvid)) found.push(video);
        } catch (error) {
            out(`② 搜「${keyword}」失败：${describeError(error)}`);
        }
        await deps.sleep(GAP_MS);
    }

    // ③ 读字幕：先取 cid（view 接口，匿名会 412），再问带签名的播放器接口
    let needLogin = false;
    let shown = false;
    let errors = 0;
    for (const video of found.slice(0, SUBTITLES_TRIED)) {
        result.subtitles.tried += 1;
        let subtitle: SubtitleResult;
        try {
            subtitle = await account.subtitle(video);
        } catch (error) {
            errors += 1;
            out(`③ 《${video.title.slice(0, 20)}》读字幕出错：${describeError(error)}`);
            await deps.sleep(GAP_MS);
            continue;
        }
        if (subtitle.status === 'ok') {
            result.subtitles.readable += 1;
            out(`③ 《${video.title.slice(0, 20)}》有字幕（${subtitle.lan}，${subtitle.lines.length} 句）${shown ? '' : `：${subtitle.lines.slice(0, 2).join('，').slice(0, 40)}……`}`);
            shown = true;
        } else if (subtitle.status === 'none') {
            out(`③ 《${video.title.slice(0, 20)}》没有字幕轨`);
        } else {
            needLogin = true;
            out(`③ 《${video.title.slice(0, 20)}》B 站说读字幕要登录（登录了还这么说：凭证被作废了，或请求没带对登录态）`);
        }
        await deps.sleep(GAP_MS);
    }
    if (!found.length) out('③ 没有搜到视频，字幕没法试');
    else out(`③ 字幕：${result.subtitles.tried} 个视频里 ${result.subtitles.readable} 个读到了${errors ? `，${errors} 个出错` : ''}${result.subtitles.readable === 0 && !needLogin && !errors ? '（都没有字幕轨也可能是这几个视频本来就没有）' : ''}`);

    // ④ 私信：唯一写 B 站的一步，要明确给了 uid
    if (deps.dmUid !== undefined) {
        try {
            await account.sendDm({ uid: deps.dmUid, text: PROBE_DM_TEXT });
            result.dm = 'sent';
            out(`④ 私信已发给 uid ${deps.dmUid}：请看他的 B 站有没有收到（在「消息 → 我的消息」里，陌生人的私信可能在「未关注人消息」）`);
        } catch (error) {
            result.dm = 'failed';
            out(`④ 私信失败：${describeError(error)}。先确认他的 B 站关注了她的号；code 和消息记下来，退回方案（QQ 发链接）不受影响`);
        }
    } else {
        out('④ 私信没试（要试就加 --dm <他的 uid>，会真的给他发一条测试私信）');
    }

    result.ok = found.length > 0 && !needLogin && errors === 0 && (deps.dmUid === undefined || result.dm === 'sent');
    return result;
}
