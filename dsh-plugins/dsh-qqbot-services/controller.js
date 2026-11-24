export const services = ['napcat', 'hindsight', 'koishi']
const waitMs = { napcat: 120_000, hindsight: 300_000, koishi: 60_000 }

export const ready = (status, service) =>
  service === 'koishi' ? status.koishi && status.koishiListening : status[service] === true

export function createController({ probe, launch, sleep, now = Date.now }) {
  let task
  let pending
  let checked
  let operation
  let closed = false

  async function status(fresh = false) {
    if (!fresh && checked && now() - checked.at < 3_000) return checked.value
    pending ??= Promise.resolve().then(probe).then(value => {
      if (![...services, 'koishiListening', 'watchdog', 'maintenance'].every(key => typeof value?.[key] === 'boolean')) {
        throw new Error('Invalid service status')
      }
      checked = { at: now(), value }
      return value
    }).finally(() => { pending = undefined })
    return pending
  }

  async function run(work) {
    for (const service of work) {
      operation.current = service
      operation.steps[service] = 'checking'
      let state = await status(true)
      if (closed) return
      if (ready(state, service)) {
        operation.steps[service] = 'skipped'
        continue
      }
      if (state.maintenance) {
        operation.steps[service] = 'maintenance'
        return
      }

      if (!state.launchers?.[service] && !(service === 'koishi' && state.koishiProcesses > 0)) {
        await launch(service)
      }
      operation.steps[service] = 'starting'
      const deadline = now() + waitMs[service]
      do {
        await sleep(2500)
        if (closed) return
        state = await status(true)
        if (ready(state, service)) break
        if (state.maintenance) {
          operation.steps[service] = 'maintenance'
          return
        }
      } while (now() < deadline)
      operation.steps[service] = ready(state, service) ? 'ready' : 'timeout'
      if (operation.steps[service] !== 'ready') return
    }
  }

  return {
    async state() {
      const health = await status()
      return { health, checkedAt: checked.at, operation: operation ? structuredClone(operation) : null }
    },
    start(target) {
      if (closed) return 'unavailable'
      if (target !== 'all' && !services.includes(target)) return 'invalid'
      if (task) return 'busy'
      operation = { running: true, current: null, steps: {} }
      task = run(target === 'all' ? services : [target]).catch(() => {
        operation.steps[operation.current] = 'failed'
      }).finally(() => {
        operation.running = false
        task = undefined
      })
      return 'accepted'
    },
    dispose() { closed = true },
  }
}
