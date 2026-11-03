// 控制台的「林梦瑶」页面（ADR 0010）：状态、人设、世界书、作息、档位，心情、在读的书（ADR 0015）。后端在 src/console.ts。
// 手写的 ES 模块，不构建，规矩见 common.js 开头。
import { defineComponent, h, ref } from 'vue';
import { c } from './common.js';
import { character, ensureLoaded, PartEditor } from './editor.js';
import { ScenesTab } from './scenes.js';
import { booksSections, moodsSections, personaSections, scheduleSections, tierSections } from './schemas.js';
import { StatusTab } from './status.js';

const SAVE_NOTE = '保存时先生成全部档位的卡和世界书、做档位隐私检查，不过就不写；过了写进 characters/<角色>/source/，重新生成 st/，插件自动重新读。';

// 当前标签放在模块里：控制台重连时页面会重新挂载，回来还停在原来那一页（草稿见 editor.js）
const tab = ref('status');

const Page = defineComponent({
    setup() {
        const pane = (label, name, render) => h(c('el-tab-pane'), { label, name, lazy: true }, render);
        // 心情、在读的书两页要看资料里有没有，所以一打开就读资料（别的编辑页也是读这一份）
        ensureLoaded();
        return () => {
            // 资料里有 moods.yml、books.yml 才有这两页（插件还是旧代码时读到的资料里没有，见 ADR 0015「后果」）
            const source = character.source.value;
            return h(c('k-layout'), null, {
                default: () => h('div', { class: 'qqbot-page' }, [
                    h(c('el-tabs'), { modelValue: tab.value, 'onUpdate:modelValue': v => { tab.value = v; } }, () => [
                        pane('状态', 'status', () => h(StatusTab)),
                        pane('她是谁', 'persona', () => h(PartEditor, { part: 'persona', sections: personaSections, intro: `人设各段：每个字段给哪些档位、某几档用的改写版本。${SAVE_NOTE}` })),
                        pane('她的世界', 'scenes', () => h(ScenesTab)),
                        pane('日程', 'schedule', () => h(PartEditor, { part: 'schedule', sections: scheduleSections, intro: `作息、课表、假期、空闲活动，以及它们给哪些档位。${SAVE_NOTE}` })),
                        pane('相处方式', 'tiers', () => h(PartEditor, { part: 'tiers', sections: tierSections, intro: `每个档位：对方是谁、说话方式、示例对话、禁用词。${SAVE_NOTE}` })),
                        source?.moods ? pane('心情', 'moods', () => h(PartEditor, {
                            part: 'moods', sections: moodsSections,
                            intro: `每天一个心情：按日期和当天的课表抽，同一天对谁都一样；陌生人、名单外没有。插件配置「她自己的日子」打开才用。${SAVE_NOTE}`,
                        })) : null,
                        source?.books ? pane('正在看的书', 'books', () => h(PartEditor, {
                            part: 'books', sections: booksSections,
                            intro: `她在看的书：进度按天往前走，只知道看到的地方；聊到书或她正在看书时才放进提示词。${SAVE_NOTE}`,
                        })) : null,
                    ]),
                ]),
            });
        };
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
