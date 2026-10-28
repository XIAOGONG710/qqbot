// 他的评价：👍 +1 / 😐 0 / 👎 -1，写进 SOUL 的评分文件，决定她能不能改 SOUL
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
