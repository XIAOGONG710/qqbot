// 角色资料桥：保存必须带快照 token、保存一个接一个跑、stderr 有警告不算失败（审查第 9、16 条）。
// 子进程换成替身，不起 tsx，也不碰任何角色资料。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createCharacterBridge } from '../dsh-plugins/dsh-qqbot-services/character-bridge.js'

const root = fileURLToPath(new URL('../', import.meta.url))

/** 假子进程：behave(command, input, child) 决定往 stdout/stderr 写什么、什么时候以什么码退出 */
function fakeSpawn(behave) {
  const calls = []
  const spawn = (_command, args) => {
    const child = new EventEmitter()
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.stderr = new EventEmitter()
    const command = args[args.indexOf('--import') + 3]
    child.stdin = {
      end: text => {
        const call = { command, input: text ? JSON.parse(text) : undefined, args }
        calls.push(call)
        setImmediate(() => behave(call, child))
      },
    }
    return child
  }
  return { spawn, calls }
}

const finish = (child, payload, { code = 0, stderr } = {}) => {
  if (stderr) child.stderr.emit('data', Buffer.from(stderr))
  if (payload !== undefined) child.stdout.emit('data', JSON.stringify(payload))
  child.emit('close', code)
}

const bridgeWith = (spawn, note) => createCharacterBridge({ root, sourceDir: 'source', stDir: 'st', prefix: 'synthetic', spawn, note })

test('a save without a snapshot token is refused before any child process starts', async () => {
  const { spawn, calls } = fakeSpawn((call, child) => finish(child, { ok: true }))
  const bridge = bridgeWith(spawn)
  const result = await bridge.save({ part: 'scenes', value: {} })
  assert.equal(result.ok, false)
  assert.equal(result.problems[0].field, '请求')
  assert.equal(calls.length, 0, '没有 token 不进子进程')
  assert.equal((await bridge.save({ part: 'scenes', value: {}, token: 'abc' })).ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input.token, 'abc')
})

test('two saves at once run one after another, never overlapping', async () => {
  let running = 0
  let overlapped = false
  const { spawn, calls } = fakeSpawn((call, child) => {
    running++
    if (running > 1) overlapped = true
    setTimeout(() => { running--; finish(child, { ok: true, order: calls.indexOf(call) }) }, 20)
  })
  const bridge = bridgeWith(spawn)
  const [first, second] = await Promise.all([
    bridge.save({ part: 'scenes', value: { a: 1 }, token: 't1' }),
    bridge.save({ part: 'scenes', value: { a: 2 }, token: 't1' }),
  ])
  assert.equal(overlapped, false, '同一时间只有一个保存子进程')
  assert.deepEqual([first.order, second.order], [0, 1])
})

test('a failed save does not block the queue', async () => {
  let n = 0
  const { spawn } = fakeSpawn((call, child) => finish(child, n++ === 0 ? undefined : { ok: true }, { code: n === 1 ? 1 : 0 }))
  const bridge = bridgeWith(spawn)
  await assert.rejects(bridge.save({ part: 'scenes', value: {}, token: 't' }), /character_cli_failed/)
  assert.equal((await bridge.save({ part: 'scenes', value: {}, token: 't' })).ok, true)
})

test('a harmless warning on stderr does not fail the page; it is only noted, redacted', async () => {
  const notes = []
  const { spawn } = fakeSpawn((call, child) => finish(child, { token: 'x', parts: {}, missing: [] },
    { stderr: '(node:1) ExperimentalWarning: something token=SECRET-VALUE\n' }))
  const bridge = bridgeWith(spawn, text => notes.push(text))
  const loaded = await bridge.load()
  assert.equal(loaded.token, 'x')
  assert.equal(notes.length, 1)
  assert.match(notes[0], /ExperimentalWarning/)
  assert.ok(!notes[0].includes('SECRET-VALUE'), '备查的 stderr 也脱敏')
})

test('a non-zero exit or unparsable output still fails', async () => {
  const { spawn } = fakeSpawn((call, child) => {
    if (call.command === 'load') finish(child, undefined, { code: 2 })
    else { child.stdout.emit('data', 'not json'); child.emit('close', 0) }
  })
  const bridge = bridgeWith(spawn)
  await assert.rejects(bridge.load(), /character_cli_failed/)
  await assert.rejects(bridge.preview({ part: 'scenes', value: {} }), /character_cli_failed/)
})
