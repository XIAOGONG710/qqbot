// The status probe shells out to a child process. When that child cannot run,
// the whole panel used to answer 503 and every tab stayed empty, which hides
// the pages that do work. Fall back to a status the controller accepts, mark
// it, and keep the reason short enough to show in the header.
export const PROBE_PORTS = { napcat: 3001, hindsight: 8899, koishi: 5140 }

export function failedStatus(error) {
  const reason = String(error?.message ?? error ?? '').trim()
  return {
    napcat: false,
    hindsight: false,
    koishi: false,
    net: false,
    koishiProcesses: 0,
    koishiListening: false,
    maintenance: false,
    ports: { ...PROBE_PORTS },
    watchdog: false,
    launchers: {},
    probeFailed: reason.slice(0, 200) || '状态探测没有结果',
  }
}
