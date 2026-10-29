// 「同一个她」的记忆接缝（ADR 0176）：QQ 这边告诉 DSH 那边——他（男朋友档）的记忆在哪个 bank。
//
// 用户 10-29：「无论在哪里都是同一个她，记忆可以连贯起来」。QQ 和 DSH 桌面上的她共用 Hindsight，但原来是各管各的、又互相乱读：
//   · DSH 插件把所有名叫 linmengyao-* 的 bank 都召回——包括名单里其他人（鸽鸽、同学……）各自的私聊 bank，等于把别人的私聊讲给他听；
//   · DSH 写自己的 bank「linmengyao」，QQ 这边 recallWork 又对每个联系人都去查它——桌面上给他干的活被说给了同学。
// 现在：他在 DSH 桌面上和在 QQ 上是同一段关系，用同一个 bank（linmengyao-<他的哈希>）；DSH 只召回他的 bank、公共库、和老的 linmengyao（接缝之前的历史）。
// bank ID 带哈希，DSH 插件不自己算（算法在 long-term.ts，改了两边会不一致），由 QQ 启动时把它写进 <数据目录>/memory/owner-bank.json。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';

export interface OwnerBankInfo {
    /** 他（男朋友档）自己的 bank：QQ 聊天的片段写在这里，DSH 桌面上的对话也写在这里 */
    ownerBank: string;
    /** 公共记忆库（名单里的人共享的那部分） */
    commonBank: string;
    /** 接缝之前 DSH 单独用的 bank（只读，历史） */
    legacyBank: string;
    /** 写入时间（ISO），只给人看 */
    writtenAt?: string;
}

export const OWNER_BANK_FILE = 'owner-bank.json';

export const ownerBankPath = (memoryDir: string): string => join(memoryDir, OWNER_BANK_FILE);

/** 没变就不重写（每次启动都调用，不要白动文件）；返回有没有写 */
export function writeOwnerBank(memoryDir: string, info: Omit<OwnerBankInfo, 'writtenAt'>, now: () => Date = () => new Date()): boolean {
    const path = ownerBankPath(memoryDir);
    const current = readJsonOr<Partial<OwnerBankInfo>>(path, {});
    if (current.ownerBank === info.ownerBank && current.commonBank === info.commonBank && current.legacyBank === info.legacyBank) return false;
    writeJsonAtomic(path, { ...info, writtenAt: now().toISOString() });
    return true;
}

export function readOwnerBank(memoryDir: string): OwnerBankInfo | undefined {
    const value = readJsonOr<Partial<OwnerBankInfo>>(ownerBankPath(memoryDir), {});
    return typeof value.ownerBank === 'string' && typeof value.commonBank === 'string' && typeof value.legacyBank === 'string'
        ? { ownerBank: value.ownerBank, commonBank: value.commonBank, legacyBank: value.legacyBank, ...(value.writtenAt ? { writtenAt: value.writtenAt } : {}) }
        : undefined;
}
