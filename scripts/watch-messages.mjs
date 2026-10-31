// 实时看消息：node scripts/watch-messages.mjs [QQ号] [启动时回看几条]
// 读的是聊天的原始记录 runtime/bot-shadow/chats/<QQ>.jsonl（她和他每条都在这），每 2 秒看有没有新行。
// 只用来自查和调试；正文不经过任何加工，撤回/系统提示行原样显示。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const qq = process.argv[2] || '2260168937'
const back = Number(process.argv[3] ?? 30)
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const file = join(root, 'runtime', 'bot-shadow', 'chats', `${qq}.jsonl`)

let printed = -1

function time(iso) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '--:--:--'
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function tick() {
    let lines
    try { lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim()) } catch { return }
    if (printed < 0) printed = Math.max(0, lines.length - Math.max(0, back))
    for (; printed < lines.length; printed++) {
        let message
        try { message = JSON.parse(lines[printed]) } catch { continue }
        const who = message.role === 'assistant' ? '她' : '他'
        const text = String(message.content ?? '').replace(/\r/g, '').replace(/\n/g, ' ⏎ ')
        console.log(`${time(message.time)}  ${who}：${text}`)
    }
}

tick()
setInterval(tick, 2000)
