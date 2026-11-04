// 状态页：插件在不在跑、NapCat / Hindsight 连没连上、名单里每人现在在等什么（ADR 0010）。不显示聊天内容。
import { computed, defineComponent, h, ref } from 'vue';
import { send, store } from '@koishijs/client';
import { c, clock, tag, tierLabel } from './common.js';
import { attentionDetail, capabilityBundles, dshStatusLine, extrasRows, featureGroups, featureLabel, featureTitle, featureTotals, filterContacts, lifeMoments, lifePulse, memoryStatusDetail, mobileCompanionStatusDetail, overviewCounts, realWorldStatus, responderStatusText } from './dashboard.js';

const PROACTIVE_MODES = { off: ['关', 'info'], dryRun: ['试运行（只写日志不发）', 'warning'], on: ['开', 'success'] };

/** 主动消息（ADR 0011）：下一次几点、什么时机；他没回时先不排；今天主动了几条。不显示内容 */
function proactiveText(p) {
    if (!p) return '—';
    const parts = [];
    if (p.paused) parts.push('已暂停');
    parts.push(p.next ? `计划 ${clock(p.next.at)} 联系` : '暂时没有计划');
    parts.push(`今天已主动联系 ${p.today} 次${p.mode === 'dryRun' ? '（试运行）' : ''}`);
    return parts.join('；');
}

function humanValuesLine(values) {
    if (!values) return [tag('自主生活未开启', 'info')];
    const positiveLevel = value => value >= 75 ? 'success' : value <= 25 ? 'danger' : 'warning';
    const loadLevel = value => value >= 75 ? 'danger' : value <= 25 ? 'success' : 'warning';
    const relationship = values.relationship;
    return [
        tag(`精力 ${values.energy}`, positiveLevel(values.energy)),
        tag(`饥饿 ${values.hunger}`, loadLevel(values.hunger)),
        tag(`压力 ${values.stress}`, loadLevel(values.stress)),
        h('span', { class: 'qqbot-muted' }, ` 心情 ${values.mood} · 健康 ${values.health} · 动机 ${values.motivation} · 孤独 ${values.loneliness}${relationship ? ` · 亲密 ${relationship.intimacy} · 信任 ${relationship.trust} · 熟悉 ${relationship.familiarity} · 依恋 ${relationship.attachment} · 摩擦 ${relationship.friction}` : ''}`),
    ];
}

/** 把底层数值、世界账和作息合成一张生活卡；完整数字仍可展开查看。 */
function lifePulsePanel(status) {
    const rows = lifePulse(status);
    if (!rows.length) return null;
    const moments = lifeMoments(status);
    return h('section', { class: 'qqbot-life-card' }, [
        h('div', { class: 'qqbot-life-head' }, [
            h('strong', null, '她此刻的生活'),
            h('span', { class: 'qqbot-muted' }, '来自作息、世界账和数值投影，不由模型临时编写'),
        ]),
        h('div', { class: 'qqbot-summary' }, rows.map(row => h('div', { class: 'qqbot-summary-row' }, [
            h('span', { class: 'qqbot-label' }, row.label),
            h('span', null, row.text),
        ]))),
        moments.length > 1 ? h('details', { class: 'qqbot-life-moments' }, [
            h('summary', null, `今天的生活片段（${moments.length}）`),
            h('div', { class: 'qqbot-life-moment-list' }, moments.map(moment => h('div', { class: 'qqbot-life-moment' }, [
                h('span', { class: 'qqbot-muted' }, clock(moment.at)),
                h('span', null, moment.text),
            ]))),
        ]) : null,
        status.humanValues ? h('details', { class: 'qqbot-life-values' }, [
            h('summary', null, '查看完整数值'),
            h('div', { class: 'qqbot-life-values-body' }, humanValuesLine(status.humanValues)),
        ]) : null,
    ]);
}

function developmentPanel(development) {
    if (!development) return null;
    const autonomy = { recover: '先恢复状态', focus: '处理最要紧的事', explore: '探索新东西', connect: '愿意靠近', maintain: '保持原节奏' };
    const relationship = { guarded: '还在熟悉', warming: '逐渐靠近', secure: '关系稳定', strained: '有些别扭', repairing: '正在和好' };
    const emotion = { bright: '心情明亮', steady: '情绪平稳', low: '情绪偏低', tense: '心里绷着', recovering: '正在缓下来' };
    const arcNames = { study: '学业', photography: '摄影', relationships: '身边的人', 'self-care': '照顾自己', creative: '创作' };
    const arcStates = { active: '最近活跃', steady: '稳定维持', stalled: '暂时搁置' };
    const momentum = { growing: '升温', holding: '持平', cooling: '降温' };
    const tasteNames = { photography: '摄影', music: '音乐', books: '阅读', games: '游戏', food: '食物', style: '穿搭审美' };
    const tasteLeanings = { like: '喜欢', dislike: '不喜欢', curious: '好奇' };
    const confidence = { emerging: '刚形成', stable: '较稳定', strong: '很稳定' };
    const draftNames = { journal: '日记', photo: '照片', voice: '语音', status: '动态' };
    const sharedNames = { anniversary: '纪念日', promise: '约定', plan: '共同计划', 'inside-joke': '只有你们懂的梗' };
    const reflectionNames = { pace: '调整节奏', retry: '失败后重试', rest: '及时休息', repair: '修复关系', 'ask-for-help': '需要时求助' };
    const shareStates = { none: '没有待分享内容', hold: '暂时按住', draft: '先整理一下', share: '可以自然分享' };
    const arcs = (development.lifeArcStates ?? []).flatMap(arc => arcNames[arc.id] && arcStates[arc.state] && momentum[arc.momentum]
        ? [`${arcNames[arc.id]}：${arcStates[arc.state]}，${momentum[arc.momentum]}`] : []);
    const tastes = (development.tasteSignals ?? []).flatMap(taste => tasteNames[taste.theme] && tasteLeanings[taste.leaning] && confidence[taste.confidence]
        ? [`${tasteNames[taste.theme]}${tasteLeanings[taste.leaning]}（${confidence[taste.confidence]}）`] : []);
    const named = (items, names) => (items ?? []).flatMap(item => names[item] ? [names[item]] : []);
    return h('section', { class: 'qqbot-life-card' }, [
        h('div', { class: 'qqbot-life-head' }, [
            h('strong', null, '她最近形成的生活脉络'),
            h('span', { class: 'qqbot-muted' }, '由生活账和对话证据重算，不是模型自报'),
        ]),
        h('div', { class: 'qqbot-summary' }, [
            h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '自主选择'), h('span', null, autonomy[development.autonomyMode] ?? '暂时无法判断')]),
            h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '关系阶段'), h('span', null, relationship[development.relationshipStage] ?? '暂时无法判断')]),
            h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '情绪延续'), h('span', null, emotion[development.emotionTone] ?? '暂时无法判断')]),
            h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '长期变化'), h('span', null, `活跃 ${development.activeLifeArcs ?? 0} 条 · 维持 ${development.steadyLifeArcs ?? 0} 条 · 搁置 ${development.stalledLifeArcs ?? 0} 条`)]),
            arcs.length ? h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '人生线'), h('span', null, arcs.join('；'))]) : null,
            h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '分享倾向'), h('span', null, shareStates[development.shareState] ?? (development.shareReady ? '可以自然分享' : '没有待分享内容'))]),
            tastes.length ? h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '她的偏好'), h('span', null, tastes.join('；'))]) : null,
            h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '共同经历'), h('span', null, named(development.sharedExperienceTypes, sharedNames).join('、') || '还没有形成稳定证据')]),
            h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '成长反思'), h('span', null, named(development.reflectionKinds, reflectionNames).join('、') || '暂时没有')]),
            h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '待审核创作'), h('span', null, named(development.creativeDraftKinds, draftNames).join('、') || '没有')]),
        ]),
    ]);
}

/** 手机伴侣能力清单：展示确认边界，避免控制台和协议各自维护一份动作说明。 */
function phoneActionsPanel(actions) {
    if (!actions?.length) return null;
    return h('details', { class: 'qqbot-features-disclosure', open: false }, [
        h('summary', { class: 'qqbot-features-summary' }, `手机伴侣能力　${actions.length} 项`),
        h('div', { class: 'qqbot-summary' }, actions.map(action => h('div', { class: 'qqbot-summary-row' }, [
            h('span', { class: 'qqbot-label' }, action.description),
                h('span', null, [
                    tag(action.requiresConfirmation ? '需确认' : '自动', action.requiresConfirmation ? 'warning' : 'success'),
                    action.reversible ? h('span', { class: 'qqbot-muted' }, ' 可撤回') : null,
                ]),
        ]))),
    ]);
}

function externalPlatformsPanel(platforms, drafts) {
    if (!platforms) return null;
    const labels = { tieba: '百度贴吧', douyin: '抖音', xiaohongshu: '小红书' };
    const modes = {
        off: ['未启用', 'info'],
        draft: ['只生成草稿', 'warning'],
        authorized: ['授权模式，等待官方适配器', 'warning'],
    };
    const draftLine = drafts ? h('div', { class: 'qqbot-summary-row' }, [
        h('span', { class: 'qqbot-label' }, '统一草稿箱'),
        h('span', null, [
            tag(`待确认 ${drafts.pending ?? 0}`, drafts.pending ? 'warning' : 'success'),
            drafts.approved ? tag(`已批准 ${drafts.approved}`, 'warning') : null,
            drafts.publishing ? tag(`发布待核对 ${drafts.publishing}`, 'danger') : null,
            h('span', { class: 'qqbot-muted' }, ` · 共 ${drafts.total ?? 0} 条${drafts.failed ? ` · 失败 ${drafts.failed}` : ''}`),
        ].filter(Boolean)),
    ]) : null;
    return h('details', { class: 'qqbot-features-disclosure', open: false }, [
        h('summary', { class: 'qqbot-features-summary' }, '外部平台接入'),
        h('div', { class: 'qqbot-summary' }, [...Object.entries(labels).map(([key, label]) => {
            const [text, type] = modes[platforms[key] ?? 'off'] ?? modes.off;
            return h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, label), tag(text, type)]);
        }), draftLine].filter(Boolean)),
    ]);
}

/** 功能开关（ADR 0120）：按模块分组，开着的亮绿色、关着的灰色；鼠标放上去看 ADR 编号。页面文件是从仓库直接读的：插件还是旧代码（没重启）时状态里没有 features */
function featurePanel(status) {
    if (!status.features) return h('p', { class: 'qqbot-muted' }, '功能开关：重启 Koishi 后显示');
    const { on, total } = featureTotals(status.features);
    return h('details', { class: 'qqbot-features-disclosure', open: false }, [
        h('summary', { class: 'qqbot-features-summary' }, `功能开关　已开启 ${on} / ${total}`),
        h('div', { class: 'qqbot-feature-groups' }, featureGroups(status.features).map(group => h('div', { class: 'qqbot-feature-group' }, [
            h('span', { class: 'qqbot-label' }, `${group.name} ${group.on}/${group.total}`),
            h('span', { class: 'qqbot-chips' }, group.items.map(item => h('span', { class: 'qqbot-chip', title: featureTitle(item) }, [tag(featureLabel(item), item.on ? 'success' : 'info')]))),
        ]))),
    ]);
}

/** 首屏只展示六个体验能力包；完整的技术开关仍在下面折叠区逐项可查。 */
function capabilityPanel(status) {
    if (!status.features) return null;
    return h('section', { class: 'qqbot-capabilities' }, [
        h('div', { class: 'qqbot-section-title' }, [
            h('strong', null, '能力概览'),
            h('span', { class: 'qqbot-muted' }, '只做归类展示，不会批量开启权限'),
        ]),
        h('div', { class: 'qqbot-capability-grid' }, capabilityBundles(status.features).map(bundle => h('div', { class: 'qqbot-capability-card' }, [
            h('div', { class: 'qqbot-capability-head' }, [
                h('strong', null, bundle.name),
                tag(bundle.active ? `${bundle.on} 项在用` : '未启用', bundle.active ? 'success' : 'info'),
            ]),
            h('div', { class: 'qqbot-muted' }, bundle.description),
            bundle.highlights.length ? h('div', { class: 'qqbot-capability-items' }, [
                bundle.highlights.join(' · '),
                bundle.more ? ` · 另有 ${bundle.more} 项` : '',
            ]) : h('div', { class: 'qqbot-capability-items qqbot-muted' }, '当前没有启用的功能'),
        ]))),
    ]);
}

/** 照片货架、AI 照片草稿、小梗、最近一份周报：对应的功能没开就没有这几行。 */
function extrasPanel(status) {
    const rows = extrasRows(status.extras);
    if (!rows.length) return null;
    return h('div', { class: 'qqbot-summary', style: 'margin-top: 16px' }, [
        ...rows.map(row => h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, row.label), h('span', null, row.text)])),
        status.extras?.report ? h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '周报'), tag('已生成', 'success')]) : null,
    ]);
}

function overviewCard(label, value, detail, type = 'info') {
    return h('div', { class: 'qqbot-kpi' }, [
        h('div', { class: 'qqbot-kpi-label' }, label),
        h('div', { class: 'qqbot-kpi-value' }, tag(value, type)),
        h('div', { class: 'qqbot-kpi-detail' }, detail),
    ]);
}

function connectionCard(label, online, detail) {
    return h('div', { class: 'qqbot-connection' }, [
        h('span', { class: ['qqbot-health-dot', online ? 'is-on' : 'is-off'] }),
        h('span', { class: 'qqbot-connection-label' }, label),
        h('span', { class: 'qqbot-muted' }, detail),
    ]);
}

export const StatusTab = defineComponent({
    setup() {
        const query = ref('');
        const activeOnly = ref(false);
        const health = ref(undefined);
        const checking = ref(false);
        async function runHealth() {
            checking.value = true;
            try { health.value = await send('qqbot/health/run'); }
            catch { health.value = { ok: false, attentionCount: 1, items: [{ label: '体检', status: 'attention', detail: '暂时无法完成，请稍后重试' }] }; }
            finally { checking.value = false; }
        }
        const filteredContacts = computed(() => {
            const status = store.qqbot?.status;
            return filterContacts(status?.contacts, query.value, activeOnly.value);
        });
        return () => {
            const data = store.qqbot;
            if (!data) return h('p', null, '正在读取……');
            const status = data.status;
            const counts = overviewCounts(status);
            const dshFeature = status?.features?.find(feature => feature.key === 'dsh');
            const dsh = dshStatusLine(status?.dsh ?? (dshFeature?.on ? { enabled: true } : undefined));
            const worldData = realWorldStatus(status);
            const rows = status ? [
                ['作息', status ? [status.schedule ? tag('按作息运行', 'success') : tag('未启用', 'warning')] : [tag('—', 'info')]],
                ['按心情回复', status ? [status.moody && status.schedule ? tag('已启用', 'success') : tag('未启用', 'info')] : [tag('—', 'info')]],
                ['说话检查', status ? [status.speechCheck === false ? tag('未启用', 'info') : tag('已启用', 'success')] : [tag('—', 'info')]],
                ['陌生好友', status ? [status.unlistedFriends ? tag('也回复', 'warning') : tag('不回复', 'info')] : [tag('—', 'info')]],
                ['主动联系', status ? [tag(...(PROACTIVE_MODES[status.proactive ?? 'off'] ?? ['未启用', 'info']))] : [tag('—', 'info')]],
            ] : [
                ['插件', data.running ? [tag('运行正常', 'success')] : [tag('未运行', 'danger')]],
                ['QQ 连接', data.napcat?.online ? [tag('已连接', 'success')] : [tag('未连接', 'danger')]],
                ...(data.error ? [['处理建议', [h('span', { class: 'qqbot-muted' }, data.error)]]] : []),
            ];
            const summary = h('div', { class: 'qqbot-summary' }, rows.map(([label, value]) => h('div', { class: 'qqbot-summary-row' }, [
                h('span', { class: 'qqbot-label' }, label), h('span', null, value),
            ])));
            if (!status) return h('div', null, [summary]);
            const kpis = h('div', { class: 'qqbot-kpis' }, [
                overviewCard('联系人', counts.contacts, `${counts.busy} 个正在处理`, counts.busy ? 'warning' : 'success'),
                overviewCard('生活能力', `${counts.capabilities.on}/${counts.capabilities.total}`, '已启用的能力包', counts.capabilities.on ? 'success' : 'info'),
                overviewCard('外部顾问', counts.dshOn ? '已开启' : '已关闭', counts.dshOn ? '可以按需咨询' : '暂未启用', counts.dshOn ? 'success' : 'info'),
                overviewCard('待处理', counts.attention.total, attentionDetail(counts.attention), counts.attention.total ? 'danger' : 'success'),
            ]);
            const connections = h('div', { class: 'qqbot-connections' }, [
                connectionCard('插件', data.running, data.running ? '正在运行' : '请查看设置和日志'),
                connectionCard('QQ 连接', data.napcat?.online === true, data.napcat?.online ? '消息通道正常' : '等待连接'),
                connectionCard('长期记忆', Boolean(status.memory?.health?.ok), memoryStatusDetail(status.memory)),
                connectionCard('现实世界数据', worldData.healthy, worldData.detail || worldData.text),
                connectionCard('外部顾问', dsh.text === '连接正常', dsh.detail || dsh.text),
                connectionCard('手机伴侣', status.mobileCompanion?.enabled === true && status.mobileCompanion.connected === true, mobileCompanionStatusDetail(status.mobileCompanion)),
            ]);
            const healthPanel = h('section', { class: 'qqbot-life-card' }, [
                h('div', { class: 'qqbot-life-head' }, [
                    h('strong', null, '系统体检'),
                    h(c('el-button'), { type: 'primary', size: 'small', loading: checking.value, onClick: runHealth }, () => checking.value ? '检查中' : '一键体检'),
                ]),
                !health.value ? h('div', { class: 'qqbot-muted' }, '只读检查连接、记忆、现实数据、照片和待处理草稿，不会发送消息或重启。')
                    : h('div', { class: 'qqbot-summary' }, [
                        h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '结论'), tag(health.value.ok ? '全部正常' : `${health.value.attentionCount} 项需处理`, health.value.ok ? 'success' : 'warning')]),
                        ...health.value.items.map(item => h('div', { class: 'qqbot-summary-row' }, [
                            h('span', { class: 'qqbot-label' }, item.label),
                            h('span', null, [tag(item.status === 'ok' ? '正常' : item.status === 'off' ? '未启用' : '需检查', item.status === 'ok' ? 'success' : item.status === 'off' ? 'info' : 'warning'), h('span', { class: 'qqbot-muted' }, ` ${item.detail}`)]),
                        ])),
                    ]),
            ]);
            const features = featurePanel(status);
            const capabilities = capabilityPanel(status);
            const extras = extrasPanel(status);
            const phoneActions = phoneActionsPanel(data.phoneActions);
            const externalPlatforms = externalPlatformsPanel(status.externalPlatforms, status.externalDrafts);
            const pulse = lifePulsePanel(status);
            const development = developmentPanel(status.development);
            const contactToolbar = h('div', { class: 'qqbot-contact-toolbar' }, [
                h('div', { class: 'qqbot-section-title' }, [h('strong', null, '联系人'), h('span', { class: 'qqbot-muted' }, `显示 ${filteredContacts.value.length}/${counts.contacts}`)]),
                h(c('el-input'), {
                    modelValue: query.value, 'onUpdate:modelValue': value => { query.value = value; },
                    clearable: true, placeholder: '搜索联系人或当前状态', class: 'qqbot-contact-search',
                }),
                h(c('el-checkbox'), { modelValue: activeOnly.value, 'onUpdate:modelValue': value => { activeOnly.value = value; } }, () => '只看忙碌'),
            ]);
            const table = h(c('el-table'), { data: filteredContacts.value, border: true, stripe: true, size: 'small', emptyText: query.value || activeOnly.value ? '没有符合条件的联系人' : '暂无联系人', style: 'width: 100%; margin-top: 10px' }, () => [
                h(c('el-table-column'), { label: '称呼', prop: 'name', width: 130 }),
                h(c('el-table-column'), { label: '关系', width: 100 }, { default: ({ row }) => tierLabel(row.tier) }),
                h(c('el-table-column'), { label: '当前状态', minWidth: 180 }, { default: ({ row }) => responderStatusText(row.responder) }),
                h(c('el-table-column'), { label: '主动联系', minWidth: 180 }, { default: ({ row }) => proactiveText(row.proactive) }),
                h(c('el-table-column'), { label: '最近联系', width: 120 }, {
                    default: ({ row }) => (row.last ? `${clock(row.last.time)} ${row.last.from === 'user' ? '对方' : '她'}` : '—'),
                }),
                h(c('el-table-column'), { label: '她现在在做什么', minWidth: 220 }, { default: ({ row }) => row.now ?? '—' }),
            ]);
            return h('div', null, [
                h('div', { class: 'qqbot-status-head' }, [
                    h('div', null, [h('h2', { class: 'qqbot-status-title' }, '她现在的状态'), h('p', { class: 'qqbot-muted' }, `每 5 秒自动更新 · ${clock(data.updatedAt)}`)]),
                    h('div', { class: 'qqbot-status-head-tags' }, [tag(status.schedule ? '按作息运行' : '作息未启用', status.schedule ? 'success' : 'warning'), tag(dshFeature?.on ? '外部顾问已启用' : '外部顾问未启用', dshFeature?.on ? 'success' : 'info')]),
                ]),
                kpis, connections, healthPanel, pulse, development, capabilities, summary, features, phoneActions, externalPlatforms, extras, contactToolbar, table,
            ]);
        };
    },
});
