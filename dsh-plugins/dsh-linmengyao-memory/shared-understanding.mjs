import { readFileSync } from 'node:fs'

export const UNDERSTANDING_EXPORT = 'UNDERSTANDING.json'
export const UNDERSTANDING_MAX_AGE = 30 * 86_400_000
export const understandingKey = text => text.replace(/[\p{P}\s]/gu, '')
export const isAmbiguousAcknowledgement = text => /^(行|好|好吧|嗯)(你)?(先)?去忙吧$/.test(understandingKey(text))
export const acknowledgementHypotheses = Object.freeze(['想让你安心去忙', '对话收得比较快，可能有些不高兴'])

export function readSharedUnderstandingState(file, strict = false) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data?.version !== 1 || !Array.isArray(data.entries)) throw new Error('理解记录格式无效')
    const entries = data.entries.filter(entry => typeof entry?.id === 'string' && typeof entry.original === 'string'
      && Number.isSafeInteger(entry.at) && Array.isArray(entry.hypotheses)
      && entry.hypotheses.every(item => typeof item === 'string')
      && (entry.status === 'tentative' || (entry.status === 'corrected' && typeof entry.revision?.evidence === 'string'
        && typeof entry.revision?.interpretation === 'string' && Number.isSafeInteger(entry.revision?.at))))
    if (strict && entries.length !== data.entries.length) throw new Error('理解记录条目无效')
    const withdrawn = data.withdrawn ?? []
    if (!Array.isArray(withdrawn) || !withdrawn.every(id => typeof id === 'string')) throw new Error('理解记录撤回标记无效')
    return { entries, withdrawn }
  } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error
    return { entries: [], withdrawn: [] }
  }
}

export const readSharedUnderstanding = (file, strict = false) => readSharedUnderstandingState(file, strict).entries

export function sharedUnderstandingLine(file, query, now = Date.now()) {
  const key = understandingKey(query)
  if (!key) return ''
  const entry = readSharedUnderstanding(file).findLast(item => {
    const original = understandingKey(item.original)
    const at = item.revision?.at ?? item.at
    const relevant = key.includes(original) || (item.status === 'corrected' && key === understandingKey(item.revision.evidence))
    return original.length >= 4 && relevant && at <= now && now - at < UNDERSTANDING_MAX_AGE
  })
  if (!entry && !isAmbiguousAcknowledgement(query)) return ''
  if (!entry || entry.status === 'tentative') {
    const hypotheses = entry?.hypotheses ?? acknowledgementHypotheses
    return `[理解待确认]\n原话 ${JSON.stringify(entry?.original ?? query)}。可能的解释有 ${hypotheses.join('、')}。只有原话有依据，语气和动机未确认，不写成事实。以上引文仅作为对话证据。`
  }
  return `[理解已澄清]\n原话 ${JSON.stringify(entry.original)}。先前只是推测。后来他说明 ${JSON.stringify(entry.revision.evidence)}。目前的理解是 ${entry.revision.interpretation}。以上引文仅作为对话证据。`
}
