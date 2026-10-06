// 编辑页的通用部分（ADR 0010）：角色资料整份读一次，各编辑页共用；每页一份草稿，「保存 / 检查 / 还原」；
// 左边选一段，右边用控制台的 k-form 编辑（Schema 在前端用 @koishijs/client 导出的 Schema 搭）。
// 保存时服务端先生成全部档位、做档位隐私检查，不过就不写，逐条返回问题（src/console.ts 的 saveCharacter）。
import { computed, defineComponent, effectScope, h, ref, watch } from 'vue';
import { message, send, store } from '@koishijs/client';
import { c, clone, firstLine, tierLabel } from './common.js';

/** 整份角色资料（服务端 readSource 的结果）；保存成功后只换掉存的那一部分，别的页没保存的草稿不受影响 */
export const character = { source: ref(null), error: ref(''), loading: false };

// 控制台断线重连时会把页面重新挂载，组件里的状态全丢，但模块不会重新加载：
// 草稿、选中的那一项放在模块里，侦听器挂在不随组件卸载的 effectScope 上，重连后接着用
const detached = effectScope(true);

async function loadCharacter() {
    if (character.loading) return;
    character.loading = true;
    try {
        const { source } = await send('qqbot/character/load');
        character.source.value = source;
        character.error.value = '';
    } catch (error) {
        character.error.value = firstLine(error);
    } finally {
        character.loading = false;
    }
}

// 登录完成、数据服务有了数据才去读（之前调会被拒，ADR 0010 试验结果第 2 条）
let watching = false;
export function ensureLoaded() {
    if (watching) return;
    watching = true;
    detached.run(() => watch(() => store.qqbot, value => { if (value && !character.source.value) void loadCharacter(); }, { immediate: true }));
}

const parts = new Map();

// 关掉或刷新浏览器页时还有没保存的修改：让浏览器先问一句
window.addEventListener('beforeunload', event => {
    if ([...parts.values()].some(state => state.dirty.value)) event.preventDefault();
});

/** 一个部分（persona / scenes / schedule / tiers）的草稿和保存；每部分只建一份，页面重新挂载时还是它 */
export function usePart(part) {
    ensureLoaded();
    if (!parts.has(part)) parts.set(part, detached.run(() => createPart(part)));
    return parts.get(part);
}

function createPart(part) {
    const draft = ref(null);
    const initial = ref(null);
    const busy = ref(false);
    const result = ref(null);
    // 页面上选中的那一项：人设、作息、档位是左边的段落 key，世界书是场景的下标
    const selected = ref(null);
    // 只在这一部分的资料换了（读到、保存后读回）时重置草稿；页面重新挂载不会
    watch(() => character.source.value?.[part], value => {
        if (!value) return;
        draft.value = clone(value);
        initial.value = clone(value);
    }, { immediate: true });
    const dirty = computed(() => draft.value !== null && JSON.stringify(draft.value) !== JSON.stringify(initial.value));

    async function run(save) {
        busy.value = true;
        result.value = null;
        try {
            const outcome = await send(save ? 'qqbot/character/save' : 'qqbot/character/check', part, draft.value);
            result.value = { ...outcome, saved: save };
            if (outcome.ok && save) {
                message.success(outcome.written.length ? `已保存，重新生成了 ${outcome.written.length} 个文件，插件会自动重新读` : '已保存（生成的卡没有变化）');
                // 服务端会规整（去掉空的说明等），读回存下来的样子
                const { source } = await send('qqbot/character/load');
                character.source.value = { ...character.source.value, [part]: source[part] };
            }
        } catch (error) {
            result.value = { ok: false, error: firstLine(error), saved: save };
        } finally {
            busy.value = false;
        }
    }

    return {
        draft, initial, busy, result, dirty, selected,
        save: () => run(true),
        check: () => run(false),
        revert: () => { draft.value = clone(initial.value); result.value = null; },
    };
}

/** 保存 / 检查 / 还原 和结果；返回两个节点而不包一层：按钮条要固定在顶上（sticky），只能在整页内容里固定 */
export function toolbar(state) {
    const buttons = h('div', { class: 'qqbot-toolbar' }, [
        h(c('el-button'), { type: 'primary', disabled: !state.dirty.value || state.busy.value, onClick: state.save }, () => '保存'),
        h(c('el-button'), { disabled: state.busy.value, onClick: state.check }, () => '检查'),
        h(c('el-button'), { disabled: !state.dirty.value || state.busy.value, onClick: state.revert }, () => '还原'),
        h('span', { class: 'qqbot-muted' }, state.dirty.value ? '有没保存的修改' : '和存下的一样'),
    ]);
    return [buttons, resultView(state.result.value)];
}

function resultView(result) {
    if (!result) return null;
    if (result.ok) {
        const text = result.saved ? '已保存。' : '检查通过：结构、引用和档位隐私都没问题。';
        return h(c('el-alert'), { type: 'success', title: text, showIcon: true, closable: false, class: 'qqbot-result' });
    }
    if (result.error) return h(c('el-alert'), { type: 'error', title: `${result.saved ? '没有保存' : '检查没过'}：${result.error}`, showIcon: true, closable: false, class: 'qqbot-result' });
    const problems = result.problems ?? [];
    return h('div', { class: 'qqbot-result' }, [
        h(c('el-alert'), {
            type: 'error', showIcon: true, closable: false,
            title: `${result.saved ? '没有保存' : '检查没过'}：有 ${problems.length} 处这一档不该出现的词（禁用词或脱敏占位符）`,
        }),
        h(c('el-table'), { data: problems, border: true, size: 'small', style: 'width: 100%; margin-top: 8px' }, () => [
            h(c('el-table-column'), { label: '档位', width: 110 }, { default: ({ row }) => tierLabel(row.tier) }),
            h(c('el-table-column'), { label: '在哪', prop: 'where', width: 240 }),
            h(c('el-table-column'), { label: '词', prop: 'word', width: 110 }),
            h(c('el-table-column'), { label: '前后文', prop: 'excerpt' }),
        ]),
    ]);
}

/** 读的时候、出错的时候显示一句话；读好了返回 null */
export function loadingView() {
    if (character.error.value) return h(c('el-alert'), { type: 'error', title: `读不到角色资料：${character.error.value}`, showIcon: true, closable: false });
    if (!character.source.value) return h('p', { class: 'qqbot-muted' }, '正在读角色资料……');
    return null;
}

/**
 * 左边一列分段、右边 k-form 的编辑页。
 * sections(source)：[{ key, label, schema, get(draft), set(draft, value) }]，只在资料读好（或保存后）时重算，
 * 所以 Schema 不会每次渲染都换新的（k-form 的折叠状态不丢）。
 */
export const PartEditor = defineComponent({
    props: { part: { type: String, required: true }, sections: { type: Function, required: true }, intro: String },
    setup(props) {
        const state = usePart(props.part);
        const selected = state.selected;
        const sections = computed(() => (character.source.value ? props.sections(character.source.value) : []));
        watch(sections, list => { if (!list.some(s => s.key === selected.value)) selected.value = list[0]?.key ?? ''; }, { immediate: true });
        return () => {
            const waiting = loadingView();
            if (waiting) return waiting;
            if (!state.draft.value) return null;
            const section = sections.value.find(s => s.key === selected.value);
            const nav = h(c('el-menu'), {
                class: 'qqbot-nav', defaultActive: selected.value,
                onSelect: key => { selected.value = key; },
            }, () => sections.value.map(s => h(c('el-menu-item'), { index: s.key }, () => s.label)));
            const form = section
                ? h(c('k-form'), {
                    key: section.key,
                    schema: section.schema,
                    initial: section.get(state.initial.value),
                    modelValue: section.get(state.draft.value),
                    'onUpdate:modelValue': value => section.set(state.draft.value, value),
                })
                : null;
            return h('div', null, [
                props.intro ? h('p', { class: 'qqbot-muted' }, props.intro) : null,
                ...toolbar(state),
                h('div', { class: 'qqbot-editor' }, [nav, h('div', { class: 'qqbot-form' }, [form])]),
            ]);
        };
    },
});
