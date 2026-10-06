// 「林梦瑶」页面共用的小工具（ADR 0010）。手写的 ES 模块，不构建：
// 裸导入必须写成行首的 `import … from '…';`（控制台只改写这种写法，换成它自带的 vue.js / client.js）；
// Vue 是只有运行时的那份，组件用 h() 写，不能写模板字符串。
import { h, resolveComponent } from 'vue';

export const TIER_LABELS = {
    boyfriend: '男朋友',
    bestie: '闺蜜',
    girl_friend: '女生熟人',
    known: '熟人',
    classmate: '同学',
    stranger: '陌生人',
    unlisted: '名单外好友',
    // 场景档里还有群聊（群聊还没做，ADR 0003）
    group: '群聊',
};

export const tierLabel = tier => TIER_LABELS[tier] ?? tier;

/** 今天的只写时分，别的日子加上月日 */
export function clock(value) {
    if (value === undefined || value === null) return '';
    const date = new Date(value);
    const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return hm;
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

/** resolveComponent 的简写：c('el-button') */
export const c = name => resolveComponent(name);

/** 一个标签 */
export function tag(text, type = 'info') {
    return h(c('el-tag'), { type, size: 'small', disableTransitions: true }, () => text);
}

/** 深拷贝（编辑草稿用） */
export const clone = value => JSON.parse(JSON.stringify(value));

/** 监听器返回的错误是字符串（含调用栈），只留第一行 */
export const firstLine = error => String(error).split('\n')[0];
