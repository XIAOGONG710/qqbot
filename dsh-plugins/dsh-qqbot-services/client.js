window.__ModuleLoader__.load({
  id: 'dsh-qqbot-services',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const panel = 'dsh-qqbot-services'
    const api = '/api/qqbot-services'
    const tabKey = 'qqbot-services:tab'
    const tabs = [{ id: 'home', label: '总览' }, { id: 'link', label: '连接' }, { id: 'sys', label: '系统' }]
    const names = { napcat: 'NapCat', hindsight: 'Hindsight', koishi: 'Koishi', watchdog: '守护', backup: '备份' }
    const steps = { checking: '正在检查', starting: '正在等待服务就绪', skipped: '已运行，跳过启动', ready: '已就绪', timeout: '等待就绪超时', failed: '启动或检查失败', maintenance: '维护期间暂停启动' }
    const eventNames = { watching: '开始监测', recovered: '恢复正常', starting: '尝试启动', failed: '运行异常' }
    const button = { padding: '6px 12px', borderRadius: 6, cursor: 'pointer' }
    const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 0',
      borderBottom: '1px solid var(--dsw-alias-border-l1, #aaa5)' }

    function readTab() {
      try {
        const saved = window.localStorage.getItem(tabKey)
        if (tabs.some(tab => tab.id === saved)) return saved
      } catch { /* 存储不可用时照常打开总览 */ }
      return 'home'
    }

    // 标签键盘切换沿用灵犀 QQ 桥接的 Tabs，绑定本项目自己的面板。
    function Tabs({ value, onChange, instanceId }) {
      const index = Math.max(0, tabs.findIndex(tab => tab.id === value))
      const onKey = event => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
        event.preventDefault()
        const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
        onChange(next.id)
        event.currentTarget.querySelector(`[data-tab="${next.id}"]`)?.focus()
      }
      return h('div', { role: 'tablist', 'aria-label': '林梦瑶 QQ 桥接', onKeyDown: onKey, style: { display: 'flex', gap: 8, marginTop: 12 } },
        ...tabs.map(tab => h('button', {
          key: tab.id, type: 'button', role: 'tab', id: `${instanceId}-tab-${tab.id}`, 'data-tab': tab.id,
          'aria-selected': tab.id === value, 'aria-controls': `${instanceId}-panel-${tab.id}`,
          tabIndex: tab.id === value ? 0 : -1, onClick: () => onChange(tab.id), style: { ...button, fontWeight: tab.id === value ? 700 : 400 },
        }, tab.label)))
    }

    function summary(health, service) {
      if (!health) return '状态未知'
      if (service === 'koishi') {
        if (!health.koishiListening) return health.koishiProcesses ? '进程已启动，尚未监听' : '未运行'
        return health.napcat && health.lastConnection?.state === 'connected' ? '已连接 NapCat' : '控制台就绪，OneBot 待连接'
      }
      if (health[service]) return service === 'napcat' ? 'OneBot 端口已监听' : '探测正常'
      return health.launchers?.[service] ? '进程已启动，尚未就绪' : '未就绪'
    }

    function Panel() {
      const [state, setState] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [sending, setSending] = React.useState(false)
      const [diagnosticOpen, setDiagnosticOpen] = React.useState(false)
      const [copyStatus, setCopyStatus] = React.useState('')
      const [tab, setTab] = React.useState(readTab)
      const instanceId = React.useId()
      const selectTab = value => {
        setTab(value)
        try { window.localStorage.setItem(tabKey, value) } catch { /* 当前页面仍可切换 */ }
      }
      const refresh = React.useRef(null)
      React.useEffect(() => {
        const controller = new AbortController()
        let timer
        let pending = false
        const read = async () => {
          if (pending || controller.signal.aborted) return
          clearTimeout(timer)
          pending = true
          try {
            const response = await fetch(`${api}/state`, { signal: controller.signal })
            if (!response.ok) throw Error()
            const data = await response.json()
            if (!controller.signal.aborted) setState(data)
          } catch {
            if (!controller.signal.aborted) setState(null)
          } finally {
            pending = false
            if (!controller.signal.aborted) timer = setTimeout(read, 8000)
          }
        }
        refresh.current = read
        void read()
        return () => { controller.abort(); clearTimeout(timer); refresh.current = null }
      }, [])

      const start = async service => {
        setSending(true)
        setNotice('')
        try {
          const response = await fetch(`${api}/start/${service}`, {
            method: 'POST', headers: {
              'x-qqbot-service-panel': '1', 'x-qqbot-service-token': state.panelToken,
            }, signal: AbortSignal.timeout(10_000),
          })
          if (!response.ok) throw Error()
          setNotice('已提交启动请求')
          await refresh.current?.()
        } catch { setNotice('未能提交启动请求，请刷新状态') }
        finally { setSending(false) }
      }

      const health = state?.health
      const operation = state?.operation
      const blocked = !health || health.maintenance || sending || operation?.running
      const isReady = name => name === 'koishi' ? health?.koishiListening : health?.[name]
      const copyDiagnostic = async () => {
        setDiagnosticOpen(true)
        try {
          await navigator.clipboard.writeText(state.diagnostic)
          setCopyStatus('已复制诊断')
        } catch {
          setCopyStatus('可选中下方诊断，手动复制。')
        }
      }
      return h('section', { style: { padding: 24, maxWidth: 740, margin: '0 auto', overflow: 'auto', height: '100%' } },
        h('header', { style: row },
          h('h2', { style: { margin: 0 } }, '林梦瑶 · QQ 桥接'),
          tab === 'home' && h('button', { style: button, onClick: () => start('all'), disabled: blocked }, '按顺序启动缺失服务')),
        h(Tabs, { value: tab, onChange: selectTab, instanceId }),
        !state && h('p', { role: 'status' }, '正在获取服务状态，无法连接时会自动重试。'),
        health?.maintenance && h('p', { role: 'status' }, '正在维护，启动暂不可用。'),
        notice && h('p', { role: 'status' }, notice),
        h('div', { role: 'tabpanel', id: `${instanceId}-panel-home`, 'aria-labelledby': `${instanceId}-tab-home`, hidden: tab !== 'home' },
        ...['napcat', 'hindsight', 'koishi'].map(service => h('div', { key: service, style: row },
          h('div', null, h('strong', null, names[service]), h('div', null, summary(health, service)),
            operation?.steps?.[service] && h('small', null, steps[operation.steps[service]])),
          h('button', { style: button, disabled: blocked || isReady(service) || health?.launchers?.[service],
            'aria-label': `启动 ${names[service]}`, onClick: () => start(service) }, '启动'))),
        h('div', { style: row }, h('strong', null, '自动守护'),
          h('span', null, health ? (health.watchdog ? '运行中' : '未运行') : '状态未知')),
        state?.checkedAt && h('small', null, `最近探测 ${new Date(state.checkedAt).toLocaleTimeString('zh-CN')}`)),
        h('div', { role: 'tabpanel', id: `${instanceId}-panel-link`, 'aria-labelledby': `${instanceId}-tab-link`, hidden: tab !== 'link' },
          ...['napcat', 'koishi', 'hindsight'].map(service => h('div', { key: service, style: row },
            h('strong', null, names[service]),
            h('span', null, health?.ports?.[service] ? `${health.ports[service]} · ${summary(health, service)}` : summary(health, service))))),
        h('div', { role: 'tabpanel', id: `${instanceId}-panel-sys`, 'aria-labelledby': `${instanceId}-tab-sys`, hidden: tab !== 'sys' },
        state?.diagnostic && h('section', { 'aria-label': '链路诊断', style: { marginTop: 16 } },
          h('div', { style: row }, h('strong', null, '链路诊断'),
            h('button', { style: button, onClick: copyDiagnostic }, '复制诊断')),
          copyStatus && h('p', { role: 'status' }, copyStatus),
          diagnosticOpen && h('textarea', { 'aria-label': '诊断报告', readOnly: true, value: state.diagnostic,
            rows: 10, style: { width: '100%', boxSizing: 'border-box' } })),
        h('h3', null, '最近后台事件'),
        state?.events?.length
          ? h('ul', null, ...state.events.map(({ at, service, event }, index) =>
            h('li', { key: `${at}-${index}` }, `${at}　${names[service]}　${eventNames[event]}`)))
          : h('p', null, '暂无可显示的后台事件。')))
    }

    function Icon() {
      return h('span', { 'aria-hidden': true, style: { fontSize: 16 } }, '▤')
    }

    let mounted = false
    return {
      inject: ['slots'],
      apply(ctx) {
        if (mounted) return
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel, inject: () => ({}) }, Panel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: panel, order: 13, label: () => '服务管理',
        }, Icon))
        const removeSettings = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'linmengyao-qq-bridge', order: 27, label: () => '林梦瑶 · QQ 桥接',
        }, Panel))
        if (typeof removeSettings === 'function') ctx.effect?.(() => removeSettings, '林梦瑶 QQ 桥接设置页')
        mounted = true
        ctx.on?.('dispose', () => { mounted = false })
      },
    }
  },
})
