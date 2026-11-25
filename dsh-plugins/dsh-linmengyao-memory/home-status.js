import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const homePlaces = { living: '客厅', kitchen: '厨房', study: '书房', balcony: '阳台', garden: '花园', outside: '在外面' }
export const homeActivities = { resting: '休息', reading: '看书', cooking: '做饭', tidying: '收拾东西', zoningOut: '发会儿呆', walking: '走走' }
const lifetime = 60 * 60_000

export function publishedHomeStatus(data, now = Date.now()) {
  if (data?.version !== 1 || data.audience !== 'owner' || !Number.isSafeInteger(data.at)
    || data.at > now || data.at + lifetime <= now || typeof data.place !== 'string' || typeof data.doing !== 'string'
    || !Object.hasOwn(homePlaces, data.place)
    || !Object.hasOwn(homeActivities, data.doing)) return null
  return { place: data.place, doing: data.doing, at: data.at }
}

export function readPublishedHomeStatus(file) {
  try { return publishedHomeStatus(JSON.parse(readFileSync(file, 'utf8'))) }
  catch { return null }
}

export function publishHomeStatus(file, { place, doing, hide }, at = Date.now()) {
  const data = hide === true ? null : { version: 1, audience: 'owner', place, doing, at }
  if (data && !publishedHomeStatus(data, at)) throw Error('家中状态只接受预设地点和活动')
  mkdirSync(dirname(file), { recursive: true })
  const staging = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(staging, JSON.stringify(data), { flag: 'wx', mode: 0o600 })
    renameSync(staging, file)
  } finally { rmSync(staging, { force: true }) }
}
