/**
 * Small, dependency-free primitives shared by the Super Agent engine:
 * ids, time helpers, bounded logs, percentile math and the debounced JSON store.
 *
 * Nothing here imports a DSH package: the engine stays testable with `node`
 * alone (see `test/engine.test.mjs`).
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Monotonic per-process counter used for readable ids (`w-01`, `t-01`, `th-01`). */
export class Counters {
  constructor() {
    this.map = new Map()
  }

  next(prefix) {
    const value = (this.map.get(prefix) ?? 0) + 1
    this.map.set(prefix, value)
    return `${prefix}-${String(value).padStart(2, '0')}`
  }

  seed(prefix, value) {
    const current = this.map.get(prefix) ?? 0
    if (value > current) this.map.set(prefix, value)
  }

  export() {
    return Object.fromEntries(this.map)
  }

  restore(data) {
    if (!data || typeof data !== 'object') return
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'number' && Number.isFinite(value)) this.map.set(key, value)
    }
  }
}

export const now = () => Date.now()

/** Rounds to `digits` decimals without string juggling in hot paths. */
export const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/** Nearest-rank percentile over an unsorted duration array; `null` when empty. */
export function percentile(values, p) {
  const clean = (values ?? []).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  if (clean.length === 0) return null
  const rank = clamp(Math.ceil((p / 100) * clean.length), 1, clean.length)
  return clean[rank - 1]
}

export const average = values => {
  const clean = (values ?? []).filter(Number.isFinite)
  if (clean.length === 0) return null
  return clean.reduce((sum, value) => sum + value, 0) / clean.length
}

/** Exponential moving average with a configurable weight. */
export const ema = (previous, sample, weight = 0.2) => {
  if (!Number.isFinite(previous)) return sample
  if (!Number.isFinite(sample)) return previous
  return previous * (1 - weight) + sample * weight
}

/** A bounded newest-first log that never throws on malformed input. */
export class Log {
  constructor(limit) {
    this.limit = limit
    this.items = []
  }

  push(item) {
    this.items.unshift(item)
    if (this.items.length > this.limit) this.items.length = this.limit
    return item
  }

  clear() {
    this.items = []
  }

  export() {
    return this.items.map(item => ({ ...item }))
  }

  restore(items) {
    if (!Array.isArray(items)) return
    this.items = items.slice(0, this.limit).map(item => (item && typeof item === 'object' ? { ...item } : { t: now(), text: String(item) }))
  }
}

/** Deterministic-ish small hash used for dedupe keys. */
export function hash(text) {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0).toString(36)
}

export const slug = (text, fallback = 'task') => {
  const clean = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (clean || fallback).slice(0, 40)
}

/**
 * Debounced, atomic JSON snapshot store.
 *
 * Writes serialize through one promise chain so two saves can never interleave,
 * and land through a temp file + rename so a crash cannot truncate the record.
 * A failed save is reported once and does not retry in a loop.
 */
export class JsonStore {
  constructor(directory, name = 'state.json') {
    this.file = join(directory, name)
    this.pending = null
    this.chain = Promise.resolve()
    this.closed = false
    this.reported = false
  }

  async load() {
    try {
      const text = await readFile(this.file, 'utf8')
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  save(snapshot, delayMs = 900) {
    this.pending = snapshot
    if (this.closed) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.flush().catch(() => {}) }, delayMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  flush() {
    const snapshot = this.pending
    this.pending = null
    if (!snapshot) return this.chain
    this.chain = this.chain.then(async () => {
      if (this.closed) return
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, JSON.stringify(snapshot), 'utf8')
      await rename(temp, this.file)
    }).catch(error => {
      if (this.reported) return
      this.reported = true
      this.onError?.(error)
    })
    return this.chain
  }

  async close() {
    this.closed = false
    clearTimeout(this.timer)
    await this.flush()
    this.closed = true
  }
}
