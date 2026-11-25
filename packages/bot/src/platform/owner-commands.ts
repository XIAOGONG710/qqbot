import { randomBytes } from 'node:crypto';
import type { DshLink, DshProbeResult } from '../dsh-link.ts';
import { sanitizeDshError } from '../dsh-link.ts';
import type { Executor } from '../executor/executor.ts';
import type { Dormancy } from '../memory/dormancy.ts';
import type { DormancyCommands } from '../memory/dormancy-commands.ts';
import type { Identity } from '../memory/identity.ts';
import { summarize as summarizeMemoryLedger, type memoryLedger } from '../memory/memory-audit.ts';
import type { MobileCompanionIntegration } from '../mobile-companion-dsh.ts';
import type { createCommandReceiptStore } from './command-receipts.ts';
import type { AppConfig, Contact } from './config.ts';
import type { DeviceService } from './device-service.ts';
import type { Log } from './log.ts';
import type { MessageEvent } from './onebot.ts';
import { readWorkMode, setWorkMode } from './work-mode.ts';

// 他（男朋友档、设备所有者）发的指令：只认纯文字；命中的算处理完，不进聊天记录、不交给回复器。
// 指令收敛（2026-10-31 用户：「把绝大多数的指令去掉吧，以后也不新增指令」）：留下的就是这里认的这些，别的 / 开头一律回「不用了」。
// 原来在 app.ts 的 processMessage 里（claimOwnerCommand 和三段指令），ADR 0336 第 6 步原样搬到这里，三段仍由 App 按原来的先后调：
// early（/dsh 子命令、不用了的、/设定、/休眠、/唤醒）→ App 里的唱歌 → 休眠中不回 → workMode（/dsh、/工作、/QQ、/模式）→ device（设备命令）。
export interface OwnerCommandsDeps {
    config: Pick<AppConfig, 'dataDir'>;
    deviceOwner: Contact | undefined;
    dshEnabled: boolean;
    dshLink: Pick<DshLink, 'probe'>;
    /** 最近一次 /dsh probe 的结果（状态页显示） */
    setDshProbe: (result: DshProbeResult) => void;
    mobileCompanion: () => MobileCompanionIntegration | undefined;
    askDsh: (question: string) => void;
    identity: Pick<Identity, 'status'> | undefined;
    memoryLedgerNow: ReturnType<typeof memoryLedger> | undefined;
    dormancy: Pick<Dormancy, 'status'> | undefined;
    dormancyCommands: DormancyCommands;
    commandReceipts: Pick<ReturnType<typeof createCommandReceiptStore>, 'claim'>;
    clockNow: () => Date;
    tellOwner: (text: string) => void;
    plainTextOf: (message: MessageEvent['message']) => string | undefined;
    deviceService: () => DeviceService | undefined;
    transport: Pick<Executor['qq'], 'sendPrivateText'>;
    sendOwnedNotice: (send: () => Promise<unknown>, success: () => void, failure: (error: unknown) => void) => Promise<void>;
    /** 他提给她、等她点头的请求（看屏幕 / 摄像头……） */
    pendingAsk: Map<number, { label: string; at: number; run: () => Promise<{ kind: string; text?: string }> }>;
    planners: ReadonlyMap<number, { poke(): void }>;
    log: Log;
}

export interface OwnerCommands {
    /** /dsh 子命令、不用了的指令、/设定、/休眠、/唤醒；返回 true = 处理完了 */
    early(event: MessageEvent, plain: string | undefined): boolean;
    /** /dsh、/工作（挂起等她决定，照样交给回复器）、/QQ、/回聊、/模式；返回 true = 处理完了 */
    workMode(event: MessageEvent): boolean;
    /** 设备命令（ADR 0148）；返回 true = 处理完了 */
    device(event: MessageEvent): boolean;
}

export function ownerCommands(deps: OwnerCommandsDeps): OwnerCommands {
    const { config, deviceOwner, dshEnabled, dshLink, setDshProbe, askDsh, identity, memoryLedgerNow, dormancy, commandReceipts, clockNow, tellOwner, plainTextOf, transport, sendOwnedNotice, pendingAsk, planners, log } = deps;
    const dormancyCommandsNow = deps.dormancyCommands;

    function claimOwnerCommand(event: MessageEvent): boolean {
        try {
            return commandReceipts.claim(event.user_id, event.message_id, clockNow());
        } catch (error) {
            log(`入口：QQ 命令 ${event.message_id} 去重收据写入失败，未执行（${error instanceof Error ? error.message : String(error)}）`);
            tellOwner('（命令记录暂时写不进去，这次没有执行，等恢复后换一条新消息再试。）');
            return false;
        }
    }

    function early(event: MessageEvent, plain: string | undefined): boolean {
        const mobileCompanion = deps.mobileCompanion();
        if (plain?.startsWith('/') && !claimOwnerCommand(event)) return true;
        // DSH 工作模式保留裸 /dsh；桥接探针和咨询使用显式子命令，避免改变 DSH 原有语义。
        if (dshEnabled && plain === '/dsh probe') {
            void dshLink.probe().then(result => {
                setDshProbe(result);
                return tellOwner(result.ok
                    ? `（DSH 已连通：${result.model}，${result.latencyMs}ms）`
                    : `（DSH 没连上：${sanitizeDshError(result.error)}）`);
            });
            return true;
        }
        if (dshEnabled && plain === '/dsh pair') {
            if (!mobileCompanion) { tellOwner('（手机伴侣还没开。）'); return true; }
            const clientId = `android-${randomBytes(6).toString('hex')}`;
            const ticket = mobileCompanion.issuePairing(clientId);
            tellOwner(`（手机伴侣配对码：${ticket.pairingCode}；设备 ID：${clientId}；${Math.ceil((ticket.expiresAt - Date.now()) / 60_000)} 分钟内有效。不要把配对码发给别人。）`);
            return true;
        }
        if (dshEnabled && plain === '/dsh unpair') {
            if (!mobileCompanion) { tellOwner('（手机伴侣还没开。）'); return true; }
            mobileCompanion.reset();
            tellOwner('（手机伴侣已解除配对，旧连接和媒体会话都失效了。）');
            return true;
        }
        if (dshEnabled && plain?.startsWith('/dsh ask ')) {
            askDsh(plain.slice('/dsh ask '.length).trim());
            return true;
        }
        if (dshEnabled && plain?.startsWith('/dsh talk ')) {
            askDsh(plain.slice('/dsh talk '.length).trim());
            return true;
        }
        // 指令收敛（2026-10-31 用户：「把绝大多数的指令去掉吧，以后也不新增指令」）：
        // 只留运维必需的四条（休眠/唤醒/模式/设定），别的指令一律当作“不用了”，直接请他用话说。
        // 想看什么、想让她做什么，都在聊天里说——她会自己判断做不做。
        const KEEP = new Set(['/设定', '/休眠', '/唤醒', '/模式', '/dsh', '/工作', '/QQ', '/qq', '/回聊', '/屏幕', '/看屏幕', '/摄像头', '/拍照', '/设备', '/批准', '/拒绝']);
        const head = plain?.startsWith('/') ? plain.split(/\s+/)[0]! : undefined;
        if (head && !KEEP.has(head)) {
            tellOwner('（这些指令已经不用了，直接跟我说就行）');
            return true;
        }
        if (plain === '/设定' && (identity || memoryLedgerNow || dormancy)) {
            tellOwner([identity?.status(), memoryLedgerNow ? summarizeMemoryLedger(memoryLedgerNow) : undefined, dormancy?.status()].filter(Boolean).join('\n\n'));
            return true;
        }
        if (dormancy && plain && /^\/休眠(?:\s|$)/.test(plain)) { void dormancyCommandsNow.handle(plain.replace(/^\/休眠\s*/, '')); return true; }
        if (dormancy && plain === '/唤醒') { void dormancyCommandsNow.wakeUp(); return true; }
        return false;
    }

    function workMode(event: MessageEvent): boolean {
        // 他发「/dsh」「/QQ」「/模式」：只认男朋友档的他、只认纯文字；命中的算处理完，不进聊天记录
        if (event.user_id === deviceOwner?.qq) {
            const plain = plainTextOf(event.message)?.trim();
            log(`[${event.user_id}] 命令检查：${JSON.stringify(plain)}`);
            if (plain === '/dsh' || plain === '/工作') {
                // 不机械切换：先挂起，让她自己答应/拒绝/提条件；反复催会让她烦
                setWorkMode(config.dataDir, event.user_id, 'pending');
                log(`[${event.user_id}] 收到 /dsh：等她决定`);
            } else if (plain === '/QQ' || plain === '/qq' || plain === '/回聊') {
                setWorkMode(config.dataDir, event.user_id, 'chat');
                tellOwner('（回聊天模式了）');
                log(`[${event.user_id}] 收到 /QQ：切回聊天模式`);
                return true;
            } else if (plain === '/模式') {
                const mode = readWorkMode(config.dataDir, event.user_id);
                tellOwner(mode === 'work' ? '（现在：工作模式）' : mode === 'pending' ? '（她还没答应切工作）' : '（现在：聊天模式）');
                return true;
            }
        }
        return false;
    }

    function device(event: MessageEvent): boolean {
        // 他发的设备命令（ADR 0148）：「批准」「拒绝」「/屏幕」「/摄像头」「/设备」，只认纯文字、只认男朋友档的他；
        // 命中的算处理完，不进聊天记录、不交给回复器。看屏幕 / 摄像头：看完的描述作为他这一条消息交给回复器，她自然地回
        const deviceService = deps.deviceService();
        if (deviceService && deviceOwner && event.user_id === deviceOwner.qq) {
            const plain = plainTextOf(event.message);
            if (plain !== undefined && !plain.trim().startsWith('/') && deviceService.isOwnerCommand(plain) && !claimOwnerCommand(event)) return true;
            const outcome = plain === undefined ? undefined : deviceService.owner(plain);
            if (outcome?.kind === 'reply') {
                void sendOwnedNotice(() => transport.sendPrivateText(event.user_id, outcome.text), () => {},
                    error => log(`设备控制：回复没发出去（${error instanceof Error ? error.message : String(error)}）`));
                return true;
            }
            if (outcome?.kind === 'capture') {
                // 她有权拒绝（用户 10-30）：先把请求提给她，不直接做
                pendingAsk.set(event.user_id, { label: '看你的屏幕或摄像头', at: clockNow().getTime(), run: outcome.run });
                void transport.sendPrivateText(event.user_id, '（我跟她说了，她愿意就给我看）').catch(error => log(`设备控制：话说没发出去：${error instanceof Error ? error.message : String(error)}`));
                planners.get(event.user_id)?.poke();
                return true;
            }
        }
        return false;
    }

    return { early, workMode, device };
}
