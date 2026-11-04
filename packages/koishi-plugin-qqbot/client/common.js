// 「林梦瑶」页面共用的小工具（ADR 0010）。手写的 ES 模块，不构建：
// 裸导入必须写成行首的 `import … from '…';`（控制台只改写这种写法，换成它自带的 vue.js / client.js）；
// Vue 是只有运行时的那份，组件用 h() 写，不能写模板字符串。
import { h, resolveComponent } from 'vue';
export { TIER_LABELS, clock, tierLabel } from './format.js';

/** resolveComponent 的简写：c('el-button') */
export const c = name => resolveComponent(name);

/** 一个标签 */
export function tag(text, type = 'info') {
    return h(c('el-tag'), { type, size: 'small', disableTransitions: true }, () => text);
}

/** 深拷贝（编辑草稿用） */
export const clone = value => JSON.parse(JSON.stringify(value));
