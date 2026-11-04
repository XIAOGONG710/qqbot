// AI 照片的非人物视觉参考页（ADR 0242）：只管理设定，不生成、审核或发送照片。
import { defineComponent, h, onMounted, ref } from 'vue';
import { message, send } from '@koishijs/client';
import { c, tag } from './common.js';
import { dashboardTime } from './dashboard.js';

const KINDS = [
    { value: 'cat', label: '土豆的外观' },
    { value: 'desk', label: '书桌与房间' },
    { value: 'tableware', label: '餐具与饭桌' },
    { value: 'view', label: '窗外与常见场景' },
];
const KIND_NAMES = Object.fromEntries(KINDS.map(item => [item.value, item.label]));
const MAX_BYTES = 5 * 1024 * 1024;

function readImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(new Error('read failed'));
        reader.readAsDataURL(file);
    });
}

export const PhotoReferencesTab = defineComponent({
    setup() {
        const entries = ref([]);
        const loading = ref(false);
        const saving = ref(false);
        const error = ref('');
        const kind = ref('cat');
        const referenceName = ref('');
        const image = ref('');
        const fileName = ref('');
        const nonHuman = ref(false);

        async function refresh() {
            loading.value = true;
            error.value = '';
            try {
                const result = await send('qqbot/ai-photo-references/list');
                if (!result?.ok) {
                    error.value = result?.error || '暂时无法读取视觉参考。';
                    return;
                }
                entries.value = result.entries;
            } catch {
                error.value = '暂时无法读取视觉参考，请稍后重试。';
            } finally {
                loading.value = false;
            }
        }

        async function chooseFile(event) {
            const file = event.target?.files?.[0];
            image.value = '';
            fileName.value = '';
            if (!file) return;
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > MAX_BYTES) {
                message.error('请选择 5 MB 以内的 JPEG、PNG 或 WebP 图片。');
                event.target.value = '';
                return;
            }
            try {
                image.value = await readImage(file);
                fileName.value = file.name;
            } catch {
                message.error('这张图片暂时无法读取。');
            }
        }

        async function add() {
            if (!image.value || !referenceName.value.trim() || !nonHuman.value) {
                message.warning('请补全图片、参考名称，并确认画面不含人物。');
                return;
            }
            if (!window.confirm('参考图会在质量审查时发送到已配置的看图服务，但不会生成照片或发送到 QQ。确定登记吗？')) return;
            saving.value = true;
            try {
                const result = await send('qqbot/ai-photo-references/add', kind.value, image.value, referenceName.value.trim(), true, 'confirmed');
                if (!result?.ok) {
                    message.error(result?.error || '登记没有完成，请稍后重试。');
                    return;
                }
                message.success('已登记非人物视觉参考。');
                referenceName.value = '';
                image.value = '';
                fileName.value = '';
                nonHuman.value = false;
                await refresh();
            } catch {
                message.error('登记没有完成，请稍后重试。');
            } finally {
                saving.value = false;
            }
        }

        async function remove(entry) {
            if (!window.confirm(`删除这项“${KIND_NAMES[entry.kind] || '生活场景'}”参考？已有照片不会受影响。`)) return;
            try {
                const result = await send('qqbot/ai-photo-references/remove', entry.id, 'confirmed');
                if (!result?.ok) {
                    message.error(result?.error || '删除没有完成，请稍后重试。');
                    return;
                }
                message.success('已删除这项视觉参考。');
                await refresh();
            } catch {
                message.error('删除没有完成，请稍后重试。');
            }
        }

        onMounted(() => void refresh());
        return () => h('div', { class: 'qqbot-photo-references' }, [
            h('div', { class: 'qqbot-photo-review-head' }, [
                h('div', null, [
                    h('h2', { class: 'qqbot-status-title' }, '视觉参考'),
                    h('p', { class: 'qqbot-muted' }, '让土豆、书桌、餐具和窗外在不同照片里保持连贯。参考图保存在本机受控状态目录；质量审查时会随候选图发送到已配置的看图服务，但不会发送到 QQ。'),
                ]),
                h(c('el-button'), { disabled: loading.value, onClick: refresh }, () => '刷新'),
            ]),
            error.value ? h(c('el-alert'), { type: 'error', title: error.value, showIcon: true, closable: false }) : null,
            h('section', { class: 'qqbot-reference-form' }, [
                h('h3', null, '登记新参考'),
                h('div', { class: 'qqbot-reference-fields' }, [
                    h('label', null, [h('span', null, '用在哪里'), h(c('el-select'), {
                        modelValue: kind.value, 'onUpdate:modelValue': value => { kind.value = value; }, disabled: saving.value,
                    }, () => KINDS.map(item => h(c('el-option'), { key: item.value, label: item.label, value: item.value })))]),
                    h('label', null, [h('span', null, '参考名称'), h(c('el-input'), {
                        modelValue: referenceName.value, 'onUpdate:modelValue': value => { referenceName.value = value; },
                        placeholder: '例如 土豆正面', maxlength: 64, disabled: saving.value,
                    })]),
                    h('label', null, [h('span', null, '本地图片'), h('input', {
                        class: 'qqbot-reference-file', type: 'file', accept: 'image/jpeg,image/png,image/webp', disabled: saving.value,
                        onChange: event => void chooseFile(event),
                    }), fileName.value ? h('small', { class: 'qqbot-muted' }, `已选：${fileName.value}`) : null]),
                ]),
                h(c('el-checkbox'), {
                    modelValue: nonHuman.value, 'onUpdate:modelValue': value => { nonHuman.value = value === true; }, disabled: saving.value,
                }, () => '我已确认画面中没有人物、人脸、手或其他身体部位'),
                h('div', { class: 'qqbot-photo-actions' }, [h(c('el-button'), {
                    type: 'primary', loading: saving.value, disabled: saving.value, onClick: () => void add(),
                }, () => '登记参考')]),
            ]),
            h('section', { class: 'qqbot-reference-list' }, [
                h('h3', null, '已登记的参考'),
                loading.value && !entries.value.length ? h('p', { class: 'qqbot-muted' }, '正在读取……') : null,
                !loading.value && !error.value && !entries.value.length ? h('div', { class: 'qqbot-photo-empty' }, '还没有登记视觉参考。') : null,
                entries.value.length ? h('div', { class: 'qqbot-reference-grid' }, entries.value.map(entry => h('article', {
                    class: 'qqbot-reference-card', key: entry.id,
                }, [
                    h('div', null, [tag(KIND_NAMES[entry.kind] || '生活场景', 'success')]),
                    h('div', { class: 'qqbot-muted' }, `登记时间：${dashboardTime(entry.addedAt)}`),
                    h(c('el-button'), { size: 'small', onClick: () => void remove(entry) }, () => '删除'),
                ]))) : null,
            ]),
        ]);
    },
});
