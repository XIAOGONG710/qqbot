// 世界书页（ADR 0010）：左边场景列表（按场景档、关键字筛选），右边编辑选中的那个；能新建、删掉。
// 一个档位的世界书收哪个场景档的场景，在档位页的「世界书用哪个场景档」里设。
import { computed, defineComponent, h, ref } from 'vue';
import { Schema } from '@koishijs/client';
import { c, tierLabel } from './common.js';
import { character, loadingView, toolbar, usePart } from './editor.js';

function sceneSchema(labels) {
    const textarea = () => Schema.string().role('textarea', { rows: [1, 6] });
    return Schema.object({
        id: Schema.string().description('**id**：档位页「去掉的场景」用它'),
        kind: Schema.string().description('**标签**：会进提示词（「[场景参考·标签]」），低档位别写这一档不该知道的事'),
        tiers: Schema.array(Schema.union(labels.map(label => Schema.const(label).description(tierLabel(label))))).role('checkbox').description('**场景档**'),
        trigger: Schema.array(Schema.string()).description('**触发词**：聊天里出现才注入；不进提示词'),
        examples: Schema.array(textarea()).description('**她可能这样回**'),
        avoid: Schema.array(textarea()).description('**不要这样回**：也会进提示词'),
        source: Schema.string().description('**出处**：不进卡'),
    });
}

// 筛选条件和没建完的 id 放在模块里，控制台重连、页面重新挂载后还在（同 editor.js 的草稿）
const filter = ref('');
const label = ref('');
const newId = ref('');

export const ScenesTab = defineComponent({
    setup() {
        const state = usePart('scenes');
        const selected = state.selected;
        if (selected.value === null) selected.value = -1;
        const labels = computed(() => [...new Set((character.source.value?.scenes ?? []).flatMap(s => s.tiers))]);
        const schema = computed(() => sceneSchema(labels.value));
        const rows = computed(() => (state.draft.value ?? [])
            .map((scene, index) => ({ ...scene, index }))
            .filter(scene => !label.value || scene.tiers.includes(label.value))
            .filter(scene => {
                const q = filter.value.trim();
                if (!q) return true;
                return [scene.id, scene.kind, ...scene.trigger, ...scene.examples, ...scene.avoid].some(text => text.includes(q));
            }));

        function add() {
            const id = newId.value.trim();
            if (!id || state.draft.value.some(s => s.id === id)) return;
            state.draft.value.push({ id, kind: '新场景', tiers: [label.value || labels.value[0]], trigger: [], examples: [], avoid: [] });
            selected.value = state.draft.value.length - 1;
            newId.value = '';
        }

        function remove() {
            if (selected.value < 0) return;
            state.draft.value.splice(selected.value, 1);
            selected.value = -1;
        }

        return () => {
            const waiting = loadingView();
            if (waiting) return waiting;
            if (!state.draft.value) return null;
            const scene = state.draft.value[selected.value];
            const initial = scene && character.source.value.scenes.find(s => s.id === scene.id);
            const left = h('div', { class: 'qqbot-list' }, [
                h('div', { class: 'qqbot-list-filters' }, [
                    h(c('el-select'), {
                        modelValue: label.value, 'onUpdate:modelValue': v => { label.value = v; },
                        placeholder: '所有场景档', clearable: true, style: 'width: 150px; flex: none',
                    }, () => labels.value.map(l => h(c('el-option'), { value: l, label: tierLabel(l) }))),
                    h(c('el-input'), {
                        modelValue: filter.value, 'onUpdate:modelValue': v => { filter.value = v; },
                        placeholder: '按 id、标签、触发词、例句筛选', clearable: true,
                    }),
                ]),
                h(c('el-table'), {
                    data: rows.value, height: 520, highlightCurrentRow: true, size: 'small',
                    onRowClick: row => { selected.value = row.index; },
                    rowClassName: ({ row }) => (row.index === selected.value ? 'qqbot-row-selected' : ''),
                }, () => [
                    h(c('el-table-column'), { prop: 'id', label: 'id', width: 170 }),
                    h(c('el-table-column'), { prop: 'kind', label: '标签' }),
                    h(c('el-table-column'), { label: '场景档', width: 150 }, { default: ({ row }) => row.tiers.map(tierLabel).join('、') }),
                ]),
                h('div', { class: 'qqbot-list-filters' }, [
                    h(c('el-input'), { modelValue: newId.value, 'onUpdate:modelValue': v => { newId.value = v; }, placeholder: '新场景的 id（英文、数字、连字符）' }),
                    h(c('el-button'), { disabled: !newId.value.trim(), onClick: add }, () => '新建'),
                ]),
                h('p', { class: 'qqbot-muted' }, `共 ${state.draft.value.length} 个场景，筛出 ${rows.value.length} 个`),
            ]);
            const right = scene
                ? h('div', { class: 'qqbot-form' }, [
                    h(c('k-form'), {
                        key: `${selected.value}`,
                        schema: schema.value,
                        initial,
                        modelValue: scene,
                        'onUpdate:modelValue': value => { state.draft.value[selected.value] = value; },
                    }),
                    h(c('el-button'), { type: 'danger', plain: true, onClick: remove }, () => '删掉这个场景'),
                ])
                : h('div', { class: 'qqbot-form' }, [h('p', { class: 'qqbot-muted' }, '左边选一个场景')]);
            return h('div', null, [...toolbar(state), h('div', { class: 'qqbot-editor' }, [left, right])]);
        };
    },
});
