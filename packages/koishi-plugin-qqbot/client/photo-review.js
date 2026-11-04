// AI 照片草稿审核页（ADR 0239）：只审核，不生成、不发送 QQ。
import { defineComponent, h, onMounted, ref } from 'vue';
import { message, send } from '@koishijs/client';
import { c, tag } from './common.js';
import { dashboardTime } from './dashboard.js';

const FILTERS = [
    { value: 'pending_review', label: '待审核' },
    { value: 'approved', label: '已通过' },
    { value: 'rejected', label: '已拒绝' },
];
const KIND_NAMES = { cat: '土豆', food: '吃的', desk: '书桌', view: '窗外与路上' };
const STATUS_NAMES = { pending_review: '待审核', approved: '已通过', rejected: '已拒绝' };
const STATUS_TYPES = { pending_review: 'warning', approved: 'success', rejected: 'info' };

export const PhotoReviewTab = defineComponent({
    setup() {
        const filter = ref('pending_review');
        const entries = ref([]);
        const previews = ref({});
        const loading = ref(false);
        const acting = ref([]);
        const error = ref('');
        let generation = 0;

        async function refresh() {
            const token = ++generation;
            loading.value = true;
            error.value = '';
            try {
                const result = await send('qqbot/ai-photos/list', filter.value, 24);
                if (!result?.ok) {
                    if (token === generation) error.value = result?.error || '暂时无法读取照片草稿。';
                    return;
                }
                if (token !== generation) return;
                entries.value = result.entries;
                const next = {};
                previews.value = next;
                // 逐张读取，避免一次把多张大图同时塞进控制台连接。
                for (const entry of result.entries) {
                    if (token !== generation) return;
                    const preview = await send('qqbot/ai-photos/preview', entry.id).catch(() => undefined);
                    if (preview?.ok) {
                        next[entry.id] = preview.dataUrl;
                        previews.value = { ...next };
                    }
                }
            } catch (caught) {
                if (token === generation) error.value = '暂时无法读取照片草稿，请稍后重试。';
            } finally {
                if (token === generation) loading.value = false;
            }
        }

        async function choose(next) {
            if (filter.value === next) return;
            filter.value = next;
            await refresh();
        }

        async function review(entry, action) {
            const approving = action === 'approve';
            const prompt = approving
                ? '通过后会进入照片货架，但不会自动发给任何人。确定通过吗？'
                : '拒绝后这张草稿不能直接改为通过。确定拒绝吗？';
            if (!window.confirm(prompt)) return;
            acting.value = [...acting.value, entry.id];
            try {
                const result = await send('qqbot/ai-photos/review', action, entry.id, 'confirmed');
                if (!result?.ok) {
                    message.error(result?.error || '审核没有完成，请稍后重试。');
                    return;
                }
                message.success(approving ? '已通过并放入照片货架，不会自动发送。' : '已拒绝这张草稿。');
                await refresh();
            } catch {
                message.error('审核没有完成，请稍后重试。');
            } finally {
                acting.value = acting.value.filter(id => id !== entry.id);
            }
        }

        onMounted(() => void refresh());
        return () => h('div', { class: 'qqbot-photo-review' }, [
            h('div', { class: 'qqbot-photo-review-head' }, [
                h('div', null, [
                    h('h2', { class: 'qqbot-status-title' }, 'AI 照片审核'),
                    h('p', { class: 'qqbot-muted' }, '生成的照片先停在这里。通过后只进入照片货架，仍不会自动发送。'),
                ]),
                h(c('el-button'), { disabled: loading.value, onClick: refresh }, () => '刷新'),
            ]),
            h('div', { class: 'qqbot-photo-filters' }, FILTERS.map(item => h(c('el-button'), {
                type: filter.value === item.value ? 'primary' : undefined,
                plain: filter.value !== item.value,
                disabled: loading.value,
                onClick: () => void choose(item.value),
            }, () => item.label))),
            error.value ? h(c('el-alert'), { type: 'error', title: error.value, showIcon: true, closable: false }) : null,
            loading.value && !entries.value.length ? h('p', { class: 'qqbot-muted' }, '正在读取照片……') : null,
            !loading.value && !error.value && !entries.value.length
                ? h('div', { class: 'qqbot-photo-empty' }, filter.value === 'pending_review' ? '当前没有待审核照片。' : `当前没有${STATUS_NAMES[filter.value]}的照片。`)
                : null,
            entries.value.length ? h('div', { class: 'qqbot-photo-grid' }, entries.value.map(entry => {
                const waiting = acting.value.includes(entry.id);
                return h('article', { class: 'qqbot-photo-card', key: entry.id }, [
                    previews.value[entry.id]
                        ? h('img', { class: 'qqbot-photo-image', src: previews.value[entry.id], alt: entry.caption })
                        : h('div', { class: 'qqbot-photo-image qqbot-photo-placeholder' }, '图片暂不可预览'),
                    h('div', { class: 'qqbot-photo-card-body' }, [
                        h('div', { class: 'qqbot-photo-card-tags' }, [
                            tag(KIND_NAMES[entry.kind] ?? '生活照'),
                            tag(STATUS_NAMES[entry.status] ?? '未知', STATUS_TYPES[entry.status] ?? 'info'),
                        ]),
                        h('div', { class: 'qqbot-photo-caption' }, entry.caption),
                        h('div', { class: 'qqbot-muted' }, `画面时间：${dashboardTime(entry.at)}`),
                        h('div', { class: 'qqbot-muted' }, `${entry.reviewedAt ? '审核时间' : '生成时间'}：${dashboardTime(entry.reviewedAt ?? entry.createdAt)}`),
                        entry.status === 'pending_review' ? h('div', { class: 'qqbot-photo-actions' }, [
                            h(c('el-button'), { type: 'success', disabled: waiting, onClick: () => void review(entry, 'approve') }, () => '通过'),
                            h(c('el-button'), { disabled: waiting, onClick: () => void review(entry, 'reject') }, () => '拒绝'),
                        ]) : null,
                    ]),
                ]);
            })) : null,
        ]);
    },
});

