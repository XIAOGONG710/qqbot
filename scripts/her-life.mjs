// 她的连续生活：不依赖模型，每 10 分钟推进一次状态。
// 产出 LIFE.json / NOW.md / STORY.md，供 QQ、DSH、常驻进程读取。
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isNightHour as isNight, localDay } from './her-schedule.mjs'

// 灵魂目录：和 packages/bot 的 soulDir()、DSH 插件一致
const DIR = process.env.HER_SOUL_DIR || process.env.QQBOT_SOUL_DIR || join(homedir(), '.dsh', 'linmengyao')
const STATE = join(DIR, 'LIFE.json')
const NOW = join(DIR, 'NOW.md')
const STORY = join(DIR, 'STORY.md')
const HOUR = 3_600_000

// 随机数可以换：测试里用固定序列，能复现（原来直接用 Math.random，不可重放）
let random = Math.random
export function setRandom(fn = Math.random) { random = fn }

// 虚构的同学：不能用真人的名字（「鸽鸽」是他真实的联系人）——她不能把没发生的事讲给他，更不能讲给鸽鸽本人听
const NPCS = [
    { id: 'roommate', name: '苏雨桐', role: '同专业朋友' },
    { id: 'classmate', name: '同学', role: '同学' },
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
        today: localDay(new Date(now)),
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
    // 2026-10-29 起 NOW.md 由 QQ 那边渲染（同一份作息 + 世界 + 心境），这里只在它没接管时才写，
    // 免得两套规则互相覆盖、她的「现在在干嘛」前后矛盾（任务书 §2）。
    let owned = false
    try { owned = readFileSync(NOW, 'utf8').includes('generated-at:') } catch { /* 没有就是没接管 */ }
    if (!owned) writeFileSync(NOW, nowText(state))
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }

function logEvent(state, text) {
    state.events.push({ at: Date.now(), text })
    state.events = state.events.slice(-40)
}


function activeInterests() {
    try {
        const text = readFileSync(join(DIR, 'INTERESTS.md'), 'utf8')
        return [...text.matchAll(/^- \[ \] (.+)$/gm)].map(match => match[1].trim()).filter(Boolean)
    } catch { return [] }
}

/** 吃一顿之后剩多少饿：她不是永远饿着 */
export const HUNGER_AFTER_MEAL = 10
/** 哪些活动算「吃了东西」 */
export const EAT = /找点吃的|吃饭|吃夜宵|吃了/

/** 换了活动之后饿不饿：去吃东西就饱了，别的照旧 */
export function hungerAfterActivity(activity, hunger) {
    return EAT.test(activity) ? HUNGER_AFTER_MEAL : hunger
}

function chooseActivity(state, hour) {
    const weights = []
    const energy = state.energy
    const hunger = state.hunger
    if (isNight(hour) || energy < 30) weights.push(['睡觉', 6])
    if (hunger > 70) weights.push(['找点吃的', 5])
    if (energy > 45 && !isNight(hour)) weights.push(['看书/追剧', 3], ['刷手机', 2])
    const interests = activeInterests()
    if (energy > 45 && !isNight(hour) && interests.length) {
        const pick = interests[Math.floor(random() * interests.length)]
        weights.push([`做自己的事：${pick}`, 5])
    }
    if (state.relationships.baobao.resentment > 25) weights.push(['生闷气', 1])
    weights.push(['发呆', 1])
    const total = weights.reduce((sum, [, w]) => sum + w, 0)
    let pick = random() * total
    for (const [name, weight] of weights) {
        pick -= weight
        if (pick <= 0) return name
    }
    return '发呆'
}

function npcTick(state, hour) {
    if (isNight(hour)) return
    if (random() > 0.12) return
    const npc = NPCS[Math.floor(random() * NPCS.length)]
    const lines = {
        roommate: ['苏雨桐带了饭回来，问我要不要一起吃。', '室友在说下周的作业，我听了两耳朵。'],
        classmate: ['有同学在群里吐槽老师拖堂。', '同学说周末可能约饭，我还没回。'],
        family: ['妈妈发微信问我这周回不回家。', '爸爸转了个养生视频，没说话。'],
    }
    const text = lines[npc.id][Math.floor(random() * lines[npc.id].length)]
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
    const changed = next !== state.activity
    // 2026-10-30：饥饿只涨不降，两天就卡在 100，她每晚都得说「饿得睡不着」（00:04 那次）。
    // 真去吃一顿就该饱：吃完 hunger 回到 10 上下。
    if (changed) state.hunger = hungerAfterActivity(next, state.hunger)
    if (changed) {
        logEvent(state, `我在${next}。`)
        state.activity = next
    }
    npcTick(state, hour)

    const today = localDay(new Date(now))
    if (today !== state.today) {
        state.today = today
        logEvent(state, '新的一天。')
    }
    // 每 7 天写一章“人生故事”（确定性摘要，不调模型）
    if (now - state.storyAt > 7 * 24 * HOUR && state.events.length) {
        state.storyAt = now
        const lines = state.events.slice(-20).map(e => `- ${localDay(new Date(e.at))}：${e.text}`)
        appendFileSync(STORY, `\n## ${today}\n${lines.join('\n')}\n`)
    }
    save(state)
    return { state, changed }
}

// 只认「冲着她」的话。原来 /烦|想|喜欢|亲…/ 一命中就算：他说「我今天好烦，项目压力大」是在向她倾诉，却被记成冲她的负面（怨气 +8，
// NOW.md 随之告诉她「你现在不想哄他：可以顶回去、拒绝他」）；「我想问你个事」被当成「想你」加信任。
const AT_HER_NEGATIVE = /滚(开|蛋|远点|出去)|你滚|闭嘴|别烦我|(不想|懒得|不)理你|讨厌你|烦死你|你(真|好|太|可)?烦|生你(的)?气|你(怎么)?这么冷淡/
const AT_HER_POSITIVE = /想你|想死你|好想你|喜欢你|爱你|陪你|陪着你|陪我|抱抱|抱你|亲亲|亲你|么么|辛苦了|谢谢|晚安|好梦/
export const isNegativeAtHer = (text) => AT_HER_NEGATIVE.test(String(text || ''))
export const isPositiveAtHer = (text) => AT_HER_POSITIVE.test(String(text || ''))

/** 他发消息/她回消息：算一次互动，改变关系与心情 */
export function noteInteraction(text, from = 'baobao', forcedNegative = false) {
    const state = load()
    const value = String(text || '')
    const positive = isPositiveAtHer(value)
    const negative = forcedNegative || isNegativeAtHer(value)
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
    const behavior = rel.resentment > 30
        ? '你现在不想哄他：可以短回、顶回去、拒绝他；他认真哄你才慢慢松。'
        : rel.trust > 80
            ? '你跟他很亲：可以主动、撒娇、说想他。'
            : ''
    const tired = state.energy < 25 ? '你太累了：能短就短，不想动。' : ''
    const recent = state.events.slice(-3).map(e => e.text).join('；')
    return `现在 ${time}，我在${state.activity}，${body}，${mood}，${relation}。${behavior}${tired}${recent ? `最近：${recent}` : ''}`
}

export function readNow() {
    try { return readFileSync(NOW, 'utf8').trim() } catch { return nowText() }
}

export { DIR, STATE, NOW, STORY }

