// 面板里「她的哪一天」「哪个日历日」统一按插件配置的时区算（ADR 0331：bot 进程把 TZ 设成配置的 timeZone，默认 Asia/Shanghai）。
// DSH 面板进程自己的时区跟着机器走，和 bot 不一定一样；凡是要和 bot 写下的日子对上的地方，都不能用 Date 的本地方法。

import { activeKoishiPlugin } from './chat.js'

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
/** 她的一天从这个钟点开始（schedule.ts herDay：睡觉时刻 02:00 之前算前一天） */
export const HER_DAY_START_HOUR = 2

/** 认得的 IANA 时区名原样回；不认得、不是字符串回 null */
export function validTimeZone(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return null
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone } catch { return null }
}

/** 插件配置里的时区；没写或不认得就是 bot 的默认（Asia/Shanghai） */
export function configuredTimeZone(config) {
  let plugin = null
  try { plugin = activeKoishiPlugin(config) } catch { plugin = null }
  return validTimeZone(plugin?.timeZone) ?? DEFAULT_TIME_ZONE
}

/** 某时刻在 timeZone 里的日历日、钟点、「时:分」 */
export function zoned(date, timeZone = DEFAULT_TIME_ZONE) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const parts = Object.fromEntries(format.formatToParts(date).map(({ type, value }) => [type, value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), time: `${parts.hour}:${parts.minute}` }
}

/** YYYY-MM-DD 往前（负数）或往后挪几天，纯日历算法，不受夏令时影响 */
export function shiftDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10)
}

/** 她的哪一天：timeZone 里 02:00 之前算前一天 */
export function herDayOf(date, timeZone = DEFAULT_TIME_ZONE) {
  const { day, hour } = zoned(date, timeZone)
  return hour >= HER_DAY_START_HOUR ? day : shiftDay(day, -1)
}
