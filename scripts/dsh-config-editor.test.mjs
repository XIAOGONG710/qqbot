// 配置编辑器回归：只在临时目录里改合成 YAML，不碰 runtime/koishi。
// 覆盖：预览不写盘、只回显被编辑的字段、保留其他插件与未编辑字段、
// .bak 可撤销、文件被改过报 409、会话不符或过期报 403、oneDiary 保持关闭。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createConfigEditor } from '../dsh-plugins/dsh-qqbot-services/config-editor.js'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const original = `plugins:
  qqbot:local2:
    selfId: 10001
    token: fake-token
    oneDiary: off
    groupChat: on
    proactive: dryRun
    contacts:
      - qq: 20001
        name: 主人
        tier: boyfriend
        note: 保留我
      - qq: 20002
        name: 同学
        tier: classmate
  other-plugin:
    enable: true
    watched:
      - 一号
`

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-config-'))
  writeFileSync(join(dir, 'koishi.yml'), original)
  return dir
}

function editorFor(dir, clock = { now: 1_000_000 }) {
  return createConfigEditor({ file: join(dir, 'koishi.yml'), yaml, now: () => clock.now })
}

const edit = {
  contacts: [
    { qq: 20001, name: '主人', tier: 'boyfriend' },
    { qq: 20002, name: '同学', tier: 'bestie' },
  ],
  modes: { groupChat: 'read' },
}

test('预览只回显被编辑的字段，不整份回传 YAML', () => {
  const dir = setup()
  try {
    const editor = editorFor(dir)
    const preview = editor.preview(edit, 'session-a')
    assert.equal(preview.status, 200)
    assert.deepEqual(preview.scope, { contacts: edit.contacts, modes: { groupChat: 'read' } })
    assert.equal(readFileSync(join(dir, 'koishi.yml'), 'utf8'), original, '预览不得写盘')
    const payload = JSON.stringify(preview.scope)
    assert.ok(!payload.includes('other-plugin') && !payload.includes('watched'), '不夹带其他插件的配置')
    assert.ok(!payload.includes('fake-token'), '不夹带密钥')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('应用后保留未编辑字段与其他插件，并留一份 .bak 可撤销', () => {
  const dir = setup()
  try {
    const editor = editorFor(dir)
    const { ticket } = editor.preview(edit, 'session-a')
    assert.equal(editor.apply(ticket, 'session-a').status, 200)
    const saved = yaml.load(readFileSync(join(dir, 'koishi.yml'), 'utf8'))
    const plugin = saved.plugins['qqbot:local2']
    assert.equal(plugin.selfId, 10001, '未编辑字段保留')
    assert.equal(plugin.token, 'fake-token')
    assert.equal(plugin.oneDiary, 'off', 'oneDiary 保持关闭')
    assert.equal(plugin.groupChat, 'read', '编辑的开关生效')
    assert.equal(plugin.proactive, 'dryRun', '没提的开关不动')
    assert.equal(plugin.contacts[0].note, '保留我', '联系人里未编辑的字段保留')
    assert.equal(plugin.contacts[1].tier, 'bestie')
    assert.deepEqual(saved.plugins['other-plugin'], { enable: true, watched: ['一号'] })
    const backup = readdirSync(dir).find(name => name.endsWith('.bak'))
    assert.ok(backup, '应当留下 .bak')
    assert.equal(readFileSync(join(dir, backup), 'utf8'), original, '.bak 是改动前的原文')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('文件在预览之后被改过就报 409，不覆盖别人的改动', () => {
  const dir = setup()
  try {
    const editor = editorFor(dir)
    const { ticket } = editor.preview(edit, 'session-a')
    writeFileSync(join(dir, 'koishi.yml'), original.replace('enable: true', 'enable: false'))
    assert.deepEqual(editor.apply(ticket, 'session-a'), { status: 409, error: 'config_changed' })
    assert.ok(readFileSync(join(dir, 'koishi.yml'), 'utf8').includes('enable: false'), '不覆盖外部改动')
    assert.ok(!readdirSync(dir).some(name => name.endsWith('.tmp')), '不留下临时文件')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('会话不符或草稿过期都要重新确认', () => {
  const dir = setup()
  try {
    const clock = { now: 1_000_000 }
    const editor = editorFor(dir, clock)
    const { ticket } = editor.preview(edit, 'session-a')
    assert.deepEqual(editor.apply(ticket, 'session-b'), { status: 403, error: 'confirmation_required' })
    clock.now += 120_001
    assert.deepEqual(editor.apply(ticket, 'session-a'), { status: 403, error: 'confirmation_required' })
    assert.equal(readFileSync(join(dir, 'koishi.yml'), 'utf8'), original)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('不合规的编辑直接拒绝：空名单、错档位、主人被换掉、多出来的开关', () => {
  const dir = setup()
  try {
    const editor = editorFor(dir)
    const bad = [
      { contacts: [], modes: {} },
      { contacts: [{ qq: 20001, name: '主人', tier: 'lover' }], modes: {} },
      { contacts: [{ qq: 20002, name: '同学', tier: 'boyfriend' }], modes: {} },
      { contacts: [{ qq: 20001, name: '主人', tier: 'boyfriend' }, { qq: 20001, name: '重复', tier: 'known' }], modes: {} },
      { contacts: edit.contacts, modes: { oneDiary: 'on' } },
      { contacts: edit.contacts, modes: { unknownSwitch: 'on' } },
      { contacts: edit.contacts, modes: 'read' },
      { contacts: edit.contacts.map(row => ({ ...row, name: ' ' })), modes: {} },
    ]
    for (const item of bad) {
      assert.deepEqual(editor.preview(item, 'session-a'), { status: 400, error: 'invalid_config_edit' }, JSON.stringify(item))
    }
    assert.equal(readFileSync(join(dir, 'koishi.yml'), 'utf8'), original)
    assert.ok(!existsSync(join(dir, 'koishi.yml.tmp')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('一次草稿只能应用一次', () => {  const dir = setup()
  try {
    const editor = editorFor(dir)
    const { ticket } = editor.preview(edit, 'session-a')
    assert.equal(editor.apply(ticket, 'session-a').status, 200)
    assert.deepEqual(editor.apply(ticket, 'session-a'), { status: 403, error: 'confirmation_required' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('不加引号的日期和锚点、合并键原样写回，Koishi 读到的其他配置一个字都不变（审查第 10 条）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-config-'))
  const withDates = `shared: &shared
  retries: 3
  since: 2026-11-01
${original}  dated-plugin:
    <<: *shared
    startedAt: 2026-01-05
    label: 合成
`
  writeFileSync(join(dir, 'koishi.yml'), withDates)
  try {
    const before = yaml.load(withDates)
    assert.ok(before.plugins['dated-plugin'].startedAt instanceof Date, '前提：Koishi 的读法会把它当日期')
    const editor = editorFor(dir)
    const { status, ticket } = editor.preview(edit, 'session-a')
    assert.equal(status, 200)
    assert.equal(editor.apply(ticket, 'session-a').status, 200)
    const text = readFileSync(join(dir, 'koishi.yml'), 'utf8')
    assert.match(text, /startedAt: 2026-01-05\n/, '日期还是原来的写法')
    assert.match(text, /since: 2026-11-01\n/)
    assert.ok(!text.includes('T00:00:00'), '没有被改写成时间戳')
    assert.match(text, /<<: \*\w+/, '合并键还在，没有被摊开')
    const after = yaml.load(text)
    assert.deepEqual(after.plugins['dated-plugin'], before.plugins['dated-plugin'])
    assert.deepEqual(after.shared, before.shared)
    assert.equal(after.plugins['qqbot:local2'].groupChat, 'read')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('含令牌的 .bak 只留最近 5 份，别的文件不碰（审查第 17 条）', async () => {
  const { utimesSync } = await import('node:fs')
  const dir = setup()
  try {
    writeFileSync(join(dir, 'unrelated.bak'), 'keep me')
    writeFileSync(join(dir, 'koishi.yml.manual.bak'), 'keep me too')
    for (let index = 0; index < 6; index++) {
      const name = join(dir, `koishi.yml.qqbot-old${index}.bak`)
      writeFileSync(name, 'old')
      utimesSync(name, 1_000 + index, 1_000 + index)
    }
    const editor = editorFor(dir)
    const { ticket } = editor.preview(edit, 'session-a')
    assert.equal(editor.apply(ticket, 'session-a').status, 200)
    const left = readdirSync(dir).filter(name => /^koishi\.yml\.qqbot-.*\.bak$/.test(name)).sort()
    assert.equal(left.length, 5)
    assert.ok(left.includes(`koishi.yml.qqbot-${ticket}.bak`), '这次的备份一定留着')
    assert.ok(!left.includes('koishi.yml.qqbot-old0.bak') && !left.includes('koishi.yml.qqbot-old1.bak'), '最旧的两份删掉')
    assert.ok(existsSync(join(dir, 'unrelated.bak')) && existsSync(join(dir, 'koishi.yml.manual.bak')), '不是编辑器留的不碰')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
