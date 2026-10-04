// 控制台的「林梦瑶」页面（ADR 0010）：状态、人设、世界书、作息、档位。后端在 src/console.ts。
// 手写的 ES 模块，不构建，规矩见 common.js 开头。
import { defineComponent, h, ref } from 'vue';
import { c } from './common.js';
import { PartEditor } from './editor.js';
import { ScenesTab } from './scenes.js';
import { personaSections, scheduleSections, tierSections } from './schemas.js';
import { StatusTab } from './status.js';

const SAVE_NOTE = '保存时先生成全部档位的卡和世界书、做档位隐私检查，不过就不写；过了写进 characters/<角色>/source/，重新生成 st/，插件自动重新读。';

const Page = defineComponent({
    setup() {
        const tab = ref('status');
        const pane = (label, name, render) => h(c('el-tab-pane'), { label, name, lazy: true }, render);
        return () => h(c('k-layout'), null, {
            default: () => h('div', { class: 'qqbot-page' }, [
                h(c('el-tabs'), { modelValue: tab.value, 'onUpdate:modelValue': v => { tab.value = v; } }, () => [
                    pane('状态', 'status', () => h(StatusTab)),
                    pane('人设', 'persona', () => h(PartEditor, { part: 'persona', sections: personaSections, intro: `人设各段：每个字段给哪些档位、某几档用的改写版本。${SAVE_NOTE}` })),
                    pane('世界书', 'scenes', () => h(ScenesTab)),
                    pane('作息', 'schedule', () => h(PartEditor, { part: 'schedule', sections: scheduleSections, intro: `作息、课表、假期、空闲活动，以及它们给哪些档位。${SAVE_NOTE}` })),
                    pane('档位', 'tiers', () => h(PartEditor, { part: 'tiers', sections: tierSections, intro: `每个档位：对方是谁、说话方式、示例对话、禁用词。${SAVE_NOTE}` })),
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
