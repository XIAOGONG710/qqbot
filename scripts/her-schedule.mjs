// 常驻的她什么时候做哪件事：纯函数，常驻进程用，便于测试。
// 原来的毛病：睡眠整合在「本地 3 点以后」的任何时间触发（含白天，提示词却写「现在是夜里，宝宝睡了」），去重用 UTC 日期；
// 醒来完全不看钟点和她自己的状态，凌晨三点也会 25% 起来用整机权限上网。
// ADR 0347 第 1 层（一个生活，两个地方）：她睡没睡不再看 her-life.mjs 自己推的 LIFE.json（那套生活已经拆掉），
// 只看 QQ 那边写的 NOW.md（packages/bot/src/life/now-export.ts）；NOW.md 不新鲜时才退回下面的 23–07 夜里。

/** 本地日期 YYYY-MM-DD（不是 UTC：本地刚过午夜不能还算前一天） */
export function localDay(at = new Date()) {
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/** 她的夜里：23:00–07:00。QQ 的 NOW.md 读不到 / 过期时，拿它兜底判断她睡没睡 */
export function isNightHour(hour) { return hour >= 23 || hour < 7 }

/** NOW.md 超过这么久没重写就算过期（和 now-export.ts 的 NOW_STALE_MS 一致） */
export const NOW_STALE_MS = 30 * 60_000
/** 生成时间比现在还晚这么多就不信（时钟乱了或者文件被手改过） */
export const NOW_FUTURE_MS = 60_000

/** 读 NOW.md 第一行给机器看的生成时间；没有或坏了返回 undefined */
function generatedAt(text) {
    const match = /<!--\s*generated-at:\s*(\S+?)\s*-->/.exec(String(text ?? ''))
    if (!match) return undefined
    const at = Date.parse(match[1])
    return Number.isFinite(at) ? at : undefined
}

/** NOW.md 新鲜就原样（去掉首尾空白）返回，没有 / 过期 / 时间在未来 / 没有生成时间就返回 null */
export function nowFreshText(text, now = new Date()) {
    if (typeof text !== 'string' || !text.trim()) return null
    const at = generatedAt(text)
    if (at === undefined) return null
    const age = now.getTime() - at
    if (age > NOW_STALE_MS || age < -NOW_FUTURE_MS) return null
    return text.trim()
}

/** 她这会儿睡着没有：新鲜的 NOW.md 里 `<!-- asleep: yes|no -->` 说了算；NOW.md 不可用或没写这一行，就按 23–07 夜里算 */
export function herAsleep({ nowText, now = new Date() }) {
    const fresh = nowFreshText(nowText, now)
    const said = fresh ? /<!--\s*asleep:\s*(yes|no)\s*-->/.exec(fresh) : null
    if (said) return said[1] === 'yes'
    return isNightHour(now.getHours())
}

/** 睡眠整合（整理今天的事、写日记）该不该做：03:00 之后、当天 21:00 之前、今天还没做成（10-30 用户：夜里没做成就第二天补）；她自己离开电脑时不做 */
export function sleepDue({ now, lastSleepDay, offline = false }) {
    if (offline) return false
    const hour = now.getHours()
    // 原来只认 03:00–07:00：笔记本一合盖，这一夜就永远错过了（10-30 凌晨 03–07 点一次心跳都没有）
    if (hour < 3 || hour >= 21) return false
    return lastSleepDay !== localDay(now)
}

/**
 * 随机醒来做自己的事：夜里不醒、她睡着时不醒、离开电脑时不醒；其余按 chance 的概率（roll 是 [0,1) 的随机数）。
 * 夜里这道关和「她睡着」是两道：原来一道看钟点、一道看她自己的状态，夜里不拿整机权限上网是钟点那道管的。
 * 换了睡没睡的来源（QQ 的 NOW.md）之后两道都留着——QQ 说她熬夜还醒着，夜里也照样不起来做事，只会比原来少醒、不会多醒。
 */
export function wakeDue({ now, roll, asleep = false, offline = false, chance = 0.25 }) {
    if (offline) return false
    if (isNightHour(now.getHours())) return false
    if (asleep) return false
    return roll < chance
}
