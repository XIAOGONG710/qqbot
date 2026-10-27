// 我们能调的 B 站命令表（ADR 0168，照 bili-cli 的 `bili schema` 化用）：给 Agent / 别的程序看的一份机器可读清单。
// 只列「已经写了的」；没写的（投稿、账号数据、登录）不列，免得按清单调用时全是空。
// 一条命令 = 名字 + 说明 + 所属模块 + 是否只读 + 参数说明；真正的执行在各自的 CLI / 模块里。

export interface BiliCommand {
    name: string;
    summary: string;
    /** 只读 / 写 */
    mode: 'read' | 'write';
    /** 需要登录态？ */
    login: boolean;
    /** 参数：名字 → 一句话 */
    args?: Record<string, string>;
    /** 对应的入口（模块或 CLI） */
    entry: string;
}

export const BILI_COMMANDS: readonly BiliCommand[] = [
    { name: 'video view', summary: '视频信息 + 分段章节 + 弹幕高能 + 雪碧图', mode: 'read', login: false, args: { bvid: 'BV 号' }, entry: 'ops/bilibili-view-cli.ts' },
    { name: 'video summary', summary: 'B 站 AI 总结（要登录）', mode: 'read', login: true, args: { bvid: 'BV 号' }, entry: 'bilibili-summary.ts' },
    { name: 'feed recommend', summary: '首页推荐流 + 一次「刷」的会话（停 / 划走）', mode: 'read', login: false, args: { fresh: '第几刷', size: '这次刷几个' }, entry: 'ops/bilibili-feed-cli.ts' },
    { name: 'stats video', summary: '单稿播放 / 赞 / 币 / 藏 / 评 + 每百播率', mode: 'read', login: false, args: { bvid: 'BV 号（可多个）' }, entry: 'ops/bilibili-stats-cli.ts' },
    { name: 'inbox mentions', summary: '@我的（解析）', mode: 'read', login: true, entry: 'bilibili-inbox.ts' },
    { name: 'inbox likes', summary: '收到的赞（解析）', mode: 'read', login: true, entry: 'bilibili-inbox.ts' },
    { name: 'inbox replies', summary: '回复我的（原有）', mode: 'read', login: true, entry: 'bilibili-account.ts' },
    { name: 'comment visible', summary: '刚发的评论有没有出现在公开列表（折叠检查）', mode: 'read', login: true, entry: 'bilibili-account.ts' },
];

export function findCommand(name: string): BiliCommand | undefined {
    return BILI_COMMANDS.find(command => command.name === name);
}

/** 给 Agent 的清单：一行一条，只读/写、要不要登录都写清楚 */
export function schemaLine(command: BiliCommand): string {
    return `${command.name} [${command.mode}${command.login ? ', 要登录' : ''}] ${command.summary}（${command.entry}）`;
}
