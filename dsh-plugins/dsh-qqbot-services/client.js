window.__ModuleLoader__.load({
  id: 'dsh-qqbot-services',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const panel = 'dsh-qqbot-services'
    const api = '/api/qqbot-services'
    const tabKey = 'qqbot-services:tab'
    const tabs = [{ id: 'home', label: '总览' }, { id: 'chat', label: '聊天' }, { id: 'room', label: '会客室' },
      { id: 'house', label: '她的家' }, { id: 'soul', label: '灵魂' }, { id: 'memory', label: '记忆' }, { id: 'books', label: '读书' },
      { id: 'link', label: '连接' }, { id: 'sys', label: '系统' }]
    const names = { napcat: 'NapCat', hindsight: 'Hindsight', koishi: 'Koishi', watchdog: '守护', backup: '备份' }
    const steps = { checking: '正在检查', starting: '正在等待服务就绪', skipped: '已运行，跳过启动', ready: '已就绪', timeout: '等待就绪超时', failed: '启动或检查失败', maintenance: '维护期间暂停启动' }
    const eventNames = { watching: '开始监测', recovered: '恢复正常', starting: '尝试启动', prepared: '准备启动', failed: '运行异常', backup: '备份',
  matched: '配对成功', 'no-match': '没有配对', 'not-queried': '没查到' }

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
        '.qqb-chat-media{width:100%;padding:6px 0}.qqb-chat-media summary{cursor:pointer}.qqb-chat-media img{display:block;max-width:100%;max-height:250px;border-radius:10px}.qqb-chat-media audio{width:min(270px,100%)}',
        '.qqb-composer{padding:10px 12px;border-top:1px solid var(--q-line);background:var(--q-surf)}',
        '.qqb-composer-bar{display:flex;align-items:flex-end;gap:8px}.qqb-composer textarea{flex:1;min-width:0;resize:vertical}',
        '.qqb-chat-empty{margin:0;padding:12px 14px;color:var(--q-fg2)}.qqb-diagnostic{width:100%;box-sizing:border-box;resize:vertical}',
        '.qqb-house-scene{display:block;width:100%;height:clamp(310px,65vh,680px);border:1px solid var(--q-line);border-radius:14px;background:#151b28}',
        '.qqb-room-invite{width:100%;box-sizing:border-box;margin-top:8px}',
        '.qqb-library{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:10px}.qqb-library figure{margin:0;padding:7px;border:1px solid var(--q-line);border-radius:10px;overflow:hidden}.qqb-library img{width:100%;height:76px;object-fit:contain}.qqb-library figcaption{overflow-wrap:anywhere;font-size:12px}',
        '.qqb-memory-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;padding:0;list-style:none}.qqb-memory-grid li{border:1px solid var(--q-line);border-radius:10px;padding:8px}',
        '@media(max-width:580px){.qqb-tabs{grid-template-columns:repeat(4,1fr)}.qqb-tabs::before{display:none}.qqb-tab[aria-selected=true]{background:color-mix(in srgb,var(--q-acc) 12%,transparent)}}',
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

    function ChatMedia({ item, base = `${api}/chat/media` }) {
      const [open, setOpen] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const source = `${base}/${item.id}`
      return h('details', { className: 'qqb-chat-media', onToggle: event => setOpen(event.currentTarget.open) },
        h('summary', null, item.kind === 'image' ? '查看图片' : '播放语音'),
        open && (failed ? h('small', null, '来源已失效或格式不支持。') : item.kind === 'image'
          ? h('img', { src: source, alt: 'QQ 消息图片', onError: () => setFailed(true) })
          : h('audio', { src: source, controls: true, preload: 'none', onError: () => setFailed(true) })))
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
            h('div', { className: 'qqb-bubble' }, message.text),
            ...(message.media ?? []).map(item => h(ChatMedia, { key: item.id, item })))))),
        h('form', { className: 'qqb-composer', onSubmit: submit },
          h('div', { className: 'qqb-composer-bar' },
            h('textarea', { className: 'qqb-input', rows: 2, maxLength: 2000, value: draft,
              placeholder: canSend ? '说点什么…' : undefined, disabled: !canSend || sending, 'aria-label': 'QQ 消息',
              onChange: event => setDraft(event.target.value) }),
            h('button', { type: 'submit', className: 'qqb-btn qqb-primary', disabled: !canSend || sending || !draft.trim() }, '发送')),
          !canSend && h('p', { className: 'qqb-note' }, '此会话未启用手动发送。'),
          notice && h('p', { className: 'qqb-note', role: 'status' }, notice)))
    }

    async function roomRequest(action, data = {}, signal) {
      const response = await fetch(`${api}/room/owner/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-qqbot-service-panel': '1' },
        body: JSON.stringify(data), signal,
      })
      if (!response.ok) throw Error()
      return response.json()
    }

    function GuestRoom() {
      const [messages, setMessages] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [invite, setInvite] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const pending = React.useRef(false)
      React.useEffect(() => {
        const controller = new AbortController()
        let timer
        const read = async () => {
          try {
            const data = await roomRequest('messages', {}, controller.signal)
            if (!controller.signal.aborted) setMessages(data.messages)
          } catch { if (!controller.signal.aborted) setMessages(null) }
          finally { if (!controller.signal.aborted) timer = setTimeout(read, 2500) }
        }
        void read()
        return () => { controller.abort(); clearTimeout(timer) }
      }, [])
      const action = async (kind, text) => {
        if (pending.current) return
        if (kind === 'close' && !window.confirm('关闭会客室并撤销现有邀请和来宾权限？')) return
        pending.current = true
        setBusy(true)
        setNotice('')
        try {
          const result = await roomRequest(kind, text === undefined ? {} : { text })
          if (kind === 'invite') setInvite(result.url)
          if (kind === 'close') { setInvite(''); setMessages([]) }
          if (kind === 'post') setDraft('')
        } catch { setNotice('操作未能确认，请查看房间消息。') }
        finally { pending.current = false; setBusy(false) }
      }
      const upload = async event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file || pending.current) return
        if (file.size > 512 * 1024) { setNotice('附件不能超过 512 KB。'); return }
        pending.current = true
        setBusy(true)
        setNotice('')
        try {
          const response = await fetch(`${api}/room/owner/upload`, {
            method: 'POST', body: file,
            headers: { 'content-type': 'application/octet-stream', 'x-qqbot-service-panel': '1' },
          })
          if (!response.ok) throw Error()
        } catch { setNotice('附件未能发送。') }
        finally { pending.current = false; setBusy(false) }
      }
      return h('section', { className: 'qqb-card' },
        h('div', { className: 'qqb-actions' }, h('h3', { className: 'qqb-title' }, '网页会客室'),
          h('div', { className: 'qqb-actions' },
            h('button', { className: 'qqb-btn', type: 'button', disabled: busy, onClick: () => action('invite') }, '生成邀请'),
            h('button', { className: 'qqb-btn', type: 'button', disabled: busy, onClick: () => action('close') }, '关闭房间'))),
        invite && h('label', null, '邀请链接，一次有效',
          h('input', { className: 'qqb-input qqb-room-invite', readOnly: true, value: invite, onFocus: event => event.target.select() })),
        h('p', { className: 'qqb-note' }, '受邀成员可见。发言可能交给模型判断是否接话。'),
        messages === null ? h('p', { className: 'qqb-note', role: 'status' }, '等待读取房间消息…')
          : h('ol', { className: 'qqb-feed', 'aria-label': '会客室消息' }, ...messages.map(row =>
            h('li', { key: row.id, className: `qqb-message${row.role === 'owner' ? ' is-mine' : ''}` },
              h('div', { className: 'qqb-body' }, h('small', { className: 'qqb-sender' }, row.name, row.role === 'guest' ? ' · 来宾' : ''),
                h('div', { className: 'qqb-bubble' }, row.text),
                row.media && h(ChatMedia, { item: { id: String(row.id), kind: row.media }, base: `${api}/room/owner/media` }))))),
        h('label', { className: 'qqb-note' }, '图片或语音（最多 512 KB） ',
          h('input', { type: 'file', disabled: busy, onChange: upload, accept: 'image/png,image/jpeg,image/webp,audio/wav,audio/mpeg,audio/ogg,audio/webm' })),
        h('form', { className: 'qqb-composer-bar', onSubmit: event => {
          event.preventDefault()
          if (draft.trim()) void action('post', draft)
        } }, h('textarea', { className: 'qqb-input', rows: 2, value: draft, maxLength: 500, disabled: busy,
          onChange: event => setDraft(event.target.value), 'aria-label': '会客室消息' }),
        h('button', { className: 'qqb-btn', type: 'button', disabled: busy,
          onClick: () => setDraft(value => value.startsWith('@林梦瑶 ') ? value : `@林梦瑶 ${value}`.slice(0, 500)) }, '叫她'),
        h('button', { className: 'qqb-btn qqb-primary', type: 'submit', disabled: busy || !draft.trim() }, '发送')),
        notice && h('p', { className: 'qqb-note', role: 'status' }, notice))
    }

    function HerHome() {
      return h('iframe', { className: 'qqb-house-scene', src: `${api}/home/scene/`, title: '林梦瑶 · 她的家', referrerPolicy: 'no-referrer' })
    }

    const tierLabels = { boyfriend: '本人', bestie: '挚友', girl_friend: '女性朋友', known: '熟人', classmate: '同学', stranger: '陌生人' }
    const modeLabels = { off: '关闭', read: '只读', dryRun: '只演练', on: '开启', export: '导出状态', desktop: '桌面联动' }

    function AccessEditor({ data, onSaved }) {
      const [draft, setDraft] = React.useState(() => JSON.stringify({
        contacts: data.contacts, modes: Object.fromEntries(Object.entries(data.modes).filter(([, value]) => value !== null)),
      }, null, 2))
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      async function request(action, body) {
        const response = await fetch(`${api}/config/${action}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-qqbot-service-panel': '1' },
          body: JSON.stringify(body),
        })
        if (!response.ok) throw Error(response.status === 409 ? '配置已变化，请刷新后重新编辑。' : '配置校验或保存失败。')
        return response.json()
      }
      const submit = async event => {
        event.preventDefault()
        if (busy) return
        let data
        try { data = JSON.parse(draft) }
        catch { setNotice('导入内容需要是有效 JSON。'); return }
        setBusy(true)
        setNotice('')
        try {
          const { ticket, scope } = await request('preview', data)
          const names = scope.contacts.map(row => `${row.name}（${row.qq}，${tierLabels[row.tier]}）`).join('\n')
          const modes = Object.entries(scope.modes).map(([key, value]) => `${key}：${modeLabels[value]}`).join('\n')
          if (!window.confirm(`应用到本机 Koishi？原 YAML 会留备份，配置排版与注释会重新生成。保存后 Koishi 可能自动重载插件。\n\n${names}\n${modes}`)) return
          await request('apply', { ticket })
          onSaved()
        } catch (error) { setNotice(error.message) }
        finally { setBusy(false) }
      }
      return h('details', { className: 'qqb-note' },
        h('summary', null, '编辑或导入名单与模式'),
        h('form', { onSubmit: submit },
          h('label', null, '导入 JSON ', h('input', { type: 'file', accept: '.json,application/json', disabled: busy,
            onChange: async event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              if (file.size > 16_384) { setNotice('导入文件太大。'); return }
              try { setDraft(await file.text()) } catch { setNotice('读取导入文件失败。') }
            } })),
          h('textarea', { className: 'qqb-input qqb-diagnostic', rows: 9, value: draft, disabled: busy,
            onChange: event => setDraft(event.target.value), 'aria-label': '名单与模式 JSON' }),
          h('button', { className: 'qqb-btn', type: 'submit', disabled: busy }, '校验并预览'),
          notice && h('p', { role: 'status' }, notice)))
    }

    const partLabels = { persona: '人设', scenes: '场景', schedule: '作息', tiers: '档位', moods: '心情', books: '在读的书' }
    const kindLabels = { privacy: '这一档不该出现的说法', reference: '引用不存在', format: '格式不对' }

    /** 角色资料：和 Koishi 控制台同一层（character-editing.ts），只给人要改的部分和一个快照 token */
    function CharacterEditor() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [part, setPart] = React.useState('persona')
      const [draft, setDraft] = React.useState('')
      const [base, setBase] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const load = React.useCallback(async () => {
        try {
          const response = await fetch(`${api}/character`)
          if (!response.ok) throw Error('read')
          const data = await response.json()
          setSnapshot(data)
          const first = ['persona', 'scenes', 'schedule', 'tiers', 'moods', 'books'].find(key => data.parts[key] !== undefined && data.parts[key] !== null)
          if (first) setPart(current => (data.parts[current] !== undefined && data.parts[current] !== null ? current : first))
          return data
        } catch {
          setNotice('读不到角色资料，请确认插件仍在运行。')
          return null
        }
      }, [])
      React.useEffect(() => { void load() }, [load])
      React.useEffect(() => {
        if (!snapshot) return
        const value = snapshot.parts[part]
        const text = value === undefined || value === null ? '' : JSON.stringify(value, null, 2)
        setDraft(text)
        setBase(text)
        setResult(null)
      }, [snapshot, part])
      async function submit(mode) {
        if (busy) return
        let value
        try { value = JSON.parse(draft) }
        catch { setNotice(`${partLabels[part]}这一页要改成有效 JSON 才能检查。`); return }
        if (mode === 'save' && !window.confirm(`保存${partLabels[part]}？会同时改写 source/ 里的资料和 st/ 里重新生成的卡；Koishi 可能自动重载插件。`)) return
        setBusy(true)
        setNotice('')
        try {
          const response = await fetch(`${api}/character/${mode === 'save' ? 'save' : 'preview'}`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-qqbot-service-panel': '1' },
            body: JSON.stringify({ part, value, token: snapshot?.token }),
          })
          if (!response.ok) throw Error('request')
          const outcome = await response.json()
          setResult({ ...outcome, saved: mode === 'save' })
          if (outcome.ok && mode === 'save') {
            setNotice(`已保存，重新生成了 ${outcome.written.length} 个文件。`)
            await load()
          } else if (outcome.conflict) {
            setNotice('资料在别处改过了，已经重新读了最新的，请再改一次。')
            await load()
          }
        } catch { setNotice('请求没有完成，请稍后重试。') }
        finally { setBusy(false) }
      }
      if (!snapshot) return h('section', { className: 'qqb-card' },
        h('h3', { className: 'qqb-title' }, '角色资料'), h('p', { className: 'qqb-note', role: 'status' }, notice || '正在读资料…'))
      const dirty = draft !== base
      return h('section', { className: 'qqb-card' }, h('h3', { className: 'qqb-title' }, '角色资料'),
        h('div', { className: 'qqb-actions' }, ...['persona', 'scenes', 'schedule', 'tiers', 'moods', 'books'].map(key =>
          h('button', { key, className: `qqb-btn${key === part ? ' qqb-primary' : ''}`, disabled: busy || snapshot.parts[key] === undefined,
            onClick: () => setPart(key) }, partLabels[key]))),
        snapshot.missing?.length > 0 && h('p', { className: 'qqb-note' }, `资料里没有这些分页：${snapshot.missing.map(key => partLabels[key]).join('、')}`),
        h('textarea', { className: 'qqb-input qqb-diagnostic', rows: 14, value: draft, disabled: busy,
          onChange: event => setDraft(event.target.value), 'aria-label': `${partLabels[part]} JSON` }),
        h('div', { className: 'qqb-actions' },
          h('button', { className: 'qqb-btn', onClick: () => submit('preview'), disabled: busy || !dirty }, '检查'),
          h('button', { className: 'qqb-btn qqb-primary', onClick: () => submit('save'), disabled: busy || !dirty }, '保存'),
          h('button', { className: 'qqb-btn', onClick: () => { setDraft(base); setResult(null); setNotice('') }, disabled: busy || !dirty }, '还原'),
          h('small', { className: 'qqb-note' }, dirty ? '有没保存的修改' : '和存下的一样')),
        notice && h('p', { className: 'qqb-note', role: 'status' }, notice),
        result && !result.ok && !result.conflict && h('div', null,
          h('p', { className: 'qqb-warnline', role: 'status' }, `${result.saved ? '没有保存' : '检查没过'}：有 ${result.problems.length} 处要改（只显示位置和类别）`),
          result.problems.map((problem, index) => h('div', { className: 'qqb-kv', key: index },
            h('span', null, `${problem.field}${problem.tier ? ` · ${tierLabels[problem.tier] ?? problem.tier}` : ''}`),
            h('span', null, `${kindLabels[problem.kind] ?? '要改'} — ${problem.hint}`)))))
    }

    const certaintyLabels = { stated: '库里直接写的', inferred: '整合出来的', unknown: '来源不明' }

    function MemoryExplorer() {
      const [query, setQuery] = React.useState('')
      const [page, setPage] = React.useState(1)
      const [result, setResult] = React.useState(null)
      const [graph, setGraph] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const search = async (text, nextPage) => {
        const q = text.trim()
        if (!q) { setNotice('先写个词，我再去公共库找。'); return }
        setBusy(true)
        setNotice('')
        setGraph(null)
        try {
          const response = await fetch(`${api}/memory/search?q=${encodeURIComponent(q)}&page=${nextPage}&limit=8`)
          const outcome = await response.json()
          if (!response.ok) throw Error('request')
          setResult(outcome)
          setPage(nextPage)
          if (!outcome.linked) setNotice('还没有公布公共库，或者公共库没在运行。')
        } catch { setNotice('公共库现在连不上，等一会儿再试。') }
        finally { setBusy(false) }
      }

      const readGraph = async () => {
        const q = query.trim()
        if (!q) { setNotice('先写个词，我再去公共库找。'); return }
        setBusy(true)
        setNotice('')
        try {
          const response = await fetch(`${api}/memory/graph?q=${encodeURIComponent(q)}`)
          const outcome = await response.json()
          if (!response.ok) throw Error('request')
          setGraph(outcome)
          if (!outcome.linked) setNotice('还没有公布公共库，或者公共库没在运行。')
          else if (!outcome.edges.length) setNotice('这一段里没有能连起来的名字。')
        } catch { setNotice('公共库现在连不上，等一会儿再试。') }
        finally { setBusy(false) }
      }

      const submit = event => { event.preventDefault(); void search(query, 1) }
      const pages = result?.linked && result.total > 0 ? Math.ceil(result.total / result.limit) : 1

      return h('section', { className: 'qqb-card' }, h('h3', { className: 'qqb-title' }, '公共记忆'),
        h('form', { className: 'qqb-actions', onSubmit: submit },
          h('input', { className: 'qqb-input', type: 'search', value: query, placeholder: '想找什么？例如 海边',
            'aria-label': '公共记忆关键词', onChange: event => setQuery(event.target.value) }),
          h('button', { className: 'qqb-btn qqb-primary', type: 'submit', disabled: busy }, '找记忆'),
          h('button', { className: 'qqb-btn', type: 'button', disabled: busy, onClick: () => void readGraph() }, '看关系图')),
        notice && h('p', { className: 'qqb-note', role: 'status' }, notice),
        result?.linked && h('p', { className: 'qqb-note' },
          `这一段里找到 ${result.total} 条（第 ${result.page}/${pages} 页），只显示摘要、来源和时间，收回的不出正文。`),
        result?.items?.map(item => h('div', { className: 'qqb-kv', key: item.id },
          h('span', { className: 'qqb-tag' }, certaintyLabels[item.certainty] ?? '来源不明'),
          h('span', null, item.withdrawn ? '（这条已经收回，只留位置）' : (item.text || '（没有正文）')),
          h('small', { className: 'qqb-note' },
            [item.source ? `来源 ${item.source.document}` : '来源不明', item.when.dated ? '' : '时间不明'].filter(Boolean).join(' · ')))),
        result?.linked && pages > 1 && h('div', { className: 'qqb-actions' },
          h('button', { className: 'qqb-btn', type: 'button', disabled: busy || page <= 1, onClick: () => void search(query, page - 1) }, '上一页'),
          h('small', { className: 'qqb-note' }, `${page} / ${pages}`),
          h('button', { className: 'qqb-btn', type: 'button', disabled: busy || page >= pages, onClick: () => void search(query, page + 1) }, '下一页')),
        graph?.linked && h('div', null,
          h('h4', null, '关系图'),
          graph.nodes.length
            ? graph.nodes.map(node => h('div', { className: 'qqb-kv', key: `node-${node.name}` },
                h('span', null, node.name),
                h('small', { className: 'qqb-note' }, `${node.memories} 条 · ${certaintyLabels[node.certainty] ?? '来源不明'}`)))
            : h('p', { className: 'qqb-note' }, '这段记忆里没有可连的名字。'),
          graph.edges.length > 0 && h('div', null,
            h('h4', null, '连起来的'),
            graph.edges.map((edge, index) => h('div', { className: 'qqb-kv', key: `edge-${index}` },
              h('span', null, `${edge.from} — ${edge.to}`),
              h('small', { className: 'qqb-note' }, `共现 ${edge.memories.length} 条`))))))
    }

    const LOG_EVENT_OPTIONS = {
      operations: ['watching', 'recovered', 'starting', 'failed', 'backup'],
      recall: ['matched', 'no-match', 'not-queried', 'failed'],
    }

    function LogsPanel() {
      const [source, setSource] = React.useState('operations')
      const [events, setEvents] = React.useState([])
      const [page, setPage] = React.useState(1)
      const [data, setData] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        const query = new URLSearchParams({ source, page: String(page), limit: '20' })
        for (const event of events) query.append('event', event)
        fetch(`${api}/logs/list?${query}`)
          .then(response => response.ok ? response.json() : Promise.reject(Error('read')))
          .then(result => { if (alive) { setData(result); setNotice('') } })
          .catch(() => { if (alive) { setData(null); setNotice('读不到日志，稍后再试。') } })
        return () => { alive = false }
      }, [source, events, page])

      const pick = value => {
        setSource(value)
        setEvents([])
        setPage(1)
      }
      const toggle = event => {
        setEvents(current => current.includes(event) ? current.filter(item => item !== event) : [...current, event])
        setPage(1)
      }
      const download = async () => {
        setBusy(true)
        try {
          const query = new URLSearchParams({ source })
          for (const event of events) query.append('event', event)
          const response = await fetch(`${api}/logs/export?${query}`)
          if (!response.ok) throw Error('export')
          const text = await response.text()
          const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
          const link = document.createElement('a')
          link.href = url
          link.download = `linmengyao-${source}-${new Date().toISOString().slice(0, 10)}.txt`
          link.click()
          URL.revokeObjectURL(url)
          setNotice('已导出：只有时间、服务、事件类别和计数。')
        } catch { setNotice('导出没有完成，请稍后重试。') }
        finally { setBusy(false) }
      }

      const pages = data && data.total > 0 ? Math.ceil(data.total / data.limit) : 1
      return h('section', { className: 'qqb-card' }, h('h3', { className: 'qqb-title' }, '日志'),
        h('div', { className: 'qqb-actions' },
          h('button', { className: `qqb-btn${source === 'operations' ? ' qqb-primary' : ''}`, type: 'button', onClick: () => pick('operations') }, '运维事件'),
          h('button', { className: `qqb-btn${source === 'recall' ? ' qqb-primary' : ''}`, type: 'button', onClick: () => pick('recall') }, '召回诊断'),
          h('button', { className: 'qqb-btn', type: 'button', disabled: busy, onClick: () => void download() }, '导出脱敏摘要')),
        h('div', { className: 'qqb-actions' }, ...LOG_EVENT_OPTIONS[source].map(event =>
          h('button', { key: event, className: `qqb-btn${events.includes(event) ? ' qqb-primary' : ''}`, type: 'button',
            'aria-pressed': events.includes(event), onClick: () => toggle(event) }, eventNames[event] ?? event))),
        notice && h('p', { className: 'qqb-note', role: 'status' }, notice),
        data && h('p', { className: 'qqb-note' },
          `共 ${data.total} 条（第 ${data.page}/${pages} 页）。只显示结构化摘要，原文不在这里。`),
        data?.items?.map((row, index) => h('div', { className: 'qqb-kv', key: `${row.at}-${index}` },
          h('span', null, row.at),
          h('span', null, source === 'recall'
            ? `${eventNames[row.important] ?? row.important} · 候选 ${row.items} · 选入 ${row.selected} · 失败库 ${row.failed}`
            : `${names[row.service] ?? row.service} · ${eventNames[row.event] ?? row.event}`))),
        data && !data.items.length && h('p', { className: 'qqb-note' }, '这一组里没有记录。'),
        data && pages > 1 && h('div', { className: 'qqb-actions' },
          h('button', { className: 'qqb-btn', type: 'button', disabled: page <= 1, onClick: () => setPage(current => Math.max(1, current - 1)) }, '上一页'),
          h('small', { className: 'qqb-note' }, `${data.page} / ${pages}`),
          h('button', { className: 'qqb-btn', type: 'button', disabled: page >= pages, onClick: () => setPage(current => current + 1) }, '下一页')))
    }

    function DetailsCard({ kind }) {
      const [data, setData] = React.useState(undefined)
      const [revision, setRevision] = React.useState(0)
      const [drillStatus, setDrillStatus] = React.useState('')
      const [stageDay, setStageDay] = React.useState(null)
      const [stagePick, setStagePick] = React.useState(null)
      const busy = React.useRef(false)
      React.useEffect(() => {
        const controller = new AbortController()
        setData(undefined)
        fetch(`${api}/details/${kind}${kind === 'versions' && revision > 0 ? '?refresh=1' : ''}`, { cache: 'no-store', signal: controller.signal })
          .then(response => {
            if (!response.ok) throw Error()
            return response.json()
          }).then(value => { if (!controller.signal.aborted) setData(value) })
          .catch(() => { if (!controller.signal.aborted) setData(null) })
        return () => controller.abort()
      }, [kind, revision])
      const access = kind === 'access'
      const exportAccess = () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }))
        const link = document.createElement('a')
        link.href = url
        link.download = 'linmengyao-access.json'
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      const drill = async (day, keep = false) => {
        if (busy.current) return
        busy.current = true
        setDrillStatus('正在校验备份…')
        try {
          const verified = await fetch(`${api}/details/restore-check?${new URLSearchParams({ day })}`)
          if (!verified.ok) throw Error()
          const { databaseBytes, stateBytes } = await verified.json()
          const target = keep ? '校验通过后保留隔离副本。' : '演练结束后清理临时目录。'
          if (!window.confirm(`对 ${day} 的备份执行隔离演练？数据库制品 ${databaseBytes} 字节，状态包 ${stateBytes} 字节。${target}`)) {
            setDrillStatus('')
            return
          }
          setDrillStatus('正在隔离演练…')
          const response = await fetch(`${api}/backup/restore-drill`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-qqbot-service-panel': '1' },
            body: JSON.stringify({ day, keep }),
          })
          if (!response.ok) throw Error()
          const result = await response.json()
          setDrillStatus(result.target ? `隔离副本已验证：${result.target}` : `${day} 文件级恢复演练通过。`)
        } catch { setDrillStatus('未能完成隔离演练。') }
        finally { busy.current = false }
      }
      const runStage = async (day, stage) => {
        if (busy.current) return
        busy.current = true
        setStageDay(day)
        setStagePick({ stage, status: '正在跑…' })
        try {
          const response = await fetch(`${api}/backup/stage`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-qqbot-service-panel': '1' },
            body: JSON.stringify({ day, stage }),
          })
          const payload = await response.json()
          if (response.status === 403 && payload.error === 'needs_approval') {
            setStagePick({ stage, steps: payload.steps })
            return
          }
          if (!response.ok) throw Error()
          setStagePick({ stage, result: payload })
        } catch { setStagePick({ stage, error: true }) }
        finally { busy.current = false }
      }
      const stageLabels = { artifacts: '制品校验', files: '文件隔离恢复', database: '隔离数据库恢复', switch: '正式切换' }
      const stageView = day => {
        if (stageDay !== day) return null
        return h('div', { className: 'qqb-stage' },
          h('div', { className: 'qqb-actions' },
            ...['artifacts', 'files', 'database'].map(stage =>
              h('button', { className: 'qqb-btn', key: stage, type: 'button', onClick: () => void runStage(day, stage) }, stageLabels[stage])),
            h('button', { className: 'qqb-btn', key: 'switch', type: 'button', onClick: () => void runStage(day, 'switch') }, '切换步骤')),
          stagePick?.status && h('p', { className: 'qqb-note', role: 'status' }, `${stageLabels[stagePick.stage]}：${stagePick.status}`),
          stagePick?.error && h('p', { className: 'qqb-err', role: 'status' }, `${stageLabels[stagePick.stage]}没走通，先看运维事件。`),
          stagePick?.steps && h('div', null,
            h('p', { className: 'qqb-note' }, '正式切换会覆盖当前数据，只能按手册手动做：'),
            h('ol', null, ...stagePick.steps.map((step, index) => h('li', { key: index }, step)))),
          stagePick?.result && h('div', { className: 'qqb-kv' },
            h('span', null, stageLabels[stagePick.stage]),
            h('span', null, stagePick.result.ok
              ? (stagePick.result.stage === 'artifacts' ? `尺寸对得上 · ${stagePick.result.state.source}`
                : stagePick.result.stage === 'files' ? `${stagePick.result.files} 个文件 · 已清理`
                  : `${stagePick.result.bytes} 字节 · ${stagePick.result.isolated === 'executed' ? '已在隔离库跑过' : '只预演命令'}`)
              : `没走通：${stagePick.result.error}`)))
      }
      return h('section', { className: 'qqb-card' },
        h('div', { className: 'qqb-actions' },
          h('h3', { className: 'qqb-title' }, { access: 'QQ 接入配置', backups: '备份清单', books: '书架', library: '梗与表情', memory: '记忆连接', versions: '版本状态', logs: '本地诊断日志' }[kind]),
          h('button', { className: 'qqb-btn', type: 'button', onClick: () => setRevision(value => value + 1) }, kind === 'versions' ? '检查远端' : '刷新')),
        drillStatus && h('p', { className: 'qqb-note', role: 'status' }, drillStatus),
        data === undefined ? h('p', { className: 'qqb-note', role: 'status' }, '正在读取…')
          : data === null ? h('p', { className: 'qqb-err', role: 'status' }, '暂时无法读取。')
          : access ? h('div', null,
            h('button', { className: 'qqb-btn', type: 'button', onClick: exportAccess }, '导出名单和模式'),
            h(AccessEditor, { data, onSaved: () => { setDrillStatus('已保存本机配置。'); setRevision(value => value + 1) } }),
            ...Object.entries({ groupChat: '群聊', proactive: '主动消息', oneLife: '桌面联动' }).map(([key, label]) =>
              h('div', { className: 'qqb-kv', key }, h('span', null, label), h('span', null, modeLabels[data.modes[key]] ?? '配置未显式指定'))),
            h('h4', null, '私聊名单'),
            data.contacts.length ? data.contacts.map((contact, index) =>
              h('div', { className: 'qqb-kv', key: `${contact.qq}-${index}` },
                h('span', null, contact.name || '未命名', ' · ', String(contact.qq)), h('span', null, tierLabels[contact.tier])))
              : h('p', { className: 'qqb-note' }, '配置里没有联系人。'))
          : kind === 'books' ? h('div', null,
            data.books.length ? data.books.map(book => h('div', { className: 'qqb-kv', key: book.id },
              h('span', null, book.title, book.author && ` · ${book.author}`),
              h('span', null, book.progress ? `${book.progress.amount}${book.total !== null ? ` / ${book.total}` : ''}${book.progress.unit}${book.progress.finished ? ' · 已读完' : book.progress.stopped ? ' · 已放下' : ''}` : '暂无进度')))
              : h('p', { className: 'qqb-note' }, '本地角色卡没有书架条目。'))
          : kind === 'library' ? h('div', null,
            h('h4', null, '共享的梗'),
            data.jokes.length ? h('ul', null, ...data.jokes.map((phrase, index) => h('li', { key: index }, phrase)))
              : h('p', { className: 'qqb-note' }, '暂无能核验来源的梗。'),
            h('h4', null, '表情库'),
            data.stickers.length ? h('div', { className: 'qqb-library' }, ...data.stickers.map(sticker =>
              h('figure', { key: sticker.id }, h('img', { loading: 'lazy', src: `${api}/sticker/${sticker.id}`, alt: sticker.title || '收藏表情' }),
                h('figcaption', null, sticker.title || sticker.tags.join(' · ')))))
              : h('p', { className: 'qqb-note' }, '暂无本地收藏。'))
          : kind === 'memory' ? h('div', null,
            h('div', { className: 'qqb-kv' }, h('span', null, '桌面与 QQ 的本人记忆'), h('span', null, data.linked ? '已登记' : '未登记')),
            h('div', { className: 'qqb-kv' }, h('span', null, '公共库统计'), h('span', null,
              data.common ? `${data.common.facts} 条记忆 · ${data.common.documents} 份来源文档` : '暂无可用统计')),
            data.common?.types && h('ul', { className: 'qqb-memory-grid', 'aria-label': '公共记忆分类' },
              ...data.common.types.map(item => h('li', { key: item.type },
                `${{ world: '世界事实', experience: '共同经历', observation: '归纳观察', opinion: '观点' }[item.type]} · ${item.count}`))))
          : kind === 'versions' ? (() => {
            const relation = { same: '和远端一致', behind: '远端有新的', ahead: '本地有新的', diverged: '两边都有新提交', unknown: '没能比较' }
            const blockerNames = { 'not-main': '当前不在 main 上', 'dirty-tree': '工作区有没提交的改动', 'backup-stale': '先用一份今天的备份', diverged: '先手动处理分叉', 'no-remote': '连不上远端' }
            const backupNames = { fresh: '今天有一份', stale: '最近一份已经过期', missing: '还没备份' }
            return h('div', null,
              h('div', { className: 'qqb-kv' }, h('span', null, '本地提交'), h('code', null, data.local?.slice(0, 12) ?? '未知')),
              h('div', { className: 'qqb-kv' }, h('span', null, '远端 main'),
                h('code', null, (data.remote ?? data.tracked)?.slice(0, 12) ?? '未能读取')),
              data.relationship && h('div', { className: 'qqb-kv' }, h('span', null, '版本差异'),
                h('span', null, relation[data.relationship] ?? '没能比较')),
              Number.isFinite(data.behind) && data.behind > 0 && h('div', { className: 'qqb-kv' },
                h('span', null, '落后的提交'),
                h('span', null, `${data.behind} 个 · 涉及 ${data.changed?.count ?? 0} 个文件`)),
              data.commits?.length ? h('ul', null, ...data.commits.map(item => h('li', { key: item.short }, `${item.short} ${item.subject}`))) : null,
              data.changed?.paths?.length ? h('p', { className: 'qqb-note' }, `改动：${data.changed.paths.join('、')}`) : null,
              data.backup && h('div', { className: 'qqb-kv' }, h('span', null, '更新前备份'),
                h('span', null, `${backupNames[data.backup.state] ?? '未知'}${data.backup.latest ? `（${data.backup.latest}）` : ''}`)),
              data.blockers?.length ? h('div', null,
                h('h4', null, '更新前要处理'),
                h('ul', null, ...data.blockers.map(key => h('li', { key }, blockerNames[key] ?? key)))) : null,
              data.canFastForward ? h('div', null,
                h('p', { className: 'qqb-note' }, '可以快进；更新和服务重载在运维流程里手动做，面板不执行。'),
                h('code', null, data.commands.join(' && '))) : null,
              data.rollback?.commit && h('p', { className: 'qqb-note' }, `回滚点：${data.rollback.hint}`))
          })()
          : kind === 'logs' ? h('div', null,
            h('h4', null, '运维事件'),
            ...data.operations.map(({ at, service, event }, index) => h('div', { className: 'qqb-kv', key: `op-${index}` },
              h('span', null, at), h('span', null, `${names[service]} · ${eventNames[event]}`))),
            h('h4', null, '召回诊断'),
            ...data.recall.map((row, index) => h('div', { className: 'qqb-kv', key: `recall-${index}` },
              h('span', null, new Date(row.at).toLocaleString('zh-CN')),
              h('span', null, `候选 ${row.items} · 选入 ${row.selected} · 失败库 ${row.failed}`))),
            !data.operations.length && !data.recall.length && h('p', { className: 'qqb-note' }, '暂无可显示的诊断日志。'))
          : data.length ? data.map(backup => h('div', { key: backup.name },
            h('div', { className: 'qqb-kv' },
              h('span', null, backup.name), h('span', null, backup.complete ? '完整' : '未完成',
                Number.isFinite(backup.stateBytes) ? ` · 状态包 ${(backup.stateBytes / 1048576).toFixed(1)} MB` : ''),
              backup.complete && Number.isFinite(backup.stateBytes) && h('span', null,
                h('button', { className: 'qqb-btn', type: 'button', onClick: () => void drill(backup.name) }, '隔离演练'),
                h('button', { className: 'qqb-btn', type: 'button', onClick: () => void drill(backup.name, true) }, '保留隔离副本'),
                h('button', { className: 'qqb-btn', type: 'button', onClick: () => { setStageDay(stageDay === backup.name ? null : backup.name); setStagePick(null) } }, '分阶段'))),
            // 四阶段：前三个可以在这里跑，正式切换只给步骤。
            backup.complete && stageView(backup.name)))
            : h('p', { className: 'qqb-note' }, '暂无备份。'))
    }

    function Panel() {
      ensureStyle()
      const [state, setState] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [sending, setSending] = React.useState(false)
      const [diagnosticOpen, setDiagnosticOpen] = React.useState(false)
      const [copyStatus, setCopyStatus] = React.useState('')
      const [loadError, setLoadError] = React.useState('')
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
            const response = await fetch(`${api}/state`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
            if (!response.ok) {
              if (!controller.signal.aborted) setLoadError(`读取失败（${response.status}）`)
              throw Error()
            }
            const data = await response.json()
            if (!controller.signal.aborted) { setState(data); setLoadError('') }
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
      const koishiPort = health?.ports?.koishi
      const koishiConsole = health?.koishiListening && Number.isInteger(koishiPort) && koishiPort > 0 && koishiPort <= 65535
        ? `http://127.0.0.1:${koishiPort}` : null
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
        !state && h('p', { className: 'qqb-note', role: 'status' },
          loadError ? `${loadError}，正在重试。` : '正在获取服务状态，无法连接时会自动重试。'),
        health?.maintenance && h('p', { className: 'qqb-warnline', role: 'status' }, '正在维护，启动暂不可用。'),
        notice && h('p', { className: 'qqb-note', role: 'status' }, notice),
        section('chat', tab === 'chat' && state && h(Chat)),
        section('room', tab === 'room' && state && h(GuestRoom)),
        section('house', tab === 'house' && state && h(HerHome)),
        section('soul', tab === 'soul' && state && h(DetailsCard, { kind: 'library' }),
          tab === 'soul' && state && h(CharacterEditor),
          koishiConsole && h('section', { className: 'qqb-card' }, h('h3', { className: 'qqb-title' }, '人设管理'),
            h('a', { className: 'qqb-btn', href: `${koishiConsole}/qqbot`, target: '_blank', rel: 'noopener noreferrer' }, '打开本机人设面板'))),
        section('books', tab === 'books' && state && h(DetailsCard, { kind: 'books' })),
        section('memory', tab === 'memory' && state && h(MemoryExplorer), tab === 'memory' && state && h(DetailsCard, { kind: 'memory' })),
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
            h('span', null, health?.ports?.[service] ? `${health.ports[service]} · ${summary(health, service)}` : summary(health, service))))),
          tab === 'link' && h(DetailsCard, { kind: 'access' }),
          koishiConsole && h('div', { className: 'qqb-actions' },
            h('a', { className: 'qqb-btn', href: koishiConsole, target: '_blank', rel: 'noopener noreferrer' }, '在 Koishi 管理配置'))),
        section('sys',
          tab === 'sys' && h(DetailsCard, { kind: 'backups' }),
          tab === 'sys' && h(DetailsCard, { kind: 'versions' }),
          tab === 'sys' && h(LogsPanel),
        tab === 'sys' && h(DetailsCard, { kind: 'logs' }),
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
