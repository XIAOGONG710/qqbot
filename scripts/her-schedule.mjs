// 常驻的她什么时候做哪件事：纯函数，常驻进程和生活引擎共用，便于测试。
// 原来的毛病：睡眠整合在「本地 3 点以后」的任何时间触发（含白天，提示词却写「现在是夜里，宝宝睡了」），去重用 UTC 日期；
// 醒来完全不看钟点和她自己的状态，凌晨三点也会 25% 起来用整机权限上网。

/** 本地日期 YYYY-MM-DD（不是 UTC：本地刚过午夜不能还算前一天） */
export function localDay(at = new Date()) {
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/** 她的夜里：23:00–07:00（生活引擎 her-life.mjs 也用这个，不睡觉的时间才会醒来做事） */
export function isNightHour(hour) { return hour >= 23 || hour < 7 }

/** 睡眠整合（整理今天的事、写日记）：只在本地 03:00–07:00 做，每个本地日一次；她自己离开电脑时不做 */
export function sleepDue({ now, lastSleepDay, offline = false }) {
    if (offline) return false
    const hour = now.getHours()
    if (hour < 3 || hour >= 7) return false
    return lastSleepDay !== localDay(now)
}

/** 随机醒来做自己的事：夜里不醒、她自己在睡觉时不醒、离开电脑时不醒；其余按 chance 的概率（roll 是 [0,1) 的随机数） */
export function wakeDue({ now, roll, activity = '', offline = false, chance = 0.25 }) {
    if (offline) return false
    if (isNightHour(now.getHours())) return false
    if (activity === '睡觉') return false
    return roll < chance
}
