// 他在 QQ 里切换「工作 / 聊天」的状态（每联系人一个值）
// 只做状态与提示词接线；真正调工具的那一步以后接 DSH 桥
import { join } from 'node:path'
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts'

export type WorkMode = 'chat' | 'work'

type File = Record<string, WorkMode>

const pathOf = (dir: string) => join(dir, 'work-mode.json')

export function readWorkMode(dir: string, qq: number, log?: (message: string) => void): WorkMode {
    const saved = readJsonOr<File>(pathOf(dir), {}, log)
    return saved[String(qq)] === 'work' ? 'work' : 'chat'
}

export function setWorkMode(dir: string, qq: number, mode: WorkMode): void {
    const saved = readJsonOr<File>(pathOf(dir), {})
    saved[String(qq)] = mode
    writeJsonAtomic(pathOf(dir), saved)
}
