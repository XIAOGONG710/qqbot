/**
 * Delivery back to the Trigger's own thread: the paper's "结果回投来源" hop.
 *
 * A ticket remembers where it came from (`source`, `url`, `repo`, `externalId`, `threadId`). When
 * it finishes, the result goes back there instead of asking the person to come and fetch it:
 *
 *   - inbox tickets  → a JSON receipt in `<inbox>/outbox/` (the same directory the trigger came from)
 *   - GitHub tickets → a comment on the issue/PR (needs a token; without one the caller falls back)
 *   - anything else  → `{ ok: false }`, and the console's event stream is the record
 *
 * Every function returns a plain object and never throws; a reply is a convenience, never a reason
 * to lose the work result.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const safeName = text => String(text).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'ticket'

/** Extracts `owner/name` and the issue/PR number from a GitHub HTML or API URL. */
export function parseGitHubTarget(url) {
  if (typeof url !== 'string' || url === '') return null
  const match = url.match(/github\.com[/:]([^/]+)\/([^/#?]+)\/(?:issues|pull)\/(\d+)/i)
  if (!match) return null
  return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) }
}

/** Writes a receipt next to the inbox that produced the ticket; resolves to the file path. */
export async function replyToInbox({ dir, ticket, result, summary }) {
  if (typeof dir !== 'string' || dir.trim() === '') return { ok: false, error: 'inbox dir is not configured' }
  const outbox = join(dir, 'outbox')
  const receipt = {
    ticketId: ticket?.id ?? '',
    title: ticket?.title ?? '',
    threadId: ticket?.threadId ?? '',
    status: result?.status ?? 'unknown',
    branch: result?.branch ?? '',
    commit: result?.commit ?? '',
    patchPath: result?.patchPath ?? '',
    draftPath: result?.draftPath ?? '',
    prUrl: result?.prUrl ?? '',
    changedFiles: result?.changedFiles ?? [],
    summary: String(summary ?? '').slice(0, 2000),
    repliedAt: new Date().toISOString(),
  }
  try {
    await mkdir(outbox, { recursive: true })
    const path = join(outbox, `${safeName(ticket?.id ?? 'ticket')}.json`)
    await writeFile(path, JSON.stringify(receipt, null, 2), 'utf8')
    return { ok: true, path }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** Posts one comment on a GitHub issue/PR. Falls back with `{ ok:false }` when there is no token. */
export async function replyToGitHub({ repo, number, token, body, apiBase = 'https://api.github.com', fetchImpl = fetch }) {
  if (typeof token !== 'string' || token.trim() === '') return { ok: false, error: 'no github token' }
  if (typeof repo !== 'string' || repo === '' || !Number.isFinite(Number(number))) return { ok: false, error: 'no github target' }
  const url = `${apiBase.replace(/\/+$/, '')}/repos/${repo}/issues/${Number(number)}/comments`
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'dsh-super-agent',
      },
      body: JSON.stringify({ body: String(body ?? '').slice(0, 60_000) }),
    })
    if (!response.ok) {
      const text = typeof response.text === 'function' ? await response.text() : ''
      return { ok: false, status: response.status, error: `github ${response.status} ${String(text).slice(0, 200)}` }
    }
    const value = typeof response.json === 'function' ? await response.json() : {}
    return { ok: true, url: value?.html_url ?? '' }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** Renders the human-facing reply body for one finished ticket. */
export function replyBody({ ticket, result, summary }) {
  const lines = [
    `**Super Agent** · 工单 \`${ticket?.id ?? ''}\` ${ticket?.title ? `— ${ticket.title}` : ''}`,
    '',
    `状态：\`${result?.status ?? 'unknown'}\``,
  ]
  if (result?.branch) lines.push(`分支：\`${result.branch}\``)
  if (result?.commit) lines.push(`提交：\`${String(result.commit).slice(0, 12)}\``)
  if (result?.prUrl) lines.push(`PR：${result.prUrl}`)
  if (Array.isArray(result?.changedFiles) && result.changedFiles.length > 0) {
    lines.push('', '改动文件：')
    for (const file of result.changedFiles.slice(0, 20)) lines.push(`- \`${file}\``)
  }
  if (summary) lines.push('', '执行摘要：', String(summary).slice(0, 1500))
  if (result?.status === 'patch') lines.push('', '> 需要人验收：patch 与 PR 草稿已生成，尚未推送。')
  if (result?.error) lines.push('', `> 失败原因：${result.error}`)
  return lines.join('\n')
}

/**
 * Delivers the result back to the source that produced the ticket.
 * `config` is the plugin's `sources` section; only the relevant branch is read.
 */
export async function replyToSource({ ticket, result, summary, config = {}, fetchImpl = fetch }) {
  if (!ticket) return { ok: false, error: 'no ticket' }
  const body = replyBody({ ticket, result, summary })
  const source = String(ticket.source ?? '')
  if (source === 'github') {
    const target = parseGitHubTarget(ticket.url) ?? parseGitHubTarget(ticket.threadId) ??
      (typeof ticket.threadId === 'string' && /^github:[^#]+#\d+$/.test(ticket.threadId)
        ? { repo: ticket.threadId.slice(7).split('#')[0], number: Number(ticket.threadId.split('#')[1]) }
        : null)
    if (target) {
      const token = config?.github?.token ?? ''
      const replied = await replyToGitHub({ ...target, token, body, fetchImpl })
      if (replied.ok || token !== '') return { ...replied, channel: 'github' }
    }
    return { ok: false, channel: 'github', error: 'no github target or token' }
  }
  if (source === 'inbox' || source === 'ci') {
    const dir = config?.inbox?.dir ?? ''
    if (dir !== '') {
      const replied = await replyToInbox({ dir, ticket, result, summary })
      return { ...replied, channel: 'inbox' }
    }
  }
  return { ok: false, channel: source || 'none', error: 'no reply channel for this source' }
}
