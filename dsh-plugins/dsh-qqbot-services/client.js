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

    // 灵犀 QQ 桥接的 MIT 主题。命名空间与上游独立，避免共装时串样式。
    const STYLE_ID = 'qqb-style'
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      // 「灵犀」皮肤：跟随 DSH 主题变量（亮/暗自动），只用 transform/opacity 过渡，
      // 没有常驻动画、没有 WebGL；动画只在进页、切页、悬停时跑一次。
      style.textContent = [
        '.qqb-page{--q-acc:var(--dsw-alias-brand-primary,#4d6bfe);--q-fg:var(--dsw-alias-label-primary,currentColor);--q-fg2:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));',
        '  --q-line:var(--dsw-alias-border-l2,rgba(127,127,127,.2));--q-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));',
        '  --q-ok:#2fbf87;--q-bad:#ef5b67;--q-warn:#e2a23b;--q-ease:cubic-bezier(.22,1,.36,1);--q-ease2:cubic-bezier(.65,0,.35,1);',
        '  --q-serif:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong",Georgia,serif;',
        '  --q-surf:color-mix(in srgb,var(--q-fg) 2.5%,transparent);',
        '  display:flex;flex-direction:column;gap:14px;font-feature-settings:"tnum"}',
        /* hero */
        '.qqb-hero{position:relative;overflow:hidden;display:flex;align-items:center;gap:18px;padding:22px 24px;border-radius:18px;border:1px solid var(--q-line);',
        '  background:radial-gradient(120% 140% at 0% 0%,color-mix(in srgb,var(--q-acc) 16%,transparent),transparent 55%),radial-gradient(90% 120% at 100% 100%,color-mix(in srgb,#b06bff 12%,transparent),transparent 60%),var(--q-surf);',
        '  animation:qqb-rise .7s var(--q-ease) both}',
        '.qqb-hero::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(115deg,transparent 30%,color-mix(in srgb,#fff 14%,transparent) 50%,transparent 70%);transform:translateX(-120%);animation:qqb-sheen 1.6s .25s var(--q-ease2) both}',
        '.qqb-mark{position:relative;flex:none;width:52px;height:52px}',
        '.qqb-mark i{position:absolute;top:50%;width:30px;height:30px;margin-top:-15px;border-radius:50%;border:1.5px solid var(--q-acc);transition:transform .6s var(--q-ease)}',
        '.qqb-mark i:first-child{left:2px;background:color-mix(in srgb,var(--q-acc) 14%,transparent)}',
        '.qqb-mark i:last-child{right:2px;border-color:#b06bff;background:color-mix(in srgb,#b06bff 10%,transparent)}',
        '.qqb-hero:hover .qqb-mark i:first-child{transform:translateX(4px)}.qqb-hero:hover .qqb-mark i:last-child{transform:translateX(-4px)}',
        '.qqb-hero-text{flex:1;min-width:0}',
        '.qqb-name{margin:2px 0 4px;font-family:var(--q-serif);font-weight:600;font-size:30px;letter-spacing:.18em;line-height:1.15;',
        '  color:var(--q-fg)}',
        '.qqb-tag{margin:0;font-size:12px;color:var(--q-fg2);letter-spacing:.04em}',
        '.qqb-pill{flex:none;display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;font-size:12px;border:1px solid var(--q-line);background:color-mix(in srgb,var(--q-fg) 4%,transparent);transition:border-color .4s,color .4s}',
        '.qqb-pill-dot{width:7px;height:7px;border-radius:50%;background:var(--q-fg2)}',
        '.qqb-pill.is-ok{color:var(--q-ok);border-color:color-mix(in srgb,var(--q-ok) 40%,transparent)}.qqb-pill.is-ok .qqb-pill-dot{background:var(--q-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--q-ok) 22%,transparent)}',
        '.qqb-pill.is-warn{color:var(--q-warn);border-color:color-mix(in srgb,var(--q-warn) 40%,transparent)}.qqb-pill.is-warn .qqb-pill-dot{background:var(--q-warn)}',
        '.qqb-pill.is-bad{color:var(--q-bad);border-color:color-mix(in srgb,var(--q-bad) 40%,transparent)}.qqb-pill.is-bad .qqb-pill-dot{background:var(--q-bad)}',
        /* tabs */
        '.qqb-tabs{position:sticky;top:0;z-index:2;display:grid;grid-template-columns:repeat(var(--n,4),1fr);padding:4px;border-radius:12px;border:1px solid var(--q-line);',
        '  background:var(--q-surf);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);animation:qqb-rise .7s .06s var(--q-ease) both}',
        '.qqb-tabs::before{content:"";position:absolute;top:4px;bottom:4px;left:4px;width:calc((100% - 8px) / var(--n,4));border-radius:9px;',
        '  background:color-mix(in srgb,var(--q-acc) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--q-acc) 30%,transparent);transform:translateX(calc(var(--i,0) * 100%));transition:transform .5s var(--q-ease)}',
        '.qqb-tab{position:relative;appearance:none;border:0;background:none;color:var(--q-fg2);font:inherit;font-size:13px;padding:8px 0;border-radius:9px;cursor:pointer;transition:color .3s}',
        '.qqb-tab:hover{color:var(--q-fg)}.qqb-tab[aria-selected=true]{color:var(--q-fg);font-weight:600}',
        '.qqb-tab small{display:block;font-size:10px;font-weight:400;opacity:.6;letter-spacing:.08em;margin-top:1px}',
        '.qqb-tab:focus-visible{outline:2px solid var(--q-acc);outline-offset:-2px}',
        '.qqb-sec{display:none;flex-direction:column;gap:14px}.qqb-sec.is-on{display:flex}',
        '.qqb-sec.is-on>*{animation:qqb-rise .55s var(--q-ease) both}',
        '.qqb-sec.is-on>:nth-child(2){animation-delay:.05s}.qqb-sec.is-on>:nth-child(3){animation-delay:.1s}.qqb-sec.is-on>:nth-child(4){animation-delay:.15s}.qqb-sec.is-on>:nth-child(n+5){animation-delay:.2s}',
        /* cards */
        '.qqb-card{position:relative;border:1px solid var(--q-line);border-radius:16px;padding:16px 18px;background:var(--q-surf);transition:border-color .35s var(--q-ease),box-shadow .35s var(--q-ease),transform .35s var(--q-ease)}',
        '.qqb-card:hover{border-color:color-mix(in srgb,var(--q-acc) 28%,var(--q-line));box-shadow:0 10px 30px -18px color-mix(in srgb,var(--q-acc) 45%,transparent)}',
        '.qqb-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;letter-spacing:.04em;margin:0 0 12px;color:var(--q-fg)}',
        '.qqb-title::before{content:"";width:3px;height:13px;border-radius:2px;background:linear-gradient(var(--q-acc),#b06bff)}',
        '.qqb-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px}',
        '.qqb-ok{background:var(--q-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--q-ok) 18%,transparent)}.qqb-idle{background:var(--q-fg2);opacity:.6}',
        '.qqb-kv{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12.5px;line-height:1.7;padding:5px 0;border-bottom:1px dashed color-mix(in srgb,var(--q-line) 70%,transparent)}',
        '.qqb-kv:last-child{border-bottom:0}',
        '.qqb-kv span:first-child{color:var(--q-fg2)}',
        /* controls */
        '.qqb-btn{appearance:none;border:1px solid var(--q-line);background:transparent;color:var(--q-fg);border-radius:10px;padding:6px 14px;font:inherit;font-size:12.5px;cursor:pointer;',
        '  transition:background .25s,border-color .25s,transform .2s var(--q-ease),box-shadow .25s}',
        '.qqb-btn:hover{background:var(--q-hover);border-color:color-mix(in srgb,var(--q-acc) 35%,var(--q-line))}',
        '.qqb-btn:active{transform:scale(.96)}',
        '.qqb-btn[disabled]{opacity:.42;cursor:default;transform:none}',
        '.qqb-primary{border-color:transparent;color:#fff;background:linear-gradient(120deg,var(--q-acc),color-mix(in srgb,var(--q-acc) 55%,#b06bff));box-shadow:0 6px 18px -10px var(--q-acc)}',
        '.qqb-primary:hover{background:linear-gradient(120deg,var(--q-acc),color-mix(in srgb,var(--q-acc) 40%,#b06bff));border-color:transparent;box-shadow:0 8px 22px -10px var(--q-acc);transform:translateY(-1px)}',
        '.qqb-input{background:color-mix(in srgb,var(--q-fg) 3%,transparent);border:1px solid var(--q-line);color:var(--q-fg);border-radius:10px;padding:6px 11px;font:inherit;font-size:12.5px;min-width:120px;transition:border-color .25s,box-shadow .25s}',
        '.qqb-input:focus{outline:none;border-color:var(--q-acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--q-acc) 18%,transparent)}',
        /* 开关：把原生 checkbox 画成小拨杆，点击区域和键盘操作都不变 */
        '.qqb-note{font-size:11.5px;line-height:1.65;color:var(--q-fg2);margin:8px 0 0}',
        '.qqb-warnline{font-size:12px;color:var(--q-warn)}',
        '.qqb-err{font-size:12px;color:var(--q-bad);margin:6px 0 0;animation:qqb-fade .35s var(--q-ease) both}',
        '.qqb-page pre{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--q-fg) 4%,transparent);transition:max-height .5s var(--q-ease)}',
        '.qqb-page textarea:focus{outline:none;border-color:var(--q-acc)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--q-acc) 16%,transparent)}',
        '.qqb-page ::-webkit-scrollbar{width:6px;height:6px}.qqb-page ::-webkit-scrollbar-thumb{border-radius:3px;background:color-mix(in srgb,var(--q-fg) 18%,transparent)}',
        '@keyframes qqb-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
        '@keyframes qqb-fade{from{opacity:0}to{opacity:1}}',
        '@keyframes qqb-sheen{to{transform:translateX(120%)}}',
        '@media (max-width:560px){.qqb-hero{flex-wrap:wrap;padding:18px}.qqb-name{font-size:24px}.qqb-tab small{display:none}}',
        '@media (prefers-reduced-motion:reduce){.qqb-page *,.qqb-page *::before,.qqb-page *::after,.qqb-hero,.qqb-tabs{animation:none!important;transition:none!important}}',
        '.qqb-page{box-sizing:border-box;padding:22px;max-width:960px;margin:0 auto;min-width:0}',
        '.qqb-shell{height:100%;overflow:auto}',
        '.qqb-btn:focus-visible,.qqb-input:focus-visible,.qqb-peer:focus-visible{outline:2px solid var(--q-acc);outline-offset:2px}',
        '.qqb-actions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:9px}',
        '.qqb-hero .qqb-actions{justify-content:flex-start}',
        '.qqb-services{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:12px}',
        '.qqb-service{display:flex;flex-direction:column;gap:9px;align-items:flex-start}',
        '.qqb-service .qqb-title{margin:0}',
        '.qqb-service small{color:var(--q-fg2)}',
        '.qqb-chat{container-type:inline-size}',
        '.qqb-workspace{display:grid;grid-template-columns:minmax(140px,1fr) minmax(0,3fr);border:1px solid var(--q-line);border-radius:14px;overflow:hidden;margin-top:12px}',
        '.qqb-peers{min-width:0;max-height:480px;overflow:auto;padding:10px;border-right:1px solid var(--q-line);background:var(--q-surf)}',
        '.qqb-peers .qqb-input{width:100%;min-width:0;box-sizing:border-box;margin-bottom:8px}',
        '.qqb-peer{width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;margin-bottom:3px;border-color:transparent}',
        '.qqb-peer[aria-pressed=true]{background:color-mix(in srgb,var(--q-acc) 12%,transparent);border-color:color-mix(in srgb,var(--q-acc) 30%,transparent)}',
        '.qqb-thread{min-width:0}.qqb-thread-head{padding:10px 14px;border-bottom:1px solid var(--q-line)}.qqb-thread-head h3{font-size:15px;margin:0}.qqb-thread-head select{min-width:0}',
        // 灵犀 WebChat 的头像、左右气泡和底部输入栏，颜色接 DSH 主题。
        '.qqb-feed{overflow:auto;height:clamp(180px,36vh,420px);margin:0;padding:14px 12px 8px;list-style:none;display:flex;flex-direction:column;gap:12px}',
        '.qqb-message{display:flex;gap:8px;align-items:flex-start;max-width:100%}.qqb-message.is-mine{flex-direction:row-reverse}',
        '.qqb-avatar{width:34px;height:34px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#161821;user-select:none}',
        '.qqb-body{min-width:0;max-width:78%;display:flex;flex-direction:column;gap:3px}.is-mine .qqb-body{align-items:flex-end}',
        '.qqb-sender{font-size:12px;color:var(--q-fg2);padding:0 2px}',
        '.qqb-bubble{background:color-mix(in srgb,var(--q-acc) 9%,var(--q-surf));padding:9px 12px;border-radius:14px;border-top-left-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere}',
        '.is-mine .qqb-bubble{background:var(--q-acc);color:#fff;border-radius:14px;border-top-right-radius:4px}',
        '.qqb-composer{padding:10px 12px;border-top:1px solid var(--q-line);background:var(--q-surf)}',
        '.qqb-composer-bar{display:flex;align-items:flex-end;gap:8px}.qqb-composer textarea{flex:1;min-width:0;resize:vertical}',
        '.qqb-chat-empty{margin:0;padding:12px 14px;color:var(--q-fg2)}.qqb-diagnostic{width:100%;box-sizing:border-box;resize:vertical}',
        '@container (max-width:540px){.qqb-workspace{grid-template-columns:1fr}.qqb-peers{max-height:140px;border-right:0;border-bottom:1px solid var(--q-line)}.qqb-feed{height:clamp(145px,24vh,230px)}}'
      ].join('\n')
      document.head.appendChild(style)
    }

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
      return h('div', { className: 'qqb-tabs', role: 'tablist', 'aria-label': '林梦瑶 QQ 桥接', onKeyDown: onKey,
        style: { '--n': tabs.length, '--i': index } },
        ...tabs.map(tab => h('button', {
          key: tab.id, type: 'button', role: 'tab', id: `${instanceId}-tab-${tab.id}`, 'data-tab': tab.id,
          'aria-selected': tab.id === value, 'aria-controls': `${instanceId}-panel-${tab.id}`,
          tabIndex: tab.id === value ? 0 : -1, onClick: () => onChange(tab.id), className: 'qqb-tab',
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
      return h('section', { className: 'qqb-card qqb-chat' },
        h('div', { className: 'qqb-actions' },
          h('span', null, data?.account ? `QQ 账号 ${data.account.name}（${data.account.id}）` : 'QQ 会话'),
          h('button', { type: 'button', className: 'qqb-btn', onClick: () => setRevision(value => value + 1) }, '刷新会话')),
        listError && h('p', { className: 'qqb-err', role: 'alert' }, '读不到 QQ 会话，请检查 NapCat 登录状态后刷新。'),
        !data && !listError && h('p', { className: 'qqb-note', role: 'status' }, '正在读取 QQ 会话…'),
        data && h('div', { className: 'qqb-workspace' },
          h('nav', { 'aria-label': 'QQ 会话', className: 'qqb-peers' },
            h('input', { className: 'qqb-input', value: filter, placeholder: '搜索群或好友', 'aria-label': '搜索群或好友',
              onChange: event => setFilter(event.target.value) }),
            ...data.sessions.filter(item => `${item.name} ${item.target}`.toLowerCase().includes(filter.trim().toLowerCase()))
              .map(item => h('div', { key: item.key },
                h('button', { type: 'button', className: 'qqb-btn qqb-peer', title: item.name, 'aria-pressed': item.key === key,
                  onClick: () => setKey(item.key) }, `${item.kind === 'group' ? '群' : '私聊'} · ${item.name}`)))),
          h('div', { className: 'qqb-thread' },
            session ? h(Conversation, { key: `${data.account.id}:${session.key}`, session, account: data.account,
              sendPrefix: data.sendKey === session.key ? data.sendPrefix : null, request, revision }) : h('p', { className: 'qqb-chat-empty' }, '选择一个好友或群聊。'))))
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
        h('header', { className: 'qqb-thread-head qqb-actions' },
        h('h3', null, `${session.name}（${session.target}）`),
        h('label', null, '最近消息 ', h('select', { className: 'qqb-input', value: count, onChange: event => {
          const value = Number(event.target.value)
          setCount(value)
          try { window.localStorage.setItem(viewKey, String(value)) } catch { /* 当前页面仍可设置 */ }
        } }, ...[15, 30, 60].map(value => h('option', { value, key: value }, value))))),
        messages === null && h('p', { className: 'qqb-chat-empty', role: 'status' }, '正在读取消息…'),
        messages === false && h('p', { className: 'qqb-chat-empty', role: 'status' }, '暂时读不到消息，将自动重试。'),
        messages?.length === 0 && h('p', { className: 'qqb-chat-empty' }, '近期没有消息。'),
        Array.isArray(messages) && h('ol', { className: 'qqb-feed' },
          ...messages.map((message, index) => h('li', { key: `${message.id}-${index}`,
            className: `qqb-message${message.senderId === account.id ? ' is-mine' : ''}` },
          h('span', { className: 'qqb-avatar', 'aria-hidden': true,
            style: { backgroundColor: colorOf(message.senderId || message.sender) } }, Array.from(message.sender.trim())[0] || '?'),
          h('div', { className: 'qqb-body' },
            h('small', { className: 'qqb-sender' }, message.sender, ' ',
              message.at && new Date(message.at * 1000).toLocaleString('zh-CN')),
            h('div', { className: 'qqb-bubble' }, message.text))))),
        h('form', { className: 'qqb-composer', onSubmit: submit },
          h('div', { className: 'qqb-composer-bar' },
            h('textarea', { className: 'qqb-input', rows: 2, maxLength: 2000, value: draft,
              placeholder: canSend ? '说点什么…' : undefined, disabled: !canSend || sending, 'aria-label': 'QQ 消息',
              onChange: event => setDraft(event.target.value) }),
            h('button', { type: 'submit', className: 'qqb-btn qqb-primary', disabled: !canSend || sending || !draft.trim() }, '发送')),
          !canSend && h('p', { className: 'qqb-note' }, '此会话未启用手动发送。'),
          notice && h('p', { className: 'qqb-note', role: 'status' }, notice)))
    }

    function Panel() {
      ensureStyle()
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
      const linked = health?.napcat && health.lastConnection?.state === 'connected' && health.koishiListening
      const statusText = !health ? '正在检查' : health.maintenance ? '维护中' : linked ? 'QQ 已连接' : 'QQ 待连接'
      const section = (id, ...children) => h('div', { className: `qqb-sec${tab === id ? ' is-on' : ''}`, role: 'tabpanel',
        id: `${instanceId}-panel-${id}`, 'aria-labelledby': `${instanceId}-tab-${id}`, hidden: tab !== id }, ...children)
      return h('div', { className: 'qqb-shell' }, h('section', { className: 'qqb-page' },
        h('header', { className: 'qqb-hero' },
          h('div', { className: 'qqb-mark', 'aria-hidden': true }, h('i'), h('i')),
          h('div', { className: 'qqb-hero-text' },
            h('h2', { className: 'qqb-name' }, '林梦瑶'),
            h('p', { className: 'qqb-tag' }, 'QQ 桥接')),
          h('span', { className: `qqb-pill ${linked && !health?.maintenance ? 'is-ok' : health ? 'is-warn' : ''}`, role: 'status' },
            h('span', { className: 'qqb-pill-dot', 'aria-hidden': true }), statusText)),
        h(Tabs, { value: tab, onChange: selectTab, instanceId }),
        !state && h('p', { className: 'qqb-note', role: 'status' }, '正在获取服务状态，无法连接时会自动重试。'),
        health?.maintenance && h('p', { className: 'qqb-warnline', role: 'status' }, '正在维护，启动暂不可用。'),
        notice && h('p', { className: 'qqb-note', role: 'status' }, notice),
        section('chat', tab === 'chat' && state && h(Chat)),
        section('home',
          h('div', { className: 'qqb-actions' },
            state?.checkedAt && h('small', { className: 'qqb-note' }, `最近探测 ${new Date(state.checkedAt).toLocaleTimeString('zh-CN')}`),
            h('button', { className: 'qqb-btn qqb-primary', onClick: () => start('all'), disabled: blocked }, '按顺序启动缺失服务')),
          h('div', { className: 'qqb-services' }, ...['napcat', 'hindsight', 'koishi', 'watchdog'].map(service =>
            h('section', { key: service, className: 'qqb-card qqb-service' },
              h('h3', { className: 'qqb-title' }, service === 'watchdog' ? '自动守护' : names[service]),
              h('small', null, h('span', { className: `qqb-dot ${isReady(service) ? 'qqb-ok' : 'qqb-idle'}`, 'aria-hidden': true }),
                service === 'watchdog' ? (health ? (health.watchdog ? '运行中' : '未运行') : '状态未知') : summary(health, service)),
              operation?.steps?.[service] && h('small', null, steps[operation.steps[service]]),
              service !== 'watchdog' && h('button', { className: 'qqb-btn', disabled: blocked || isReady(service) || health?.launchers?.[service],
                'aria-label': `启动 ${names[service]}`, onClick: () => start(service) }, '启动'))))),
        section('link', h('section', { className: 'qqb-card' }, h('h3', { className: 'qqb-title' }, '服务连接'),
          ...['napcat', 'koishi', 'hindsight'].map(service => h('div', { key: service, className: 'qqb-kv' },
            h('span', null, names[service]),
            h('span', null, health?.ports?.[service] ? `${health.ports[service]} · ${summary(health, service)}` : summary(health, service)))))),
        section('sys',
          state?.diagnostic && h('section', { className: 'qqb-card', 'aria-label': '链路诊断' },
            h('div', { className: 'qqb-actions' }, h('h3', { className: 'qqb-title' }, '链路诊断'),
              h('button', { className: 'qqb-btn', onClick: copyDiagnostic }, '复制诊断')),
            copyStatus && h('p', { className: 'qqb-note', role: 'status' }, copyStatus),
            diagnosticOpen && h('textarea', { className: 'qqb-input qqb-diagnostic', 'aria-label': '诊断报告',
              readOnly: true, value: state.diagnostic, rows: 10 })),
          h('section', { className: 'qqb-card' }, h('h3', { className: 'qqb-title' }, '最近后台事件'),
            state?.events?.length
              ? state.events.map(({ at, service, event }, index) => h('div', { className: 'qqb-kv', key: `${at}-${index}` },
                h('span', null, at), h('span', null, `${names[service]} · ${eventNames[event]}`)))
              : h('p', { className: 'qqb-note' }, '暂无后台事件。')))))
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
