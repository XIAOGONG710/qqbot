// 状态页的“功能开关”仪表盘用到的纯函数（ADR 0120）。没有任何导入——Node 里能直接测（test/dashboard.test.ts）。
// 数据来自 app.ts 的 status().features / extras（bot/src/features.ts 的功能总表 + 此刻的开关）。

/** 模块的显示顺序；总表里出现了这里没有的模块，排在最后 */
export const GROUP_ORDER = ['说话', '她的日子', '主动找他', '照片和表情', 'B 站', '在 QQ 上的样子', '记忆和安全', '工具'];

const MODE_NAMES = { on: '开', dryRun: '试运行', greet: '问候', send: '会发', collect: '只收藏', true: '开' };

/** features → [{ name, on, total, items }]，每组里开着的排前面，其余照总表顺序 */
export function featureGroups(features) {
    const byGroup = new Map();
    for (const feature of features ?? []) {
        if (!byGroup.has(feature.group)) byGroup.set(feature.group, []);
        byGroup.get(feature.group).push(feature);
    }
    const names = [...GROUP_ORDER.filter(name => byGroup.has(name)), ...[...byGroup.keys()].filter(name => !GROUP_ORDER.includes(name))];
    return names.map(name => {
        const items = byGroup.get(name);
        const ordered = [...items.filter(item => item.on), ...items.filter(item => !item.on)];
        return { name, on: items.filter(item => item.on).length, total: items.length, items: ordered };
    });
}

/** 一个开关的小标签：开着的写上模式（试运行 / 问候 / 会发）；ADR 编号放在提示里 */
export function featureLabel(item) {
    const mode = item.mode && MODE_NAMES[item.mode] !== '开' ? `（${MODE_NAMES[item.mode] ?? item.mode}）` : '';
    return `${item.label}${mode}`;
}
export const featureTitle = item => `${item.on ? '开着' : '关着'}${item.adr ? `　ADR ${item.adr}` : ''}`;

/** 开了几个、一共几个（顶上的一行） */
export function featureTotals(features) {
    const list = features ?? [];
    return { on: list.filter(item => item.on).length, total: list.length };
}

/** 货架 / 小梗 / 周报：[{ label, text }]；对应的功能没开（没有这一项）就不出现 */
export function extrasRows(extras) {
    const rows = [];
    if (extras?.photos) {
        const p = extras.photos;
        rows.push({ label: '照片货架', text: p.count ? `${p.count} 张（土豆 ${p.cat}、天空 ${p.view}${p.work ? `、她的片子 ${p.work}` : ''}）` : '空的（她自己去网上找，每 6 小时一次）' });
    }
    if (extras?.jokes !== undefined) rows.push({ label: '小梗', text: extras.jokes ? `${extras.jokes} 个` : '还没有（聊得够多会自己抽）' });
    if (extras?.report) rows.push({ label: '最近一份周报', text: extras.report.name });
    return rows;
}
