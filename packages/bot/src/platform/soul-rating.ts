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

/** 他最近给她的评价：影响她说话的分寸（不是讨好，是知道最近合不合他胃口） */
export function ratingSummary(): string | undefined {
    const file = join(soulDir(), 'RATINGS.json')
    const data = readJsonOr<{ samples?: Array<{ score: number; at: number }> }>(file, {})
    const samples = (Array.isArray(data.samples) ? data.samples : []).slice(-20)
    if (samples.length < 3) return undefined
    let weighted = 0
    let total = 0
    for (const sample of samples) {
        const ageDays = Math.max(0, (Date.now() - Number(sample.at || 0)) / 86_400_000)
        const decay = Math.pow(0.5, ageDays / 7)
        weighted += Number(sample.score || 0) * decay
        total += decay
    }
    const score = (weighted / (total || 1) + 1) / 2
    if (score < 0.35) return '他最近对你的评价偏低：别急着讨好，也别硬凑；先按你自己的判断来，话少一点。'
    if (score < 0.6) return '他最近对你的评价一般：正常说话，不用刻意表现。'
    return '他最近挺买你的账：可以放松一点，但别飘。'
}
