// 状态页的“功能开关”仪表盘用到的纯函数（ADR 0120）。没有任何导入——Node 里能直接测（test/dashboard.test.ts）。
// 数据来自 app.ts 的 status().features / extras（bot/src/features.ts 的功能总表 + 此刻的开关）。

/** 模块的显示顺序；总表里出现了这里没有的模块，排在最后 */
export const GROUP_ORDER = ['说话', '她的日子', '主动找他', '照片和表情', 'B 站', '在 QQ 上的样子', '记忆和安全', '工具'];
const TIER_NAMES = { boyfriend: '男朋友', bestie: '闺蜜', girl_friend: '女生熟人', known: '熟人', classmate: '同学', stranger: '陌生人', unlisted: '名单外好友', group: '群聊' };

const CAPABILITY_DEFS = [
    { id: 'conversation', name: '对话与关系', groups: ['说话'], description: '口吻、情绪回应、关系变化和事实检查' },
    { id: 'life', name: '自主生活', groups: ['她的日子', '主动找他'], description: '作息、世界、连续数值和主动联系' },
    { id: 'media', name: '图片与语音', groups: ['照片和表情'], description: '看图、听语音、照片和表情表达' },
    { id: 'social', name: '社交空间', groups: ['B 站', '在 QQ 上的样子'], description: 'B站、QQ空间、群聊和账号形象' },
    { id: 'continuity', name: '记忆与边界', groups: ['记忆和安全'], description: '长期记忆、跨端连续、隐私和设备权限' },
    { id: 'tools', name: '外部能力', groups: ['工具'], description: '外部顾问、周报和可审计工具' },
];

const MODE_NAMES = { on: '开', dryRun: '试运行', greet: '问候', send: '会发', collect: '只收藏', true: '开' };
const RESPONDER_SEARCH_NAMES = {
    waiting: '等待', settling: '连续消息', generating: '准备回复', sending: '发送回复', retry: '重试', initiating: '主动联系', idle: '空闲',
};
const positiveInteger = value => Number.isInteger(value) && value > 0 ? value : 0;

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
        const ordered = [...items.filter(item => item.on), ...items.filter(item => item.configured && !item.on), ...items.filter(item => !item.on && !item.configured)];
        return { name, on: items.filter(item => item.on).length, blocked: items.filter(item => item.configured && !item.on).length, total: items.length, items: ordered };
    });
}

/** 一个开关的小标签：开着的写上模式（试运行 / 问候 / 会发）；ADR 编号放在提示里 */
export function featureLabel(item) {
    if (item.configured && !item.on) return `${item.label}（还需开启其他功能）`;
    const modeName = item.mode ? (MODE_NAMES[item.mode] ?? '已启用') : '';
    const mode = modeName && modeName !== '开' ? `（${modeName}）` : '';
    return `${item.label}${mode}`;
}
export const featureTitle = item => `${item.on ? '已启用' : item.configured ? `已开启但尚未生效${item.missing?.length ? `；还需启用：${item.missing.join('、')}` : ''}` : '未启用'}${item.hint ? `；${item.hint}` : ''}`;

/** 开了几个、一共几个（顶上的一行） */
export function featureTotals(features) {
    const list = features ?? [];
    return { on: list.filter(item => item.on).length, blocked: list.filter(item => item.configured && !item.on).length, total: list.length };
}

/**
 * 把技术开关按用户能理解的体验重新归组。这里只做只读投影；能力包本身不是总开关，
 * 不会绕过底层每一项各自的权限、确认和审计。
 */
export function capabilityBundles(features) {
    const list = features ?? [];
    return CAPABILITY_DEFS.map(definition => {
        const items = list.filter(feature => definition.groups.includes(feature.group));
        const enabled = items.filter(feature => feature.on);
        return {
            id: definition.id,
            name: definition.name,
            description: definition.description,
            on: enabled.length,
            total: items.length,
            active: enabled.length > 0,
            highlights: enabled.slice(0, 4).map(feature => feature.label),
            more: Math.max(0, enabled.length - 4),
        };
    });
}

export function capabilityTotals(features) {
    const bundles = capabilityBundles(features);
    return { on: bundles.filter(bundle => bundle.active).length, total: bundles.length };
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
    const drafts = positiveInteger(status?.externalDrafts?.pending);
    const approved = positiveInteger(status?.externalDrafts?.approved);
    const publishing = positiveInteger(status?.externalDrafts?.publishing);
    const failed = positiveInteger(status?.externalDrafts?.failed);
    const aiPhotos = positiveInteger(status?.extras?.aiPhotoDrafts?.pending);
    const dsh = status?.features?.find(feature => feature.key === 'dsh');
    return {
        contacts: contacts.length,
        busy,
        attention: { total: retrying + drafts + approved + publishing + failed + aiPhotos, retrying, drafts, approved, publishing, failed, aiPhotos },
        dshOn: dsh?.on === true,
        features: featureTotals(status?.features),
        capabilities: capabilityTotals(status?.features),
    };
}

/** 顶部待处理卡片只展示用户能理解的来源，不暴露内部状态码。 */
export function attentionDetail(attention = {}) {
    const parts = [];
    if (attention.retrying) parts.push(`回复需重试 ${attention.retrying}`);
    if (attention.drafts) parts.push(`草稿待确认 ${attention.drafts}`);
    if (attention.approved) parts.push(`已批准待发布 ${attention.approved}`);
    if (attention.publishing) parts.push(`发布待核对 ${attention.publishing}`);
    if (attention.failed) parts.push(`发布失败待处理 ${attention.failed}`);
    if (attention.aiPhotos) parts.push(`AI 照片待审核 ${attention.aiPhotos}`);
    return parts.join(' · ') || '当前没有需要处理的事项';
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

/** 手机伴侣连接卡片：queued 是手机上行请求的处理队列，不是宿主待发送动作。 */
export function mobileCompanionStatusDetail(companion) {
    if (!companion?.enabled) return '暂未启用';
    const state = !companion.pairedClientId ? '等待配对' : companion.connected ? '已连接' : '等待重连';
    const queued = Number.isInteger(companion.queued) && companion.queued > 0 ? companion.queued : 0;
    return queued ? `${state} · 正在处理 ${queued} 条` : state;
}

const REAL_WORLD_SOURCES = {
    'open-meteo': 'Open-Meteo',
    'open-meteo-air-quality': 'Open-Meteo',
    'open-meteo-daylight': 'Open-Meteo',
    'holiday.ailcc.com': '法定日历服务',
    'generic-transport': '自定义交通数据',
};
const safeSource = provider => REAL_WORLD_SOURCES[provider];
const safeUpdatedAt = value => Number.isFinite(Date.parse(value)) ? `更新 ${dashboardTime(value)}` : undefined;
// 地点来自卡上的 weather.places（ADR 0334），状态里只有它们的 id：这里只说覆盖几个地方，不在页面上写具体地名
const coveragePlaces = rows => { const count = Object.keys(rows ?? {}).length; return count ? `${count} 个地方` : ''; };
const withMeta = (state, parts) => {
    const safe = parts.filter(Boolean);
    return safe.length ? `${state}（${safe.join('；')}）` : state;
};

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
        else state = '正常';
        if (errors || stale || state === '等待取数') issues += 1;
        modules.push(`${label}${withMeta(state, [
            coveragePlaces(data.places),
            amount ? `${amount} ${amountLabel}` : undefined,
            safeSource(data.provider) ? `来源 ${safeSource(data.provider)}` : undefined,
            safeUpdatedAt(data.fetchedAt),
        ])}`);
    };
    places('天气', status?.weather, 'hours', '小时');
    places('空气质量', status?.airQuality, 'hours', '小时');
    places('日照', status?.daylight, 'days', '天');
    if (status?.transport) {
        const rows = Object.values(status.transport.locations ?? {});
        const errors = rows.filter(row => row.error).length;
        const stale = rows.filter(row => row.stale).length;
        const observed = rows.filter(row => row.status && row.observedAt).length;
        let state;
        if (errors) state = `${errors} 个地点失败`;
        else if (stale || status.transport.stale) state = `${stale || rows.length || 1} 个地点陈旧`;
        else if (!status.transport.fetchedAt && observed === 0) state = '等待取数';
        else state = '正常';
        if (errors || stale || status.transport.stale || state === '等待取数') issues += 1;
        modules.push(`交通${withMeta(state, [
            coveragePlaces(status.transport.locations),
            safeSource(status.transport.provider) ? `来源 ${safeSource(status.transport.provider)}` : undefined,
            safeUpdatedAt(status.transport.fetchedAt),
        ])}`);
    }
    if (status?.calendar) {
        const staleYears = status.calendar.staleYears ?? [];
        const state = status.calendar.error ? '获取失败'
            : staleYears.length ? `${staleYears.join('、')} 年陈旧`
                : status.calendar.years?.length ? '正常' : '等待取数';
        if (status.calendar.error || staleYears.length || state === '等待取数') issues += 1;
        modules.push(`法定日历${withMeta(state, [
            status.calendar.years?.length ? `覆盖 ${status.calendar.years.join('、')} 年` : undefined,
            safeSource(status.calendar.provider) ? `来源 ${safeSource(status.calendar.provider)}` : undefined,
            safeUpdatedAt(status.calendar.fetchedAt),
        ])}`);
    }
    if (!modules.length) return { text: '未开启', type: 'info', detail: '', healthy: false };
    return {
        text: issues ? `${issues} 项需检查` : '正常',
        type: issues ? 'warning' : 'success',
        detail: modules.join(' · '),
        healthy: issues === 0,
    };
}

/**
 * 把分散的作息、世界事实和连续数值压成用户能直接看懂的生活切片。
 * 这里只解释现有状态，不调用模型，也不根据缺失数据补故事。
 */
export function lifePulse(status) {
    if (!status) return [];
    const owner = status.contacts?.find(contact => contact.tier === 'boyfriend') ?? status.contacts?.[0];
    const values = status.humanValues;
    const rows = [];
    rows.push({ label: '现在', text: owner?.now || (status.schedule ? '正在等待作息状态' : '作息未启用') });

    if (values) {
        const body = [];
        if (Number.isFinite(values.energy)) {
            if (values.energy <= 30) body.push('有些累');
            else if (values.energy >= 75) body.push('精力不错');
        }
        if (Number.isFinite(values.hunger)) {
            if (values.hunger >= 70) body.push('已经饿了');
            else if (values.hunger <= 20) body.push('还不饿');
        }
        if (Number.isFinite(values.stress)) {
            if (values.stress >= 70) body.push('压力偏高');
            else if (values.stress <= 25) body.push('比较放松');
        }
        const hasBodyValues = [values.energy, values.hunger, values.stress].some(Number.isFinite);
        if (hasBodyValues) rows.push({ label: '身体感受', text: body.join('，') || '状态比较平稳' });
    }

    const trend = lifeTrend(status);
    if (trend) rows.push(trend);

    const mood = status.today?.mood;
    if (mood) rows.push({ label: '心情', text: `${mood.name}${mood.reason ? `，${mood.reason}` : ''}` });

    const relationship = values?.relationship;
    if (relationship && Number.isFinite(relationship.intimacy) && Number.isFinite(relationship.trust)) {
        let text = relationship.intimacy >= 75 && relationship.trust >= 65 ? '和你很亲近，信任稳定'
            : relationship.intimacy >= 50 ? '和你熟悉，也愿意分享自己的事'
                : relationship.trust >= 50 ? '正在慢慢建立信任' : '还在保持分寸';
        if (relationship.friction >= 45) text += '，最近有些别扭';
        rows.push({ label: '你们之间', text });
    }

    const books = status.today?.books?.filter(book => !book.finished && !book.putDown).slice(0, 2)
        .map(book => `《${book.title}》第 ${book.amount} ${book.unit}`);
    if (books?.length) rows.push({ label: '在读', text: books.join('、') });

    const highlights = status.today?.highlights;
    const recent = highlights?.[0];
    rows.push({
        label: '刚发生',
        text: recent?.text || (highlights === undefined ? '还没有可用的世界记录' : '今天还没有已记录的小事'),
    });
    return rows;
}

/** 把内部字段变化翻成中文趋势；未知字段不展示，避免控制台出现代码串。 */
export function lifeTrend(status) {
    const trend = status?.humanTrends;
    const window = trend?.windowMinutes;
    if (!Number.isFinite(window) || window < 1 || !trend?.values || typeof trend.values !== 'object') return undefined;
    const words = {
        energy: ['精力', '恢复', '下降'],
        hunger: ['饥饿感', '增加', '减轻'],
        stress: ['压力', '上升', '缓解'],
        mood: ['心情', '变好', '走低'],
        health: ['身体状态', '好转', '下降'],
        loneliness: ['孤独感', '增加', '减轻'],
        motivation: ['行动意愿', '增强', '减弱'],
        boredom: ['无聊感', '增加', '减轻'],
        socialBattery: ['社交电量', '恢复', '消耗'],
    };
    const parts = Object.entries(trend.values)
        .filter(([key, value]) => words[key] && Number.isFinite(value) && Math.abs(value) >= 0.5)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 4)
        .map(([key, value]) => `${words[key][0]}${value > 0 ? words[key][1] : words[key][2]} ${Math.abs(Math.round(value * 10) / 10)}`);
    if (!parts.length) return undefined;
    return { label: window === 60 ? '近一小时' : `近 ${Math.round(window)} 分钟`, text: parts.join('，') };
}

/** 私有生活片段只接受带合法时间和非空文字的世界账摘要。 */
export function lifeMoments(status) {
    return (status?.today?.highlights ?? [])
        .filter(item => item && typeof item.text === 'string' && item.text.trim() && Number.isFinite(Date.parse(item.at)))
        .slice(0, 6)
        .map(item => ({ at: item.at, text: item.text.trim() }));
}

/** 货架 / 小梗 / 周报：[{ label, text }]；对应的功能没开（没有这一项）就不出现 */
export function extrasRows(extras) {
    const rows = [];
    if (extras?.photos) {
        const p = extras.photos;
        rows.push({ label: '照片货架', text: p.count ? `${p.count} 张（猫 ${p.cat}、天空 ${p.view}${p.work ? `、她的片子 ${p.work}` : ''}${p.food ? `、吃的 ${p.food}` : ''}）` : '空的（她自己去网上找，每 6 小时一次）' });
    }
    if (extras?.aiPhotoDrafts) {
        const p = extras.aiPhotoDrafts;
        const total = positiveInteger(p.total);
        const pending = positiveInteger(p.pending);
        const approved = positiveInteger(p.approved);
        const rejected = positiveInteger(p.rejected);
        rows.push({ label: 'AI 照片草稿', text: pending ? `${pending} 张待审核（共 ${total} 张；已通过 ${approved}、已拒绝 ${rejected}）` : `没有待审核（共 ${total} 张；已通过 ${approved}、已拒绝 ${rejected}）` });
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

/** AI 照片运行摘要：只把有限枚举和非负整数翻成中文，其他内容不展示。 */
export function aiPhotoRuntimeRows(value) {
    const feature = value?.feature === 'on' ? '已开启（仍需人工审核）'
        : value?.feature === 'off' ? '已关闭' : '状态暂不可用';
    const providerNames = { local: '本地服务', primary: '主服务', fallback: '备用服务' };
    const providers = Array.isArray(value?.providers)
        ? [...new Set(value.providers.filter(item => providerNames[item]))].map(item => providerNames[item]) : [];
    const rows = [
        { label: '功能状态', text: feature },
        { label: '生图服务', text: providers.length ? providers.join('、') : '未配置' },
    ];
    const usage = value?.usage;
    if (usage && [usage.attempts, usage.generated, usage.failed, usage.remaining].every(item => Number.isInteger(item) && item >= 0)) {
        rows.push({ label: '今日用量', text: `尝试 ${usage.attempts} 次，成功 ${usage.generated} 次，失败 ${usage.failed} 次，剩余 ${usage.remaining} 次` });
    } else {
        const degraded = ['用量统计尚未连接。', '今日用量暂时无法读取。'].includes(value?.degraded) ? value.degraded : '暂时无法读取';
        rows.push({ label: '今日用量', text: degraded });
    }
    const drafts = value?.drafts;
    if (drafts && [drafts.pending, drafts.approved, drafts.rejected].every(item => Number.isInteger(item) && item >= 0)) {
        rows.push({ label: '照片草稿', text: `待审核 ${drafts.pending} 张，已通过 ${drafts.approved} 张，已拒绝 ${drafts.rejected} 张` });
    } else {
        rows.push({ label: '照片草稿', text: '暂时无法读取' });
    }
    return rows;
}

/**
 * 状态页「她的时区」一行：实际在用的 IANA 时区、此刻的 UTC 偏移、她那边现在几点（作息、饭点、日界都按它算，
 * 浏览器所在的时区不影响这个）。没有这个字段（插件还是旧代码）返回 undefined，页面提示重启。
 */
export function timeZoneLine(zone, nowMs) {
    if (typeof zone !== 'string' || !zone) return undefined;
    const at = new Date(nowMs);
    try {
        const part = (options, type) => new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options }).formatToParts(at).find(item => item.type === type)?.value;
        const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(part({ timeZoneName: 'longOffset' }, 'timeZoneName') ?? 'GMT');
        const minutes = match?.[1] ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
        const offset = minutes ? `UTC${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}` : 'UTC±00:00';
        const time = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
        return `${zone}（${offset}），她那边现在 ${time}`;
    } catch {
        return zone;
    }
}
