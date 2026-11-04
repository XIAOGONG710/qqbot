export const TIER_LABELS = {
    boyfriend: '男朋友',
    bestie: '闺蜜',
    girl_friend: '女生熟人',
    known: '熟人',
    classmate: '同学',
    stranger: '陌生人',
    unlisted: '名单外好友',
    group: '群聊',
};

export const tierLabel = tier => TIER_LABELS[tier] ?? '未知关系';

/** 今天的只写时分，别的日子加上月日。 */
export function clock(value) {
    if (value === undefined || value === null) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '时间未知';
    const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return hm;
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}
