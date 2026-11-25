import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { activeKoishiPlugin } from './chat.js'

const tiers = ['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate', 'stranger']
const modes = { groupChat: ['off', 'read', 'dryRun', 'on'], proactive: ['off', 'dryRun', 'on'], oneLife: ['off', 'read', 'export', 'desktop'] }

function editAccess(config, edit) {
  const plugin = activeKoishiPlugin(config)
  if (!plugin || !Array.isArray(plugin.contacts) || !Array.isArray(edit?.contacts) || !edit.contacts.length || edit.contacts.length > 200) return null
  if (!edit.modes || typeof edit.modes !== 'object' || Array.isArray(edit.modes)) return null
  if (Object.keys(edit.modes).some(key => !Object.hasOwn(modes, key) || !modes[key].includes(edit.modes[key]))) return null
  const oldContacts = new Map(plugin.contacts.map(contact => [contact?.qq, contact]))
  const seen = new Set()
  const contacts = []
  for (const row of edit.contacts) {
    if (!Number.isSafeInteger(row?.qq) || row.qq <= 0 || seen.has(row.qq) || !tiers.includes(row.tier)
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 80) return null
    seen.add(row.qq)
    contacts.push({ ...oldContacts.get(row.qq), qq: row.qq, name: row.name.trim(), tier: row.tier })
  }
  const before = plugin.contacts.filter(contact => contact?.tier === 'boyfriend')
  const after = contacts.filter(contact => contact.tier === 'boyfriend')
  if (before.length !== 1 || after.length !== 1 || before[0].qq !== after[0].qq) return null
  const pluginKey = Object.keys(config.plugins).find(key => /^qqbot(?::[^:]+)?$/.test(key))
  config.plugins[pluginKey] = { ...plugin, contacts, ...edit.modes }
  return { pluginKey, contacts: contacts.map(({ qq, name, tier }) => ({ qq, name, tier })), modes: edit.modes }
}

/** 去掉这次编辑的字段（contacts 和改到的模式），剩下的部分应当和原来一模一样 */
function withoutEdited(config, pluginKey, modeKeys) {
  const copy = structuredClone(config)
  const plugin = copy?.plugins?.[pluginKey]
  if (plugin && typeof plugin === 'object') for (const key of ['contacts', ...modeKeys]) delete plugin[key]
  return copy
}

/** 留几份 apply 前的整份配置（里面有令牌）：够撤销最近几次就行（审查第 17 条） */
export const KEEP_BACKUPS = 5

/** 只删这个编辑器自己留的 koishi.yml.qqbot-<ticket>.bak，按修改时间留最新的 keep 份 */
export function pruneBackups(file, keep = KEEP_BACKUPS) {
  try {
    const directory = dirname(file)
    const prefix = `${basename(file)}.qqbot-`
    const backups = readdirSync(directory)
      .filter(name => name.startsWith(prefix) && name.endsWith('.bak'))
      .map(name => ({ path: join(directory, name), at: lstatSync(join(directory, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const old of backups.slice(keep)) rmSync(old.path, { force: true })
  } catch { /* 清理失败不影响这次保存 */ }
}

export function createConfigEditor({ file, yaml, now = Date.now }) {
  const drafts = new Map()
  function current() {
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw Error('config_unavailable')
    return readFileSync(file, 'utf8')
  }
  const digest = raw => createHash('sha256').update(raw).digest('hex')
  return {
    preview(edit, session) {
      const original = current()
      // 读写都用 CORE_SCHEMA（审查第 10 条）：默认 schema 会把不加引号的 2026-11-01 读成 Date、写成
      // 2026-11-01T00:00:00.000Z，<< 合并键也会被摊开。CORE 下它们原样是字符串 / 普通键，写回去还是原来的写法。
      const config = yaml.load(original, { schema: yaml.CORE_SCHEMA })
      const edited = editAccess(config, edit)
      if (!edited) return { status: 400, error: 'invalid_config_edit' }
      const { pluginKey, ...scope } = edited
      const next = yaml.dump(config, { lineWidth: -1, schema: yaml.CORE_SCHEMA })
      // 签发 ticket 之前再核一遍：按 Koishi 自己的读法（默认 schema），除了这次编辑的字段，别的一个都不能变
      if (!isDeepStrictEqual(withoutEdited(yaml.load(original), pluginKey, Object.keys(edit.modes)),
        withoutEdited(yaml.load(next), pluginKey, Object.keys(edit.modes)))) {
        return { status: 422, error: 'config_roundtrip_unsafe' }
      }
      const clock = now()
      for (const [id, draft] of drafts) if (draft.expires <= clock) drafts.delete(id)
      if (drafts.size >= 8) drafts.delete(drafts.keys().next().value)
      const ticket = randomBytes(24).toString('base64url')
      drafts.set(ticket, { session, digest: digest(original), next, expires: clock + 120_000 })
      return { status: 200, ticket, scope }
    },
    apply(ticket, session) {
      const draft = drafts.get(ticket)
      if (!draft || draft.session !== session || draft.expires <= now()) return { status: 403, error: 'confirmation_required' }
      drafts.delete(ticket)
      const original = current()
      if (digest(original) !== draft.digest) return { status: 409, error: 'config_changed' }
      const stage = `${file}.${ticket}.tmp`
      try {
        writeFileSync(stage, draft.next, { mode: 0o600, flag: 'wx' })
        if (digest(current()) !== draft.digest) return { status: 409, error: 'config_changed' }
        writeFileSync(`${file}.qqbot-${ticket}.bak`, original, { mode: 0o600, flag: 'wx' })
        if (digest(current()) !== draft.digest) return { status: 409, error: 'config_changed' }
        renameSync(stage, file)
      } finally { rmSync(stage, { force: true }) }
      pruneBackups(file)
      return { status: 200, ok: true }
    },
  }
}
