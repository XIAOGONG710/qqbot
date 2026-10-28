// 他的评价：👍 +1 / 😐 0 / 👎 -1，写进 SOUL 的评分文件，决定她能不能改 SOUL
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts'

export function soulDir(): string {
    return process.env.QQBOT_SOUL_DIR ?? 'C:/Users/22601/.dsh/linmengyao'
}

export function addSoulRating(score: number): void {
    const file = join(soulDir(), 'RATINGS.json')
    const data = readJsonOr<{ samples?: Array<{ score: number; at: number }> }>(file, {})
    const samples = Array.isArray(data.samples) ? data.samples : []
    samples.push({ score, at: Date.now() })
    writeJsonAtomic(file, { samples: samples.slice(-100) })
}

/** 她拒绝之后写进私密日记（不给他看） */
export function appendPrivate(content: string): void {
    const text = content.trim().slice(0, 2000)
    if (!text) return
    const stamp = new Date().toISOString().slice(0, 10)
    appendFileSync(join(soulDir(), 'PRIVATE.md'), `\n## ${stamp}\n${text}\n`)
}

/** 她拒绝过的事：记下来，下次提示词里带上，不能一拒就忘 */
export function addRefusal(topic: string): void {
    const text = topic.trim().slice(0, 200)
    if (!text) return
    const file = join(soulDir(), 'REFUSALS.json')
    const data = readJsonOr<{ items?: Array<{ at: number; text: string }> }>(file, {})
    const items = Array.isArray(data.items) ? data.items : []
    items.push({ at: Date.now(), text })
    writeJsonAtomic(file, { items: items.slice(-20) })
}

/** 最近拒绝过的事，拼成一行给提示词 */
export function recentRefusals(): string | undefined {
    const file = join(soulDir(), 'REFUSALS.json')
    const data = readJsonOr<{ items?: Array<{ at: number; text: string }> }>(file, {})
    const items = (Array.isArray(data.items) ? data.items : []).slice(-3)
    if (!items.length) return undefined
    return `你最近拒绝过：${items.map(item => item.text).join('；')}。这次别装没发生过，记得自己拒绝过什么。`
}
