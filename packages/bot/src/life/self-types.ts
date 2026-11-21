// 「此刻的她」（SELF）导出与回执的格式（ADR 0347 第 2 层，方案 docs/plans/2026-11-22-same-her-layer2-self.md 二、2 / 二、5）。
// 只有类型和文件名：QQ 侧写 SELF.json、读 self-receipts.jsonl；DSH 插件（纯 JS，不 import 这里）按同一格式读写。
// 格式改了要同时改插件 dsh-plugins/dsh-linmengyao-memory/index.js 的 readSelf / 回执，并升 version。

/** 灵魂目录里的文件名 */
export const SELF_FILE = 'SELF.json';
export const SELF_RECEIPTS_FILE = 'self-receipts.jsonl';
export const SELF_KIND = 'qq-self';
export const SELF_VERSION = 1;

/** 和 QQ「此刻」块逐字相同的一段（slot 是 interpreter/slots.ts 的槽名） */
export interface SelfLine {
    slot: string;
    text: string;
}

/** 攒着想跟他说的一件：念头 / 她那边的事 / 待跟进 */
export type SelfPendingKind = 'inner' | 'news' | 'followUp';

export interface SelfPending {
    /** inner:<念头 id> / news:<事件 id> / followUp:<待跟进 id>，回执按它认 */
    id: string;
    kind: SelfPendingKind;
    /** 念头才有：想告诉他 / 想问他 */
    goes?: 'tell' | 'ask';
    /** 念头是她自己的原话；她那边的事、待跟进是那件事本身 */
    text: string;
    /** 从什么时候攒着的（ISO） */
    since: string;
}

export interface SelfExport {
    kind: typeof SELF_KIND;
    version: typeof SELF_VERSION;
    /** 写的时刻（ISO） */
    generatedAt: string;
    /** 渲染用的「此刻」（ISO） */
    at: string;
    /** 状态行下一次会变的时刻与 at + 10 分钟取早的（ISO）；过了就不能再当「现在」 */
    validUntil: string;
    /** 她的那一天（herDay，YYYY-MM-DD） */
    day: string;
    /** 同 NOW.md 的 asleep 行 */
    asleep: boolean;
    lines: SelfLine[];
    /** 危机暂停中为空 */
    pending: SelfPending[];
    paused?: 'crisis';
}

/** 插件在一个桌面回合结束时追加的一行（只追加） */
export interface SelfReceipt {
    v: 1;
    /** 这一行自己的 id（uuid），去重用 */
    id: string;
    /** 写的时刻（ISO） */
    at: string;
    /** 那一轮用的 SELF.json 的 generatedAt */
    selfAt: string;
    /** 这一轮放给她看过的 pending id */
    shown: string[];
    /** 她这一轮的回复，前 600 字 */
    said: string;
}
