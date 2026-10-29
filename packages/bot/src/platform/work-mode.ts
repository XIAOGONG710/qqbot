// 他在 QQ 里切换「工作 / 聊天」的状态（每联系人一个值）
// pending：他在求她切工作，等她自己答应或拒绝（她可以提条件、可以拒绝）
import { join } from 'node:path'
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts'

/** 她自己判断这一条要动电脑时写的标记（不用他先发 /dsh）；不落模式，一次一条 */
export const WORK_MARKER = '<<用电脑>>'

/** 从她这条回复里摘出标记：摘掉标记、返回要不要干活 */
export function takeWorkMarker(text: string): { text: string; wanted: boolean } {
    if (!text.includes(WORK_MARKER)) return { text, wanted: false }
    return { text: text.split(WORK_MARKER).join('').trim(), wanted: true }
}

export type WorkMode = 'chat' | 'work' | 'pending'

type File = Record<string, WorkMode>

const pathOf = (dir: string) => join(dir, 'work-mode.json')

export function readWorkMode(dir: string, qq: number, log?: (message: string) => void): WorkMode {
    const saved = readJsonOr<File>(pathOf(dir), {}, log)
    const value = saved[String(qq)]
    return value === 'work' || value === 'pending' ? value : 'chat'
}

export function setWorkMode(dir: string, qq: number, mode: WorkMode): void {
    const saved = readJsonOr<File>(pathOf(dir), {})
    saved[String(qq)] = mode
    writeJsonAtomic(pathOf(dir), saved)
}
