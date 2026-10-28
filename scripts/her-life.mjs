// 她的连续生活：不依赖模型，每 10 分钟推进一次状态。
// 产出 LIFE.json / NOW.md / STORY.md，供 QQ、DSH、常驻进程读取。
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.HER_SOUL_DIR || 'C:/Users/22601/.dsh/linmengyao'
const STATE = join(DIR, 'LIFE.json')
const NOW = join(DIR, 'NOW.md')
const STORY = join(DIR, 'STORY.md')
const HOUR = 3_600_000

const NPCS = [
    { id: 'roommate', name: '苏雨桐', role: '同专业朋友' },
    { id: 'classmate', name: '鸽鸽', role: '同学' },
    { id: 'family', name: '妈妈', role: '家人' },
]

function fresh() {
    const now = Date.now()
    return {
        at: now,
        energy: 72,
        hunger: 30,
        mood: 0.2,
        activity: '在宿舍待着',
        events: [],
        today: new Date(now).toISOString().slice(0, 10),
        relationships: {
            baobao: { trust: 70, resentment: 0 },
            roommate: { trust: 55, resentment: 0 },
            classmate: { trust: 60, resentment: 0 },
            family: { trust: 65, resentment: 0 },
        },
        storyAt: 0,
    }
}

export function load() {
    try { return { ...fresh(), ...JSON.parse(readFileSync(STATE, 'utf8')) } } catch { return fresh() }
}

function save(state) {
    writeFileSync(STATE, JSON.stringify(state, null, 2))
    writeFileSync(NOW, nowText(state))
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }

function logEvent(state, text) {
    state.events.push({ at: Date.now(), text })
    state.events = state.events.slice(-40)
}

function isNight(hour) { return hour >= 23 || hour < 7 }

function chooseActivity(state, hour) {
    const weights = []
    const energy = state.energy
    const hunger = state.hunger
    if (isNight(hour) || energy < 30) weights.push(['睡觉', 6])
    if (hunger > 70) weights.push(['找点吃的', 5])
    if (energy > 45 && !isNight(hour)) weights.push(['看书/追剧', 3], ['刷手机', 2])
    if (energy > 55) weights.push(['做自己的事（拍照/整理）', 2])
    if (state.relationships.baobao.resentment > 25) weights.push(['生闷气', 1])
    weights.push(['发呆', 1])
    const total = weights.reduce((sum, [, w]) => sum + w, 0)
    let pick = Math.random() * total
    for (const [name, weight] of weights) {
        pick -= weight
        if (pick <= 0) return name
    }
    return '发呆'
}

function npcTick(state, hour) {
    if (isNight(hour)) return
    if (Math.random() > 0.12) return
    const npc = NPCS[Math.floor(Math.random() * NPCS.length)]
    const lines = {
        roommate: ['苏雨桐带了饭回来，问我要不要一起吃。', '室友在说下周的作业，我听了两耳朵。'],
        classmate: ['鸽鸽发消息说周末可能约饭。', '鸽鸽在群里吐槽老师拖堂。'],
        family: ['妈妈发微信问我这周回不回家。', '爸爸转了个养生视频，没说话。'],
    }
    const text = lines[npc.id][Math.floor(Math.random() * lines[npc.id].length)]
    logEvent(state, text)
    state.relationships[npc.id].trust = clamp(state.relationships[npc.id].trust + 1, 0, 100)
}

/** 推进一次；返回是否有“值得叫醒她”的变化 */
export function tick(now = Date.now()) {
    const state = load()
    const hours = Math.max(0, (now - state.at) / HOUR)
    const hour = new Date(now).getHours()
    state.at = now

    if (isNight(hour) || state.activity === '睡觉') {
        state.energy = clamp(state.energy + hours * 9, 0, 100)
        state.hunger = clamp(state.hunger + hours * 2, 0, 100)
    } else {
        state.energy = clamp(state.energy - hours * 2.5, 0, 100)
        state.hunger = clamp(state.hunger + hours * 4, 0, 100)
    }
    state.mood = clamp(state.mood * 0.98, -1, 1)
    for (const rel of Object.values(state.relationships)) rel.resentment = clamp(rel.resentment - hours, 0, 100)

    const next = chooseActivity(state, hour)
    if (next !== state.activity) {
        logEvent(state, `我在${next}。`)
        state.activity = next
    }
    npcTick(state, hour)

    const today = new Date(now).toISOString().slice(0, 10)
    if (today !== state.today) {
        state.today = today
        logEvent(state, '新的一天。')
    }
    // 每 7 天写一章“人生故事”（确定性摘要，不调模型）
    if (now - state.storyAt > 7 * 24 * HOUR && state.events.length) {
        state.storyAt = now
        const lines = state.events.slice(-20).map(e => `- ${new Date(e.at).toISOString().slice(0, 10)}：${e.text}`)
        appendFileSync(STORY, `\n## ${today}\n${lines.join('\n')}\n`)
    }
    save(state)
    return { state, changed: next !== state.activity }
}

/** 他发消息/她回消息：算一次互动，改变关系与心情 */
export function noteInteraction(text, from = 'baobao') {
    const state = load()
    const value = String(text || '')
    const positive = /(想|喜欢|陪|抱|亲|辛苦|谢谢|晚安|好梦)/.test(value)
    const negative = /(烦|滚|闭嘴|别烦|不理|生气|讨厌|冷淡)/.test(value)
    const rel = state.relationships[from] || state.relationships.baobao
    if (positive) { rel.trust = clamp(rel.trust + 2, 0, 100); rel.resentment = clamp(rel.resentment - 4, 0, 100); state.mood = clamp(state.mood + 0.05, -1, 1) }
    if (negative) { rel.trust = clamp(rel.trust - 3, 0, 100); rel.resentment = clamp(rel.resentment + 8, 0, 100); state.mood = clamp(state.mood - 0.15, -1, 1) }
    logEvent(state, `${from === 'baobao' ? '宝宝' : from}跟我说：${value.slice(0, 40)}`)
    save(state)
}

export function nowText(state = load()) {
    const time = new Date(state.at).toTimeString().slice(0, 5)
    const mood = state.mood > 0.3 ? '心情不错' : state.mood < -0.3 ? '心情不太好' : '心情一般'
    const body = state.energy < 30 ? '有点累' : state.hunger > 70 ? '有点饿' : '身体还行'
    const rel = state.relationships.baobao
    const relation = rel.resentment > 30 ? '还在生他的气' : rel.trust > 80 ? '跟他很亲' : '跟他正常'
    const recent = state.events.slice(-3).map(e => e.text).join('；')
    return `现在 ${time}，我在${state.activity}，${body}，${mood}，${relation}。${recent ? `最近：${recent}` : ''}`
}

export function readNow() {
    try { return readFileSync(NOW, 'utf8').trim() } catch { return nowText() }
}

export { DIR, STATE, NOW, STORY }
