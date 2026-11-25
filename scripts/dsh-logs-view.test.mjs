// 日志页回归：只出结构化摘要，筛选、分页、导出都不带原文。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createLogsView, redact } from '../dsh-plugins/dsh-qqbot-services/logs-view.js'

const operationsLines = [
  '2026/11/24 18:00:00 服务守护：开始监测，每 30 秒一次',
  '2026/11/24 18:00:05 hindsight：启动失败 token=SECRET-ABC secret=zzz',
  '2026/11/24 18:00:10 koishi：拉起成功，恢复正常',
  '2026/11/24 18:03:00 对话：他说「今晚早点睡」 https://example.test/cb?code=SECRET123&state=1',
  '2026/11/24 18:04:00 备份：完成 runtime/backups/2026-11-24',
  '    at Object.<anonymous> (C:\\private\\stack.js:1:1)',
  'TypeError: boom at 内部函数',
]

const recallLines = [
  '2026-11-24T10:00:00.000Z recall items=12 selected=3 memoryChars=240 important=matched failedBanks=0',
  '2026-11-24T10:05:00.000Z recall items=0 selected=0 memoryChars=0 important=no-match failedBanks=1',
  '2026-11-24T10:06:00.000Z recall 查询词：海边（这一行格式不对，应该被丢掉）',
]

function build() {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-logs-'))
  const view = createLogsView({
    root,
    home: root,
    readTail: file => file.includes('services-watchdog') ? operationsLines : recallLines,
  })
  return { root, view, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('只认白名单里的两个来源', () => {
  const { view, done } = build()
  try {
    assert.equal(view.list({ source: 'secrets' }), null)
    assert.equal(view.exportText({ source: '../etc/passwd' }), null)
    assert.match(view.pathOf('operations'), /services-watchdog\.log$/)
    assert.match(view.pathOf('recall'), /linmengyao-memory\.log$/)
  } finally { done() }
})

test('列表只有结构化字段：没有对话、令牌、URL 参数和异常堆栈', () => {
  const { view, done } = build()
  try {
    const result = view.list({ source: 'operations', limit: 20 })
    assert.equal(result.total, 4, '四行能归到事件类别：守护、失败、恢复、备份；对话与堆栈解析不了')
    const text = JSON.stringify(result)
    for (const secret of ['SECRET-ABC', 'zzz', '今晚早点睡', 'code=SECRET123', 'TypeError', 'private\\stack.js', '内部函数']) {
      assert.ok(!text.includes(secret), `列表里不该出现 ${secret}`)
    }
    assert.deepEqual(result.items.map(row => row.event).slice(0, 2), ['backup', 'recovered'])
    assert.equal(result.items[0].service, 'backup')
  } finally { done() }
})

test('按状态筛选，多选是并集', () => {
  const { view, done } = build()
  try {
    const failed = view.list({ source: 'operations', events: ['failed'] })
    assert.equal(failed.total, 1)
    assert.equal(failed.items[0].service, 'hindsight')
    const both = view.list({ source: 'operations', events: ['failed', 'recovered'] })
    assert.equal(both.total, 2)
  } finally { done() }
})

test('分页：limit 与 page 越界夹回默认，翻到空页不报错', () => {
  const { view, done } = build()
  try {
    const first = view.list({ source: 'operations', limit: 2, page: 1 })
    assert.equal(first.items.length, 2)
    assert.equal(first.limit, 2)
    const second = view.list({ source: 'operations', limit: 2, page: 2 })
    assert.notDeepEqual(second.items[0], first.items[0])
    const weird = view.list({ source: 'operations', limit: 9999, page: 9999 })
    assert.equal(weird.limit, 20)
    assert.equal(weird.page, 1)
    assert.equal(view.list({ source: 'operations', limit: 2, page: 50 }).items.length, 0)
  } finally { done() }
})

test('召回日志只留计数，查询词不进结果', () => {
  const { view, done } = build()
  try {
    const result = view.list({ source: 'recall' })
    assert.equal(result.total, 2, '格式不对的那行被丢掉')
    assert.deepEqual(result.items[1], { at: '2026-11-24T10:00:00.000Z', items: 12, selected: 3, chars: 240, important: 'matched', failed: 0 })
    assert.ok(!JSON.stringify(result).includes('海边'))
  } finally { done() }
})

test('导出是结构化摘要，且不含任何原文', () => {
  const { view, done } = build()
  try {
    const text = view.exportText({ source: 'operations' })
    assert.match(text, /^# 林梦瑶 · 运维事件/m)
    assert.match(text, /hindsight 运行异常/)
    assert.match(text, /2026\/11\/24 18:04:00 backup 备份/)
    for (const secret of ['SECRET-ABC', 'zzz', '今晚早点睡', 'code=SECRET123', 'TypeError', 'stack.js']) {
      assert.ok(!text.includes(secret), `导出里不该出现 ${secret}`)
    }
    const recall = view.exportText({ source: 'recall' })
    assert.match(recall, /召回 items=12 selected=3 chars=240 important=配对成功 failed=0/)
    assert.ok(!recall.includes('海边'))
  } finally { done() }
})

test('导出最多 500 条，导两次内容一样', () => {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-logs-'))
  const many = Array.from({ length: 600 }, (_, index) => `2026/11/24 18:00:00 koishi：拉起 ${index}`)
  const view = createLogsView({ root, home: root, readTail: () => many })
  try {
    const text = view.exportText({ source: 'operations' })
    const rows = text.split('\n').filter(line => !line.startsWith('#'))
    assert.equal(rows.length, 500, '导出与解析层都最多 500 条')
    assert.equal(view.exportText({ source: 'operations' }), text)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('redact 兜底：令牌、URL 参数和长串都抹掉', () => {
  assert.equal(redact('token=abc cookie:xyz'), 'token=<隐藏> cookie:<隐藏>')
  assert.equal(redact('https://x.test/cb?code=abc&state=1'), 'https://x.test/cb?code=<隐藏>&state=<隐藏>')
  assert.match(redact('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'), /<隐藏>/)
})
