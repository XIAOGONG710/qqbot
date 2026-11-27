import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

export const FOCUS_CHECKPOINT_FILE = 'focus-checkpoints.json'
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const NEXT = /^[^\p{C}\p{Zl}\p{Zp}]{1,160}$/u
const ACTIONS = { start: 'active', wait: 'waiting', resume: 'active', finish: 'finished', interrupt: 'unknown', cancel: 'cancelled' }
const validTime = value => Number.isSafeInteger(value) && value >= 0
const invalid = () => new Error('桌面任务检查点格式无效')

function save(file, data) {
  const tmp = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(tmp, JSON.stringify(data), { flag: 'wx' }); renameSync(tmp, file) }
  finally { try { unlinkSync(tmp) } catch { /* renamed or never created */ } }
}

function load(file) {
  let data
  try { data = JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { if (error?.code === 'ENOENT') return { version: 1, tasks: [] }; throw error }
  if (data?.version !== 1 || !Array.isArray(data.tasks)) throw invalid()
  const taskIds = new Set()
  for (const task of data.tasks) {
    if (typeof task?.id !== 'string' || !ID.test(task.id) || taskIds.has(task.id) || typeof task.next !== 'string'
      || !NEXT.test(task.next) || !Array.isArray(task.steps) || task.steps[0]?.action !== 'start') throw invalid()
    taskIds.add(task.id)
    const keys = new Set()
    let previous
    for (const step of task.steps) {
      if (!step || typeof step.id !== 'string' || !ID.test(step.id) || keys.has(step.id) || !validTime(step.at)
        || (previous && (step.at < previous.at || !allowed(ACTIONS[previous.action], step.action)))) throw invalid()
      keys.add(step.id)
      previous = step
    }
  }
  if (data.tasks.filter(task => status(task) === 'active').length > 1) throw invalid()
  return data
}

const status = task => ACTIONS[task.steps.at(-1).action]
const allowed = (current, action) => {
  if (action === 'cancel') return ['active', 'waiting', 'unknown'].includes(current)
  if (current === 'active') return ['wait', 'finish', 'interrupt'].includes(action)
  if (current === 'unknown') return action === 'finish'
  return current === 'waiting' && action === 'resume'
}

export function focusCheckpoint(file, args, now = Date.now()) {
  const { taskId, operationId, action, next, claimId } = args
  if (taskId !== undefined && (typeof taskId !== 'string' || !ID.test(taskId))) throw invalid()
  if (action === 'read') {
    const { tasks } = load(file)
    const task = taskId ? tasks.find(item => item.id === taskId)
      : tasks.filter(item => ['active', 'waiting', 'unknown'].includes(status(item))).sort((a, b) => b.steps.at(-1).at - a.steps.at(-1).at)[0]
    return task ? { ...(taskId ? {} : { taskId: task.id }), status: status(task), next: task.next } : { status: 'missing' }
  }
  if (!taskId || (action !== 'dispatch' && !Object.hasOwn(ACTIONS, action)) || typeof operationId !== 'string' || !ID.test(operationId) || !validTime(now)
    || ((action === 'start' || action === 'wait') && (typeof next !== 'string' || !NEXT.test(next.trim())))) throw invalid()

  mkdirSync(dirname(file), { recursive: true })
  const lock = `${file}.lock`
  writeFileSync(lock, '', { flag: 'wx' })
  try {
    const data = load(file)
    let task = data.tasks.find(item => item.id === taskId)
    const claim = task?.steps.findLast(step => step.action === 'start' || step.action === 'resume')
    if (claimId && claim?.id !== claimId) {
      return { status: 'stale', acquired: false }
    }
    if (action === 'finish' && /^(start|resume)-[a-f0-9]{24}$/.test(claim?.id ?? '') && !claimId) {
      return { status: status(task), next: task.next, acquired: false }
    }
    if (action === 'dispatch') {
      if (!claimId || !claim || status(task) !== 'active' || claim.dispatched) return { status: task ? status(task) : 'missing', acquired: false }
      claim.dispatched = true
      save(file, data)
      return { status: 'active', acquired: true }
    }
    const replay = task?.steps.find(step => step.id === operationId)
    if (replay) {
      if (replay.action !== action) throw invalid()
      return { status: status(task), next: task.next, acquired: false }
    }
    if (task && status(task) === 'unknown' && action === 'finish' && (!claimId || !claim?.dispatched)) {
      return { status: 'unknown', next: task.next, acquired: false }
    }
    if ((action === 'start' && task) || (task && !allowed(status(task), action))) {
      return { status: status(task), next: task.next, acquired: false }
    }
    if (!task && action !== 'start') return { status: 'missing', acquired: false }
    const acquired = action === 'start' || action === 'resume'
    if (acquired && data.tasks.some(item => status(item) === 'active')) return { status: 'busy', acquired: false }
    if (task && now < task.steps.at(-1).at) throw invalid()
    if (!task) { task = { id: taskId, next: next.trim(), steps: [] }; data.tasks.push(task) }
    if (action === 'wait') task.next = next.trim()
    task.steps.push({ id: operationId, action, at: now })
    save(file, data)
    return { status: status(task), next: task.next, acquired }
  } finally { unlinkSync(lock) }
}

/** Explicit waiting releases the overlapping coarse desktop span. Active task work still wins. */
export function desktopFocusBusy(file, fallback, now) {
  const { tasks } = load(file)
  let spans = [...fallback]
  const active = []
  for (const task of tasks) {
    for (const [index, step] of task.steps.entries()) {
      const end = Math.min(task.steps[index + 1]?.at ?? now, now)
      if (end <= step.at || end < now - 2 * 86_400_000) continue
      const start = new Date(step.at)
      const until = new Date(end)
      if (ACTIONS[step.action] === 'active') active.push({ start, end: until })
      else if (step.action === 'wait') spans = spans.flatMap(span => {
        const workStart = task.steps[index - 1].at
        if (span.start.getTime() > workStart || span.end <= start || span.start >= until) return [span]
        return [...(span.start < start ? [{ start: span.start, end: start }] : []),
          ...(span.end > until ? [{ start: until, end: span.end }] : [])]
      })
    }
  }
  return [...spans, ...active]
}
