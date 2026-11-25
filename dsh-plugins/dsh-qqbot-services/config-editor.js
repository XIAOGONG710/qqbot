import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  return { contacts: contacts.map(({ qq, name, tier }) => ({ qq, name, tier })), modes: edit.modes }
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
      const config = yaml.load(original)
      const scope = editAccess(config, edit)
      if (!scope) return { status: 400, error: 'invalid_config_edit' }
      const next = yaml.dump(config, { lineWidth: -1 })
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
      return { status: 200, ok: true }
    },
  }
}
