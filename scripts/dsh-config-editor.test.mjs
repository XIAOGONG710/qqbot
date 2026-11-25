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
