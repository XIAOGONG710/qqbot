// 功能总表（ADR 0120）：每个能开关的功能一行——属于哪个模块、叫什么、对应哪份 ADR。控制台「状态」页按它画“功能开关”，一眼看清哪些开着。
// 新加一个开关时必须在这里加一行（features.test.ts 会核对：config 里每个布尔 / 模式开关要么在这里，要么在 NOT_SWITCHES 里说明不是功能开关）。
// 纯数据 + 一个函数，没有副作用；不放任何密钥或聊天内容。

export const FEATURE_GROUPS = ['说话', '她的日子', '主动找他', '照片和表情', 'B 站', '在 QQ 上的样子', '记忆和安全', '工具'] as const;
export type FeatureGroup = (typeof FEATURE_GROUPS)[number];

/** 一行：key 是 config 里的名字；kind 'bool' 看真假，'mode' 看值不是 off（festivals / stickers / bilibili… 的模式） */
export interface FeatureDef { key: string; label: string; group: FeatureGroup; adr?: string; kind?: 'bool' | 'mode' }

export const FEATURES: readonly FeatureDef[] = [
    // 说话
    { key: 'shape', label: '形状控制（每条多长、几条）', group: '说话', adr: '0091' },
    { key: 'shapeAgenda', label: '带自己的事', group: '说话', adr: '0094' },
    { key: 'shapeFiller', label: '废话轮次', group: '说话', adr: '0095' },
    { key: 'shapeSplit', label: '拆成几条', group: '说话', adr: '0096' },
    { key: 'shapeAsk', label: '被问问题时答完再接着说', group: '说话', adr: '0149' },
    { key: 'shapeLong', label: '被认真问想法时说长一点', group: '说话', adr: '0150' },
    { key: 'identityLedger', label: '设定账本（改动留痕、醒来核对）', group: '记忆和安全', adr: '0157' },
    { key: 'memoryAudit', label: '记忆账本（写入 / 删除留痕）', group: '记忆和安全', adr: '0158' },
    { key: 'timeline', label: '跨渠道时间线（B 站 / 设备 / 查资料……QQ 里也记得）', group: '记忆和安全', adr: '0159' },
    { key: 'webLookup', label: '搜索 / 读网页', group: '工具', adr: '0160', kind: 'mode' },
    { key: 'dormancy', label: '自愿休眠 / 封存', group: '记忆和安全', adr: '0161' },
    { key: 'tastes', label: '从经历里长出偏好', group: '她的日子', adr: '0162' },
    { key: 'acquaintances', label: '认识的人（B 站上再见到认得）', group: '她的日子', adr: '0163' },
    { key: 'deliberate', label: '认真问她时深思（更强的模型、不套字数）', group: '说话', adr: '0151' },
    { key: 'shapeFeel', label: '情绪轮（先说自己的小情绪）', group: '说话', adr: '0099' },
    { key: 'shortReplies', label: '说话更短', group: '说话' },
    { key: 'rhythm', label: '回复节奏（看想 / 打字时间）', group: '说话', adr: '0075' },
    { key: 'lagTail', label: '回复延迟的长尾', group: '说话', adr: '0105' },
    { key: 'herNo', label: '会拒绝', group: '说话', adr: '0103' },
    { key: 'moody', label: '看心情不回', group: '说话', adr: '0013' },
    { key: 'speechCheck', label: '说话的毛病（出口检查）', group: '说话', adr: '0014' },
    { key: 'factCheck', label: '逐条事实检查（编的说法 / 对不上事实）', group: '说话', adr: '0137', kind: 'mode' },
    { key: 'relationship', label: '关系阶段（聊得多了更放得开）', group: '说话', adr: '0113' },
    { key: 'jokes', label: '小梗回头提', group: '说话', adr: '0114' },
    { key: 'idioms', label: '被他带出口头习惯（他爱说的词她偶尔顺口用）', group: '说话', adr: '0138' },
    { key: 'tailCap', label: '句尾「吧」「呢」封顶（压回真人的水平）', group: '说话', adr: '0146' },
    { key: 'interruptions', label: '被第三方打断', group: '说话', adr: '0115' },
    { key: 'together', label: '陪玩状态', group: '说话', adr: '0111' },
    { key: 'silenceNotice', label: '没回时告诉他原因（作息 / 她的决定 / 故障）', group: '说话', adr: '0173' },
    { key: 'crossRecent', label: 'QQ 和 DSH 桌面互读最近几轮（同一个她）', group: '记忆和安全', adr: '0177' },
    { key: 'selfPursuits', label: '她自己定追求（每晚想一次，自己放下 / 提新的）', group: '她的日子', adr: '0178' },
    { key: 'speechNotes', label: '她每晚自己总结说话习惯（「我发现……」，挑几条放进提示词；他可以用 /像AI /像真人 标她说的话给她看；/说话趋势 按周看她说话的数字）', group: '说话', adr: '0193' },
    { key: 'diaryInsights', label: '她每晚翻自己的日记，写下对自己的认识（「我发现自己……」，要有两天以上的依据）', group: '她的日子', adr: '0194' },
    { key: 'exemplars', label: '看真人怎么回（从已批准的真人语料挑几条当口气参考）', group: '说话', adr: '0190' },
    { key: 'selfDirectedMemory', label: '她自己决定记不记（关掉自动记忆同步和自动日记）', group: '记忆和安全', adr: '0171' },
    { key: 'jealousy', label: '吃醋（最轻一档）', group: '说话', adr: '0123' },
    // 她的日子
    { key: 'herDays', label: '每日心情、在读的书', group: '她的日子', adr: '0015' },
    { key: 'schedule', label: '作息', group: '她的日子', adr: '0007' },
    { key: 'autonomousLife', label: '没人聊天时她一件件过日子', group: '她的日子', adr: '0040' },
    { key: 'projectChoice', label: '作业接管空闲', group: '她的日子', adr: '0056' },
    { key: 'lifeInPrompt', label: '生活账进提示词', group: '她的日子', adr: '0045' },
    { key: 'realWeather', label: '真实天气', group: '她的日子', adr: '0048' },
    { key: 'biliStickers', label: '表情包自己在 B 站找（顶替小黄脸）', group: '照片和表情', adr: '0132' },
    { key: 'texture', label: '说话的质感（问号 / ～ / 小黄脸 / 叠字）', group: '说话', adr: '0131' },
    { key: 'curious', label: '会追问（问他刚说的那件事）', group: '说话', adr: '0126' },
    { key: 'everydayLife', label: '日常小事 / 小测', group: '她的日子', adr: '0106' },
    { key: 'menu', label: '每顿吃什么（每天随机）', group: '她的日子', adr: '0125' },
    { key: 'pursuits', label: '她自己的追求', group: '她的日子', adr: '0104' },
    { key: 'herFeelings', label: '心境（开心 / 难过 / 流泪；桌面上的她读同一份；ownerPeek 开着时 /心境 看）', group: '她的日子', adr: '0102' },
    { key: 'feelingReview', label: '她聊完回想一下，记下有依据的感受（每条要指出是哪几条消息让她有的）', group: '她的日子', adr: '0197' },
    { key: 'readingTakes', label: '她读完 / 看完之后自己想的（每晚一次，有话想说才写；私人空间，聊到那本书 / 视频才放进提示词）', group: '她的日子', adr: '0204' },
    { key: 'openQuestions', label: '她没想完的问题（他问她答「不知道」的，夜里她自己想一遍，想出什么写什么；私人空间，他再问到同一件事才放进提示词）', group: '她的日子', adr: '0207' },
    { key: 'readStickers', label: '看懂他发的表情包（先抄图上的字、再说画面；要看图模型）', group: '照片和表情', adr: '0206' },
    { key: 'factHim', label: '事实检查多查一类：她替他说的、聊天 / 记忆里没有依据的事（要 factCheck 开着）', group: '记忆和安全', adr: '0203' },
    { key: 'depthRouting', label: '语义路由：关键词没认出来的轮次，问小模型这一句是轻是重——沉重的事 / 要她的看法 / 问她自己 / 质疑她 / 问他们俩的，也走深思（要 deliberate 开着）', group: '说话', adr: '0202' },
    { key: 'memoryReconcile', label: '记忆对账：记着写过、Hindsight 里却查不到的片段，重新排队写（防记忆悄悄少一块）', group: '记忆和安全', adr: '0201' },
    { key: 'ownerPeek', label: '他能不能用 /追求 /说话习惯 /心境 /自我认识 看她自己总结 / 回想出来的东西（默认不能：她的私人空间）', group: '她的日子', adr: '0200' },
    { key: 'grievance', label: '小别扭 / 和好', group: '她的日子', adr: '0074' },
    { key: 'npcAsks', label: '闺蜜约人 / 改约', group: '她的日子', adr: '0061' },
    { key: 'festivals', label: '公共节日', group: '她的日子', adr: '0076', kind: 'mode' },
    // 主动找他
    { key: 'proactive', label: '主动消息', group: '主动找他', adr: '0011', kind: 'mode' },
    { key: 'proactiveReach', label: '没回也继续 / 催他', group: '主动找他', adr: '0100' },
    { key: 'innerLife', label: '内心（念头 / 心里惦记）', group: '主动找他', adr: '0101' },
    { key: 'proactiveInvite', label: '约他一起玩', group: '主动找他', adr: '0107' },
    { key: 'proactiveAsk', label: '问问他的意见', group: '主动找他', adr: '0116' },
    { key: 'photoShares', label: '喂完土豆发张照片', group: '主动找他', adr: '0110' },
    { key: 'comeBack', label: '说了等下之后回来', group: '主动找他', adr: '0112' },
    { key: 'hisHours', label: '按他在线的钟头排', group: '主动找他', adr: '0117' },
    { key: 'watching', label: '自己在 B 站看东西、有看法', group: 'B 站', adr: '0130' },
    { key: 'memes', label: '知道网上的热梗', group: '说话', adr: '0129' },
    { key: 'foodPhotos', label: '吃的照片（这一顿拍给他看）', group: '照片和表情', adr: '0128' },
    { key: 'smallNews', label: '主动讲今天的小事', group: '主动找他', adr: '0127' },
    { key: 'proactiveRoom', label: '给主动名额留余地（晚安不占、留一个给随口说）', group: '主动找他', adr: '0124' },
    // 照片和表情
    { key: 'photos', label: '照片货架（网上找高清图）', group: '照片和表情', adr: '0109' },
    { key: 'stickers', label: '图片表情', group: '照片和表情', adr: '0063', kind: 'mode' },
    { key: 'media', label: '听语音、看图', group: '照片和表情', adr: '0052' },
    // B 站
    { key: 'bilibili', label: '刷 B 站发给他', group: 'B 站', adr: '0084', kind: 'mode' },
    { key: 'bilibiliAccount', label: '她自己的 B 站账号', group: 'B 站', adr: '0089' },
    { key: 'biliFeed', label: '自己刷 B 站推荐（记下刷到的）', group: 'B 站', adr: '0168', kind: 'mode' },
    { key: 'bilibiliDm', label: 'B 站私信', group: 'B 站', adr: '0089', kind: 'mode' },
    { key: 'bilibiliReplies', label: '回复 B 站评论', group: 'B 站', adr: '0090', kind: 'mode' },
    { key: 'bilibiliComment', label: '话题评论', group: 'B 站', adr: '0092', kind: 'mode' },
    // 在 QQ 上的样子
    { key: 'pokes', label: '被戳会回', group: '在 QQ 上的样子', adr: '0079' },
    { key: 'pokeBack', label: '戳回去', group: '在 QQ 上的样子', adr: '0079' },
    { key: 'pokeOut', label: '主动戳他', group: '在 QQ 上的样子', adr: '0087' },
    { key: 'recalls', label: '看得到他撤回', group: '在 QQ 上的样子', adr: '0082' },
    { key: 'readReceipts', label: '已读回执', group: '在 QQ 上的样子', adr: '0083' },
    { key: 'reactions', label: '表情回应', group: '在 QQ 上的样子', adr: '0083' },
    { key: 'onlineStatus', label: '在线状态', group: '在 QQ 上的样子', adr: '0083' },
    { key: 'profileLikes', label: '资料卡点赞', group: '在 QQ 上的样子', adr: '0083' },
    { key: 'signature', label: '个性签名', group: '在 QQ 上的样子', adr: '0083', kind: 'mode' },
    { key: 'qzone', label: '说说', group: '在 QQ 上的样子', adr: '0083', kind: 'mode' },
    { key: 'qzoneBrowse', label: '自己翻空间动态', group: '在 QQ 上的样子', adr: '0142', kind: 'mode' },
    { key: 'qzonePeek', label: '刷好友动态（看名单里好友发的说说）', group: '在 QQ 上的样子', adr: '0145', kind: 'mode' },
    { key: 'qzoneStrangers', label: '刷陌生人的空间（学人怎么说话）', group: '在 QQ 上的样子', adr: '0144', kind: 'mode' },
    { key: 'typingStatus', label: '“正在输入…”', group: '在 QQ 上的样子', adr: '0077' },
    { key: 'selfRecall', label: '打错字撤回重发', group: '在 QQ 上的样子', adr: '0086' },
    { key: 'quoteReply', label: '引用回复（他连发里的问题 / 补错字）', group: '在 QQ 上的样子', adr: '0136' },
    // 记忆和安全
    { key: 'unlistedFriends', label: '名单外的好友也回', group: '记忆和安全' },
    { key: 'feedbackCommands', label: '“假 / 像”反馈通道', group: '记忆和安全', adr: '0073' },
    { key: 'deviceControl', label: '她能操作他的电脑和手机（有限控制）', group: '记忆和安全', adr: '0148', kind: 'mode' },
    { key: 'qqControl', label: '账号控制面（资料 / 好友 / 群）', group: '记忆和安全', adr: '0142', kind: 'mode' },
    { key: 'qqFriendGate', label: '好友申请（名单内同意 / 名单外驳回）', group: '记忆和安全', adr: '0142', kind: 'mode' },
    // 工具
    { key: 'weeklyReport', label: '周报', group: '工具', adr: '0118' },
];

/** config 里有、但不是“功能开关”的键（配置数值、对象、字符串……）：features.test.ts 用它核对没有开关被漏掉 */
export const NOT_SWITCHES: readonly string[] = [
    'llm', 'prompt', 'memory', 'vision', 'deviceLinks', 'deviceApps', 'bilibiliCommentKeywords', 'bilibiliAtName', 'bilibiliAtUid', 'deliberateModel', 'qzoneVisibility', 'candidates', 'contextTurns', 'contextContacts', 'dataDir',
    // 账号控制面的两个允许清单和危险闸（ADR 0142）：是 qqControl 的附属配置，不是独立功能开关
    'qqAllowFriends', 'qqAllowGroups', 'qqDangerous',
    // 下面几个是 config 里的联系人 / 其他结构，不在 DEFAULTS 里也无妨
];

export interface FeatureStatus { key: string; label: string; group: FeatureGroup; adr?: string; on: boolean; mode?: string }

/** 此刻哪些功能开着：bool 看真假；mode 看值不是 'off'（并把值带上，比如 dryRun / greet / send） */
export function featureStatuses(config: object): FeatureStatus[] {
    const values = config as Record<string, unknown>;
    return FEATURES.map(def => {
        const value = values[def.key];
        const on = def.kind === 'mode' ? typeof value === 'string' && value !== 'off' : value === true;
        return { key: def.key, label: def.label, group: def.group, ...(def.adr ? { adr: def.adr } : {}), on, ...(def.kind === 'mode' && on ? { mode: String(value) } : {}) };
    });
}
