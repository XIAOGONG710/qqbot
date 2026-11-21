# Super Agent 无人值守扩展 · 模块契约（v1）

目标：把当前 bundle 补成「跨仓库并行 + 自动交付 + 无人值守」。三个新模块由不同人并行开发，**只通过本文件定义的接口互相依赖**；未列出的文件谁都不许改（`lib/engine.js`、`index.js`、`package.json`、`cordis.patch.yml` 由 Lead 独占）。

## 0. 统一术语

- **ticket**：一张工单。`{ id, title, brief, source, threadId, repo?, cwd? }`
- **worktree**：`{ path, branch, baseSha, repoDir, disposable }`
- **trigger event**（源 → 控制面）：
  ```ts
  interface TriggerEvent {
    source: 'inbox'|'github'|'ci'|'feishu'|'chat'
    author: string
    text: string            // 人类可读的请求正文（≤4000 字）
    threadId?: string       // 去重/订阅直通用的线程键（如 github:owner/repo#42）
    human?: boolean         // 是否真人发起（默认 true）
    externalId?: string     // 源侧唯一 id（issue comment id、CI run id…），用于幂等
    url?: string            // 来源链接，交付时回贴
    repo?: string           // 'owner/name' 或本地路径
    meta?: Record<string, string>
  }
  ```
- **delivery result**（交付 → 控制面）：
  ```ts
  interface DeliveryResult {
    status: 'patch'|'pushed'|'pr'|'no-change'|'failed'
    branch?: string
    commit?: string
    patchPath?: string          // 本地 patch 文件
    draftPath?: string          // PR 标题/正文草稿（无 token 时）
    prUrl?: string              // 真 PR（有 token 时）
    remoteUrl?: string
    changedFiles?: string[]
    note?: string
    error?: string
  }
  ```
  所有 `async` 函数失败时**返回** `{status:'failed', error}`，不抛；只有编程错误才抛。

## 1. `lib/worktree.js`（Lead 实现）

```js
export class WorktreeManager {
  constructor(opts: { rootDir: string, gitPath?: string, log?: (level, msg) => void })
  // 在 rootDir 下为 repoDir 建一个独立工作树，分支名 `<prefix><ticketId>`。
  async prepare(opts: { repoDir: string, ticketId: string, branchPrefix?: string, baseRef?: string }): Promise<Worktree>
  // 变更摘要（不提交）。
  async status(worktree): Promise<{ dirty: boolean, changedFiles: string[] }>
  // 删除工作树（keep=false 时连分支一起删）。永不抛。
  async dispose(worktree, opts?: { keep?: boolean }): Promise<void>
  // 列出当前登记的工作树（重启恢复用）。
  async list(): Promise<Worktree[]>
}
```

约定：分支名默认 `sa/<ticketId>`；worktree 路径 `<rootDir>/<repoSlug>/<ticketId>`；命令一律 `git -C <dir> …`，Windows 下也要能跑。

## 2. `lib/sources/*.mjs`（Source）

每个模块导出一个工厂或纯函数，**不直接依赖 engine**，只调用 `onEvent(event)`：

```js
// lib/sources/local-inbox.mjs —— 监听目录里出现的 *.json 触发器文件（离线、可无人值守）
export function createInboxSource(opts: {
  dir: string, intervalMs?: number,
  onEvent: (event: TriggerEvent) => void,
  log?: (level: string, message: string) => void,
}): { start(): void, stop(): Promise<void> }
```
语义：每 `intervalMs` 扫一遍；读到合法 JSON 就 `onEvent`，随后把文件改名 `.done`（失败 `.failed`）；同一个 `externalId` 只投一次；目录不存在就自动创建。

```js
// lib/sources/github.mjs —— 轮询 issue/PR 评论 + issue 正文（REST，无第三方依赖）
export function createGitHubSource(opts: {
  repos: string[],                 // ['owner/name']
  token?: string,                  // 无 token 时只读公共仓库、速率低
  intervalMs?: number,             // 默认 60_000
  onEvent: (event: TriggerEvent) => void,
  allowAuthors?: string[],         // 白名单（空=全部）
  log?: (level: string, message: string) => void,
  fetchImpl?: typeof fetch,        // 测试注入
  stateDir?: string,               // 存 cursor/ETag，重启不重放
}): { start(): void, stop(): Promise<void>, pollOnce(): Promise<number> }
```
语义：每个 repo 拉 `issues?state=open&sort=updated&direction=desc&per_page=30`，对每个 issue 拉 `issues/<n>/comments?per_page=30`；新 issue 正文与新增评论各产生一个 event；`threadId = github:<repo>#<n>`；`externalId` 用 `issue:<repo>#<n>:<updated_at>` 或 `comment:<id>`；用 stateDir 持久化 cursor；429/403 退避（读 `x-ratelimit-reset`）；网络错误只记日志，不抛。

```js
// lib/sources/webhook.mjs —— 入站 webhook 的签名校验与归一化（GitHub / 通用 CI）
export function verifySignature(opts: { secret: string, body: string|Buffer, header: string, algo?: 'sha256'|'sha1' }): boolean
export function parseGitHubWebhook(opts: { headers: Record<string,string>, body: string, payload: any }): TriggerEvent | null
export function parseCIWebhook(opts: { headers: Record<string,string>, body: string, payload: any }): TriggerEvent | null
```
语义：`verifySignature` 用 HMAC 常量时间比较；GitHub 解析 `issue_comment.created` / `issues.opened`，CI 解析 `{status:'failed', repo, runUrl, log}` 这类通用形状；无法识别返回 `null`。

## 3. `lib/delivery/*.mjs`（交付闭环）

```js
// lib/delivery/index.mjs —— 唯一入口
export async function deliver(opts: {
  ticket: Ticket,
  worker: { id: string, summary?: string },
  worktree: Worktree | null,
  repoDir: string,
  config: {
    mode: 'patch'|'push'|'pr',      // 默认 patch
    remote?: string,                 // 默认 'origin'
    branchPrefix?: string,           // 默认 'sa/'
    commitMessage?: string,          // 可用模板
    githubToken?: string,            // 有值且 mode='pr' 时走 GitHub API
    prBase?: string,                 // 默认仓库默认分支
    authorName?: string, authorEmail?: string,
  },
  git?: (cwd: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>, // 测试注入
  fetchImpl?: typeof fetch,
  log?: (level: string, message: string) => void,
}): Promise<DeliveryResult>
```
行为：
1. 在 worktree 里 `git status --porcelain`；无变更 → `{status:'no-change'}`；
2. `git add -A && git commit -m <message>`（未配置作者时用 `-c user.name=... -c user.email=...`，不要改全局配置）；
3. 生成 patch：`git format-patch -1 --stdout`（或 `git diff base..HEAD`）写入 `patchPath`（由调用方给 `artifactsDir` 时），并返回 `changedFiles`；
4. `mode='patch'`：结束（status:'patch'），并把 PR 标题/正文草稿写到 `draftPath`；
5. `mode='push'`：`git push -u <remote> <branch>`，status:'pushed'；
6. `mode='pr'`：push 后调 GitHub REST `POST /repos/{repo}/pulls`（token 必需），成功返回 `prUrl`；失败降级为 'pushed' 并带上 `error`；
7. 任何一步失败 → `{status:'failed', error}`，**不要回滚提交**（保留证据）。

## 4. 验收要求（两个模块都要自带，可 `node` 直接跑）

- Source：`node lib/sources/selftest.mjs` —— 覆盖 inbox 幂等/改名、GitHub 轮询游标（用 `fetchImpl` 假数据）、签名校验正负例、webhook 解析。
- Delivery：`node lib/delivery/selftest.mjs` —— 在临时目录复制一个 git 仓库、建 bare remote、验证 patch/push/pr(假 fetch)/无变更/失败五条路径。

## 5. 代码风格

- 纯 ESM `.mjs`，只用 `node:fs`、`node:path`、`node:crypto`、`node:child_process` 与全局 `fetch`；**不引第三方依赖**。
- 不写 `console.log`（用传入的 `log`，缺省空实现）。
- 所有循环有界、所有 timer 可 `stop()`，Windows 路径用 `node:path` 处理。
