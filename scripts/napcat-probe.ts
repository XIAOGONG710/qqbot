// NapCat 探针：把「没在真 QQ 上试过」的那些 NapCat 动作和事件格式，在你在场时一次验完，不开机器人的任何开关（ADR 0085）。
// 它另开一条 WebSocket 连到 NapCat（和 Koishi 并行，NapCat 允许多个客户端），调接口、听事件、打印每一项成没成，
// 并且用机器人自己的识别函数（onebot.ts 的 isPokeAtMe / isFriendRecall / segmentsToText）去认真实的事件，认不认得一看便知。
//
// 用法（要你在场看手机；步骤之间会停几秒让你看）：
//   node scripts/napcat-probe.ts --user <你的QQ> [--config <onebot11.json>] [--steps login,packet,online,like,poke,typing,events]
//        [--events-seconds 120] [--hold-seconds 6] [--out <报告.json>] [--signature "试一下"] [--qzone]
// 步骤：
//   login   get_login_info：确认连的是她的号
//   packet  nc_get_packet_status：戳一戳 / 戳回去用的 packet 服务能不能用
//   online  set_online_status：依次改成 在线 / 离开 / 忙碌 / 听歌中，最后改回在线（你看手机上她的状态）
//   like    send_like：给你的资料卡点 1 个赞
//   poke    friend_poke：她戳你一下
//   typing  set_input_status：你那边她的对话顶上显示「对方正在输入…」几秒
//   events  听 --events-seconds 秒：你戳她、给她发一句话（会被点表情回应并标已读）、引用她的一句回复、发一句再撤回，
//           每种事件都打印真实字段，并说明机器人认不认得
//   selfrecall（要明确写进 --steps）给你发一条「测试，几秒后撤回」的消息，3 秒后用 delete_msg 撤回（selfRecall 用的那个动作），并看撤回通知长什么样
//   signature（要 --signature）读她现在的签名，改成你给的，读回来核对，再改回原样
//   qzone   （要 --qzone）发一条「仅自己可见」的测试说说，拿到 tid 后立刻删掉
// 你发的消息她（线上那个）会照常回；探针自己不发任何文字消息。报告里不留消息正文，只留字段和长度。
// token 从 NapCat 的 onebot11.json 里读（不打印）。默认 <仓库>/runtime/napcat/workdir/config/onebot11.json。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isFriendRecall, isPokeAtMe, segmentsToText, type OneBotEvent, type Segment } from '../packages/bot/src/onebot.ts';

export const STEPS = ['login', 'packet', 'online', 'like', 'poke', 'typing', 'events', 'selfrecall', 'signature', 'qzone'] as const;
export type Step = typeof STEPS[number];
export const DEFAULT_STEPS: readonly Step[] = ['login', 'packet', 'online', 'like', 'poke', 'typing', 'events'];

export interface ActionResponse { status?: string; retcode?: number; data?: unknown; message?: string; wording?: string }
export interface Connection {
    call(action: string, params?: Record<string, unknown>): Promise<ActionResponse>;
    onEvent(listener: (event: Record<string, unknown>) => void): () => void;
    close(): void;
}

export interface ProbeResult { step: Step; name: string; ok: boolean; detail: string }

export interface ProbeOptions {
    connection: Connection;
    user: number;
    steps?: readonly Step[];
    say?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
    holdMs?: number;
    eventsMs?: number;
    signature?: string;
    qzone?: boolean;
}

const MAX_DETAIL = 300;
const PROFILE_KEYS_REDACTED = new Set(['text', 'raw_message', 'summary', 'content', 'nickname', 'card', 'title', 'prompt', 'url', 'file', 'path', 'data_json']);

/** 事件和返回值的「形状」：留数字、布尔、短枚举串，正文、昵称、链接一律换成字数；不给报告留聊天内容 */
export function shapeOf(value: unknown, key = ''): unknown {
    if (typeof value === 'string') return PROFILE_KEYS_REDACTED.has(key) || !/^[a-z_]{1,24}$/.test(value) ? `<字符串 ${value.length} 字>` : value;
    if (Array.isArray(value)) return value.slice(0, 8).map(item => shapeOf(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v, k)]));
    return value;
}

const failText = (response: ActionResponse): string => {
    const text = `retcode ${response.retcode ?? '?'}${response.message || response.wording ? `：${String(response.message ?? response.wording)}` : ''}`;
    return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
};
const succeeded = (response: ActionResponse): boolean => response.status === 'ok' && response.retcode === 0;
const sleepReal = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});

/** NapCat 的在线状态：status 10 在线 / 30 离开 / 50 忙碌 / 70 请勿打扰 / 40 隐身；ext_status 1028 听歌中（NapCat 文档） */
export const ONLINE_SEQUENCE: readonly { name: string; status: number; ext: number }[] = [
    { name: '在线', status: 10, ext: 0 },
    { name: '离开', status: 30, ext: 0 },
    { name: '忙碌', status: 50, ext: 0 },
    { name: '听歌中', status: 10, ext: 1028 },
    { name: '在线（改回去）', status: 10, ext: 0 },
];

export async function runProbe(options: ProbeOptions): Promise<ProbeResult[]> {
    const { connection, user } = options;
    const steps = options.steps ?? DEFAULT_STEPS;
    const say = options.say ?? (() => {});
    const sleep = options.sleep ?? sleepReal;
    const holdMs = options.holdMs ?? 6000;
    const eventsMs = options.eventsMs ?? 120_000;
    const results: ProbeResult[] = [];
    let selfId: number | undefined;

    const record = (step: Step, name: string, ok: boolean, detail = ''): void => {
        results.push({ step, name, ok, detail });
        say(`${ok ? '✔' : '✘'} ${name}${detail ? `：${detail}` : ''}`);
    };
    const act = async (step: Step, name: string, action: string, params: Record<string, unknown>, okDetail = ''): Promise<ActionResponse> => {
        const response = await connection.call(action, params);
        record(step, name, succeeded(response), succeeded(response) ? okDetail : failText(response));
        return response;
    };

    if (steps.includes('login')) {
        const response = await connection.call('get_login_info', {});
        const data = asRecord(response.data);
        if (succeeded(response) && typeof data.user_id !== 'undefined') {
            selfId = Number(data.user_id);
            record('login', '登录账号', true, `${selfId}（${String(data.nickname ?? '')}）——确认这是她的号`);
        } else record('login', '登录账号', false, failText(response));
    }

    if (steps.includes('packet')) {
        await act('packet', 'packet 服务（戳一戳、戳回去要用）', 'nc_get_packet_status', {}, '可用');
    }

    if (steps.includes('online')) {
        say(`在线状态：依次改成 ${ONLINE_SEQUENCE.map(step => step.name).join(' → ')}，每个停 ${Math.round(holdMs / 1000)} 秒，请看手机上她的头像状态`);
        for (const { name, status, ext } of ONLINE_SEQUENCE) {
            await act('online', `在线状态「${name}」`, 'set_online_status', { status, ext_status: ext, battery_status: 0 }, '接口成功；手机上显示对不对要你看');
            await sleep(holdMs);
        }
    }

    if (steps.includes('like')) {
        await act('like', '资料卡点赞', 'send_like', { user_id: String(user), times: 1 }, '你应该收到一个赞的通知（今天已赞过会失败，看 retcode）');
    }

    if (steps.includes('poke')) {
        await act('poke', '她戳你', 'friend_poke', { user_id: String(user) }, '你应该看到「她戳了戳你」');
        await sleep(Math.min(holdMs, 3000));
    }

    if (steps.includes('typing')) {
        await act('typing', '「对方正在输入…」', 'set_input_status', { user_id: String(user), event_type: 1 }, '你那边她的对话顶上应该显示「对方正在输入…」几秒');
        await sleep(holdMs);
    }

    if (steps.includes('events')) {
        selfId = await runEvents({ connection, user, say, sleep, eventsMs, record, selfId });
    }

    if (steps.includes('selfrecall')) await runSelfRecall(connection, user, say, sleep, record);

    if (steps.includes('signature')) {
        if (!options.signature) record('signature', '个性签名', false, '没给 --signature，跳过');
        else await runSignature(connection, selfId, options.signature, record);
    }

    if (steps.includes('qzone')) {
        if (!options.qzone) record('qzone', 'QQ 空间说说', false, '没给 --qzone，跳过');
        else {
            const response = await connection.call('send_qzone_msg', { content: '（测试，马上删）', ugc_right: 64 });
            const tid = asRecord(response.data).tid;
            if (succeeded(response) && typeof tid === 'string' && tid) {
                record('qzone', '发说说（仅自己可见）', true, `tid ${tid}`);
                await act('qzone', '删掉测试说说', 'delete_qzone_msg', { tid }, '已删');
            } else record('qzone', '发说说（仅自己可见）', false, succeeded(response) ? '成功了但没有 tid' : failText(response));
        }
    }
    return results;
}

/** 给他发一条马上撤回的测试消息：delete_msg 能不能撤回自己发的；撤回时 NapCat 推的 friend_recall 是什么样、机器人（ADR 0082）认不认、是不是被她忽略 */
async function runSelfRecall(connection: Connection, user: number, say: (line: string) => void, sleep: (ms: number) => Promise<void>, record: (step: Step, name: string, ok: boolean, detail?: string) => void): Promise<void> {
    const notices: Record<string, unknown>[] = [];
    const stop = connection.onEvent(event => { if (event.post_type === 'notice' && event.notice_type === 'friend_recall') notices.push(event); });
    try {
        say('撤回自己的消息：马上给你发一条「测试」，3 秒后撤回；你应该先看到它，再看到「对方撤回了一条消息」');
        const sent = await connection.call('send_private_msg', { user_id: String(user), message: [{ type: 'text', data: { text: '（探针测试：这条几秒后撤回）' } }] });
        const messageId = asRecord(sent.data).message_id;
        if (!succeeded(sent) || typeof messageId !== 'number') { record('selfrecall', '发测试消息', false, failText(sent)); return; }
        record('selfrecall', '发测试消息', true, `id ${messageId}${messageId < 2 ** 32 ? '（32 位）' : '（不是 32 位）'}`);
        await sleep(3000);
        const deleted = await connection.call('delete_msg', { message_id: messageId });
        record('selfrecall', '撤回自己发的消息（delete_msg）', succeeded(deleted), succeeded(deleted) ? '你那边应该出现「对方撤回了一条消息」' : failText(deleted));
        await sleep(2000);
        const echo = notices.find(notice => Number(notice.message_id) === messageId);
        if (!echo) say('· 没收到自己撤回的 friend_recall 通知（NapCat 不推自己撤回的，也行：机器人本来就不用它）');
        else {
            const mine = isFriendRecall(echo as OneBotEvent);
            record('selfrecall', '自己撤回的通知', true, `${JSON.stringify(shapeOf(echo))}；机器人${mine ? '认得（但 receiveRecall 只处理他的消息，找不到她这条就什么都不做）' : '不认得'}`);
        }
    } finally {
        stop();
    }
}

async function runSignature(connection: Connection, selfId: number | undefined, text: string, record: (step: Step, name: string, ok: boolean, detail?: string) => void): Promise<void> {
    if (selfId === undefined) { record('signature', '个性签名', false, '不知道她的号（要带 login 步骤），不敢改'); return; }
    const read = async (): Promise<string | undefined> => {
        const response = await connection.call('get_stranger_info', { user_id: String(selfId), no_cache: true });
        const value = asRecord(response.data).long_nick;
        return succeeded(response) && typeof value === 'string' ? value : undefined;
    };
    const before = await read();
    if (before === undefined) { record('signature', '读她现在的签名', false, '读不到，没法改回去，所以不改'); return; }
    record('signature', '读她现在的签名', true, `${before.length} 字`);
    const set = await connection.call('set_self_longnick', { longNick: text });
    if (!succeeded(set)) { record('signature', '改个性签名', false, failText(set)); return; }
    const after = await read();
    record('signature', '改个性签名并读回来核对', after === text, after === text ? '读回来一致' : `读回来是 ${after === undefined ? '读不到' : `${after.length} 字，和写的不一样`}`);
    const restore = await connection.call('set_self_longnick', { longNick: before });
    record('signature', '改回原来的签名', succeeded(restore), succeeded(restore) ? '' : `${failText(restore)}——请手动改回去`);
}

interface EventsContext {
    connection: Connection;
    user: number;
    say: (line: string) => void;
    sleep: (ms: number) => Promise<void>;
    eventsMs: number;
    record: (step: Step, name: string, ok: boolean, detail?: string) => void;
    selfId: number | undefined;
}

async function runEvents(context: EventsContext): Promise<number | undefined> {
    const { connection, user, say, sleep, eventsMs, record } = context;
    let selfId = context.selfId;
    const seen = { message: false, reply: false, poke: false, recall: false };
    const seenIds = new Set<number>();
    let reacted = false;
    let queue: Promise<void> = Promise.resolve();

    say(`听 ${Math.round(eventsMs / 1000)} 秒。请在 QQ 里依次：①戳她一下 ②给她发一句话 ③引用她的一句话回复 ④再发一句然后撤回。她（线上那个）会照常回你。`);

    const handle = async (event: Record<string, unknown>): Promise<void> => {
        if (typeof event.self_id === 'number') selfId = event.self_id;
        if (event.post_type === 'message' && event.message_type === 'private' && event.user_id === user && event.user_id !== event.self_id) {
            const id = Number(event.message_id);
            seen.message = true;
            seenIds.add(id);
            const segments = (Array.isArray(event.message) ? event.message : []) as Segment[];
            record('events', '收到你的私聊消息', true, `id ${id}，段：${segments.map(s => s.type).join('+') || '（无）'}`);
            record('events', '消息 id 是 32 位整数（聊天记录的 id 假设）', Number.isSafeInteger(id) && id >= 0 && id < 2 ** 32, `id=${id}`);
            const reply = segments.find(s => s.type === 'reply');
            if (reply) {
                seen.reply = true;
                const quotedId = Number(reply.data?.id);
                const fetched = await connection.call('get_msg', { message_id: quotedId });
                const data = asRecord(fetched.data);
                if (succeeded(fetched)) {
                    const sender = Number(asRecord(data.sender).user_id);
                    const content = (Array.isArray(data.message) ? data.message : []) as Segment[];
                    const text = segmentsToText(event.message as Segment[], messageId => messageId === quotedId
                        ? { role: sender === selfId ? 'assistant' : 'user', content: segmentsToText(content) }
                        : undefined);
                    record('events', '引用回复：get_msg 查得到被引用的那条', true, `id ${quotedId}，发送者是${sender === selfId ? '她' : '你'}；转成给模型的文字 ${text.length} 字，${text.includes('[引用') ? '带「[引用…]」' : '没有带引用（不对）'}`);
                } else record('events', '引用回复：get_msg 查被引用的那条', false, failText(fetched));
            }
            if (!reacted) {
                reacted = true;
                await Promise.all([
                    connection.call('set_msg_emoji_like', { message_id: id, emoji_id: '76', set: true }).then(response => record('events', '给你这条消息点表情回应（赞）', succeeded(response), succeeded(response) ? '你应该在这条消息下面看到一个赞' : failText(response))),
                    connection.call('mark_private_msg_as_read', { user_id: String(user) }).then(response => record('events', '标已读', succeeded(response), succeeded(response) ? '你那边这条该显示「已读」' : failText(response))),
                ]);
            }
        } else if (event.post_type === 'notice') {
            const shaped = JSON.stringify(shapeOf(event));
            if (event.notice_type === 'notify' && event.sub_type === 'poke') {
                const mine = isPokeAtMe(event as OneBotEvent);
                if (mine) seen.poke = true;
                record('events', mine ? '你戳她：机器人认得（isPokeAtMe）' : '戳一戳事件（机器人不算：不是你戳她、或是她自己戳你的回声）', mine || event.sender_id === selfId, shaped);
            } else if (event.notice_type === 'friend_recall') {
                const mine = isFriendRecall(event as OneBotEvent);
                if (mine) seen.recall = true;
                const known = seenIds.has(Number(event.message_id));
                record('events', mine ? '撤回：机器人认得（isFriendRecall）' : '撤回事件，机器人不认得', mine, `${shaped}${known ? '；撤回的 id 就是刚收到的那条 ✔' : '；撤回的 id 不在刚收到的里（可能是别的消息）'}`);
            } else say(`· 其他通知：${shaped}`);
        }
    };
    const stop = connection.onEvent(event => { queue = queue.then(() => handle(event)).catch(error => say(`· 处理事件出错：${error instanceof Error ? error.message : String(error)}`)); });
    await sleep(eventsMs);
    stop();
    await queue;
    const missed = Object.entries({ 戳她: seen.poke, 发消息: seen.message, 引用回复: seen.reply, 撤回: seen.recall }).filter(([, done]) => !done).map(([name]) => name);
    if (missed.length) say(`· 这些没试到（不算失败，要验就再跑一次 events）：${missed.join('、')}`);
    return selfId;
}

/** 连 NapCat 的 WebSocket 服务端（根路径 /：同一条连接收事件、调接口；token 用 ?access_token=）。Node 自带的 WebSocket */
export function connect(url: string, timeoutMs = 10_000): Promise<Connection> {
    return new Promise((resolveConnection, reject) => {
        const socket = new WebSocket(url);
        const pending = new Map<string, { resolve: (response: ActionResponse) => void; timer: ReturnType<typeof setTimeout> }>();
        const listeners = new Set<(event: Record<string, unknown>) => void>();
        let sequence = 0;
        const failAll = (message: string): void => {
            for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve({ status: 'failed', retcode: -1, message }); }
            pending.clear();
        };
        const opening = setTimeout(() => { reject(new Error(`连不上 NapCat（${timeoutMs / 1000} 秒）`)); socket.close(); }, timeoutMs);
        socket.addEventListener('open', () => {
            clearTimeout(opening);
            resolveConnection({
                call: (action, params = {}) => new Promise(resolve => {
                    const echo = `probe-${++sequence}`;
                    const timer = setTimeout(() => { pending.delete(echo); resolve({ status: 'failed', retcode: -2, message: `${action} 15 秒没回` }); }, 15_000);
                    pending.set(echo, { resolve, timer });
                    socket.send(JSON.stringify({ action, params, echo }));
                }),
                onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
                close: () => socket.close(),
            });
        });
        socket.addEventListener('error', () => { clearTimeout(opening); reject(new Error('连接出错（地址、端口、token 对吗？）')); });
        socket.addEventListener('close', () => failAll('连接断了'));
        socket.addEventListener('message', message => {
            let data: Record<string, unknown>;
            try { data = JSON.parse(String(message.data)) as Record<string, unknown>; } catch { return; }
            const entry = typeof data.echo === 'string' ? pending.get(data.echo) : undefined;
            if (entry) { pending.delete(data.echo as string); clearTimeout(entry.timer); entry.resolve(data as ActionResponse); return; }
            if (typeof data.post_type === 'string' && data.post_type !== 'meta_event') for (const listener of listeners) listener(data);
        });
    });
}

interface Args { user?: number; config?: string; url?: string; steps?: Step[]; eventsSeconds?: number; holdSeconds?: number; out?: string; signature?: string; qzone: boolean }

export function parseArgs(argv: readonly string[]): Args {
    const args: Args = { qzone: false };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]!;
        const value = (): string => { const next = argv[++i]; if (next === undefined) throw new Error(`${flag} 后面要有值`); return next; };
        switch (flag) {
            case '--user': args.user = Number(value()); break;
            case '--config': args.config = value(); break;
            case '--url': args.url = value(); break;
            case '--steps': args.steps = value().split(',').map(name => { if (!(STEPS as readonly string[]).includes(name)) throw new Error(`不认识的步骤：${name}（有 ${STEPS.join('、')}）`); return name as Step; }); break;
            case '--events-seconds': args.eventsSeconds = Number(value()); break;
            case '--hold-seconds': args.holdSeconds = Number(value()); break;
            case '--out': args.out = value(); break;
            case '--signature': args.signature = value(); break;
            case '--qzone': args.qzone = true; break;
            default: throw new Error(`不认识的参数：${flag}`);
        }
    }
    return args;
}

/** 从 NapCat 的 onebot11.json 取 WebSocket 服务端的地址和 token（先找叫 qqbot 的，没有就第一个启用的） */
export function serverFromConfig(json: string): { url: string; token: string } {
    const config = JSON.parse(json) as { network?: { websocketServers?: { name?: string; enable?: boolean; host?: string; port?: number; token?: string }[] } };
    const servers = config.network?.websocketServers ?? [];
    const server = servers.find(entry => entry.name === 'qqbot' && entry.enable) ?? servers.find(entry => entry.enable);
    if (!server?.port) throw new Error('onebot11.json 里没有启用的 WebSocket 服务端');
    return { url: `ws://${server.host && server.host !== '0.0.0.0' ? server.host : '127.0.0.1'}:${server.port}/`, token: server.token ?? '' };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!args.user || !Number.isSafeInteger(args.user)) throw new Error('要用 --user 给你的 QQ 号');
    const configPath = args.config ?? resolve(import.meta.dirname, '..', 'runtime/napcat/workdir/config/onebot11.json');
    const server = serverFromConfig(readFileSync(configPath, 'utf8'));
    const url = `${args.url ?? server.url}${server.token ? `?access_token=${encodeURIComponent(server.token)}` : ''}`;
    const connection = await connect(url);
    const lines: string[] = [];
    const say = (line: string): void => { lines.push(line); console.log(line); };
    try {
        const results = await runProbe({
            connection, user: args.user, say,
            ...(args.steps ? { steps: args.steps } : {}),
            ...(args.eventsSeconds !== undefined ? { eventsMs: args.eventsSeconds * 1000 } : {}),
            ...(args.holdSeconds !== undefined ? { holdMs: args.holdSeconds * 1000 } : {}),
            ...(args.signature !== undefined ? { signature: args.signature } : {}),
            qzone: args.qzone,
        });
        const failed = results.filter(result => !result.ok);
        console.log(`\n共 ${results.length} 项，${results.length - failed.length} 项成功，${failed.length} 项没成功${failed.length ? `：${failed.map(result => result.name).join('、')}` : ''}`);
        if (args.out) {
            mkdirSync(dirname(resolve(args.out)), { recursive: true });
            writeFileSync(resolve(args.out), JSON.stringify({ at: new Date().toISOString(), results, lines }, null, 2));
            console.log(`报告（无消息正文）：${resolve(args.out)}`);
        }
        process.exitCode = failed.length ? 1 : 0;
    } finally {
        connection.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
}
