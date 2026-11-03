// 状态页的“功能开关”仪表盘用到的纯函数（ADR 0120）。没有任何导入——Node 里能直接测（test/dashboard.test.ts）。
// 数据来自 app.ts 的 status().features / extras（bot/src/features.ts 的功能总表 + 此刻的开关）。

/** 模块的显示顺序；总表里出现了这里没有的模块，排在最后 */
export const GROUP_ORDER = ['说话', '她的日子', '主动找他', '照片和表情', 'B 站', '在 QQ 上的样子', '记忆和安全', '工具'];
const TIER_NAMES = { boyfriend: '男朋友', bestie: '闺蜜', girl_friend: '女生熟人', known: '熟人', classmate: '同学', stranger: '陌生人', unlisted: '名单外好友', group: '群聊' };

const MODE_NAMES = { on: '开', dryRun: '试运行', greet: '问候', send: '会发', collect: '只收藏', true: '开' };
const RESPONDER_SEARCH_NAMES = {
    waiting: '等待', settling: '连续消息', generating: '准备回复', sending: '发送回复', retry: '重试', initiating: '主动联系', idle: '空闲',
};

/** 回复器内部阶段统一翻成页面中文；搜索和表格共用，避免用户看到或输入代码值。 */
export function responderStatusText(responder = {}) {
    switch (responder.phase) {
        case 'waiting': return '等对方停下来';
        case 'settling': return '对方还在发消息';
        case 'generating': return '正在准备回复';
        case 'sending': return '正在发送回复';
        case 'retry': return '回复遇到问题，稍后再试';
        case 'initiating': return '正在主动联系';
        default: return responder.skipped ? '暂时不回复' : '空闲';
    }
}

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
    const modeName = item.mode ? (MODE_NAMES[item.mode] ?? '已启用') : '';
    const mode = modeName && modeName !== '开' ? `（${modeName}）` : '';
    return `${item.label}${mode}`;
}
export const featureTitle = item => `${item.on ? '已启用' : '未启用'}${item.hint ? `；${item.hint}` : ''}`;

/** 开了几个、一共几个（顶上的一行） */
export function featureTotals(features) {
    const list = features ?? [];
    return { on: list.filter(item => item.on).length, total: list.length };
}

/** 联系人列表筛选：控制台只在本地过滤状态摘要，不触碰聊天内容。 */
export function filterContacts(contacts, query = '', activeOnly = false) {
    const needle = String(query).trim().toLocaleLowerCase();
    return (contacts ?? []).filter(contact => {
        if (activeOnly && (!contact.responder?.phase || contact.responder.phase === 'idle')) return false;
        if (!needle) return true;
        const haystack = [
            contact.name, contact.qq, contact.tier, contact.now,
            TIER_NAMES[contact.tier],
            responderStatusText(contact.responder),
            RESPONDER_SEARCH_NAMES[contact.responder?.phase],
        ].filter(value => value !== undefined && value !== null).join(' ').toLocaleLowerCase();
        return haystack.includes(needle);
    });
}

/** 一眼看总览卡片用的计数，避免在组件里重复拼业务判断。 */
export function overviewCounts(status) {
    const contacts = status?.contacts ?? [];
    const busy = contacts.filter(contact => contact.responder?.phase && contact.responder.phase !== 'idle').length;
    const retrying = contacts.filter(contact => contact.responder?.phase === 'retry').length;
    const dsh = status?.features?.find(feature => feature.key === 'dsh');
    return {
        contacts: contacts.length,
        busy,
        retrying,
        dshOn: dsh?.on === true,
        features: featureTotals(status?.features),
    };
}

/** 控制台统一使用用户本地时间，不直接展示 ISO 时间串。 */
export function dashboardTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '时间未知';
    const pad = number => String(number).padStart(2, '0');
    return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** DSH 探针摘要：不把外部错误原文带进控制台，只展示是否探测过和最近延迟。 */
export function dshStatusLine(dsh) {
    if (!dsh?.enabled) return { text: '未启用', type: 'info', detail: '' };
    const probe = dsh.lastProbe;
    if (!probe) return { text: '已启用，尚未探测', type: 'warning', detail: '在 QQ 发送 /dsh probe 后显示连接结果' };
    const at = dashboardTime(probe.at);
    if (!probe.ok) return { text: '探测失败', type: 'danger', detail: `最近探测 ${at}` };
    const latency = Number.isFinite(probe.latencyMs) ? ` · ${probe.latencyMs} 毫秒` : '';
    return { text: '连接正常', type: 'success', detail: `最近探测 ${at}${latency}` };
}

/** 长期记忆连接卡片：保留最近一次活动，但不重复整块明细。 */
export function memoryStatusDetail(memory) {
    if (!memory) return '功能未开启';
    if (!memory.health) return '正在检查';
    if (!memory.health.ok) return '暂时不可用，请检查设置';
    const events = [
        memory.lastWrite && { ...memory.lastWrite, label: '写入' },
        memory.lastRecall && { ...memory.lastRecall, label: '召回' },
    ].filter(Boolean).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const recent = events[0];
    if (!recent) return '服务正常，等待第一次同步';
    return `服务正常 · 最近${recent.label}${recent.ok ? '成功' : '失败'} ${dashboardTime(recent.at)}`;
}

/** 手机伴侣连接卡片：状态和积压数放在一行，不再另做重复明细。 */
export function mobileCompanionStatusDetail(companion) {
    if (!companion?.enabled) return '暂未启用';
    const state = !companion.pairedClientId ? '等待配对' : companion.connected ? '已连接' : '等待重连';
    return `${state} · 待发送 ${companion.queued ?? 0} 条`;
}

/** 现实数据统一摘要：控制台只给中文结论，不展示供应商错误原文或接口细节。 */
export function realWorldStatus(status) {
    const modules = [];
    let issues = 0;
    const places = (label, data, amountKey, amountLabel) => {
        if (!data) return;
        const rows = Object.values(data.places ?? {});
        const errors = rows.filter(row => row.error).length;
        const stale = rows.filter(row => row.stale).length;
        const amount = rows.reduce((sum, row) => sum + (row[amountKey] ?? 0), 0);
        let state;
        if (errors) state = `${errors} 个地点失败`;
        else if (stale) state = `${stale} 个地点陈旧`;
        else if (!data.fetchedAt && amount === 0) state = '等待取数';
        else state = `正常${amount ? `（${amount} ${amountLabel}）` : ''}`;
        if (errors || stale || state === '等待取数') issues += 1;
        modules.push(`${label}${state}`);
    };
    places('天气', status?.weather, 'hours', '小时');
    places('空气质量', status?.airQuality, 'hours', '小时');
    places('日照', status?.daylight, 'days', '天');
    if (status?.calendar) {
        const staleYears = status.calendar.staleYears ?? [];
        const state = status.calendar.error ? '获取失败'
            : staleYears.length ? `${staleYears.join('、')} 年陈旧`
                : status.calendar.years?.length ? `正常（${status.calendar.years.join('、')} 年）` : '等待取数';
        if (status.calendar.error || staleYears.length || state === '等待取数') issues += 1;
        modules.push(`法定日历${state}`);
    }
    if (!modules.length) return { text: '未开启', type: 'info', detail: '', healthy: false };
    return {
        text: issues ? `${issues} 项需检查` : '正常',
        type: issues ? 'warning' : 'success',
        detail: modules.join(' · '),
        healthy: issues === 0,
    };
}

/** 货架 / 小梗 / 周报：[{ label, text }]；对应的功能没开（没有这一项）就不出现 */
export function extrasRows(extras) {
    const rows = [];
    if (extras?.photos) {
        const p = extras.photos;
        rows.push({ label: '照片货架', text: p.count ? `${p.count} 张（土豆 ${p.cat}、天空 ${p.view}${p.work ? `、她的片子 ${p.work}` : ''}${p.food ? `、吃的 ${p.food}` : ''}）` : '空的（她自己去网上找，每 6 小时一次）' });
    }
    if (extras?.jokes !== undefined) rows.push({ label: '小梗', text: extras.jokes ? `${extras.jokes} 个` : '还没有（聊得够多会自己抽）' });
    if (extras?.report) {
        const match = /(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?:\D|$)/.exec(String(extras.report.name ?? ''));
        const month = match ? Number(match[2]) : 0;
        const day = match ? Number(match[3]) : 0;
        rows.push({ label: '最近一份周报', text: month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `${month}月${day}日生成` : '已生成' });
    }
    return rows;
}
