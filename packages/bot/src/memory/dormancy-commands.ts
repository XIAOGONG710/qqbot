import type { AppConfig, Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import type { Responder } from '../social/responder.ts';
import type { ChatHistory } from './history.ts';
import type { Identity } from './identity.ts';
import type { memoryLedger } from './memory-audit.ts';
import type { Timeline } from './timeline.ts';
import { proposeNote, wakeNote, type Dormancy } from './dormancy.ts';

// 「/休眠」「/唤醒」两条指令（ADR 0161）：先让她自己说话再封存；醒来时核对封存清单、设定账本、记忆账本，补回漏掉的消息，她像刚睡醒一样说一句。
// 原来在 app.ts 里，ADR 0336 第 6 步原样搬到这里（`dormancyCommands(deps)`），函数体逐字不动；
// 会变的「停没停」「她的 QQ 号」改成现取，醒来后各项恢复（补回、B 站、追更、主动消息、存在感）由 App 给一个 resume。
export interface DormancyCommandsDeps {
    config: Pick<AppConfig, 'contacts'>;
    dormancy: Dormancy | undefined;
    /** 男朋友档的第一个人：指令只认他，回执也发给他 */
    deviceOwner: Contact | undefined;
    stopped: () => boolean;
    /** 她的 QQ 号（还没连上时是 0） */
    selfIdKnown: () => number;
    responders: ReadonlyMap<number, Pick<Responder, 'initiate'>>;
    chatHistory: Pick<ChatHistory, 'load'>;
    identity: Pick<Identity, 'check'> | undefined;
    memoryLedgerNow: Pick<ReturnType<typeof memoryLedger>, 'verify'> | undefined;
    noteTimeline: (entry: Parameters<Timeline['record']>[0]) => void;
    /** 给他发一句提示（系统口吻，不是她说的） */
    tellOwner: (text: string) => void;
    /** 补回漏掉的消息（同第一次连上） */
    syncMissed: (selfId: number) => Promise<void>;
    syncRecalledMemory: (qq: number) => void;
    /** 醒来后把休眠时停下的各项接着做：补回之后的追赶、B 站、追更、主动消息、存在感 */
    resume: () => void;
    log: Log;
}

export interface DormancyCommands {
    /** 「/休眠 …」后面的参数：空 / 原因、「确认」「取消」 */
    handle(argument: string): Promise<void>;
    wakeUp(): Promise<void>;
}

export function dormancyCommands(deps: DormancyCommandsDeps): DormancyCommands {
    const { config, dormancy, deviceOwner, stopped, selfIdKnown, responders, chatHistory, identity, memoryLedgerNow, noteTimeline, tellOwner, syncMissed, syncRecalledMemory, resume, log } = deps;
    /** 「/休眠 [原因]」先商量：让她自己说话（这一条会发给他），记下她的话；「/休眠 确认」才封存并休眠；「/休眠 取消」回到醒着 */
    async function handleDormancyCommand(argument: string): Promise<void> {
        if (!dormancy || !deviceOwner) return;
        try {
            if (argument === '确认') {
                const done = dormancy.confirm();
                if (!done.ok) { tellOwner(`（${done.reason}）`); return; }
                noteTimeline({ channel: 'dormancy', kind: 'sleep', summary: '进入休眠，设定和状态封存好了' });
                log(`休眠：已封存 ${done.archive.files} 个文件（${(done.archive.bytes / 1_048_576).toFixed(1)} MB）到 ${done.archive.dir}`);
                tellOwner(`（已封存：${done.archive.files} 个文件、${(done.archive.bytes / 1_048_576).toFixed(1)} MB，在 ${done.archive.dir}；不含密钥、日志和 Hindsight 数据库。她进入休眠，发 /唤醒 叫醒她。）`);
                return;
            }
            if (argument === '取消') { tellOwner(dormancy.cancel() ? '（不休眠了，她还醒着。）' : '（没有在商量的休眠。）'); return; }
            if (dormancy.isDormant()) { tellOwner('（她已经在休眠了。）'); return; }
            const reason = argument.trim() || undefined;
            const proposalToken = dormancy.propose(reason, undefined);
            const outcome = await responders.get(deviceOwner.qq)!.initiate({ label: '休眠前商量', note: proposeNote(reason), topic: '休眠前她想对他说什么', maxBubbles: 3, dryRun: false, commit: () => undefined });
            if (stopped()) return;
            if (outcome.result === 'sent') {
                if (!dormancy.updateProposal(proposalToken, outcome.parts.join('\n'))) return;
                tellOwner('（她回答了，上面就是她的话，已经记进封存。要继续就发「/休眠 确认」，改主意发「/休眠 取消」。）');
            } else {
                const current = dormancy.state();
                if (current.state !== 'proposed' || current.token !== proposalToken) return;
                tellOwner(`（没能让她回答${outcome.result === 'failed' || outcome.result === 'skipped' ? `：${outcome.reason}` : ''}。你可以直接发「/休眠 确认」（她的留言会是空的），或「/休眠 取消」。）`);
            }
        } catch (error) {
            log(`休眠：处理命令出错（${error instanceof Error ? error.message : String(error)}）`);
            tellOwner('（休眠命令出错了，没有做任何改动；详情看日志。）');
        }
    }

    /** 「/唤醒」：核对封存清单、设定账本、记忆账本，补回休眠期间漏掉的消息，她像刚睡醒一样跟他说一句 */
    async function wakeUp(): Promise<void> {
        if (!dormancy || !deviceOwner) return;
        try {
            const since = (() => { const state = dormancy.state(); return state.state === 'dormant' ? Date.parse(state.since) : Date.now(); })();
            const woke = dormancy.wake();
            if (!woke.ok) { tellOwner(`（${woke.reason}）`); return; }
            const problems = [...woke.check.problems];
            let identityLine: string | undefined;
            if (identity) {
                const report = identity.check();
                if (!report.chain.ok) problems.push(`设定账本验不过（${report.chain.reason}）`);
                identityLine = report.changes.length ? `设定有 ${report.changes[0]!.files.length} 处改动${report.unexplained.length ? '，其中有没登记原因的' : '，都有记录'}` : '设定和睡前一样';
            }
            if (memoryLedgerNow) { const check = memoryLedgerNow.verify(); if (!check.ok) problems.push(`记忆账本验不过（${check.reason}）`); }
            noteTimeline({ channel: 'dormancy', kind: 'wake', summary: `醒来了，睡了 ${woke.minutes} 分钟${problems.length ? '，核对有问题' : '，核对都对得上'}`, ok: problems.length === 0 });
            if (selfIdKnown()) { await syncMissed(selfIdKnown()); }
            if (stopped()) return;
            for (const contact of config.contacts) syncRecalledMemory(contact.qq);
            const missed = chatHistory.load(deviceOwner.qq).filter(m => m.role === 'user' && Date.parse(m.time) >= since).length;
            tellOwner(`（她醒了。睡了 ${woke.minutes} 分钟；核对：${problems.length ? problems.join('；') : '封存清单、设定、记忆账本都对得上'}。休眠期间你发了 ${missed} 条。）`);
            resume();
            const outcome = await responders.get(deviceOwner.qq)!.initiate({
                label: '醒来', note: wakeNote(woke.minutes, problems, identityLine, missed ? `休眠期间他发了 ${missed} 条，你会接着回。` : ''),
                topic: '她刚睡醒，想对他说什么', maxBubbles: 3, dryRun: false, commit: () => undefined,
            });
            if (outcome.result !== 'sent') log('休眠：醒来的那一句没发出去');
        } catch (error) {
            log(`休眠：醒来出错（${error instanceof Error ? error.message : String(error)}）`);
            tellOwner('（醒来的过程出错了；详情看日志。）');
        }
    }
    return { handle: handleDormancyCommand, wakeUp };
}
