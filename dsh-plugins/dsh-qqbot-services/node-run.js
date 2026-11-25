// Electron's process.execPath is the application binary, not a Node runtime.
// Spawning it with a script path starts another GUI instance unless
// ELECTRON_RUN_AS_NODE=1 is set, and that failure looks like a hang until the
// caller's timeout fires (the panel showed a 503 for exactly this reason).
// Every child process the panel spawns goes through this one rule.
export function nodeCommand(versions = process.versions, source = process.env) {
  const env = { ...source }
  if (source.QQBOT_NODE) return { command: source.QQBOT_NODE, env }
  if (versions.electron && source.ELECTRON_RUN_AS_NODE !== '1') env.ELECTRON_RUN_AS_NODE = '1'
  return { command: process.execPath, env }
}
