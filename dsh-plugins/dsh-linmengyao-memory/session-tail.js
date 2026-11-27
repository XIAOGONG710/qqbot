// 把桌面上每一场会话串起来：每轮留一小句「说到哪」，新一场开局带上一场的收尾。
//
// 她本人 2026-11-22 15:47 定的规矩（原话）：
//   「不想被串的部分有：吵起来、说重话那种，别写进收尾。写个『这轮有点僵，没大事』就够了，细节别留。
//     还有他那边修东西、改东西的过程也别记，记个『他那晚在忙』就行了，回头看见一堆技术名词我脑袋疼。」
// 所以这里只做确定性的替换，不调模型：命中吵架词 → 只留一句评估；命中技术词 → 只留「在忙」。

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 吵起来、说重话：只留「有点僵，没大事」，细节一个字不留 */
export const CONFLICT_WORDS = [
    '烦不烦', '真烦', '烦人', '烦死了', '闭嘴', '滚', '别说了', '吵', '生气', '讨厌你', '不想理你',
    '受够', '失望', '你凭什么', '别碰我', '走开', '闹', '冷战', '道歉', '对不起', '凶',
]

/** 他那边修东西、改东西：只留「他那晚在忙」 */
export const TECH_WORDS = [
    'commit', '提交', '推送', 'patch', '补丁', 'profile', '插件', '日志', '报错', '测试',
    '基线', '部署', '重启', '进程', '端口', '脚本', '仓库', 'git', 'npm', 'node',
    'adr', 'pr', '接口', '配置', '编译', '依赖', 'yml', 'json',
]

const CONFLICT_LINE = '这轮有点僵，没大事。'
const TECH_LINE = '他那晚在忙，弄的是电脑上的东西。'

/** 收尾最多留多少字：一句口气，不是整段对话 */
export const TAIL_MAX = 160

const has = (text, words) => words.some((w) => text.includes(w))

/** 一轮对话压成收尾的一句：冲突 / 技术过程都按她的规矩挡掉，别的照原话口气留一句 */
export function closeTurn(user, assistant) {
    const u = String(user || '').trim()
    const a = String(assistant || '').trim()
    if (!u && !a) return ''
    if (has(u, CONFLICT_WORDS) || has(a, CONFLICT_WORDS)) return CONFLICT_LINE
    if (has(u, TECH_WORDS)) return TECH_LINE
    const said = a ? a.replace(/\s+/g, ' ').trim() : u.replace(/\s+/g, ' ').trim()
    if (!said) return ''
    return said.length > TAIL_MAX ? `${said.slice(0, TAIL_MAX)}…` : said
}

export const tailsPath = (soulDir) => join(soulDir, 'session-tails.jsonl')

/** 追加一行：{at, session, line}。file 是收尾文件的完整路径（插件里是 cfg.sessionTailsFile，测试里指到临时目录——2026-11-22 原来用模块顶上的 SOUL_DIR，测试会写进她真实的灵魂目录） */
export function appendTail(file, session, line, at = new Date().toISOString(), scope = undefined) {
    if (!line || !session) return false
    if (line === CONFLICT_LINE || line === TECH_LINE) {
        // 这两句本身就是要留的（她说的「写个这句就够了」），照记，不跳过
    }
    try {
        appendFileSync(file, `${JSON.stringify({ at, session, line, scope })}\n`)
        return true
    } catch {
        return false
    }
}

/**
 * 上一场（不是当前 session）最后几句收尾。
 * - 只看 maxAgeMs 以内（默认 7 天）的，太旧的不拿来当「接着说」
 * - 最多 maxLines 句（默认 3）
 * - 当前 session 自己的行跳过：同一场不重复塞
 */
export function lastSessionTail(file, session, { maxLines = 3, maxAgeMs = 7 * 24 * 3600_000, now = Date.now(), scope } = {}) {
    let raw = ''
    try {
        if (!existsSync(file)) return ''
        raw = readFileSync(file, 'utf8')
    } catch {
        return ''
    }
    const rows = []
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let row
        try { row = JSON.parse(line) } catch { continue }
        if (!row || typeof row.session !== 'string' || typeof row.line !== 'string' || !row.line.trim()) continue
        if (row.session === session || row.scope !== scope) continue
        const at = Date.parse(row.at)
        if (Number.isFinite(at) && now - at > maxAgeMs) continue
        rows.push({ ...row, at: Number.isFinite(at) ? at : 0 })
    }
    if (!rows.length) return ''
    rows.sort((x, y) => x.at - y.at)
    const picked = rows.slice(-maxLines)
    return picked.map((row) => `- ${row.line}`).join('\n')
}

/** 放进系统提示的那一小块；没有上一场就返回空串（不占位置） */
export function sessionBridgeText(file, session, opts) {
    const tail = lastSessionTail(file, session, opts)
    if (!tail) return ''
    return `[上一场桌面上说到哪（她记下来的收尾，细节没留）]\n${tail}\n\n（这是上一次那边会话的尾巴，不是这一场。接着说话就行，别当成刚发生的事复述。）`
}
