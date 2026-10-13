// 上线前检查的纯函数部分（ADR 0070 第 17 项）：把「这次要上的提交里有什么」分类，给出该问用户、该先做什么的清单。

export interface ChangeSet { cards: string[]; code: string[]; scripts: string[]; docs: string[]; other: string[] }

// 角色卡目录（characters 下每个角色的 st 文件夹）一变，线上插件当场热加载（ADR 0011 第 5 节），所以卡的改动要单独标出来
export function classifyChanges(files: readonly string[]): ChangeSet {
    const set: ChangeSet = { cards: [], code: [], scripts: [], docs: [], other: [] };
    for (const file of files.map(name => name.replace(/\\/g, '/'))) {
        if (/^characters\/[^/]+\/st\//.test(file)) set.cards.push(file);
        else if (/^packages\/[^/]+\/(src|client)\//.test(file)) set.code.push(file);
        else if (/^scripts\//.test(file) || /^\.github\//.test(file) || file === 'package.json' || file === 'package-lock.json') set.scripts.push(file);
        else if (/^docs\//.test(file) || /\.md$/.test(file) || /^packages\/[^/]+\/test\//.test(file)) set.docs.push(file);
        else set.other.push(file);
    }
    return set;
}

export interface GoLiveInput {
    liveHead: string;
    targetHead: string;
    dirty: boolean;
    commits: readonly string[];
    changes: ChangeSet;
    exposed: readonly { address: string; port: number; name: string }[];
}

export interface GoLiveReport { blockers: string[]; notes: string[]; asks: string[] }

export function goLiveReport(input: GoLiveInput, options: { cardsApproved?: boolean } = {}): GoLiveReport {
    const blockers: string[] = [];
    const notes: string[] = [];
    if (input.dirty) blockers.push('线上目录有没提交的改动：先弄清是谁的，别人的半成品不要被一起带上线');
    if (input.exposed.length) {
        const who = input.exposed.map(item => `${item.name} ${item.address}:${item.port}`).join('、');
        blockers.push(`有进程监听了非本机地址：${who}`);
    }
    if (input.changes.cards.length && !options.cardsApproved) {
        blockers.push(`快进会改角色卡（${input.changes.cards.length} 个文件）：线上插件当场热加载，等于上线。要用户当次点头，并加 --cards-ok 确认过`);
    }
    if (input.liveHead === input.targetHead) notes.push('线上目录已经是目标提交，没有要快进的');
    else notes.push(`线上 ${input.liveHead} → 目标 ${input.targetHead}，${input.commits.length} 个提交`);
    const { code, scripts, docs } = input.changes;
    if (code.length || scripts.length) {
        notes.push(`代码或脚本改动 ${code.length + scripts.length} 个文件：下次重启才生效（守护自己拉起也算）。重启前要用户当次点头，并在 exchange/handoff 写一行「我要在 hh:mm 重启，原因」`);
    } else if (docs.length) {
        notes.push('只有文档和测试的改动：不用重启');
    }
    const asks = [
        '用户在当前会话里点头了吗（合入 main 和上线是两次授权）？',
        'exchange/handoff 里写了重启通知吗？另一个窗口看过吗？',
        '这次只开一个新变量吗（上一个满 48 小时了吗）？',
    ];
    return { blockers, notes, asks };
}
