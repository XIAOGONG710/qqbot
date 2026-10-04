// 控制台的「林梦瑶」页面（ADR 0010）：状态、人设、世界书、作息、档位。后端在 src/console.ts。
// 手写的 ES 模块，不构建，规矩见 common.js 开头。
import { defineComponent, h, ref } from 'vue';
import { c } from './common.js';
import { StatusTab } from './status.js';

const Page = defineComponent({
    setup() {
        const tab = ref('status');
        const pending = name => h('p', { class: 'qqbot-muted' }, `${name}的编辑还在做（ADR 0010 第 2 步）。现在请直接改 characters/linmengyao/source/ 下的 YAML，再跑 node packages/character-tools/src/cli.ts。`);
        return () => h(c('k-layout'), null, {
            default: () => h('div', { class: 'qqbot-page' }, [
                h(c('el-tabs'), { modelValue: tab.value, 'onUpdate:modelValue': v => { tab.value = v; } }, () => [
                    h(c('el-tab-pane'), { label: '状态', name: 'status' }, () => h(StatusTab)),
                    h(c('el-tab-pane'), { label: '人设', name: 'persona' }, () => pending('人设')),
                    h(c('el-tab-pane'), { label: '世界书', name: 'scenes' }, () => pending('世界书')),
                    h(c('el-tab-pane'), { label: '作息', name: 'schedule' }, () => pending('作息')),
                    h(c('el-tab-pane'), { label: '档位', name: 'tiers' }, () => pending('档位')),
                ]),
            ]),
        });
    },
});

export default (ctx) => {
    ctx.page({
        name: '林梦瑶',
        path: '/qqbot',
        icon: 'activity:default',
        order: 450,
        authority: 4,
        // 数据服务有了数据（登录完成）才可用：自动登录完成之前调监听器会被拒（ADR 0010 试验结果第 2 条）
        fields: ['qqbot'],
        component: Page,
    });
};
