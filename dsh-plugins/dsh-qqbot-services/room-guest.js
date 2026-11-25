const element = id => document.getElementById(id)
const join = element('join')
const composer = element('composer')
const feed = element('feed')
const status = element('status')
const invitation = new URLSearchParams(location.hash.slice(1)).get('invite')
history.replaceState(null, '', location.pathname)
let credential
let lastId
let posting = false
const mediaUrls = new Set()

function addMedia(item, row) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = row.media === 'image' ? '查看图片' : '播放语音'
  button.addEventListener('click', async () => {
    button.disabled = true
    try {
      const response = await fetch(`media/${row.id}`, { credentials: 'omit', headers: { authorization: `Bearer ${credential}` } })
      if (!response.ok) throw Error()
      const blob = await response.blob()
      if (!item.isConnected) return
      const url = URL.createObjectURL(blob)
      mediaUrls.add(url)
      const player = document.createElement(row.media === 'image' ? 'img' : 'audio')
      if (row.media === 'image') player.alt = '房间图片'
      else player.controls = true
      player.src = url
      button.replaceWith(player)
    } catch { button.disabled = false; button.textContent = '加载失败，重试' }
  })
  item.append(document.createElement('br'), button)
}

async function request(path, data) {
  const response = await fetch(path, {
    method: 'POST', credentials: 'omit',
    headers: { 'content-type': 'application/json', 'x-qqbot-service-panel': '1',
      ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(data ?? {}),
  })
  if (!response.ok) throw Error(String(response.status))
  return response.json()
}

async function refresh() {
  if (!credential) return
  try {
    const { messages } = await request('messages')
    if (lastId !== messages.at(-1)?.id) {
      lastId = messages.at(-1)?.id
      for (const url of mediaUrls) URL.revokeObjectURL(url)
      mediaUrls.clear()
      feed.replaceChildren(...messages.map(row => {
        const item = document.createElement('li')
        const name = document.createElement('small')
        name.textContent = row.name + (row.role === 'guest' ? ' · 来宾' : '')
        item.className = row.role
        item.append(name, document.createElement('br'), document.createTextNode(row.text))
        if (row.media) addMedia(item, row)
        return item
      }))
      feed.scrollTop = feed.scrollHeight
    }
  } catch (error) {
    if (error.message === '403') {
      credential = undefined
      composer.hidden = true
      element('upload').hidden = true
      status.textContent = '来宾权限已结束。'
    }
  } finally { if (credential) setTimeout(refresh, 2500) }
}

if (!invitation) {
  join.hidden = true
  status.textContent = '请用房主给的邀请链接打开。'
}
join.addEventListener('submit', async event => {
  event.preventDefault()
  try {
    const result = await request('join', { invitation, name: element('nickname').value })
    credential = result.credential
    join.hidden = true
    composer.hidden = false
    element('upload').hidden = false
    feed.hidden = false
    status.textContent = ''
    void refresh()
  } catch { status.textContent = '邀请无效、已使用，或房间已满。' }
})
element('attachment').addEventListener('change', async event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file || posting || !credential) return
  if (file.size > 512 * 1024) { status.textContent = '附件不能超过 512 KB。'; return }
  posting = true
  status.textContent = ''
  try {
    const response = await fetch('upload', {
      method: 'POST', credentials: 'omit', body: file,
      headers: { 'content-type': 'application/octet-stream', 'x-qqbot-service-panel': '1', authorization: `Bearer ${credential}` },
    })
    if (!response.ok) throw Error()
  } catch { status.textContent = '附件未能发送。' }
  finally { posting = false }
})
composer.addEventListener('submit', async event => {
  event.preventDefault()
  if (posting || !credential) return
  const input = element('message')
  const text = input.value
  posting = true
  status.textContent = ''
  try {
    await request('post', { text })
    if (input.value === text) input.value = ''
  } catch { status.textContent = '未能确认送达，请先看消息列表。' }
  finally { posting = false }
})
