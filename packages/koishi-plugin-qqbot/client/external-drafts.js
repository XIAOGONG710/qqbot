import { defineComponent, h, onMounted, ref } from 'vue';
import { message, send } from '@koishijs/client';
import { c, tag } from './common.js';
import { dashboardTime } from './dashboard.js';

const PLATFORMS = [{ value: undefined, label: '全部平台' }, { value: 'tieba', label: '百度贴吧' }, { value: 'douyin', label: '抖音' }, { value: 'xiaohongshu', label: '小红书' }];
const STATUSES = [{ value: 'pending', label: '待确认' }, { value: 'approved', label: '已批准' }, { value: 'publishing', label: '发布待核对' }, { value: 'failed', label: '失败' }, { value: 'published', label: '已发布' }, { value: 'rejected', label: '已拒绝' }];
const PLATFORM_NAMES = { tieba: '百度贴吧', douyin: '抖音', xiaohongshu: '小红书' };

export const ExternalDraftsTab = defineComponent({
    setup() {
        const platform = ref(undefined);
        const status = ref('pending');
        const entries = ref([]);
        const loading = ref(false);
        const error = ref('');
        async function refresh() {
            loading.value = true; error.value = '';
            try {
                const result = await send('qqbot/external-drafts/list', platform.value, status.value, 50);
                if (!result?.ok) error.value = result?.error || '暂时无法读取草稿。';
                else entries.value = result.entries;
            } catch { error.value = '暂时无法读取草稿。'; }
            finally { loading.value = false; }
        }
        async function review(item, action) {
            const word = action === 'approve' ? '批准' : '拒绝';
            if (!window.confirm(`${word}后会留下审计记录。批准不会自动发布，确定继续吗？`)) return;
            const result = await send('qqbot/external-drafts/review', action, item.id, 'confirmed').catch(() => undefined);
            if (!result?.ok) message.error(result?.error || '操作没有完成。');
            else { message.success(`已${word}，没有触发外部发布。`); await refresh(); }
        }
        onMounted(() => void refresh());
        return () => h('div', null, [
            h('div', { class: 'qqbot-photo-review-head' }, [h('div', null, [h('h2', { class: 'qqbot-status-title' }, '外部平台草稿'), h('p', { class: 'qqbot-muted' }, '贴吧、抖音和小红书统一在这里审核。批准只改变状态，不会自动发布。')]), h(c('el-button'), { disabled: loading.value, onClick: refresh }, () => '刷新')]),
            h('div', { class: 'qqbot-photo-filters' }, [
                h(c('el-select'), { modelValue: platform.value, 'onUpdate:modelValue': value => { platform.value = value; void refresh(); }, placeholder: '全部平台', clearable: true, style: 'width: 150px' }, () => PLATFORMS.filter(item => item.value).map(item => h(c('el-option'), { label: item.label, value: item.value }))),
                ...STATUSES.map(item => h(c('el-button'), { type: status.value === item.value ? 'primary' : undefined, plain: status.value !== item.value, onClick: () => { status.value = item.value; void refresh(); } }, () => item.label)),
            ]),
            error.value ? h(c('el-alert'), { type: 'error', title: error.value, showIcon: true, closable: false }) : null,
            !loading.value && !error.value && !entries.value.length ? h('p', { class: 'qqbot-muted' }, '当前没有符合条件的草稿。') : null,
            entries.value.map(item => h('article', { class: 'qqbot-photo-card', style: 'margin: 12px 0' }, [h('div', { class: 'qqbot-photo-card-body' }, [
                h('div', { class: 'qqbot-photo-card-tags' }, [tag(PLATFORM_NAMES[item.platform] || item.platform), tag(STATUSES.find(state => state.value === item.status)?.label || item.status, item.status === 'pending' ? 'warning' : 'info'), item.mediaCount ? tag(`${item.mediaCount} 个素材`) : null]),
                h('strong', null, item.title), h('p', { style: 'white-space: pre-wrap' }, item.body), h('div', { class: 'qqbot-muted' }, `更新：${dashboardTime(item.updatedAt)}`),
                item.status === 'pending' ? h('div', { class: 'qqbot-photo-actions' }, [h(c('el-button'), { type: 'success', onClick: () => void review(item, 'approve') }, () => '批准'), h(c('el-button'), { onClick: () => void review(item, 'reject') }, () => '拒绝')]) : null,
            ])])),
        ]);
    },
});
