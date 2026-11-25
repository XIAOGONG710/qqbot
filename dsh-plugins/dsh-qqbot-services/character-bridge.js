// DSH 面板这边的角色资料读写：和 Koishi 控制台共用 packages/character-tools/src/character-editing.ts 那一层。
// 面板进程读不了 TypeScript，所以每次请求起一个短命子进程跑 character-cli.ts，JSON 进 JSON 出；
// 这个文件只做参数白名单和超时，不自己校验资料，也不碰文件。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const parts = ['persona', 'scenes', 'schedule', 'tiers', 'moods', 'books']

/** 请求体只认这三样，别的东西不进子进程（save 是会写盘的） */
function pick(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const { part, value, token } = body
  if (typeof part !== 'string' || !parts.includes(part)) return null
  if (token !== undefined && typeof token !== 'string') return null
  if (value === undefined) return null
  return { part, value, token }
}

export function createCharacterBridge({ root, sourceDir, stDir, prefix, timeout = 20_000 }) {
  const script = join(root, 'packages', 'character-tools', 'src', 'character-cli.ts')
  if (!existsSync(script)) throw Error('character_cli_missing')

  function once(command, input) {
    const args = [process.execPath, '--import', 'tsx', script, command, '--source', sourceDir, '--out', stDir, '--prefix', prefix]
    return new Promise((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), {
        cwd: root, windowsHide: true, timeout,
        env: { ...process.env, NODE_OPTIONS: '', NO_COLOR: '1' },
      })
      let out = ''
      let failed = false
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { if (out.length < 8_000_000) out += chunk })
      child.stderr.on('data', () => { failed = true })
      child.on('error', reject)
      child.on('close', code => {
        if (code !== 0 || failed) return reject(Error('character_cli_failed'))
        try { resolve(JSON.parse(out)) } catch { reject(Error('character_cli_failed')) }
      })
      child.stdin.end(input === undefined ? '' : JSON.stringify(input))
    })
  }

  return {
    /** 读资料：给快照 token 和每个部分；缺的部分列在 missing 里，页面不显示对应分页 */
    load: () => once('load'),
    /** 不写盘，返回会写哪些文件或要改哪里 */
    async preview(body) {
      const request = pick(body)
      return request ? once('preview', request) : { ok: false, problems: [{ part: 'output', field: '请求', kind: 'format', hint: '页面传来的内容不对，请刷新后重试。' }] }
    },
    /** 写盘：先比快照 token，再校验，最后写 source/ 和 st/；资料在别处改过就报冲突 */
    async save(body) {
      const request = pick(body)
      return request ? once('save', request) : { ok: false, problems: [{ part: 'output', field: '请求', kind: 'format', hint: '页面传来的内容不对，请刷新后重试。' }] }
    },
  }
}
