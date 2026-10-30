// 微信通道的 id 映射（2026-10-30，目标：她自己有一个微信号去跟别人聊）。
// 为什么要有它：QQ 那边所有联系人 id 是 number（QQ 号），聊天记录文件、档位表、状态页都按数字走。
// 微信是字符串 wxid，硬改成 string 会牵动几百处；先把 wxid 稳定映射成 53 位整数，
// 现有代码一行不用动——文件里存的就是这个数字，桥接进程负责反过来查回 wxid。
//
// 规矩：同一个 wxid 永远同一个数字（FNV-1a 52 位，不依赖进程、不依赖顺序）；碰撞了桥接层报错，不静默合并。

/** wxid → 稳定的正整数（52 位内，JS 安全整数范围） */
export function wechatId(wxid: string): number | undefined {
    const text = String(wxid ?? '').trim().toLowerCase();
    if (!text) return undefined;
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    // 再混一次，避免短 id 的低位太规律
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b) >>> 0;
    hash ^= hash >>> 13;
    const value = (hash & 0xfffff) * 0x100000 + ((hash >>> 20) & 0xfffff);
    return value > 0 ? value : value + 1;
}

/** 反查表：数字 → wxid（桥接进程里维护，落盘一份，重启后仍能发回去） */
export type WechatDirectory = Record<string, string>;

/** 记录一条映射；同一个 wxid 之前映射到过别的数字（哈希变了 / 改过实现）就返回 false，由调用方决定怎么办 */
export function rememberWechat(directory: WechatDirectory, wxid: string): { id: number; conflict: boolean } | undefined {
    const id = wechatId(wxid);
    if (id === undefined) return undefined;
    const key = String(id);
    const previous = directory[key];
    if (previous && previous !== wxid) return { id, conflict: true };
    directory[key] = wxid;
    return { id, conflict: false };
}
