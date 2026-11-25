// 面板真机巡检：用真实数据（真配置、真 NapCat、真 Hindsight、真备份）把面板会调的
// 每个只读接口跑一遍，只看状态码，不打印内容，不写盘，不发 QQ 消息，不重载服务。
// 用途：面板上出现「暂时无法读取」时，先跑这个，分清是数据没有、下游没起来，还是代码问题。
// 用法：node --import tsx scripts/dsh-panel-live-check.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createChat, createNapCatReader, configuredManualOwner } from '../dsh-plugins/dsh-qqbot-services/chat.js'
import { createController } from '../dsh-plugins/dsh-qqbot-services/controller.js'
import { createCharacterBridge } from '../dsh-plugins/dsh-qqbot-services/character-bridge.js'
import { createPublicMemory } from '../dsh-plugins/dsh-qqbot-services/public-memory.js'
import { createLogsView } from '../dsh-plugins/dsh-qqbot-services/logs-view.js'
import { createRestoreStages } from './restore-stages.mjs'
import { createHandler, summarizeConnectionConfig } from '../dsh-plugins/dsh-qqbot-services/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const config = require('js-yaml').load(readFileSync(join(root, 'runtime/koishi/koishi.yml'), 'utf8'))
const owner = configuredManualOwner(config)

// 面板只读巡检不启动任何服务，健康状态直接用「都正常」；要验证启动请走运维页。
const health = { napcat: true, hindsight: true, koishi: true, koishiListening: true, maintenance: false, watchdog: true }
const controller = createController({ probe: async () => ({ ...health }), launch: async () => {}, sleep: async () => {} })
const chat = createChat(createNapCatReader({ token: process.env.QQBOT_ONEBOT_TOKEN }), { ownerId: owner })

const { createLocalPanels } = await import(pathToFileURL(join(root, 'dsh-plugins/dsh-qqbot-services/local-panels.js')).href)
const { backupEntries } = await import(pathToFileURL(join(root, 'scripts/backup-state.mjs')).href)
const local = createLocalPanels({ root, readConfig: () => config, hindsightUrl: process.env.QQBOT_HINDSIGHT_URL })
const logsView = createLogsView({ root })

// 与 index.js 的 apply() 保持一致的 details 装配
const details = async (kind, query) => {
  if (kind === 'access') return summarizeConnectionConfig(config)
  if (kind === 'logs') {
    return {
      operations: logsView.list({ source: 'operations', limit: 12 }).items,
      recall: logsView.list({ source: 'recall', limit: 12 }).items,
    }
  }
  if (kind === 'backups') return backupEntries(join(root, 'runtime', 'backups'))
  return local.details(kind, query)
}

const homeFile = resolve(process.env.QQBOT_SOUL_DIR || join(homedir(), '.dsh', 'linmengyao'), 'HOME-PUBLIC.json')
const companion = {
  home: async () => {
    const { homePlaces, homeActivities, readPublishedHomeStatus } =
      await import(pathToFileURL(join(root, 'dsh-plugins', 'dsh-linmengyao-memory', 'home-status.js')).href)
    return { places: homePlaces, activities: homeActivities, status: readPublishedHomeStatus(homeFile) }
  },
  character: createCharacterBridge({
    root,
    sourceDir: join(root, 'characters/linmengyao/source'),
    stDir: join(root, 'characters/linmengyao/st'),
    prefix: 'linmengyao',
  }),
  memory: createPublicMemory({ root, readConfig: () => config, hindsightUrl: process.env.QQBOT_HINDSIGHT_URL }),
  logs: logsView,
  restoreStages: createRestoreStages({ root }),
}

const connection = { authorizeIndex: req => req.headers.cookie === 'session=check' }
const handler = createHandler(controller, () => [], chat, connection, () => Date.now(), details, companion)

let status, payload
async function call(method, route, body) {
  const text = body === undefined ? undefined : JSON.stringify(body)
  const req = {
    method, url: '/api/qqbot-services/' + route, socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:3000', cookie: 'session=check', 'x-qqbot-service-panel': '1',
      ...(text ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) } : {}),
    },
    async *[Symbol.asyncIterator]() { if (text) yield Buffer.from(text) },
  }
  await handler(req, {
    writeHead(code) { status = code },
    end(value) { try { payload = JSON.parse(String(value)) } catch { payload = String(value) } },
  })
  // 只回状态码和错误码，不回内容：巡检输出要能贴给用户看，不能带真实数据。
  const code = payload && typeof payload === 'object' && typeof payload.error === 'string' ? ` ${payload.error}` : ''
  return { route: `${method} ${route}`, status, code }
}

const latest = backupEntries(join(root, 'runtime', 'backups')).find(item => item.complete)?.name
const checks = [
  ['GET', 'state'],
  ...['access', 'backups', 'books', 'library', 'memory', 'versions', 'logs'].map(kind => ['GET', `details/${kind}`]),
  ...(latest ? [['GET', `details/restore-check?day=${latest}`], ['GET', `backup/stages?day=${latest}`]] : []),
  ['GET', 'home'],
  ['GET', 'character'],
  ['GET', 'logs/list?source=operations'],
  ['GET', 'logs/list?source=recall'],
  ['GET', 'logs/export?source=operations'],
  ['GET', 'memory/search?q=%E6%9C%80%E8%BF%91'],
  ['GET', 'memory/graph?q=%E6%9C%80%E8%BF%91'],
  ['POST', 'chat/list'],
  ...(owner ? [['POST', `chat/history?key=private:${owner}&count=15`]] : []),
]

const results = []
for (const [method, route] of checks) results.push(await call(method, route))

for (const item of results) {
  console.log(`${item.status === 200 ? 'ok  ' : 'FAIL'} ${item.route} -> ${item.status}${item.code}`)
}
const failed = results.filter(item => item.status !== 200)
console.log(`\n共用 ${results.length} 个只读请求，${results.length - failed.length} 个正常，${failed.length} 个失败。`)
console.log(`主人在配置里是 ${owner ? '有的' : '没有的'}；当天的备份${latest ? `是 ${latest}` : '还没有'}。`)
console.log('面板显示「暂时无法读取」时：先看这里的失败项，再看面板进程是不是加载了旧代码（改了插件要重载 DSH 才生效）。')
process.exit(failed.length ? 1 : 0)
