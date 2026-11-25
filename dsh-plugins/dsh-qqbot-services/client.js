window.__ModuleLoader__.load({
  id: 'dsh-qqbot-services',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const panel = 'dsh-qqbot-services'
    const api = '/api/qqbot-services'
    const tabKey = 'qqbot-services:tab'
    const tabs = [{ id: 'home', label: '总览' }, { id: 'chat', label: '聊天' }, { id: 'link', label: '连接' }, { id: 'sys', label: '系统' }]
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

    function readHistoryCount(viewKey) {
      try {
        const value = Number(window.localStorage.getItem(viewKey))
        if ([15, 30, 60].includes(value)) return value
      } catch { /* 使用默认条数 */ }
      return 30
    }

    // 灵犀 WebChat 的发送者配色，保持同一人各条消息颜色一致。
    const senderColors = ['#e2686f', '#e0a44b', '#4bb07a', '#4b8fe0', '#9a6fe0', '#e07fa8', '#5fb8c9', '#c98f5f']
    function colorOf(sender) {
      let hash = 0
      for (const ch of sender) hash = (hash * 31 + ch.codePointAt(0)) >>> 0
      return senderColors[hash % senderColors.length]
    }

    // 沿用灵犀 WebChat 的消息流、发送者和输入区结构，数据改走本地 QQ 接口。
    function Chat() {
      const [data, setData] = React.useState(null)
      const [key, setKey] = React.useState('')
      const [filter, setFilter] = React.useState('')
      const [revision, setRevision] = React.useState(0)
      const [listError, setListError] = React.useState(false)
      const session = data?.sessions.find(item => item.key === key)
      const request = async (path, options = {}) => {
        const response = await fetch(`${api}/chat/${path}`, {
          method: 'POST', ...options, headers: {
            ...options.headers, 'x-qqbot-service-panel': '1',
          },
        })
        if (!response.ok) throw Error()
        return response.json()
      }
      React.useEffect(() => {
        const controller = new AbortController()
        setListError(false)
        request('list', { signal: controller.signal }).then(value => {
          if (!controller.signal.aborted) setData(value)
        }).catch(() => { if (!controller.signal.aborted) { setListError(true); setData(null) } })
        return () => controller.abort()
      }, [revision])
      return h('section', { style: { marginTop: 16 } },
        h('div', { style: row },
          h('span', null, data?.account ? `QQ 账号 ${data.account.name}（${data.account.id}）` : 'QQ 会话'),
          h('button', { type: 'button', style: button, onClick: () => setRevision(value => value + 1) }, '刷新会话')),
        listError && h('p', { role: 'alert' }, '读不到 QQ 会话，请检查 NapCat 登录状态后刷新。'),
        !data && !listError && h('p', { role: 'status' }, '正在读取 QQ 会话…'),
        data && h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12 } },
          h('nav', { 'aria-label': 'QQ 会话', style: { flex: '1 1 175px', maxHeight: 360, overflow: 'auto' } },
            h('input', { value: filter, placeholder: '搜索群或好友', 'aria-label': '搜索群或好友',
              onChange: event => setFilter(event.target.value) }),
            ...data.sessions.filter(item => `${item.name} ${item.target}`.toLowerCase().includes(filter.trim().toLowerCase()))
              .map(item => h('div', { key: item.key },
                h('button', { type: 'button', style: { ...button, marginTop: 4 }, 'aria-pressed': item.key === key,
                  onClick: () => setKey(item.key) }, `${item.kind === 'group' ? '群' : '私聊'} · ${item.name}`)))),
          h('div', { style: { flex: '3 1 320px', minWidth: 0 } },
            session ? h(Conversation, { key: `${data.account.id}:${session.key}`, session, account: data.account,
              sendPrefix: data.sendKey === session.key ? data.sendPrefix : null, request, revision }) : h('p', null, '选择一个好友或群聊。'))))
    }

    function Conversation({ session, account, sendPrefix, request, revision }) {
      const canSend = Boolean(sendPrefix)
      const viewKey = `qqbot-services:history-count:${account.id}:${session.key}`
      const [count, setCount] = React.useState(() => readHistoryCount(viewKey))
      const [messages, setMessages] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [sending, setSending] = React.useState(false)
      const [refresh, setRefresh] = React.useState(0)
      const busy = React.useRef(false)
      React.useEffect(() => {
        const controller = new AbortController()
        let timer
        const update = async () => {
          try {
            const query = new URLSearchParams({ key: session.key, count: String(count) })
            const result = await request(`history?${query}`, { signal: controller.signal })
            if (!controller.signal.aborted) setMessages(result.messages)
          } catch {
            if (!controller.signal.aborted) setMessages(false)
          } finally {
            if (!controller.signal.aborted) timer = setTimeout(update, 5000)
          }
        }
        void update()
        return () => { controller.abort(); clearTimeout(timer) }
      }, [session.key, count, revision, refresh])
      const submit = async event => {
        event.preventDefault()
        if (!canSend || busy.current || !draft.trim()) return
        busy.current = true
        setSending(true)
        setNotice('')
        let attempted = false
        try {
          const payload = { key: session.key, accountId: account.id, text: draft }
          const post = (path, body) => request(path, {
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          })
          const { preview, confirmation } = await post('prepare', payload)
          if (!window.confirm(`从 ${preview.account.name}（${preview.account.id}）发送给 ${preview.recipient.name}（${preview.recipient.target}）？\n\n${preview.text}`)) return
          attempted = true
          await post('send', { ...payload, confirmation })
          setDraft('')
          setRefresh(value => value + 1)
          setNotice('已发送')
        } catch { setNotice(attempted ? '发送结果未能确认，请先刷新历史再决定是否重试。' : '无法准备发送，请刷新会话后重试。') }
        finally { busy.current = false; setSending(false) }
      }
      return h('section', { 'aria-label': session.name },
        h('h3', null, `${session.name}（${session.target}）`),
        h('label', null, '最近消息条数 ', h('select', { value: count, onChange: event => {
          const value = Number(event.target.value)
          setCount(value)
          try { window.localStorage.setItem(viewKey, String(value)) } catch { /* 当前页面仍可设置 */ }
        } }, ...[15, 30, 60].map(value => h('option', { value, key: value }, value)))),
        messages === null && h('p', { role: 'status' }, '正在读取消息…'),
        messages === false && h('p', { role: 'status' }, '暂时读不到消息，将自动重试。'),
        messages?.length === 0 && h('p', null, '近期没有消息。'),
        Array.isArray(messages) && h('ol', { style: { padding: 0, listStyle: 'none', maxHeight: 360, overflow: 'auto' } },
          ...messages.map((message, index) => h('li', { key: `${message.id}-${index}`,
            style: { ...row, flexDirection: 'column', alignItems: message.senderId === account.id ? 'flex-end' : 'flex-start' } },
          h('small', null, h('strong', { style: { color: colorOf(message.senderId || message.sender) } }, message.sender),
            ' ', message.at && new Date(message.at * 1000).toLocaleString('zh-CN')),
          h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%' } }, message.text)))),
        h('form', { onSubmit: submit },
          h('textarea', { rows: 2, maxLength: 2000, value: draft, disabled: !canSend || sending, 'aria-label': 'QQ 消息',
            onChange: event => setDraft(event.target.value), style: { width: '100%', boxSizing: 'border-box' } }),
          h('button', { type: 'submit', style: button, disabled: !canSend || sending || !draft.trim() }, '发送'),
          !canSend && h('small', null, ' 此会话未启用手动发送。'),
          notice && h('p', { role: 'status' }, notice)))
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
              'x-qqbot-service-panel': '1',
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
        tab === 'chat' && h('div', { role: 'tabpanel', id: `${instanceId}-panel-chat`, 'aria-labelledby': `${instanceId}-tab-chat` },
          state && h(Chat)),
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
