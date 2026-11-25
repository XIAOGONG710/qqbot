// DSH 面板这边的角色资料读写：和 Koishi 控制台共用 packages/character-tools/src/character-editing.ts 那一层。
// 面板进程读不了 TypeScript，所以每次请求起一个短命子进程跑 character-cli.ts，JSON 进 JSON 出；
// 这个文件只做参数白名单、超时和保存的先后顺序，不自己校验资料，也不碰文件。
import { spawn as spawnProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from './logs-view.js'
import { nodeCommand } from './node-run.js'

const parts = ['persona', 'scenes', 'schedule', 'tiers', 'moods', 'books']
const badRequest = () => ({ ok: false, problems: [{ part: 'output', field: '请求', kind: 'format', hint: '页面传来的内容不对，请刷新后重试。' }] })

/** 请求体只认这三样，别的东西不进子进程（save 是会写盘的） */
function pick(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const { part, value, token } = body
  if (typeof part !== 'string' || !parts.includes(part)) return null
  if (token !== undefined && typeof token !== 'string') return null
  if (value === undefined) return null
  return { part, value, token }
}

/**
 * @param {object} options
 * @param {(text: string) => void} [options.note] 子进程 stderr 的前几百字节（脱敏后）记到这里备查
 * @param {typeof spawnProcess} [options.spawn] 测试替身
 */
export function createCharacterBridge({ root, sourceDir, stDir, prefix, timeout = 20_000, note = () => {}, spawn = spawnProcess }) {
  const script = join(root, 'packages', 'character-tools', 'src', 'character-cli.ts')
  if (!existsSync(script)) throw Error('character_cli_missing')

  function once(command, input) {
    const node = nodeCommand()
    const args = [node.command, '--no-warnings', '--import', 'tsx', script, command, '--source', sourceDir, '--out', stDir, '--prefix', prefix]
    return new Promise((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), {
        cwd: root, windowsHide: true, timeout,
        env: { ...node.env, NODE_OPTIONS: '', NO_COLOR: '1' },
      })
      let out = ''
      let err = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { if (out.length < 8_000_000) out += chunk })
      // stderr 不作为失败依据：一行无害的 ExperimentalWarning / DeprecationWarning 不该让角色页整个打不开（审查第 16 条）。
      // 成败只看退出码和 stdout 能不能解析成 JSON；stderr 只留前几百字节备查。
      child.stderr.on('data', chunk => { if (err.length < 400) err += String(chunk) })
      child.on('error', reject)
      child.on('close', code => {
        if (err.trim()) note(`${command} stderr ${redact(err.slice(0, 400).replace(/\s+/g, ' ').trim())}`)
        if (code !== 0) return reject(Error('character_cli_failed'))
        try { resolve(JSON.parse(out)) } catch { reject(Error('character_cli_failed')) }
      })
      child.stdin.end(input === undefined ? '' : JSON.stringify(input))
    })
  }

  // 保存一个接一个跑（审查第 9 条）：两次几乎同时的保存都会通过快照比较再先后写文件，后一次悄悄盖掉前一次。
  // 排队以后，第二次进子进程时快照已经变了，会照常报冲突。
  let saving = Promise.resolve()

  return {
    /** 读资料：给快照 token 和每个部分；缺的部分列在 missing 里，页面不显示对应分页 */
    load: () => once('load'),
    /** 不写盘，返回会写哪些文件或要改哪里 */
    async preview(body) {
      const request = pick(body)
      return request ? once('preview', request) : badRequest()
    },
    /** 写盘：先比快照 token，再校验，最后写 source/ 和 st/；资料在别处改过就报冲突 */
    async save(body) {
      const request = pick(body)
      // 不带快照 token 的保存一律不收：核心层没 token 就跳过冲突检查，服务端不能指望前端总会带上
      if (!request || typeof request.token !== 'string') return badRequest()
      const run = saving.then(() => once('save', request))
      saving = run.catch(() => {})
      return run
    },
  }
}
