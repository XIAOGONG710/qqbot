/**
 * Client half of the Super Agent bundle.
 *
 * Registers one sidebar panel icon and one main panel ("Super Agent console"):
 * a live architecture visualization of the Router / Worker two-layer system.
 * The console polls `GET /api/super-agent/state` and dispatches control
 * commands with `POST /api/super-agent/command`; it owns no Session state and
 * never touches the DOM outside its own React subtree.
 *
 * Plain JavaScript by design: no TypeScript, no imports, no build step.
 */

window.__ModuleLoader__.load({
  id: 'dsh-super-agent',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Client locale namespace owned by this plugin. */
    const NS = 'superAgent'
    /** Main panel key, matched by the sidebar entry id. */
    const PANEL_ID = 'dsh-super-agent'
    /** Sidebar position: between the shipped panels and the tail entries. */
    const PANEL_ORDER = 12

    /** Same-origin relative endpoints; the Host half owns their prefixes. */
    const STATE_URL = '/api/super-agent/state'
    const COMMAND_URL = '/api/super-agent/command'
    const POLL_MS = 1500
    const POLL_HIDDEN_MS = 6000
    const FETCH_TIMEOUT_MS = 8000
    const COMMAND_TIMEOUT_MS = 20000

    const EVENT_KINDS = ['trigger', 'admit', 'reject', 'batch', 'dispatch', 'progress',
      'result', 'watchdog', 'attention', 'mode', 'error']
    const WORKER_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled']
    const HEALTH_STATES = ['ready', 'warn', 'error']
    const WATCHDOG_STATES = ['ok', 'warn', 'alert']
    const REASONS = ['result-ready', 'decision-needed', 'failed', 'progress']
    const SIGNAL_LEVELS = ['info', 'warn', 'error']
    const FUNNEL_STAGES = ['raw', 'fast', 'semantic', 'dispatched']

    /**
     * Theme aliases only. The shipped theme exposes exactly these aliases, so the
     * map stays inside that set; tertiary text reuses label-secondary plus opacity
     * (applied by the styles/`svgText` below), and every var() carries a fallback
     * so a missing token can never render transparent text.
     */
    const TOK = {
      label1: 'var(--dsw-alias-label-primary, #111827)',
      label2: 'var(--dsw-alias-label-secondary, #6b7280)',
      label3: 'var(--dsw-alias-label-secondary, #6b7280)',
      caption: 'var(--dsw-alias-label-secondary, #6b7280)',
      dimmed: 'var(--dsw-alias-label-secondary, #6b7280)',
      fg: 'var(--dsw-alias-label-primary, #111827)',
      border1: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
      border2: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      border3: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      border4: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      bg1: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
      bg2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
      bg3: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
      bgModule: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
      bgBase: 'var(--dsw-alias-bg-base, transparent)',
      bgOverlay: 'var(--dsw-alias-bg-overlay, rgba(127,127,127,0.18))',
      brand: 'var(--dsw-alias-brand-primary, #3b82f6)',
      link: 'var(--dsw-alias-brand-primary, #3b82f6)',
      business: 'var(--dsw-alias-brand-primary, #3b82f6)',
      success: 'var(--dsw-alias-state-success-primary, #16a34a)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      error: 'var(--dsw-alias-state-error-primary, #dc2626)',
      idle: 'var(--dsw-alias-state-idle-primary, #9ca3af)',
      hover: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
      active: 'var(--dsw-alias-bg-overlay, rgba(127,127,127,0.18))',
      buttonFill: 'var(--dsw-alias-brand-primary, #3b82f6)',
      buttonHover: 'var(--dsw-alias-brand-primary, #3b82f6)',
      ghostFill: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
      ghostBorder: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
    }

    const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    const zh = {
      panel: 'Super Agent',
      title: 'Super Agent 控制台',
      subtitle: 'Router / Worker 双层自主体系的实时架构与注意力控制台',
      'conn.online': '在线', 'conn.offline': '离线', 'conn.loading': '加载中',
      'status.mode': '模式', 'status.health': '健康', 'status.uptime': '运行时长',
      'status.runner': 'Runner', 'status.model': '当前模型', 'status.updated': '上次同步',
      'status.paused': '已暂停', 'status.active': '运行中', 'status.waiting': '等待 Host 状态数据…',
      'mode.observe': '观察', 'mode.accept': '主动',
      'runner.session': '真实会话', 'runner.simulate': '模拟',
      'health.ready': '正常', 'health.warn': '注意', 'health.error': '异常',
      'section.topology': '架构拓扑',
      'section.funnel': '准入漏斗', 'section.attention': '注意力预算',
      'topologyHint': '真实状态驱动：Router → 两级准入 → Worker 泳道 → 注意力闸门',
      'topo.router': 'Router', 'topo.admission': '两级准入', 'topo.threads': '线程轴',
      'topo.workers': 'Worker 泳道', 'topo.gate': '注意力闸门',
      'topo.decisions': '决策', 'topo.batch': '平均 batch', 'topo.batches': '批次', 'topo.received': '接收',
      'topo.accepted': '准入', 'topo.rate': '速率', 'topo.noThreads': '暂无订阅线程',
      'topo.noWorkers': '暂无 Worker', 'topo.flow': '触发点流动', 'topo.subs': '订阅',
      'topo.thread': '线程', 'topo.gateEmitted': '打扰', 'topo.gateSuppressed': '静默',
      'topo.gateRatio': '克制比', 'topo.bypass': '绕过',
      'funnel.raw': '原始事件', 'funnel.fast': '规则快筛', 'funnel.semantic': '语义判定',
      'funnel.dispatched': '已派单',
      'funnel.rate': '转化率', 'funnel.input': '输入', 'funnel.rejected': '语义拒绝',
      'funnel.fastBlocked': '规则拦下', 'funnel.perMin': '准入 / 分钟', 'funnel.rules': '命中规则',
      'attention.emitted': '打扰', 'attention.suppressed': '静默', 'attention.ratio': '克制比',
      'attention.budget': '打扰预算', 'attention.recent': '最近打扰', 'attention.none': '最近没有打扰',
      'reason.result-ready': '结果就绪', 'reason.decision-needed': '需要决策',
      'reason.failed': '失败', 'reason.progress': '进度', 'reason.other': '其他',
      'section.workers': 'Worker 泳道',
      'workers.empty': '暂无 Worker。触发一次 demo 或派单后出现。',
      'worker.progress': '进度', 'worker.elapsed': '用时', 'worker.turns': '轮次',
      'worker.steps': '步骤', 'worker.toolCalls': '工具调用', 'worker.tokens': 'Token',
      'worker.cacheRead': '缓存读', 'worker.thread': '线程', 'worker.model': '模型',
      'worker.branch': '分支', 'worker.delivery': '交付', 'worker.reply': '已回贴',
      'worker.summary': '进展', 'worker.stalled': '已卡住', 'worker.simulated': '模拟',
      'worker.attention': '注意力成本',
      'status.queued': '排队中', 'status.running': '运行中', 'status.done': '已完成',
      'status.failed': '失败', 'status.cancelled': '已取消',
      'section.watchdog': 'Watchdog 健康',
      'watchdog.ok': '正常', 'watchdog.warn': '注意', 'watchdog.alert': '告警',
      'watchdog.checks': '巡检次数', 'watchdog.lastCheck': '最近巡检', 'watchdog.stalled': '卡住',
      'watchdog.loops': '循环', 'watchdog.drift': '漂移', 'watchdog.findings': '发现',
      'watchdog.none': '暂无异常发现', 'watchdog.kind.stall': '停滞',
      'watchdog.kind.loop': '循环', 'watchdog.kind.drift': '漂移',
      'section.metrics': '指标',
      'metrics.p50': 'p50', 'metrics.p95': 'p95', 'metrics.routerDecisions': 'Router 决策',
      'metrics.avgBatch': '平均 batch', 'metrics.cacheRead': 'cacheRead token',
      'metrics.triggersPerMin': '触发器 / 分钟', 'metrics.avgDecisionMs': '平均决策',
      'metrics.completed': '完成会话', 'metrics.savedMinutes': '节省人时',
      'metrics.compare': '与单会话基线对比', 'metrics.super': 'Super Agent',
      'metrics.single': '单会话基线', 'metrics.untested': '未测', 'metrics.saved': '节省',
      'section.events': '事件流', 'events.empty': '暂无事件', 'events.stick': '自动吸底',
      'events.paused': '吸底已暂停', 'events.resume': '回到底部',
      'section.controls': '控制条', 'control.mode': '路由模式', 'control.pause': '暂停',
      'control.resume': '继续', 'control.demo': '重放论文实验', 'control.watchdog': '立即巡检',
      'control.reset': '重置', 'control.confirmReset': '确认重置？', 'control.confirm': '确认',
      'control.cancel': '取消', 'control.busy': '执行中…', 'control.failed': '命令失败',
      'control.refresh': '刷新',
      'control.timeout': '命令超时', 'control.network': '网络错误', 'control.done': '命令已执行',
      'control.demoHint': '约 300 条触发 / 20 个工单', 'control.resetHint': '清空全部记录（保留配置）',
      'empty.waiting': '正在轮询 /api/super-agent/state …', 'empty.noData': 'Host 尚未返回状态',
      'empty.offline': '连接失败，保留上次数据',
      'offline.note': '连接失败，正在重试；界面保留最后一次成功数据。',
      'block.failed': '该区块渲染失败，其余区块不受影响。', 'block.retry': '重试',
      'boundary.failed': '控制台渲染失败。', 'boundary.retry': '重新渲染',
      'common.none': '—', 'common.now': '刚刚', 'common.ago': '前',
      'unit.s': '秒', 'unit.m': '分', 'unit.h': '时', 'unit.d': '天', 'unit.min': '分钟', 'unit.ms': '毫秒',
      'kind.trigger': '触发', 'kind.admit': '准入', 'kind.reject': '拒绝', 'kind.batch': '合批',
      'kind.dispatch': '派单', 'kind.progress': '进展', 'kind.result': '结果',
      'kind.watchdog': '巡检', 'kind.attention': '打扰', 'kind.mode': '模式', 'kind.error': '错误',
      footer: '数据来自 Host 半的 /api/super-agent 轮询（1.5s，页面隐藏时 6s）；控制命令成功后立即刷新。',
    }

    const en = {
      panel: 'Super Agent',
      title: 'Super Agent console',
      subtitle: 'Live architecture and attention console for the Router / Worker two-layer system',
      'conn.online': 'Online', 'conn.offline': 'Offline', 'conn.loading': 'Loading',
      'status.mode': 'Mode', 'status.health': 'Health', 'status.uptime': 'Uptime',
      'status.runner': 'Runner', 'status.model': 'Model', 'status.updated': 'Synced',
      'status.paused': 'Paused', 'status.active': 'Active', 'status.waiting': 'Waiting for Host state…',
      'mode.observe': 'Observe', 'mode.accept': 'Accept',
      'runner.session': 'Live session', 'runner.simulate': 'Simulated',
      'health.ready': 'Ready', 'health.warn': 'Warning', 'health.error': 'Error',
      'section.topology': 'Architecture',
      'section.funnel': 'Admission funnel', 'section.attention': 'Attention budget',
      'topologyHint': 'Driven by live state: Router → two-stage admission → worker lanes → attention gate',
      'topo.router': 'Router', 'topo.admission': 'Admission', 'topo.threads': 'Thread axis',
      'topo.workers': 'Worker lanes', 'topo.gate': 'Attention gate',
      'topo.decisions': 'Decisions', 'topo.batch': 'Avg batch', 'topo.batches': 'batches', 'topo.received': 'Received',
      'topo.accepted': 'Accepted', 'topo.rate': 'Rate', 'topo.noThreads': 'No subscribed threads',
      'topo.noWorkers': 'No workers', 'topo.flow': 'Trigger flow', 'topo.subs': 'subs',
      'topo.thread': 'Thread', 'topo.gateEmitted': 'Interrupts', 'topo.gateSuppressed': 'Silenced',
      'topo.gateRatio': 'Restraint', 'topo.bypass': 'bypass',
      'funnel.raw': 'Raw events', 'funnel.fast': 'Rule screen', 'funnel.semantic': 'Semantic',
      'funnel.dispatched': 'Dispatched',
      'funnel.rate': 'Conversion', 'funnel.input': 'Input', 'funnel.rejected': 'Semantic rejects',
      'funnel.fastBlocked': 'Rule blocked', 'funnel.perMin': 'Admitted / min', 'funnel.rules': 'Matching rules',
      'attention.emitted': 'Interrupts', 'attention.suppressed': 'Silenced', 'attention.ratio': 'Restraint',
      'attention.budget': 'Budget', 'attention.recent': 'Recent interrupts', 'attention.none': 'No recent interrupts',
      'reason.result-ready': 'Result ready', 'reason.decision-needed': 'Decision needed',
      'reason.failed': 'Failed', 'reason.progress': 'Progress', 'reason.other': 'Other',
      'section.workers': 'Worker lanes',
      'workers.empty': 'No workers yet. Run the demo or dispatch a ticket.',
      'worker.progress': 'Progress', 'worker.elapsed': 'Elapsed', 'worker.turns': 'Turns',
      'worker.steps': 'Steps', 'worker.toolCalls': 'Tool calls', 'worker.tokens': 'Tokens',
      'worker.cacheRead': 'Cache read', 'worker.thread': 'Thread', 'worker.model': 'Model',
      'worker.branch': 'Branch', 'worker.delivery': 'Delivery', 'worker.reply': 'replied',
      'worker.summary': 'Latest', 'worker.stalled': 'Stalled', 'worker.simulated': 'Simulated',
      'worker.attention': 'Attention cost',
      'status.queued': 'Queued', 'status.running': 'Running', 'status.done': 'Done',
      'status.failed': 'Failed', 'status.cancelled': 'Cancelled',
      'section.watchdog': 'Watchdog health',
      'watchdog.ok': 'Healthy', 'watchdog.warn': 'Warning', 'watchdog.alert': 'Alert',
      'watchdog.checks': 'Checks', 'watchdog.lastCheck': 'Last check', 'watchdog.stalled': 'Stalled',
      'watchdog.loops': 'Loops', 'watchdog.drift': 'Drift', 'watchdog.findings': 'Findings',
      'watchdog.none': 'No findings', 'watchdog.kind.stall': 'Stall',
      'watchdog.kind.loop': 'Loop', 'watchdog.kind.drift': 'Drift',
      'section.metrics': 'Metrics',
      'metrics.p50': 'p50', 'metrics.p95': 'p95', 'metrics.routerDecisions': 'Router decisions',
      'metrics.avgBatch': 'Avg batch', 'metrics.cacheRead': 'cacheRead tokens',
      'metrics.triggersPerMin': 'Triggers / min', 'metrics.avgDecisionMs': 'Avg decision',
      'metrics.completed': 'Completed sessions', 'metrics.savedMinutes': 'Minutes saved',
      'metrics.compare': 'Versus single-session baseline', 'metrics.super': 'Super Agent',
      'metrics.single': 'Single session', 'metrics.untested': 'Not measured', 'metrics.saved': 'Saved',
      'section.events': 'Event stream', 'events.empty': 'No events yet', 'events.stick': 'Auto-follow',
      'events.paused': 'Auto-follow paused', 'events.resume': 'Jump to bottom',
      'section.controls': 'Controls', 'control.mode': 'Routing mode', 'control.pause': 'Pause',
      'control.resume': 'Resume', 'control.demo': 'Replay paper experiment', 'control.watchdog': 'Run watchdog',
      'control.reset': 'Reset', 'control.confirmReset': 'Reset everything?', 'control.confirm': 'Confirm',
      'control.cancel': 'Cancel', 'control.busy': 'Running…', 'control.failed': 'Command failed',
      'control.refresh': 'Refresh',
      'control.timeout': 'Command timed out', 'control.network': 'Network error', 'control.done': 'Command applied',
      'control.demoHint': '~300 triggers / 20 tickets', 'control.resetHint': 'Clears all records, keeps config',
      'empty.waiting': 'Polling /api/super-agent/state …', 'empty.noData': 'Host has not returned state yet',
      'empty.offline': 'Connection failed, showing last data',
      'offline.note': 'Connection failed and is retrying; the last successful snapshot stays on screen.',
      'block.failed': 'This block failed to render; other blocks are unaffected.', 'block.retry': 'Retry',
      'boundary.failed': 'The console failed to render.', 'boundary.retry': 'Render again',
      'common.none': '—', 'common.now': 'now', 'common.ago': ' ago',
      'unit.s': 's', 'unit.m': 'm', 'unit.h': 'h', 'unit.d': 'd', 'unit.min': 'min', 'unit.ms': 'ms',
      'kind.trigger': 'Trigger', 'kind.admit': 'Admit', 'kind.reject': 'Reject', 'kind.batch': 'Batch',
      'kind.dispatch': 'Dispatch', 'kind.progress': 'Progress', 'kind.result': 'Result',
      'kind.watchdog': 'Watchdog', 'kind.attention': 'Attention', 'kind.mode': 'Mode', 'kind.error': 'Error',
      footer: 'Polled from /api/super-agent on the Host half (1.5s; 6s while the page is hidden); a successful command refreshes immediately.',
    }

    /** Scoped keyframes/classes: rendered inside this panel only, never appended to document.body. */
    const PANEL_CSS = [
      '.sa-grid2{display:grid;gap:12px;grid-template-columns:minmax(0,1fr);align-items:start}',
      '@media (min-width:1080px){.sa-grid2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}',
      '.sa-grid3{display:grid;gap:12px;grid-template-columns:minmax(0,1fr)}',
      '@media (min-width:760px){.sa-grid3{grid-template-columns:minmax(0,0.9fr) minmax(0,1.1fr)}}',
      '@keyframes sa-pulse{0%,100%{opacity:1}50%{opacity:0.28}}',
      '@keyframes sa-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-1.6px)}75%{transform:translateX(1.6px)}}',
      '@keyframes sa-dash{to{stroke-dashoffset:-24}}',
      '@keyframes sa-spin{to{transform:rotate(360deg)}}',
      '.sa-pulse{animation:sa-pulse 1.8s ease-in-out infinite}',
      '.sa-shake{animation:sa-shake 460ms linear infinite}',
      '.sa-dash{stroke-dasharray:5 7;animation:sa-dash 1.5s linear infinite}',
      '.sa-spin{animation:sa-spin 1.1s linear infinite;transform-origin:50% 50%}',
      '@media (prefers-reduced-motion:reduce){.sa-pulse,.sa-shake,.sa-dash,.sa-spin{animation:none}}',
    ].join('\n')

    /** Layout/typography only; every colour comes from a theme alias. */
    const styles = {
      root: {
        boxSizing: 'border-box',
        height: '100%',
        minHeight: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '18px 22px 32px',
        color: TOK.label1,
        fontFamily: FONT,
        fontSize: 13,
        lineHeight: 1.5,
      },
      column: { width: '100%', maxWidth: 1240, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 },
      header: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
      titleWrap: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      title: { margin: 0, fontSize: 19, lineHeight: 1.3, fontWeight: 650, letterSpacing: '0.01em' },
      subtitle: { margin: 0, fontSize: 12, color: TOK.label2 },
      headerActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      statusStrip: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      chip: {
        display: 'inline-flex', alignItems: 'baseline', gap: 5,
        padding: '3px 9px', borderRadius: 999,
        border: '1px solid ' + TOK.border1, background: TOK.bg1,
        fontSize: 11, color: TOK.label2, whiteSpace: 'nowrap',
      },
      chipLabel: { fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase', color: TOK.caption, opacity: 0.75 },
      chipValue: { fontSize: 12, fontWeight: 600, color: TOK.label1, fontVariantNumeric: 'tabular-nums' },
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '3px 10px', borderRadius: 999,
        border: '1px solid ' + TOK.border1, background: TOK.bg1,
        fontSize: 11, color: TOK.label2, whiteSpace: 'nowrap',
      },
      dot: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto', display: 'inline-block' },
      card: {
        display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0,
        padding: '12px 14px', borderRadius: 12,
        border: '1px solid ' + TOK.border1, background: TOK.bg1,
      },
      sectionHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 },
      sectionTitle: {
        fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
        color: TOK.label2,
      },
      sectionHint: { fontSize: 11, color: TOK.label3, minWidth: 0, opacity: 0.72 },
      sectionActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      button: {
        appearance: 'none', cursor: 'pointer', flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        borderRadius: 8, padding: '4px 10px', fontSize: 12, lineHeight: 1.5, fontFamily: 'inherit',
        border: '1px solid ' + TOK.border3, background: TOK.bg2, color: TOK.label1,
      },
      buttonPrimary: {
        appearance: 'none', cursor: 'pointer', flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        borderRadius: 8, padding: '4px 10px', fontSize: 12, lineHeight: 1.5, fontFamily: 'inherit',
        border: '1px solid ' + TOK.brand, background: 'transparent', color: TOK.brand,
        fontWeight: 600,
      },
      buttonDanger: {
        appearance: 'none', cursor: 'pointer', flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        borderRadius: 8, padding: '4px 10px', fontSize: 12, lineHeight: 1.5, fontFamily: 'inherit',
        border: '1px solid ' + TOK.error, background: 'transparent', color: TOK.error,
      },
      segmented: {
        display: 'inline-flex', gap: 2, padding: 2, borderRadius: 8,
        border: '1px solid ' + TOK.border1, background: TOK.bg2, flexWrap: 'wrap',
      },
      segment: {
        appearance: 'none', cursor: 'pointer', border: 'none', background: 'transparent',
        color: TOK.label2, borderRadius: 6, padding: '2px 10px', fontSize: 12,
        fontFamily: 'inherit', lineHeight: 1.5,
      },
      segmentOn: {
        appearance: 'none', cursor: 'pointer', border: 'none', background: TOK.bg1,
        color: TOK.label1, borderRadius: 6, padding: '2px 10px', fontSize: 12,
        fontWeight: 600, fontFamily: 'inherit', lineHeight: 1.5,
      },
      controlsRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      controlGroup: { display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      controlNote: { fontSize: 11, color: TOK.label3, opacity: 0.72 },
      commandLine: {
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '5px 9px', borderRadius: 8, fontSize: 11,
        border: '1px solid ' + TOK.border1, background: TOK.bg2, color: TOK.label2,
      },
      empty: { margin: 0, fontSize: 12, color: TOK.label3, opacity: 0.72 },
      errorCard: {
        display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 11px',
        borderRadius: 10, border: '1px solid ' + TOK.error, background: TOK.bg1,
      },
      errorLabel: {
        fontSize: 10, letterSpacing: '0.05em', textTransform: 'uppercase', color: TOK.error,
      },
      errorText: { fontSize: 12, overflowWrap: 'anywhere', color: TOK.label1 },
      footer: { margin: 0, fontSize: 11, color: TOK.label3, opacity: 0.72 },
      mono: { fontFamily: MONO, fontSize: 11, fontVariantNumeric: 'tabular-nums' },
      codeInline: {
        fontFamily: MONO, fontSize: 11, padding: '0 4px', borderRadius: 4,
        background: TOK.bgModule, color: TOK.label2, overflowWrap: 'anywhere',
      },
      kvGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 },
      kvCell: {
        display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0,
        padding: '6px 8px', borderRadius: 8, border: '1px solid ' + TOK.border1, background: TOK.bg2,
      },
      kvLabel: { fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase', color: TOK.caption, opacity: 0.75 },
      kvValue: { fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
      kvValueBig: { fontSize: 20, fontWeight: 650, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' },
      statGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 },
      statRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 12 },
      statLabel: { color: TOK.label2 },
      statValue: { fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      funnelGrid: { display: 'flex', flexDirection: 'column', gap: 5 },
      funnelRow: {
        display: 'grid', gridTemplateColumns: '84px minmax(0,1fr) 58px 62px',
        alignItems: 'center', gap: 8, fontSize: 12,
      },
      funnelLabel: { color: TOK.label2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      funnelTrack: {
        position: 'relative', height: 18, borderRadius: 6,
        background: TOK.bg2, border: '1px solid ' + TOK.border1, overflow: 'hidden',
      },
      funnelFill: { height: '100%', borderRadius: 5, minWidth: 2 },
      funnelCount: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
      funnelRate: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: TOK.label2, fontSize: 11 },
      workerGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(236px, 1fr))', gap: 10 },
      workerCard: {
        display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0,
        padding: '10px 11px', borderRadius: 10,
        border: '1px solid ' + TOK.border1, background: TOK.bg2,
      },
      workerHead: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      workerId: { fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.02em' },
      workerTitle: {
        fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      workerTop: { display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 },
      workerBody: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 },
      workerMeta: { fontSize: 11, color: TOK.label2, display: 'flex', flexWrap: 'wrap', gap: '0 8px' },
      workerSummary: {
        fontSize: 11, color: TOK.label3, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', minWidth: 0,
      },
      badge: {
        display: 'inline-flex', alignItems: 'center', gap: 3, padding: '0 6px',
        borderRadius: 999, fontSize: 10, lineHeight: '16px', fontWeight: 600,
        border: '1px solid ' + TOK.border1, background: TOK.bg1, color: TOK.label2, whiteSpace: 'nowrap',
      },
      ringWrap: { position: 'relative', width: 54, height: 54, flex: '0 0 auto' },
      ringCenter: {
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: TOK.label1,
      },
      healthWrap: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
      healthRing: { position: 'relative', width: 96, height: 96, flex: '0 0 auto' },
      healthCenter: {
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 1,
      },
      healthValue: { fontSize: 13, fontWeight: 700, color: TOK.label1 },
      healthCaption: { fontSize: 10, color: TOK.caption, opacity: 0.75 },
      findings: { display: 'flex', flexDirection: 'column', gap: 4, margin: 0, padding: 0, listStyle: 'none' },
      finding: {
        display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
        padding: '5px 8px', borderRadius: 8, border: '1px solid ' + TOK.border1, background: TOK.bg2,
        fontSize: 11,
      },
      findingKind: { fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' },
      findingText: { flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: TOK.label1 },
      findingMeta: { color: TOK.caption, opacity: 0.75, fontSize: 10, fontVariantNumeric: 'tabular-nums' },
      compare: { display: 'flex', flexDirection: 'column', gap: 8 },
      compareRow: { display: 'flex', flexDirection: 'column', gap: 3 },
      compareLabel: { fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase', color: TOK.caption, opacity: 0.78 },
      compareTrack: {
        position: 'relative', height: 9, borderRadius: 5,
        background: TOK.bg2, border: '1px solid ' + TOK.border1, overflow: 'hidden',
      },
      compareFill: { height: '100%', borderRadius: 4, minWidth: 2 },
      compareValues: {
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8,
        fontSize: 11, color: TOK.label2, fontVariantNumeric: 'tabular-nums',
      },
      legend: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 10, color: TOK.label2 },
      legendItem: { display: 'inline-flex', alignItems: 'center', gap: 4 },
      legendSwatch: { width: 8, height: 8, borderRadius: 2, display: 'inline-block' },
      scrollBox: {
        position: 'relative', maxHeight: 286, overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', flexDirection: 'column', gap: 0,
        border: '1px solid ' + TOK.border1, borderRadius: 10, background: TOK.bg2,
        padding: '2px 8px',
      },
      eventRow: {
        display: 'grid', gridTemplateColumns: '58px 54px minmax(0,1fr)', gap: 8,
        alignItems: 'baseline', padding: '5px 0',
        borderBottom: '1px solid ' + TOK.border1, fontSize: 11,
      },
      eventTime: { fontFamily: MONO, fontSize: 10, color: TOK.caption, opacity: 0.75, fontVariantNumeric: 'tabular-nums' },
      eventKind: { fontSize: 10, fontWeight: 700, letterSpacing: '0.03em', whiteSpace: 'nowrap' },
      eventText: { minWidth: 0, overflowWrap: 'anywhere', color: TOK.label1 },
      eventMeta: { color: TOK.caption, opacity: 0.75, fontSize: 10 },
      recentList: { display: 'flex', flexDirection: 'column', gap: 5, margin: 0, padding: 0, listStyle: 'none' },
      recentItem: {
        display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap',
        padding: '5px 8px', borderRadius: 8, background: TOK.bg2, border: '1px solid ' + TOK.border1,
        fontSize: 11,
      },
      recentReason: { fontWeight: 700, fontSize: 10, whiteSpace: 'nowrap' },
      recentText: { flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: TOK.label1 },
      recentMeta: { color: TOK.caption, opacity: 0.75, fontSize: 10 },
      centerRow: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 0' },
      spinDot: { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', border: '2px solid ' + TOK.border3, borderTopColor: TOK.brand },
      scrollHint: {
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '1px 7px', borderRadius: 999, fontSize: 10,
        border: '1px solid ' + TOK.border1, background: TOK.bg2, color: TOK.label2,
      },
    }

    // ---------------------------------------------------------------- helpers

    /** Narrow to a plain record; arrays and primitives become null. */
    function asRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function numOr(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    function intOr(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
    }

    function strOr(value, fallback) {
      return typeof value === 'string' ? value : fallback
    }

    function boolOr(value, fallback) {
      return typeof value === 'boolean' ? value : fallback
    }

    function pick(value, allowed, fallback) {
      return allowed.indexOf(value) >= 0 ? value : fallback
    }

    function clamp01(value) {
      const number = numOr(value, 0)
      return number < 0 ? 0 : number > 1 ? 1 : number
    }

    /** Count-shaped fields tolerate a number or an id list. */
    function countValue(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
      if (Array.isArray(value)) return value.length
      return 0
    }

    /** Display a nullable epoch value. */
    function optionalNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
    }

    /** Translate `key`, falling back when the dictionary has no such entry. */
    function tOr(t, key, fallback) {
      try {
        const value = t(key)
        if (typeof value === 'string' && value !== key && value !== NS + '.' + key && value !== '') return value
      } catch { /* a broken locale must not break rendering */ }
      return fallback
    }

    /** Human-readable message for a rejected fetch/JSON parse. */
    function errorTextOf(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return error
      const record = asRecord(error)
      if (record !== null) {
        if (record.name === 'AbortError') return 'timeout'
        if (strOr(record.message, '') !== '') return record.message
      }
      return 'request failed'
    }

    /** Structural narrow of the compare block; null means "not measured". */
    function normalizeCompareSide(raw) {
      const side = asRecord(raw)
      if (side === null) return { p50Ms: null, p95Ms: null }
      return { p50Ms: optionalNumber(side.p50Ms), p95Ms: optionalNumber(side.p95Ms) }
    }

    function normalizeWorker(raw, index) {
      const worker = asRecord(raw) || {}
      const tokens = asRecord(worker.tokens) || {}
      return {
        id: strOr(worker.id, 'w-' + String(index + 1).padStart(2, '0')),
        ticketId: strOr(worker.ticketId, ''),
        threadId: strOr(worker.threadId, ''),
        title: strOr(worker.title, ''),
        status: pick(worker.status, WORKER_STATUSES, 'queued'),
        source: strOr(worker.source, ''),
        cwd: strOr(worker.cwd, ''),
        startedAt: numOr(worker.startedAt, 0),
        endedAt: optionalNumber(worker.endedAt),
        elapsedMs: Math.max(0, numOr(worker.elapsedMs, 0)),
        progress: clamp01(worker.progress),
        lastProgressAt: numOr(worker.lastProgressAt, 0),
        turns: Math.max(0, intOr(worker.turns, 0)),
        steps: Math.max(0, intOr(worker.steps, 0)),
        toolCalls: Math.max(0, intOr(worker.toolCalls, 0)),
        tokens: {
          in: Math.max(0, intOr(tokens.in, 0)),
          out: Math.max(0, intOr(tokens.out, 0)),
          cacheRead: Math.max(0, intOr(tokens.cacheRead, 0)),
        },
        model: strOr(worker.model, ''),
        branch: strOr(worker.branch, ''),
        deliveryStatus: strOr(asRecord(worker.delivery)?.status, ''),
        replied: asRecord(worker.reply)?.ok === true,
        summary: strOr(worker.summary, ''),
        stalled: boolOr(worker.stalled, false),
        simulated: boolOr(worker.simulated, false),
        attentionCost: Math.max(0, numOr(worker.attentionCost, 0)),
        sessionId: strOr(worker.sessionId, ''),
      }
    }

    function normalizeThread(raw, index) {
      const thread = asRecord(raw) || {}
      return {
        id: strOr(thread.id, 'th-' + String(index + 1)),
        title: strOr(thread.title, ''),
        source: strOr(thread.source, ''),
        updatedAt: numOr(thread.updatedAt, 0),
        messages: Math.max(0, intOr(thread.messages, 0)),
        subscribers: asArray(thread.subscribers).filter((id) => typeof id === 'string'),
        directDeliveries: Math.max(0, intOr(thread.directDeliveries, 0)),
        routerBypassed: Math.max(0, intOr(thread.routerBypassed, 0)),
      }
    }

    function normalizeEvent(raw) {
      const event = asRecord(raw)
      if (event === null) return null
      const kind = pick(event.kind, EVENT_KINDS, 'progress')
      return {
        t: numOr(event.t, 0),
        kind,
        level: pick(event.level, SIGNAL_LEVELS, 'info'),
        text: strOr(event.text, ''),
        workerId: typeof event.workerId === 'string' ? event.workerId : '',
        threadId: typeof event.threadId === 'string' ? event.threadId : '',
      }
    }

    function normalizeFinding(raw) {
      const finding = asRecord(raw)
      if (finding === null) return null
      return {
        at: numOr(finding.at, 0),
        workerId: typeof finding.workerId === 'string' ? finding.workerId : '',
        kind: strOr(finding.kind, 'other'),
        text: strOr(finding.text, ''),
      }
    }

    function normalizeRecent(raw) {
      const recent = asRecord(raw)
      if (recent === null) return null
      return {
        at: numOr(recent.at, 0),
        reason: strOr(recent.reason, 'other'),
        text: strOr(recent.text, ''),
        workerId: typeof recent.workerId === 'string' ? recent.workerId : '',
      }
    }

    function normalizeReasonCounts(raw) {
      const reasons = asRecord(raw) || {}
      const counts = {}
      for (const reason of REASONS) counts[reason] = Math.max(0, intOr(reasons[reason], 0))
      return counts
    }

    function normalizeFunnel(raw, admission) {
      const entries = asArray(raw)
      const stages = []
      for (const entry of entries) {
        const stage = asRecord(entry)
        if (stage === null) continue
        const key = pick(stage.stage, FUNNEL_STAGES, '')
        if (key === '') continue
        stages.push({
          stage: key,
          label: strOr(stage.label, ''),
          count: Math.max(0, intOr(stage.count, 0)),
        })
        if (stages.length >= 4) break
      }
      if (stages.length > 0) return stages
      // Older/partial snapshots may omit `funnel`; derive it from the counters.
      return [
        { stage: 'raw', label: '', count: Math.max(0, intOr(admission.received, 0)) },
        { stage: 'fast', label: '', count: Math.max(0, intOr(admission.semanticCandidates, 0)) },
        { stage: 'semantic', label: '', count: Math.max(0, intOr(admission.accepted, 0)) },
        { stage: 'dispatched', label: '', count: Math.max(0, intOr(admission.dispatched, 0)) },
      ]
    }

    function normalizeRule(raw) {
      const rule = asRecord(raw)
      if (rule === null) return null
      return {
        id: strOr(rule.id, ''),
        name: strOr(rule.name, ''),
        hits: Math.max(0, intOr(rule.hits, 0)),
        instruction: strOr(rule.instruction, ''),
      }
    }

    /** Normalize one wire snapshot; an unusable payload returns null so the caller keeps the previous one. */
    function normalizeState(raw) {
      const root = asRecord(raw)
      if (root === null) return null

      const mode = asRecord(root.mode) || {}
      const config = asRecord(root.config) || {}
      const health = asRecord(root.health) || {}
      const router = asRecord(root.router) || {}
      const admission = asRecord(root.admission) || {}
      const watchdog = asRecord(root.watchdog) || {}
      const attention = asRecord(root.attention) || {}
      const metrics = asRecord(root.metrics) || {}
      const compare = asRecord(root.compare) || {}

      const startedAt = numOr(root.startedAt, 0)
      const now = numOr(root.now, Date.now())
      let uptimeMs = Math.max(0, numOr(root.uptimeMs, 0))
      if (uptimeMs === 0 && startedAt > 0 && now > startedAt) uptimeMs = now - startedAt

      const workers = []
      for (const entry of asArray(root.workers)) {
        const worker = normalizeWorker(entry, workers.length)
        workers.push(worker)
        if (workers.length >= 24) break
      }

      const threads = []
      for (const entry of asArray(root.threads)) {
        threads.push(normalizeThread(entry, threads.length))
        if (threads.length >= 24) break
      }

      const events = []
      for (const entry of asArray(root.events)) {
        const event = normalizeEvent(entry)
        if (event !== null) events.push(event)
        if (events.length >= 200) break
      }
      events.sort((left, right) => left.t - right.t)

      const findings = []
      for (const entry of asArray(watchdog.findings)) {
        const finding = normalizeFinding(entry)
        if (finding !== null) findings.push(finding)
        if (findings.length >= 20) break
      }

      const recent = []
      for (const entry of asArray(attention.recent)) {
        const item = normalizeRecent(entry)
        if (item !== null) recent.push(item)
        if (recent.length >= 10) break
      }

      const rules = []
      for (const entry of asArray(admission.rules)) {
        const rule = normalizeRule(entry)
        if (rule !== null) rules.push(rule)
        if (rules.length >= 12) break
      }

      const timeline = []
      for (const entry of asArray(root.timeline)) {
        const point = asRecord(entry)
        if (point === null) continue
        timeline.push({ t: numOr(point.t, 0), kind: pick(point.kind, EVENT_KINDS, 'progress') })
        if (timeline.length >= 400) break
      }

      return {
        schema: intOr(root.schema, 1),
        now,
        startedAt,
        uptimeMs,
        mode: {
          accept: mode.accept === 'accept' ? 'accept' : 'observe',
          paused: boolOr(mode.paused, false),
          runner: mode.runner === 'session' ? 'session' : 'simulate',
        },
        config: {
          maxWorkers: Math.max(1, intOr(config.maxWorkers, 4)),
          watchdogIntervalMs: Math.max(0, intOr(config.watchdogIntervalMs, 0)),
          staleAfterMs: Math.max(0, intOr(config.staleAfterMs, 0)),
          routerModel: strOr(config.routerModel, ''),
          workerModel: strOr(config.workerModel, ''),
        },
        health: {
          state: pick(health.state, HEALTH_STATES, 'ready'),
          note: strOr(health.note, ''),
        },
        router: {
          decisions: Math.max(0, intOr(router.decisions, 0)),
          batches: Math.max(0, intOr(router.batches, 0)),
          avgBatch: Math.max(0, numOr(router.avgBatch, 0)),
          avgDecisionMs: Math.max(0, numOr(router.avgDecisionMs, 0)),
          lastDecisionAt: numOr(router.lastDecisionAt, 0),
          model: strOr(router.model, ''),
          semanticCalls: Math.max(0, intOr(router.semanticCalls, 0)),
          semanticFailures: Math.max(0, intOr(router.semanticFailures, 0)),
        },
        admission: {
          received: Math.max(0, intOr(admission.received, 0)),
          fastPathBlocked: Math.max(0, intOr(admission.fastPathBlocked, 0)),
          semanticCandidates: Math.max(0, intOr(admission.semanticCandidates, 0)),
          semanticRejected: Math.max(0, intOr(admission.semanticRejected, 0)),
          accepted: Math.max(0, intOr(admission.accepted, 0)),
          dispatched: Math.max(0, intOr(admission.dispatched, 0)),
          ratePerMin: Math.max(0, numOr(admission.ratePerMin, 0)),
          funnel: normalizeFunnel(admission.funnel, admission),
          rules,
        },
        workers,
        threads,
        watchdog: {
          state: pick(watchdog.state, WATCHDOG_STATES, 'ok'),
          checks: Math.max(0, intOr(watchdog.checks, 0)),
          lastCheckAt: numOr(watchdog.lastCheckAt, 0),
          stalled: countValue(watchdog.stalled),
          loops: countValue(watchdog.loops),
          drift: countValue(watchdog.drift),
          findings,
        },
        attention: {
          emitted: Math.max(0, intOr(attention.emitted, 0)),
          suppressed: Math.max(0, intOr(attention.suppressed, 0)),
          budget: clamp01(attention.budget),
          ratio: Math.max(0, numOr(attention.ratio, 0)),
          reasons: normalizeReasonCounts(attention.reasons),
          recent,
        },
        metrics: {
          completed: Math.max(0, intOr(metrics.completed, 0)),
          p50Ms: optionalNumber(metrics.p50Ms),
          p95Ms: optionalNumber(metrics.p95Ms),
          avgMs: optionalNumber(metrics.avgMs),
          routerDecisions: Math.max(0, intOr(metrics.routerDecisions, 0)),
          cacheReadTokens: Math.max(0, intOr(metrics.cacheReadTokens, 0)),
          sessions: Math.max(0, intOr(metrics.sessions, 0)),
          savedMinutes: Math.max(0, intOr(metrics.savedMinutes, 0)),
        },
        events,
        timeline,
        compare: {
          super: normalizeCompareSide(compare.super),
          single: normalizeCompareSide(compare.single),
        },
      }
    }

    // ------------------------------------------------------------- formatting

    const INT_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
    const DECIMAL_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })

    function formatInt(value) {
      const number = numOr(value, 0)
      try {
        return INT_FORMAT.format(number)
      } catch {
        return String(Math.round(number))
      }
    }

    function formatDecimal(value, digits) {
      const number = numOr(value, 0)
      try {
        return new Intl.NumberFormat('zh-CN', {
          minimumFractionDigits: 0,
          maximumFractionDigits: digits === undefined ? 1 : digits,
        }).format(number)
      } catch {
        return String(Math.round(number * 10) / 10)
      }
    }

    function formatRatio(value) {
      const number = numOr(value, NaN)
      if (!Number.isFinite(number)) return '—'
      return formatDecimal(number, number >= 100 ? 0 : 2)
    }

    function formatCompact(value) {
      const number = numOr(value, 0)
      const magnitude = Math.abs(number)
      if (magnitude >= 1e9) return formatDecimal(number / 1e9, 1) + 'B'
      if (magnitude >= 1e6) return formatDecimal(number / 1e6, 1) + 'M'
      if (magnitude >= 1e3) return formatDecimal(number / 1e3, 1) + 'K'
      return formatInt(number)
    }

    function formatDuration(ms, t) {
      const value = numOr(ms, -1)
      if (!(value >= 0)) return t('common.none')
      if (value < 1000) return formatInt(Math.round(value)) + t('unit.ms')
      const totalSeconds = Math.round(value / 1000)
      if (totalSeconds < 60) return formatInt(totalSeconds) + t('unit.s')
      if (totalSeconds < 3600) {
        const minutes = Math.floor(totalSeconds / 60)
        const seconds = totalSeconds % 60
        return formatInt(minutes) + t('unit.m') + (seconds > 0 ? ' ' + formatInt(seconds) + t('unit.s') : '')
      }
      if (totalSeconds < 86400) {
        const hours = Math.floor(totalSeconds / 3600)
        const minutes = Math.floor((totalSeconds % 3600) / 60)
        return formatInt(hours) + t('unit.h') + (minutes > 0 ? ' ' + formatInt(minutes) + t('unit.m') : '')
      }
      const days = Math.floor(totalSeconds / 86400)
      const hours = Math.floor((totalSeconds % 86400) / 3600)
      return formatInt(days) + t('unit.d') + (hours > 0 ? ' ' + formatInt(hours) + t('unit.h') : '')
    }

    /** p50/p95 are reported in minutes on the console. */
    function formatMinutes(ms, t) {
      const value = numOr(ms, -1)
      if (!(value >= 0)) return t('metrics.untested')
      const minutes = value / 60000
      return formatDecimal(minutes, minutes >= 100 ? 0 : 1) + ' ' + t('unit.min')
    }

    function formatClock(timestamp) {
      const value = numOr(timestamp, 0)
      if (value <= 0) return ''
      try {
        return new Date(value).toLocaleTimeString('zh-CN', {
          hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
        })
      } catch {
        return ''
      }
    }

    function formatAgo(timestamp, nowMs, t) {
      const value = numOr(timestamp, 0)
      if (value <= 0) return ''
      const nowValue = numOr(nowMs, Date.now())
      const diff = Math.max(0, nowValue - value)
      if (diff < 5000) return t('common.now')
      if (diff < 60000) return formatInt(Math.round(diff / 1000)) + t('unit.s') + t('common.ago')
      if (diff < 3600000) return formatInt(Math.round(diff / 60000)) + t('unit.m') + t('common.ago')
      if (diff < 86400000) return formatInt(Math.round(diff / 3600000)) + t('unit.h') + t('common.ago')
      return formatInt(Math.round(diff / 86400000)) + t('unit.d') + t('common.ago')
    }

    function clipText(value, max) {
      const text = strOr(value, '')
      if (text.length <= max) return text
      return text.slice(0, Math.max(0, max - 1)) + '…'
    }

    function workerColor(status, stalled) {
      if (stalled) return TOK.error
      if (status === 'running') return TOK.success
      if (status === 'failed') return TOK.error
      if (status === 'done') return TOK.business
      if (status === 'queued') return TOK.warn
      return TOK.idle
    }

    function healthColor(state) {
      if (state === 'error' || state === 'alert') return TOK.error
      if (state === 'warn') return TOK.warn
      return TOK.success
    }

    function reasonColor(reason) {
      if (reason === 'failed') return TOK.error
      if (reason === 'decision-needed') return TOK.warn
      if (reason === 'result-ready') return TOK.success
      if (reason === 'progress') return TOK.business
      return TOK.idle
    }

    function kindColor(kind) {
      if (kind === 'error' || kind === 'reject') return TOK.error
      if (kind === 'attention' || kind === 'watchdog') return TOK.warn
      if (kind === 'admit' || kind === 'progress' || kind === 'result') return TOK.success
      if (kind === 'batch' || kind === 'dispatch') return TOK.business
      if (kind === 'mode') return TOK.idle
      return TOK.brand
    }

    function formatTokens(tokens, t) {
      const parts = []
      parts.push('↓ ' + formatCompact(tokens.in))
      parts.push('↑ ' + formatCompact(tokens.out))
      if (tokens.cacheRead > 0) parts.push(t('worker.cacheRead') + ' ' + formatCompact(tokens.cacheRead))
      return parts.join(' · ')
    }

    // -------------------------------------------------------------- data hook

    function useConsoleState() {
      const [snapshot, setSnapshot] = React.useState({
        status: 'loading', data: null, error: '', updatedAt: 0,
      })
      const [command, setCommand] = React.useState({ busy: '', errorCode: '', errorText: '', done: '' })
      const [generation, setGeneration] = React.useState(0)
      const alive = React.useRef(true)
      const commandTimer = React.useRef(null)

      React.useEffect(() => () => {
        alive.current = false
        if (commandTimer.current !== null) clearTimeout(commandTimer.current)
      }, [])

      const refresh = React.useCallback(() => {
        setGeneration((value) => value + 1)
      }, [])

      React.useEffect(() => {
        let disposed = false
        let timer = 0
        let timeout = 0
        let controller = null
        let inFlight = false

        const schedule = () => {
          if (disposed) return
          const delay = typeof document !== 'undefined' && document.hidden ? POLL_HIDDEN_MS : POLL_MS
          timer = window.setTimeout(load, delay)
        }

        const settle = (ok, payload, message) => {
          if (timeout !== 0) {
            clearTimeout(timeout)
            timeout = 0
          }
          inFlight = false
          controller = null
          if (disposed) return
          if (ok) {
            setSnapshot({ status: 'online', data: payload, error: '', updatedAt: Date.now() })
          } else {
            setSnapshot((previous) => ({
              status: 'offline',
              data: previous.data,
              error: message,
              updatedAt: previous.updatedAt,
            }))
          }
          schedule()
        }

        const load = () => {
          if (disposed || inFlight) return
          inFlight = true
          if (typeof window.fetch !== 'function') {
            settle(false, null, 'fetch unavailable')
            return
          }
          const supportsAbort = typeof AbortController === 'function'
          controller = supportsAbort ? new AbortController() : null
          if (supportsAbort) {
            timeout = window.setTimeout(() => {
              try {
                controller.abort()
              } catch { /* already settled */ }
            }, FETCH_TIMEOUT_MS)
          }
          const init = { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } }
          if (controller !== null) init.signal = controller.signal
          window.fetch(STATE_URL, init)
            .then((response) => {
              if (!response || typeof response.json !== 'function') throw new Error('invalid state response')
              if (response.ok === false) throw new Error('HTTP ' + String(response.status))
              return response.json()
            })
            .then((payload) => {
              const data = normalizeState(payload)
              if (data === null) throw new Error('invalid state shape')
              settle(true, data, '')
            })
            .catch((error) => {
              settle(false, null, errorTextOf(error))
            })
        }

        const onVisibility = () => {
          if (disposed) return
          if (typeof document !== 'undefined' && document.hidden) return
          if (timer !== 0) {
            clearTimeout(timer)
            timer = 0
          }
          load()
        }

        load()
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibility)
        }
        return () => {
          disposed = true
          if (timer !== 0) clearTimeout(timer)
          if (timeout !== 0) clearTimeout(timeout)
          if (controller !== null) {
            try {
              controller.abort()
            } catch { /* ignore */ }
          }
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }
      }, [generation])

      const clearCommandSoon = () => {
        if (commandTimer.current !== null) clearTimeout(commandTimer.current)
        commandTimer.current = window.setTimeout(() => {
          if (!alive.current) return
          setCommand({ busy: '', errorCode: '', errorText: '', done: '' })
        }, 7000)
      }

      const runCommand = React.useCallback((name, args) => {
        if (typeof window.fetch !== 'function') {
          setCommand({ busy: '', errorCode: 'network', errorText: 'fetch unavailable', done: '' })
          return
        }
        setCommand({ busy: name, errorCode: '', errorText: '', done: '' })
        const supportsAbort = typeof AbortController === 'function'
        const controller = supportsAbort ? new AbortController() : null
        let timeout = 0
        if (supportsAbort) {
          timeout = window.setTimeout(() => {
            try {
              controller.abort()
            } catch { /* ignore */ }
          }, COMMAND_TIMEOUT_MS)
        }
        const finish = (next) => {
          if (timeout !== 0) clearTimeout(timeout)
          if (!alive.current) return
          setCommand(next)
          clearCommandSoon()
        }
        const init = {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ command: name, args: args === undefined ? {} : args }),
        }
        if (controller !== null) init.signal = controller.signal
        window.fetch(COMMAND_URL, init)
          .then((response) => Promise.resolve()
            .then(() => (typeof response.json === 'function' ? response.json() : null))
            .catch(() => null)
            .then((payload) => {
              const body = asRecord(payload)
              if (response.ok === false) {
                throw new Error(strOr(body === null ? null : body.error, 'HTTP ' + String(response.status)))
              }
              if (body !== null && body.ok === false) {
                throw new Error(strOr(body.error, 'command rejected'))
              }
              return payload
            }))
          .then(() => {
            finish({ busy: '', errorCode: '', errorText: '', done: name })
            setGeneration((value) => value + 1)
          })
          .catch((error) => {
            const text = errorTextOf(error)
            const code = text === 'timeout' ? 'timeout' : text === 'fetch unavailable' ? 'network' : 'failed'
            finish({ busy: '', errorCode: code, errorText: text, done: '' })
          })
      }, [])

      return { snapshot, command, refresh, runCommand }
    }

    // ---------------------------------------------------------- UI primitives

    /** Keep one broken block from blanking the console; the retry resets only this subtree. */
    class BlockBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
        this.retry = () => { this.setState({ failed: false }) }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      render() {
        if (this.state.failed) {
          const t = typeof this.props.t === 'function' ? this.props.t : (key) => key
          return h('div', { style: styles.errorCard, role: 'alert' },
            h('span', { style: styles.errorLabel }, t('block.failed')),
            h('button', { type: 'button', style: styles.button, onClick: this.retry }, t('block.retry')))
        }
        return this.props.children
      }
    }

    /** Page-level containment so an unexpected render failure never blanks the whole app. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
        this.retry = () => { this.setState({ failed: false }) }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      render() {
        if (this.state.failed) {
          const t = typeof this.props.t === 'function' ? this.props.t : (key) => key
          return h('div', { style: { ...styles.root, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
            h('div', { style: styles.errorCard, role: 'alert' },
              h('span', { style: styles.errorLabel }, t('boundary.failed')),
              h('button', { type: 'button', style: styles.button, onClick: this.retry }, t('boundary.retry'))))
        }
        return this.props.children
      }
    }

    function Section({ t, title, hint, actions, children, ariaLabel }) {
      return h('section', {
        style: styles.card,
        'aria-label': ariaLabel === undefined ? title : ariaLabel,
      },
        h('div', { style: styles.sectionHead },
          h('span', { style: styles.sectionTitle }, title),
          hint === undefined || hint === '' ? null : h('span', { style: styles.sectionHint }, hint),
          actions === undefined ? null : h('div', { style: styles.sectionActions }, actions)),
        h(BlockBoundary, { t }, children))
    }

    function StatusChip({ label, value, color }) {
      const titleText = typeof value === 'string' || typeof value === 'number' ? label + ': ' + value : label
      return h('span', { style: styles.chip, title: titleText },
        h('span', { style: styles.chipLabel }, label),
        h('span', { style: color === undefined ? styles.chipValue : { ...styles.chipValue, color } }, value))
    }

    function Pill({ color, text }) {
      return h('span', { style: styles.pill },
        color === undefined ? null : h('span', { style: { ...styles.dot, background: color } }),
        h('span', null, text))
    }

    function ActionButton({ t, tone, onClick, disabled, title, children }) {
      const base = tone === 'primary' ? styles.buttonPrimary : tone === 'danger' ? styles.buttonDanger : styles.button
      const style = disabled ? { ...base, cursor: 'default', opacity: 0.55 } : base
      return h('button', {
        type: 'button',
        style,
        disabled: disabled === true,
        onClick: disabled === true ? undefined : onClick,
        title: title === undefined ? undefined : title,
      }, children)
    }

    function Segmented({ value, options, onChange, label }) {
      return h('div', { style: styles.segmented, role: 'group', 'aria-label': label },
        options.map((option) => h('button', {
          key: option.id,
          type: 'button',
          style: value === option.id ? styles.segmentOn : styles.segment,
          'aria-pressed': value === option.id,
          onClick: () => onChange(option.id),
        }, option.text)))
    }

    function ProgressRing({ size, stroke, fraction, color }) {
      const radius = (size - stroke) / 2
      const circumference = 2 * Math.PI * radius
      const clamped = clamp01(fraction)
      const center = size / 2
      return h('svg', {
        width: size, height: size, viewBox: '0 0 ' + String(size) + ' ' + String(size), 'aria-hidden': true,
      },
        h('circle', {
          cx: center, cy: center, r: radius,
          style: { fill: 'none', stroke: TOK.border2 },
          strokeWidth: stroke,
        }),
        h('circle', {
          cx: center, cy: center, r: radius,
          style: { fill: 'none', stroke: color },
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeDasharray: String(circumference * clamped) + ' ' + String(circumference),
          transform: 'rotate(-90 ' + String(center) + ' ' + String(center) + ')',
        }))
    }

    function LiveUptime({ baseMs, at, t }) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [])
      const extra = at > 0 && now > at ? now - at : 0
      return h('span', null, formatDuration(Math.max(0, numOr(baseMs, 0) + extra), t))
    }

    function EmptyState({ t, text }) {
      return h('div', { style: styles.centerRow }, h('p', { style: styles.empty }, text))
    }

    // ------------------------------------------------------------- topology

    /** One SVG text node with the shared token palette. */
    function svgText(x, y, content, options) {
      const opts = options || {}
      const style = {
        fill: opts.color === undefined ? TOK.label1 : opts.color,
        fontSize: opts.size === undefined ? 11 : opts.size,
        fontFamily: opts.mono === true ? MONO : FONT,
        fontWeight: opts.weight === undefined ? 400 : opts.weight,
      }
      if (opts.opacity !== undefined) style.opacity = opts.opacity
      else if (opts.color === TOK.label3 || opts.color === TOK.caption) style.opacity = 0.75
      const props = {
        x,
        y,
        style,
        textAnchor: opts.anchor === undefined ? 'start' : opts.anchor,
      }
      // A caller may pass an explicit key; otherwise derive a stable one, because these nodes are
      // also pushed into arrays that React renders as child lists.
      props.key = opts.key === undefined ? 'tx-' + String(x) + '-' + String(y) + '-' + String(content).slice(0, 24) : opts.key
      return h('text', props, content)
    }

    /**
     * Live architecture diagram: Router → two-stage admission → thread axis →
     * worker lanes → attention gate. Every node is fed from the normalized
     * state; trigger dots animate along the actual request path.
     */
    function TopologyPanel({ t, data }) {
      // Lane budget: a long history must not turn the diagram into a wall of rows.
      const LANE_LIMIT = 8
      const workers = data.workers.slice(0, LANE_LIMIT)
      const hiddenWorkers = Math.max(0, data.workers.length - workers.length)
      const threads = data.threads.slice(0, 6)
      const router = data.router
      const admission = data.admission
      const attention = data.attention
      const watchdog = data.watchdog

      const W = 1000
      const laneTop = 58
      const laneGap = 54
      const laneH = 46
      const rows = Math.max(workers.length, 2)
      const gateY = laneTop + rows * laneGap + 8
      const gateH = 36
      const gateCY = gateY + gateH / 2
      const H = gateY + gateH + 26

      const routerBox = { x: 12, y: laneTop + 2, w: 148, h: 92 }
      const admBox = { x: 184, y: laneTop + 16, w: 118, h: 62 }
      const axisX = 500
      const workerX = 566
      const workerW = 422
      const gateW = workerW

      const laneYs = []
      for (let index = 0; index < workers.length; index += 1) laneYs.push(laneTop + index * laneGap)
      const laneCenter = (index) => (laneYs[index] === undefined ? laneTop + 20 : laneYs[index] + laneH / 2)

      const spanTop = laneTop + 4
      const spanBottom = laneTop + Math.max(rows, 1) * laneGap - laneGap + laneH - 4
      const visibleThreads = threads
      const threadYs = []
      if (visibleThreads.length > 0) {
        for (let index = 0; index < visibleThreads.length; index += 1) {
          threadYs.push(visibleThreads.length === 1
            ? (spanTop + spanBottom) / 2
            : spanTop + (index * (spanBottom - spanTop)) / (visibleThreads.length - 1))
        }
      }

      const routerMidY = routerBox.y + routerBox.h / 2
      const admMidY = admBox.y + admBox.h / 2
      const routerRight = routerBox.x + routerBox.w
      const admRight = admBox.x + admBox.w

      const focusIndex = (() => {
        for (let index = 0; index < workers.length; index += 1) {
          if (workers[index].status === 'running' && !workers[index].stalled) return index
        }
        for (let index = 0; index < workers.length; index += 1) {
          if (workers[index].status === 'running') return index
        }
        return workers.length > 0 ? 0 : -1
      })()
      const focusCY = focusIndex >= 0 ? laneCenter(focusIndex) : laneTop + 20

      let flowPath = 'M ' + String(routerRight) + ' ' + String(routerMidY)
        + ' C ' + String(routerRight + 14) + ' ' + String(routerMidY) + ', ' + String(admBox.x - 10) + ' ' + String(admMidY) + ', ' + String(admBox.x) + ' ' + String(admMidY)
        + ' C ' + String(admRight + 38) + ' ' + String(admMidY) + ', 430 ' + String(focusCY) + ', ' + String(workerX - 8) + ' ' + String(focusCY)
        + ' L ' + String(workerX + workerW) + ' ' + String(focusCY)
        + ' C ' + String(workerX + workerW + 16) + ' ' + String(focusCY) + ', ' + String(workerX + workerW + 20) + ' ' + String(gateCY - 14) + ', ' + String(workerX + workerW - 64) + ' ' + String(gateCY)

      const flowDots = []
      const begins = ['0s', '1.2s', '2.4s']
      for (let index = 0; index < begins.length; index += 1) {
        flowDots.push(h('circle', {
          key: 'flow-' + String(index),
          r: 3.4,
          style: { fill: TOK.brand, opacity: 0.9 },
        }, h('animateMotion', {
          dur: '3.6s',
          repeatCount: 'indefinite',
          path: flowPath,
          begin: begins[index],
        })))
      }

      // Extra trigger dots for every other running lane, so parallel work reads at a glance.
      const laneDots = []
      for (let index = 0; index < workers.length && laneDots.length < 2; index += 1) {
        const worker = workers[index]
        if (worker.status !== 'running' || index === focusIndex) continue
        const wy = laneCenter(index)
        const lanePath = 'M ' + String(admRight) + ' ' + String(admMidY)
          + ' C ' + String(admRight + 60) + ' ' + String(admMidY) + ', 440 ' + String(wy) + ', ' + String(workerX - 8) + ' ' + String(wy)
        laneDots.push(h('circle', {
          key: 'lane-dot-' + worker.id,
          r: 3,
          style: { fill: TOK.success, opacity: 0.85 },
        }, h('animateMotion', {
          dur: '2.4s',
          repeatCount: 'indefinite',
          path: lanePath,
          begin: '0.6s',
        })))
      }

      // Subscription edges: thread.subscribers ↔ worker.threadId.
      const workerIndexById = new Map()
      for (let index = 0; index < workers.length; index += 1) workerIndexById.set(workers[index].id, index)
      const threadIndexById = new Map()
      for (let index = 0; index < visibleThreads.length; index += 1) threadIndexById.set(visibleThreads[index].id, index)
      const edgeKeys = new Set()
      const edges = []
      const addEdge = (threadIndex, workerIndex) => {
        const key = String(threadIndex) + '-' + String(workerIndex)
        if (edgeKeys.has(key)) return
        edgeKeys.add(key)
        edges.push({ threadIndex, workerIndex })
      }
      for (let threadIndex = 0; threadIndex < visibleThreads.length; threadIndex += 1) {
        const thread = visibleThreads[threadIndex]
        for (const subscriber of thread.subscribers) {
          if (workerIndexById.has(subscriber)) addEdge(threadIndex, workerIndexById.get(subscriber))
        }
      }
      for (let workerIndex = 0; workerIndex < workers.length; workerIndex += 1) {
        const threadId = workers[workerIndex].threadId
        if (threadIndexById.has(threadId)) addEdge(threadIndexById.get(threadId), workerIndex)
      }
      const subscriptionLines = edges.slice(0, 14).map((edge) => {
        const ty = threadYs[edge.threadIndex]
        const wy = laneCenter(edge.workerIndex)
        const path = 'M ' + String(axisX) + ' ' + String(ty)
          + ' C ' + String(axisX + 26) + ' ' + String(ty) + ', ' + String(workerX - 44) + ' ' + String(wy) + ', ' + String(workerX - 4) + ' ' + String(wy)
        return h('path', {
          key: 'edge-' + String(edge.threadIndex) + '-' + String(edge.workerIndex),
          d: path,
          className: 'sa-dash',
          style: { fill: 'none', stroke: TOK.brand, strokeWidth: 1, opacity: 0.5 },
        })
      })

      // Faint wiring from admission to every lane.
      const laneWiring = []
      for (let index = 0; index < workers.length; index += 1) {
        const wy = laneCenter(index)
        const path = 'M ' + String(admRight) + ' ' + String(admMidY)
          + ' C ' + String(admRight + 46) + ' ' + String(admMidY) + ', 448 ' + String(wy) + ', ' + String(workerX - 6) + ' ' + String(wy)
        laneWiring.push(h('path', {
          key: 'wire-' + workers[index].id,
          d: path,
          style: { fill: 'none', stroke: TOK.border3, strokeWidth: 1, opacity: 0.75 },
        }))
      }

      const workerNodes = []
      for (let index = 0; index < workers.length; index += 1) {
        const worker = workers[index]
        const y = laneYs[index]
        const color = workerColor(worker.status, worker.stalled)
        const statusText = tOr(t, 'status.' + worker.status, worker.status)
        const progressText = Math.round(worker.progress * 100) + '%'
        const tooltip = [
          worker.id + (worker.title === '' ? '' : ' · ' + worker.title),
          t('status.' + worker.status) + ' · ' + t('worker.progress') + ' ' + progressText,
          t('worker.elapsed') + ' ' + formatDuration(worker.elapsedMs, t),
          t('worker.tokens') + ' ' + formatTokens(worker.tokens, t),
          worker.threadId === '' ? '' : t('worker.thread') + ' ' + worker.threadId,
          worker.model === '' ? '' : t('worker.model') + ' ' + worker.model,
          worker.summary === '' ? '' : t('worker.summary') + ' ' + worker.summary,
        ].filter((line) => line !== '').join('\n')

        const children = []
        children.push(h('title', { key: 'title' }, tooltip))
        if (worker.status === 'running' || worker.stalled) {
          children.push(h('rect', {
            key: 'halo',
            x: workerX - 3, y: y - 3, width: workerW + 6, height: laneH + 6, rx: 13,
            className: worker.stalled ? 'sa-shake' : 'sa-pulse',
            style: { fill: 'none', stroke: color, strokeWidth: 1.3, opacity: 0.85 },
          }))
        }
        children.push(h('rect', {
          key: 'card',
          x: workerX, y, width: workerW, height: laneH, rx: 10,
          style: { fill: TOK.bg2, stroke: worker.stalled ? TOK.error : TOK.border2, strokeWidth: 1 },
        }))
        children.push(h('rect', {
          key: 'stripe',
          x: workerX, y: y + 1, width: 3.5, height: laneH - 2, rx: 1.5,
          style: { fill: color },
        }))
        children.push(svgText(workerX + 12, y + 15, worker.id, {
          mono: true, size: 10.5, weight: 700, color,
        }))
        if (worker.simulated) {
          children.push(svgText(workerX + 12 + worker.id.length * 6.4 + 10, y + 15, t('worker.simulated'), {
            size: 9, color: TOK.caption,
          }))
        }
        children.push(svgText(workerX + workerW - 10, y + 15, statusText, {
          anchor: 'end', size: 10, weight: 600, color,
        }))
        children.push(svgText(workerX + 12, y + 28, clipText(worker.title === '' ? '—' : worker.title, 52), {
          size: 11, weight: 600, color: TOK.label1,
        }))
        const metaParts = [formatDuration(worker.elapsedMs, t)]
        if (worker.turns > 0) metaParts.push(String(worker.turns) + t('worker.turns'))
        if (worker.steps > 0) metaParts.push(String(worker.steps) + t('worker.steps'))
        if (worker.toolCalls > 0) metaParts.push(String(worker.toolCalls) + t('worker.toolCalls'))
        children.push(svgText(workerX + 12, y + 40, clipText(metaParts.join(' · '), 60), {
          size: 9, color: TOK.label3,
        }))
        if (worker.stalled) {
          children.push(svgText(workerX + workerW - 118, y + 40, t('worker.stalled'), {
            anchor: 'end', size: 9, weight: 700, color: TOK.error,
          }))
        }
        children.push(svgText(workerX + workerW - 10, y + 40, progressText, {
          anchor: 'end', size: 9, color,
        }))
        const barWidth = workerW - 24
        children.push(h('rect', {
          key: 'bar-track',
          x: workerX + 12, y: y + laneH - 4.5, width: barWidth, height: 2, rx: 1,
          style: { fill: TOK.border2 },
        }))
        children.push(h('rect', {
          key: 'bar-fill',
          x: workerX + 12, y: y + laneH - 4.5, width: Math.max(0, barWidth * worker.progress), height: 2, rx: 1,
          style: { fill: color },
        }))
        workerNodes.push(h('g', { key: 'worker-' + worker.id }, children))
      }

      const threadNodes = []
      for (let index = 0; index < visibleThreads.length; index += 1) {
        const thread = visibleThreads[index]
        const ty = threadYs[index]
        const runningSubscriber = thread.subscribers.some((id) => {
          const workerIndex = workerIndexById.get(id)
          return workerIndex !== undefined && workers[workerIndex].status === 'running'
        })
        const accent = runningSubscriber ? TOK.success : TOK.brand
        const chipW = 132
        const chipX = axisX - 14 - chipW
        const tooltip = [
          thread.title === '' ? thread.id : thread.title,
          t('topo.subs') + ' ' + String(thread.subscribers.length) + ' · ' + String(thread.messages),
          thread.routerBypassed > 0 ? t('topo.bypass') + ' ' + String(thread.routerBypassed) : '',
        ].filter((line) => line !== '').join('\n')
        threadNodes.push(h('g', { key: 'thread-' + thread.id },
          h('title', null, tooltip),
          h('rect', {
            x: chipX, y: ty - 9, width: chipW, height: 18, rx: 6,
            style: { fill: TOK.bg2, stroke: TOK.border2, strokeWidth: 1 },
          }),
          svgText(chipX + 7, ty + 4, clipText(thread.title === '' ? thread.id : thread.title, 20), {
            size: 9.5, color: TOK.label2,
          }),
          h('circle', {
            cx: axisX, cy: ty, r: runningSubscriber ? 5 : 4,
            style: { fill: accent, stroke: TOK.bg1, strokeWidth: 1.2 },
          }),
          thread.subscribers.length === 0 ? null : svgText(axisX + 9, ty + 3, String(thread.subscribers.length), {
            size: 8.5, color: TOK.caption,
          })))
      }

      const health = healthColor(watchdog.state)
      const emitted = attention.emitted
      const suppressed = attention.suppressed
      const gateTotal = Math.max(1, emitted + suppressed)
      const gateBarW = 132
      const gateBarX = workerX + workerW - gateBarW - 12

      const admissionText = String(admission.received) + ' → ' + String(admission.dispatched)
      const routerModel = strOr(router.model, '') === '' ? t('common.none') : router.model

      const svgChildren = []
      svgChildren.push(h('text', { key: 'cap-router', x: routerBox.x + routerBox.w / 2, y: 22, textAnchor: 'middle', style: { fill: TOK.caption, opacity: 0.75, fontSize: 9.5, letterSpacing: '0.08em' } }, t('topo.router')))
      svgChildren.push(h('text', { key: 'cap-adm', x: admBox.x + admBox.w / 2, y: 22, textAnchor: 'middle', style: { fill: TOK.caption, opacity: 0.75, fontSize: 9.5, letterSpacing: '0.08em' } }, t('topo.admission')))
      svgChildren.push(h('text', { key: 'cap-axis', x: axisX, y: 22, textAnchor: 'middle', style: { fill: TOK.caption, opacity: 0.75, fontSize: 9.5, letterSpacing: '0.08em' } }, t('topo.threads')))
      svgChildren.push(h('text', { key: 'cap-workers', x: workerX + workerW / 2, y: 22, textAnchor: 'middle', style: { fill: TOK.caption, opacity: 0.75, fontSize: 9.5, letterSpacing: '0.08em' } }, t('topo.workers') + (hiddenWorkers > 0 ? ' +' + String(hiddenWorkers) : '')))

      // Wiring first so nodes and chips sit above it.
      for (let index = 0; index < laneWiring.length; index += 1) svgChildren.push(laneWiring[index])
      svgChildren.push(h('line', {
        key: 'axis-line',
        x1: axisX, y1: spanTop - 10, x2: axisX, y2: spanBottom + 10,
        style: { stroke: TOK.border3, strokeWidth: 1.5 },
      }))
      for (let index = 0; index < subscriptionLines.length; index += 1) svgChildren.push(subscriptionLines[index])
      for (let index = 0; index < flowDots.length; index += 1) svgChildren.push(flowDots[index])
      for (let index = 0; index < laneDots.length; index += 1) svgChildren.push(laneDots[index])

      // Router
      svgChildren.push(h('g', { key: 'router' },
        h('title', null, t('topo.router') + ' · ' + routerModel + '\n'
          + t('topo.decisions') + ' ' + String(router.decisions) + ' · ' + t('topo.batch') + ' ' + formatRatio(router.avgBatch)),
        h('rect', {
          x: routerBox.x, y: routerBox.y, width: routerBox.w, height: routerBox.h, rx: 12,
          style: { fill: TOK.bg2, stroke: TOK.border2, strokeWidth: 1 },
        }),
        h('rect', {
          x: routerBox.x, y: routerBox.y + 1, width: 3.5, height: routerBox.h - 2, rx: 1.5,
          style: { fill: TOK.brand },
        }),
        svgText(routerBox.x + 14, routerBox.y + 20, t('topo.router'), { size: 12, weight: 700 }),
        svgText(routerBox.x + 14, routerBox.y + 34, clipText(routerModel, 22), { size: 9, mono: true, color: TOK.label3 }),
        svgText(routerBox.x + 14, routerBox.y + 56, t('topo.decisions'), { size: 8.5, color: TOK.caption }),
        svgText(routerBox.x + 14, routerBox.y + 78, formatInt(router.decisions), { size: 19, weight: 700, color: TOK.label1 }),
        svgText(routerBox.x + 92, routerBox.y + 56, t('topo.batch'), { size: 8.5, color: TOK.caption }),
        svgText(routerBox.x + 92, routerBox.y + 70, formatRatio(router.avgBatch), { size: 13, weight: 600, color: TOK.label1 }),
        svgText(routerBox.x + 14, routerBox.y + 90, String(router.batches) + ' ' + t('topo.batches'), { size: 8, color: TOK.caption }),
        h('polygon', {
          points: String(admBox.x - 8) + ',' + String(admMidY - 4) + ' ' + String(admBox.x - 1) + ',' + String(admMidY) + ' ' + String(admBox.x - 8) + ',' + String(admMidY + 4),
          style: { fill: TOK.brand },
        })))

      // Admission
      svgChildren.push(h('g', { key: 'admission' },
        h('title', null, t('topo.admission') + '\n'
          + t('topo.received') + ' ' + String(admission.received)
          + ' · ' + t('funnel.fastBlocked') + ' ' + String(admission.fastPathBlocked)
          + ' · ' + t('funnel.rejected') + ' ' + String(admission.semanticRejected)
          + '\n' + t('funnel.perMin') + ' ' + formatRatio(admission.ratePerMin)),
        h('rect', {
          x: admBox.x, y: admBox.y, width: admBox.w, height: admBox.h, rx: 10,
          style: { fill: TOK.bg2, stroke: TOK.border3, strokeWidth: 1 },
        }),
        svgText(admBox.x + 10, admBox.y + 17, t('topo.admission'), { size: 10.5, weight: 700 }),
        svgText(admBox.x + 10, admBox.y + 33, admissionText, { size: 10, mono: true, color: TOK.label2 }),
        svgText(admBox.x + 10, admBox.y + 51, formatRatio(admission.ratePerMin) + ' ' + t('funnel.perMin'), { size: 8.5, color: TOK.caption })))

      // Threads
      for (let index = 0; index < threadNodes.length; index += 1) svgChildren.push(threadNodes[index])
      if (visibleThreads.length === 0) {
        svgChildren.push(svgText(axisX - 12, spanTop + 12, t('topo.noThreads'), {
          key: 'no-threads', anchor: 'end', size: 9, color: TOK.label3,
        }))
      }

      // Workers
      for (let index = 0; index < workerNodes.length; index += 1) svgChildren.push(workerNodes[index])
      if (workers.length === 0) {
        svgChildren.push(svgText(workerX + workerW / 2, laneTop + 26, t('topo.noWorkers'), {
          key: 'no-workers', anchor: 'middle', size: 11, color: TOK.label3,
        }))
      }

      // Attention gate
      svgChildren.push(h('g', { key: 'gate' },
        h('title', null, t('topo.gate') + '\n'
          + t('topo.gateEmitted') + ' ' + String(emitted) + ' · ' + t('topo.gateSuppressed') + ' ' + String(suppressed)
          + '\n' + t('topo.gateRatio') + ' ' + formatRatio(attention.ratio)),
        h('rect', {
          x: workerX, y: gateY, width: gateW, height: gateH, rx: 10,
          style: { fill: TOK.bg2, stroke: TOK.border2, strokeWidth: 1 },
        }),
        h('rect', {
          x: workerX, y: gateY + 1, width: 3.5, height: gateH - 2, rx: 1.5,
          style: { fill: health },
        }),
        svgText(workerX + 14, gateY + 15, t('topo.gate'), { size: 11, weight: 700 }),
        svgText(workerX + 14, gateY + 29,
          t('topo.gateEmitted') + ' ' + String(emitted) + ' · ' + t('topo.gateSuppressed') + ' ' + String(suppressed)
            + ' · ' + t('topo.gateRatio') + ' ' + formatRatio(attention.ratio),
          { size: 9, color: TOK.label3 }),
        h('rect', {
          x: gateBarX, y: gateY + 14, width: gateBarW, height: 8, rx: 4,
          style: { fill: TOK.border2 },
        }),
        h('rect', {
          x: gateBarX, y: gateY + 14, width: Math.max(1, (gateBarW * emitted) / gateTotal), height: 8, rx: 4,
          style: { fill: TOK.warn },
        }),
        svgText(gateBarX + gateBarW, gateY + 31, formatRatio(attention.budget) + ' ' + t('attention.budget'), {
          anchor: 'end', size: 8.5, color: TOK.caption,
        })))

      return h(React.Fragment, null,
        h('div', { style: { width: '100%', minWidth: 0, overflowX: 'auto' } },
          h('svg', {
            viewBox: '0 0 ' + String(W) + ' ' + String(H),
            width: '100%',
            style: { display: 'block', minWidth: 720, height: 'auto' },
            role: 'img',
            'aria-label': t('section.topology'),
            preserveAspectRatio: 'xMidYMin meet',
          }, ...svgChildren)),
        h('div', { style: styles.legend },
          h('span', { style: styles.legendItem },
            h('span', { style: { ...styles.legendSwatch, background: TOK.brand } }), t('topo.flow')),
          h('span', { style: styles.legendItem },
            h('svg', { width: 18, height: 6, viewBox: '0 0 18 6', 'aria-hidden': true },
              h('line', { x1: 0, y1: 3, x2: 18, y2: 3, strokeDasharray: '4 3', style: { stroke: TOK.brand, strokeWidth: 1.4 } })),
            t('topo.subs')),
          h('span', { style: styles.legendItem },
            h('span', { style: { ...styles.legendSwatch, background: TOK.success } }), t('status.running')),
          h('span', { style: styles.legendItem },
            h('span', { style: { ...styles.legendSwatch, background: TOK.warn } }), t('status.queued')),
          h('span', { style: styles.legendItem },
            h('span', { style: { ...styles.legendSwatch, background: TOK.business } }), t('status.done')),
          h('span', { style: styles.legendItem },
            h('span', { style: { ...styles.legendSwatch, background: TOK.error } }), t('worker.stalled'))))
    }

    // --------------------------------------------------------------- panels

    function FunnelPanel({ t, data }) {
      const admission = data.admission
      const stages = admission.funnel
      let max = 1
      for (const stage of stages) if (stage.count > max) max = stage.count

      const rows = stages.map((stage, index) => {
        const label = tOr(t, 'funnel.' + stage.stage, stage.label === '' ? stage.stage : stage.label)
        const width = stage.count <= 0 ? 0 : Math.max(3, (stage.count / max) * 100)
        const previous = index > 0 ? stages[index - 1] : null
        const rate = previous !== null && previous.count > 0 ? stage.count / previous.count : null
        return h('div', { style: styles.funnelRow, key: stage.stage + '-' + String(index) },
          h('span', { style: styles.funnelLabel, title: label }, label),
          h('div', { style: styles.funnelTrack },
            h('div', {
              style: {
                ...styles.funnelFill,
                width: String(width) + '%',
                minWidth: stage.count > 0 ? 2 : 0,
                background: TOK.brand,
                opacity: String(1 - index * 0.17),
              },
            })),
          h('span', { style: styles.funnelCount }, formatInt(stage.count)),
          h('span', { style: styles.funnelRate },
            rate === null ? '' : formatDecimal(rate * 100, 1) + '%'))
      })

      const stats = h('div', { style: styles.statGrid },
        h('div', { style: styles.kvCell },
          h('span', { style: styles.kvLabel }, t('funnel.input')),
          h('span', { style: styles.kvValue }, formatInt(admission.received))),
        h('div', { style: styles.kvCell },
          h('span', { style: styles.kvLabel }, t('funnel.fastBlocked')),
          h('span', { style: styles.kvValue }, formatInt(admission.fastPathBlocked))),
        h('div', { style: styles.kvCell },
          h('span', { style: styles.kvLabel }, t('funnel.rejected')),
          h('span', { style: styles.kvValue }, formatInt(admission.semanticRejected))),
        h('div', { style: styles.kvCell },
          h('span', { style: styles.kvLabel }, t('funnel.perMin')),
          h('span', { style: styles.kvValue }, formatRatio(admission.ratePerMin))))

      const ruleChips = []
      const rules = admission.rules.slice().sort((left, right) => right.hits - left.hits).slice(0, 3)
      for (let index = 0; index < rules.length; index += 1) {
        const rule = rules[index]
        ruleChips.push(h('span', {
          key: 'rule-' + String(index),
          style: styles.chip,
          title: rule.instruction,
        },
          h('span', { style: styles.chipLabel }, t('funnel.rules')),
          h('span', { style: styles.chipValue }, clipText(rule.name === '' ? rule.id : rule.name, 18)),
          h('span', { style: { ...styles.chipLabel, color: TOK.brand } }, String(rule.hits))))
      }

      return h(React.Fragment, null,
        h('div', { style: styles.funnelGrid }, rows),
        stats,
        ruleChips.length === 0 ? null : h('div', { style: styles.statusStrip }, ruleChips))
    }

    function AttentionPanel({ t, data }) {
      const attention = data.attention
      const now = Date.now()
      const cells = [
        { key: 'emitted', label: t('attention.emitted'), value: formatInt(attention.emitted), color: TOK.warn },
        { key: 'suppressed', label: t('attention.suppressed'), value: formatInt(attention.suppressed), color: TOK.success },
        { key: 'ratio', label: t('attention.ratio'), value: formatRatio(attention.ratio), color: TOK.label1 },
        { key: 'budget', label: t('attention.budget'), value: formatDecimal(attention.budget * 100, 1) + '%', color: TOK.brand },
      ]
      const recent = attention.recent.slice(0, 3)
      return h(React.Fragment, null,
        h('div', { style: styles.statGrid },
          cells.map((cell) => h('div', { style: styles.kvCell, key: cell.key },
            h('span', { style: styles.kvLabel }, cell.label),
            h('span', { style: { ...styles.kvValue, color: cell.color } }, cell.value)))),
        h('div', { style: styles.sectionHead },
          h('span', { style: { ...styles.sectionHint, textTransform: 'uppercase', letterSpacing: '0.05em' } }, t('attention.recent'))),
        recent.length === 0
          ? h('p', { style: styles.empty }, t('attention.none'))
          : h('ul', { style: styles.recentList },
            recent.map((item, index) => h('li', {
              key: 'recent-' + String(index),
              style: styles.recentItem,
            },
              h('span', {
                style: {
                  ...styles.dot,
                  background: reasonColor(item.reason),
                  alignSelf: 'center',
                },
              }),
              h('span', { style: { ...styles.recentReason, color: reasonColor(item.reason) } },
                tOr(t, 'reason.' + item.reason, item.reason)),
              h('span', { style: styles.recentText }, clipText(item.text, 74)),
              h('span', { style: styles.recentMeta },
                (item.workerId === '' ? '' : item.workerId + ' · ') + formatAgo(item.at, now, t))))))
    }

    function WorkerCard({ t, worker }) {
      const color = workerColor(worker.status, worker.stalled)
      const statusText = tOr(t, 'status.' + worker.status, worker.status)
      const detailLines = []
      if (worker.threadId !== '') detailLines.push(t('worker.thread') + ' ' + worker.threadId)
      if (worker.branch !== '') detailLines.push(t('worker.branch') + ' ' + worker.branch)
      if (worker.deliveryStatus !== '') detailLines.push(t('worker.delivery') + ' ' + worker.deliveryStatus + (worker.replied ? ' · ' + t('worker.reply') : ''))
      if (worker.model !== '') detailLines.push(t('worker.model') + ' ' + worker.model)
      if (worker.attentionCost > 0) detailLines.push(t('worker.attention') + ' ' + formatInt(worker.attentionCost))
      return h('article', { style: styles.workerCard },
        h('div', { style: styles.workerTop },
          h('div', { style: styles.ringWrap },
            h(ProgressRing, { size: 54, stroke: 5, fraction: worker.progress, color }),
            h('span', { style: styles.ringCenter }, Math.round(worker.progress * 100) + '%')),
          h('div', { style: styles.workerBody },
            h('div', { style: styles.workerHead },
              h('span', { style: { ...styles.workerId, color } }, worker.id),
              h('span', { style: { ...styles.badge, color, borderColor: color } }, statusText),
              worker.stalled
                ? h('span', { style: { ...styles.badge, color: TOK.error, borderColor: TOK.error } }, t('worker.stalled'))
                : null,
              worker.simulated
                ? h('span', { style: styles.badge }, t('worker.simulated'))
                : null),
            h('span', { style: styles.workerTitle, title: worker.title }, worker.title === '' ? '—' : worker.title),
            h('div', { style: styles.workerMeta },
              h('span', null, t('worker.elapsed') + ' ' + formatDuration(worker.elapsedMs, t)),
              h('span', null, t('worker.turns') + ' ' + formatInt(worker.turns)),
              h('span', null, t('worker.steps') + ' ' + formatInt(worker.steps)),
              h('span', null, t('worker.toolCalls') + ' ' + formatInt(worker.toolCalls))))),
        h('div', { style: styles.workerSummary, title: worker.summary },
          t('worker.summary') + ': ' + (worker.summary === '' ? '—' : worker.summary)),
        h('div', { style: styles.workerMeta },
          h('span', { style: styles.codeInline, title: t('worker.thread') }, worker.threadId === '' ? t('common.none') : worker.threadId),
          h('span', { style: styles.mono }, formatTokens(worker.tokens, t))),
        detailLines.length === 0 ? null : h('div', { style: styles.workerMeta },
          detailLines.map((line, index) => h('span', { key: 'detail-' + String(index) }, line))))
    }

    function WorkersPanel({ t, data }) {
      if (data.workers.length === 0) return h(EmptyState, { t, text: t('workers.empty') })
      return h('div', { style: styles.workerGrid },
        data.workers.map((worker) => h(WorkerCard, { t, worker, key: worker.id })))
    }

    function WatchdogPanel({ t, data }) {
      const watchdog = data.watchdog
      const now = Date.now()
      const color = healthColor(watchdog.state)
      const fraction = watchdog.state === 'ok' ? 1 : watchdog.state === 'warn' ? 0.6 : 0.25
      const stateText = tOr(t, 'watchdog.' + watchdog.state, watchdog.state)
      const findings = watchdog.findings.slice(0, 6)

      return h(React.Fragment, null,
        h('div', { style: styles.healthWrap },
          h('div', { style: styles.healthRing },
            h(ProgressRing, { size: 96, stroke: 8, fraction, color }),
            h('div', { style: styles.healthCenter },
              h('span', { style: { ...styles.healthValue, color } }, stateText),
              h('span', { style: styles.healthCaption }, t('watchdog.checks') + ' ' + formatInt(watchdog.checks)))),
          h('div', { style: { ...styles.statGrid, flex: 1, minWidth: 180 } },
            h('div', { style: styles.kvCell },
              h('span', { style: styles.kvLabel }, t('watchdog.lastCheck')),
              h('span', { style: styles.kvValue }, formatAgo(watchdog.lastCheckAt, now, t) || t('common.none'))),
            h('div', { style: styles.kvCell },
              h('span', { style: styles.kvLabel }, t('watchdog.stalled')),
              h('span', { style: { ...styles.kvValue, color: watchdog.stalled > 0 ? TOK.error : TOK.label1 } }, formatInt(watchdog.stalled))),
            h('div', { style: styles.kvCell },
              h('span', { style: styles.kvLabel }, t('watchdog.loops')),
              h('span', { style: styles.kvValue }, formatInt(watchdog.loops))),
            h('div', { style: styles.kvCell },
              h('span', { style: styles.kvLabel }, t('watchdog.drift')),
              h('span', { style: styles.kvValue }, formatInt(watchdog.drift))))),
        data.health.note === '' ? null : h('p', { style: styles.empty }, data.health.note),
        h('div', { style: styles.sectionHead },
          h('span', { style: { ...styles.sectionHint, textTransform: 'uppercase', letterSpacing: '0.05em' } }, t('watchdog.findings'))),
        findings.length === 0
          ? h('p', { style: styles.empty }, t('watchdog.none'))
          : h('ul', { style: styles.findings },
            findings.map((finding, index) => {
              const kindLabel = tOr(t, 'watchdog.kind.' + finding.kind, finding.kind)
              const tone = finding.kind === 'stall' ? TOK.error : TOK.warn
              return h('li', { key: 'finding-' + String(index), style: styles.finding },
                h('span', { style: { ...styles.findingKind, color: tone } }, kindLabel),
                h('span', { style: styles.findingText }, finding.text === '' ? t('common.none') : finding.text),
                h('span', { style: styles.findingMeta },
                  (finding.workerId === '' ? '' : finding.workerId + ' · ') + formatAgo(finding.at, now, t)))
            })))
    }

    function CompareBar({ t, label, valueMs, maxMs, color }) {
      const known = valueMs !== null
      const width = known && maxMs > 0 ? Math.max(2, (valueMs / maxMs) * 100) : 0
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 },
      },
        h('span', { style: { width: 78, flex: '0 0 auto', color: TOK.label2 } }, label),
        h('div', { style: { ...styles.compareTrack, flex: 1, minWidth: 40 } },
          known ? h('div', { style: { ...styles.compareFill, width: String(width) + '%', background: color } }) : null),
        h('span', {
          style: {
            width: 70, flex: '0 0 auto', textAlign: 'right', color: TOK.label2,
            fontVariantNumeric: 'tabular-nums',
          },
        }, known ? formatMinutes(valueMs, t) : t('metrics.untested')))
    }

    function CompareRow({ t, label, superMs, singleMs }) {
      if (superMs === null && singleMs === null) {
        return h('div', { style: styles.compareRow },
          h('span', { style: styles.compareLabel }, label),
          h('span', { style: styles.empty }, t('metrics.untested')))
      }
      let max = 1
      if (superMs !== null && superMs > max) max = superMs
      if (singleMs !== null && singleMs > max) max = singleMs
      let saved = ''
      if (superMs !== null && singleMs !== null && singleMs > 0) {
        saved = t('metrics.saved') + ' ' + formatDecimal(Math.max(0, (1 - superMs / singleMs) * 100), 1) + '%'
      }
      return h('div', { style: styles.compareRow },
        h('span', { style: styles.compareLabel }, label),
        h(CompareBar, { t, label: t('metrics.super'), valueMs: superMs, maxMs: max, color: TOK.brand }),
        h(CompareBar, { t, label: t('metrics.single'), valueMs: singleMs, maxMs: max, color: TOK.label3 }),
        saved === '' ? null : h('span', { style: { ...styles.compareLabel, color: TOK.success } }, saved))
    }

    function MetricsPanel({ t, data }) {
      const metrics = data.metrics
      const admission = data.admission
      const compare = data.compare
      const routerDecisions = metrics.routerDecisions > 0 ? metrics.routerDecisions : data.router.decisions
      const triggersPerMin = admission.ratePerMin
      const cells = [
        { key: 'p50', label: t('metrics.p50'), value: formatMinutes(metrics.p50Ms, t), big: true },
        { key: 'p95', label: t('metrics.p95'), value: formatMinutes(metrics.p95Ms, t), big: true },
        { key: 'router', label: t('metrics.routerDecisions'), value: formatInt(routerDecisions), big: true },
        { key: 'batch', label: t('metrics.avgBatch'), value: formatRatio(data.router.avgBatch), big: true },
        { key: 'cache', label: t('metrics.cacheRead'), value: formatCompact(metrics.cacheReadTokens), big: true },
        { key: 'rate', label: t('metrics.triggersPerMin'), value: formatRatio(triggersPerMin), big: true },
        { key: 'decisionMs', label: t('metrics.avgDecisionMs'), value: formatDuration(data.router.avgDecisionMs, t), big: false },
        { key: 'completed', label: t('metrics.completed'), value: formatInt(metrics.completed), big: false },
        { key: 'saved', label: t('metrics.savedMinutes'), value: formatInt(metrics.savedMinutes) + ' ' + t('unit.min'), big: false },
      ]
      return h(React.Fragment, null,
        h('div', { style: styles.statGrid },
          cells.map((cell) => h('div', { style: styles.kvCell, key: cell.key },
            h('span', { style: styles.kvLabel }, cell.label),
            h('span', { style: cell.big ? styles.kvValueBig : styles.kvValue }, cell.value)))),
        h('div', { style: styles.compare },
          h('span', { style: styles.compareLabel }, t('metrics.compare')),
          h(CompareRow, {
            t,
            label: t('metrics.p50'),
            superMs: compare.super.p50Ms,
            singleMs: compare.single.p50Ms,
          }),
          h(CompareRow, {
            t,
            label: t('metrics.p95'),
            superMs: compare.super.p95Ms,
            singleMs: compare.single.p95Ms,
          })))
    }

    function EventsPanel({ t, data }) {
      const events = data.events
      const boxRef = React.useRef(null)
      const stickRef = React.useRef(true)
      const [stick, setStick] = React.useState(true)

      React.useEffect(() => {
        const box = boxRef.current
        if (box === null || !stickRef.current) return
        box.scrollTop = box.scrollHeight
      }, [events.length, stick])

      const onScroll = () => {
        const box = boxRef.current
        if (box === null) return
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 28
        if (nearBottom !== stickRef.current) {
          stickRef.current = nearBottom
          setStick(nearBottom)
        }
      }

      const jumpToBottom = () => {
        const box = boxRef.current
        stickRef.current = true
        setStick(true)
        if (box !== null) box.scrollTop = box.scrollHeight
      }

      const rows = events.map((event, index) => {
        const color = kindColor(event.kind)
        const kindLabel = tOr(t, 'kind.' + event.kind, event.kind)
        const meta = []
        if (event.workerId !== '') meta.push(event.workerId)
        if (event.threadId !== '') meta.push(event.threadId)
        return h('div', {
          key: event.kind + ':' + String(event.t) + ':' + String(index),
          style: styles.eventRow,
        },
          h('span', { style: styles.eventTime }, formatClock(event.t)),
          h('span', { style: { ...styles.eventKind, color } }, kindLabel),
          h('span', { style: styles.eventText },
            event.text === '' ? '—' : event.text,
            meta.length === 0 ? null : h('span', { style: { ...styles.eventMeta, marginLeft: 6 } }, meta.join(' · '))))
      })

      return h(React.Fragment, null,
        h('div', { style: styles.scrollBox, ref: boxRef, onScroll, role: 'log', 'aria-label': t('section.events') },
          rows.length === 0 ? h('p', { style: styles.empty }, t('events.empty')) : rows),
        h('div', { style: { ...styles.statusStrip, marginTop: 2 } },
          stick
            ? h('span', { style: styles.scrollHint }, t('events.stick'))
            : h(React.Fragment, null,
              h('span', { style: { ...styles.scrollHint, color: TOK.warn } }, t('events.paused')),
              h('button', { type: 'button', style: styles.button, onClick: jumpToBottom }, t('events.resume')))))
    }

    function commandNameKey(name) {
      if (name === 'demo') return 'control.demo'
      if (name === 'watchdog') return 'control.watchdog'
      if (name === 'reset') return 'control.reset'
      if (name === 'mode') return 'control.mode'
      return ''
    }

    function ControlsPanel({ t, data, command, onCommand }) {
      const [confirming, setConfirming] = React.useState(false)
      const busy = command.busy !== ''
      const mode = data.mode

      React.useEffect(() => {
        if (!confirming) return undefined
        const timer = window.setTimeout(() => setConfirming(false), 6000)
        return () => window.clearTimeout(timer)
      }, [confirming])

      const statusLine = (() => {
        if (command.busy !== '') {
          return h('div', { style: styles.commandLine },
            h('span', { className: 'sa-spin', style: styles.spinDot }),
            h('span', null, t('control.busy') + ' · ' + tOr(t, commandNameKey(command.busy), command.busy)))
        }
        if (command.errorCode !== '') {
          const message = command.errorCode === 'timeout' ? t('control.timeout')
            : command.errorCode === 'network' ? t('control.network')
              : t('control.failed')
          return h('div', { style: { ...styles.errorCard, flexDirection: 'row', alignItems: 'center', gap: 8 } },
            h('span', { style: styles.errorLabel }, message),
            h('span', { style: styles.errorText }, command.errorText))
        }
        if (command.done !== '') {
          return h('div', { style: styles.commandLine },
            h('span', { style: { ...styles.dot, background: TOK.success } }),
            h('span', null, t('control.done') + ' · ' + tOr(t, commandNameKey(command.done), command.done)))
        }
        return null
      })()

      return h(React.Fragment, null,
        h('div', { style: styles.controlsRow },
          h('div', { style: styles.controlGroup },
            h('span', { style: styles.controlNote }, t('control.mode')),
            h(Segmented, {
              value: mode.accept,
              label: t('control.mode'),
              options: [
                { id: 'observe', text: t('mode.observe') },
                { id: 'accept', text: t('mode.accept') },
              ],
              onChange: (id) => {
                if (busy || id === mode.accept) return
                onCommand('mode', { accept: id })
              },
            })),
          h(ActionButton, {
            t,
            onClick: () => onCommand('mode', { paused: !mode.paused }),
            disabled: busy,
            title: mode.paused ? t('control.resume') : t('control.pause'),
          }, mode.paused ? t('control.resume') : t('control.pause')),
          h(ActionButton, {
            t,
            tone: 'primary',
            onClick: () => onCommand('demo', {}),
            disabled: busy,
            title: t('control.demoHint'),
          }, t('control.demo')),
          h(ActionButton, {
            t,
            onClick: () => onCommand('watchdog', {}),
            disabled: busy,
          }, t('control.watchdog')),
          confirming
            ? h(React.Fragment, null,
              h('span', { style: { ...styles.controlNote, color: TOK.error } }, t('control.confirmReset')),
              h(ActionButton, {
                t,
                tone: 'danger',
                onClick: () => {
                  setConfirming(false)
                  onCommand('reset', {})
                },
                disabled: busy,
              }, t('control.confirm')),
              h(ActionButton, {
                t,
                onClick: () => setConfirming(false),
              }, t('control.cancel')))
            : h(ActionButton, {
              t,
              tone: 'danger',
              onClick: () => setConfirming(true),
              disabled: busy,
              title: t('control.resetHint'),
            }, t('control.reset'))),
        h('div', { style: styles.controlNote },
          t('control.demoHint') + ' · ' + t('control.resetHint')),
        statusLine)
    }

    // ----------------------------------------------------------------- shell

    function HeaderStatus({ t, snapshot, data, onRefresh }) {
      const connection = snapshot.status
      const connectionText = connection === 'online' ? t('conn.online')
        : connection === 'offline' ? t('conn.offline') : t('conn.loading')
      const connectionColor = connection === 'online' ? TOK.success
        : connection === 'offline' ? TOK.error : TOK.warn
      const model = data === null ? t('common.none')
        : data.config.workerModel !== '' ? data.config.workerModel
          : data.router.model !== '' ? data.router.model : t('common.none')

      const chips = []
      chips.push(h(React.Fragment, { key: 'conn' },
        h('span', { style: styles.pill },
          h('span', { style: { ...styles.dot, background: connectionColor } }),
          h('span', null, connectionText))))
      if (data !== null) {
        chips.push(h(StatusChip, {
          key: 'mode',
          label: t('status.mode'),
          value: (data.mode.accept === 'accept' ? t('mode.accept') : t('mode.observe'))
            + (data.mode.paused ? ' · ' + t('status.paused') : ''),
          color: data.mode.accept === 'accept' ? TOK.brand : TOK.label2,
        }))
        chips.push(h(StatusChip, {
          key: 'health',
          label: t('status.health'),
          value: tOr(t, 'health.' + data.health.state, data.health.state),
          color: healthColor(data.health.state === 'ready' ? 'ok' : data.health.state),
        }))
        chips.push(h(StatusChip, {
          key: 'uptime',
          label: t('status.uptime'),
          value: h(LiveUptime, { baseMs: data.uptimeMs, at: snapshot.updatedAt, t }),
        }))
        chips.push(h(StatusChip, {
          key: 'runner',
          label: t('status.runner'),
          value: data.mode.runner === 'session' ? t('runner.session') : t('runner.simulate'),
        }))
        chips.push(h(StatusChip, { key: 'model', label: t('status.model'), value: clipText(model, 32) }))
        if (snapshot.updatedAt > 0) {
          chips.push(h(StatusChip, {
            key: 'updated',
            label: t('status.updated'),
            value: formatClock(snapshot.updatedAt),
          }))
        }
      } else {
        chips.push(h(StatusChip, { key: 'waiting', label: t('status.updated'), value: t('status.waiting') }))
      }
      chips.push(h(ActionButton, {
        key: 'refresh',
        t,
        onClick: onRefresh,
        title: t('control.refresh'),
      }, t('control.refresh')))

      return h(React.Fragment, null,
        h('div', { style: styles.statusStrip }, chips),
        snapshot.status === 'offline'
          ? h('div', { style: styles.errorCard },
            h('span', { style: styles.errorLabel }, t('empty.offline')),
            h('span', { style: styles.errorText }, t('offline.note') + ' ' + snapshot.error))
          : null)
    }

    function ConsoleApp({ t, useLocaleTick }) {
      useLocaleTick()
      const consoleState = useConsoleState()
      const snapshot = consoleState.snapshot
      const data = snapshot.data
      const onCommand = consoleState.runCommand

      const blocks = []
      blocks.push(h(HeaderStatus, {
        key: 'header-status',
        t,
        snapshot,
        data,
        onRefresh: consoleState.refresh,
      }))

      if (data === null) {
        blocks.push(h(Section, { key: 'waiting', t, title: t('title') },
          h(EmptyState, {
            t,
            text: snapshot.status === 'offline' ? t('empty.offline') : t('empty.waiting'),
          }),
          h('p', { style: styles.empty }, t('empty.noData'))))
      } else {
        blocks.push(h(Section, {
          key: 'controls',
          t,
          title: t('section.controls'),
          hint: t('mode.' + data.mode.accept),
        }, h(ControlsPanel, { t, data, command: consoleState.command, onCommand })))

        blocks.push(h(Section, {
          key: 'topology',
          t,
          title: t('section.topology'),
          hint: t('topologyHint'),
        }, h(TopologyPanel, { t, data })))

        blocks.push(h('div', { key: 'funnel-attention', className: 'sa-grid2' },
          h(Section, { key: 'funnel', t, title: t('section.funnel') },
            h(FunnelPanel, { t, data })),
          h(Section, { key: 'attention', t, title: t('section.attention') },
            h(AttentionPanel, { t, data }))))

        blocks.push(h(Section, {
          key: 'workers',
          t,
          title: t('section.workers'),
          hint: String(data.workers.length) + ' / ' + String(data.config.maxWorkers),
        }, h(WorkersPanel, { t, data })))

        blocks.push(h('div', { key: 'watchdog-metrics', className: 'sa-grid2' },
          h(Section, { key: 'watchdog', t, title: t('section.watchdog') },
            h(WatchdogPanel, { t, data })),
          h(Section, { key: 'metrics', t, title: t('section.metrics') },
            h(MetricsPanel, { t, data }))))

        blocks.push(h(Section, {
          key: 'events',
          t,
          title: t('section.events'),
          hint: String(data.events.length),
        }, h(EventsPanel, { t, data })))
      }

      return h('div', { style: styles.root, role: 'region', 'aria-label': t('title') },
        h('style', { key: 'sa-css' }, PANEL_CSS),
        h('div', { style: styles.column },
          h('div', { style: styles.header },
            h('div', { style: styles.titleWrap },
              h('h2', { style: styles.title }, t('title')),
              h('p', { style: styles.subtitle }, t('subtitle'))),
            h('div', { style: styles.headerActions },
              data === null ? null : h(Pill, {
                color: healthColor(data.health.state === 'ready' ? 'ok' : data.health.state),
                text: t('health.' + data.health.state),
              }))),
          blocks,
          h('p', { style: styles.footer }, t('footer'))))
    }

    // --------------------------------------------------------------- mounting

    /** Fail-open ledger read: an absent or hostile ledger reports false so the mount proceeds. */
    function entrySeated(ctx, slot, field, value) {
      try {
        let entries = null
        if (typeof ctx.slots.entries === 'function') entries = ctx.slots.entries(slot)
        else if (typeof ctx.slots.entriesOfSlot === 'function') entries = ctx.slots.entriesOfSlot(slot)
        if (!Array.isArray(entries)) return false
        for (const entry of entries) {
          const record = asRecord(entry)
          const options = record === null ? null : asRecord(record.options)
          if (options !== null && options[field] === value) return true
        }
      } catch { /* no ledger on this face — mount as usual */ }
      return false
    }

    /** Sidebar glyph: one router hub fanning out to worker nodes. */
    function SidebarIcon(props) {
      const size = numOr(asRecord(props) === null ? null : props.size, 20)
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('circle', { cx: 4.6, cy: 12, r: 2.1 }),
        h('circle', { cx: 19.2, cy: 5.6, r: 1.9 }),
        h('circle', { cx: 19.2, cy: 12, r: 1.9 }),
        h('circle', { cx: 19.2, cy: 18.4, r: 1.9 }),
        h('path', { d: 'M6.7 12h4.1' }),
        h('path', { d: 'M10.8 12c2.4 0 2.6-6.4 6.5-6.4' }),
        h('path', { d: 'M10.8 12h4.6' }),
        h('path', { d: 'M10.8 12c2.4 0 2.6 6.4 6.5 6.4' }))
    }

    /** Shared by both apply calls; reset only when the module itself is re-evaluated. */
    let mounted = false

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Both registrations are seated together; a second apply (HMR, double mount)
        // must not duplicate the main panel or the sidebar entry. Each side is
        // checked independently so a partial previous mount can still be completed.
        const mainSeated = mounted || entrySeated(ctx, 'main', 'key', PANEL_ID)
        const sidebarSeated = mounted || entrySeated(ctx, 'sidebar.panellist', 'id', PANEL_ID)
        if (mainSeated && sidebarSeated) return

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-super-agent: dictionaries')
        const t = ctx.locale.bind(NS)

        // Re-render on locale switches so memoized sections drop stale strings.
        const subscribeLocale = typeof ctx.locale.subscribe === 'function'
          ? ctx.locale.subscribe.bind(ctx.locale)
          : () => () => {}
        const readLocale = () => {
          try {
            const snapshot = ctx.locale.getLocale()
            return snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
          } catch {
            return ''
          }
        }
        const useLocaleTick = () => React.useSyncExternalStore(subscribeLocale, readLocale)

        if (!mainSeated) {
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({}),
          }, (props) => h(PanelBoundary, { t: (props && props.t) || t },
            h(ConsoleApp, Object.assign({}, props, { t: (props && props.t) || t, useLocaleTick })))))
        }

        if (!sidebarSeated) {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: () => t('panel'),
            locale: NS,
          }, SidebarIcon))
        }

        mounted = true
      },
    }
  },
})
