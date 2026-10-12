// 图片表情人工核对（ADR 0063）：列表只带元数据，点一行才从已登录的控制台接口读取图片。
import { computed, defineComponent, h, ref } from 'vue';
import { message, send, store } from '@koishijs/client';
import { c, clock, firstLine, tag } from './common.js';

const MODE = {
    off: ['关', 'info'],
    collect: ['只收藏核对', 'warning'],
    send: ['允许发送', 'success'],
};

function sourceText(source) {
    if (!source) return '—';
    if (source.kind === 'received') return `聊天收到${source.from ? `（QQ ${source.from}）` : ''}`;
    if (source.kind === 'qq-custom') return 'QQ 自定义表情';
    if (source.kind === 'inbox') return `导入箱${source.name ? `（${source.name}）` : ''}`;
    if (source.kind === 'web') return `网页直链${source.name ? `（${source.name}）` : ''}`;
    if (source.kind === 'bqb') return 'ChineseBQB';
    return source.kind;
}

export const StickersTab = defineComponent({
    setup() {
        const selected = ref('');
        const preview = ref('');
        const error = ref('');
        const busy = ref(false);
        const stickers = computed(() => store.qqbot?.status?.stickers);

        async function select(row) {
            selected.value = row.id;
            preview.value = '';
            error.value = '';
            busy.value = true;
            try {
                preview.value = (await send('qqbot/stickers/preview', row.id)).data;
            } catch (cause) {
                error.value = firstLine(cause);
            } finally {
                busy.value = false;
            }
        }

        async function mark(row, reviewed) {
            busy.value = true;
            error.value = '';
            try {
                await send('qqbot/stickers/reviewed', row.id, reviewed);
                message.success(reviewed ? '已记为核对通过' : '已取消核对标记');
            } catch (cause) {
                error.value = firstLine(cause);
            } finally {
                busy.value = false;
            }
        }

        return () => {
            const state = stickers.value;
            if (!state) return h('p', null, '插件重启后才会显示图片表情收藏。');
            const rows = state.entries ?? [];
            const checked = rows.filter(row => row.reviewedAt).length;
            const discovery = state.discovery;
            const summary = h('div', { class: 'qqbot-summary' }, [
                h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '运行模式'), tag(...(MODE[state.mode] ?? [state.mode, 'info']))]),
                h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '收藏'), h('span', null, `${state.count} 张；人工核对通过 ${checked} 张（开启发送前至少 20 张）`)]),
                h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '今日公开找图'), h('span', null, discovery ? `${discovery.reviewed}/${discovery.limit} 个（${discovery.day}，重启不重置）` : '尚无记录')]),
                h('p', { class: 'qqbot-muted' }, '先保持“只收藏核对”。逐张看实际图片、描述、图中文字和 GIF 表现；至少 20 张通过后，再单独决定是否开启发送。'),
            ]);
            const table = h(c('el-table'), {
                data: rows,
                border: true,
                style: 'width: 100%; margin-top: 16px',
                rowClassName: ({ row }) => row.id === selected.value ? 'qqbot-row-selected' : '',
                onRowClick: select,
            }, () => [
                h(c('el-table-column'), { label: '核对', width: 90 }, { default: ({ row }) => row.reviewedAt ? tag('通过', 'success') : tag('待核对', 'warning') }),
                h(c('el-table-column'), { label: '描述', prop: 'description', minWidth: 220 }),
                h(c('el-table-column'), { label: '标签', minWidth: 150 }, { default: ({ row }) => row.tags?.join('、') || '—' }),
                h(c('el-table-column'), { label: '来源', minWidth: 190 }, { default: ({ row }) => sourceText(row.source) }),
                h(c('el-table-column'), { label: '收藏时间', width: 135 }, { default: ({ row }) => clock(row.createdAt) }),
                h(c('el-table-column'), { label: '用过', prop: 'used', width: 70 }),
                h(c('el-table-column'), { label: '编号', prop: 'id', width: 120 }),
            ]);
            const row = rows.find(item => item.id === selected.value);
            const detail = row ? h('div', { class: 'qqbot-sticker-detail' }, [
                h('div', { class: 'qqbot-sticker-preview' }, [
                    busy.value && !preview.value ? h('span', { class: 'qqbot-muted' }, '正在读取图片……') : null,
                    preview.value ? h('img', { src: preview.value, alt: row.description }) : null,
                    error.value ? h('span', { class: 'qqbot-error' }, error.value) : null,
                ]),
                h('div', null, [
                    h('h3', null, row.description),
                    h('p', { class: 'qqbot-muted' }, `${sourceText(row.source)} · ${row.id}`),
                    h(c('el-button'), { type: row.reviewedAt ? 'default' : 'primary', disabled: busy.value, onClick: () => mark(row, !row.reviewedAt) }, () => row.reviewedAt ? '取消“核对通过”' : '这张核对通过'),
                ]),
            ]) : h('p', { class: 'qqbot-muted' }, rows.length ? '点一行查看实际图片。' : '收藏库还是空的；开启 collect 后，她会在空闲时每天审看少量公开候选。');
            return h('div', null, [summary, table, detail]);
        };
    },
});
