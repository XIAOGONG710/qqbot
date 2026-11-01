// 替用户问她几个大问题（只读、不写任何状态、不发 QQ）。
// 用她现在的卡（boyfriend 档）+ 她那套说话规矩，按「他问、她答」的一轮来生成。
// 用法：node scripts/ask-her.mjs "问题一" "问题二" ...
import { readFileSync } from 'node:fs'

const repo = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const card = JSON.parse(readFileSync(`${repo}characters/linmengyao/st/linmengyao-boyfriend.json`, 'utf8')).data
const key = process.env.QQBOT_LLM_API_KEY || ''
if (!key) throw new Error('QQBOT_LLM_API_KEY missing')

// 只留事实段（和运行时 INJECT_PERSONA=false 的做法一致）：关系、家、宿舍、专业、朋友、钱、雷区、日常、重要的日子、不接的话题、被问是不是 AI
const KEEP = ['和他的关系', '家', '宿舍', '专业', '朋友', '钱', '雷区', '日常', '重要的日子', '不接的话题', '被问是不是 AI']
const facts = String(card.description ?? '').split(/(?=【)/).filter(part => KEEP.some(head => part.startsWith(`【${head}】`))).join('')

const system = [
    card.system_prompt.replaceAll('{{char}}', card.name).replaceAll('{{user}}', '宝宝'),
    facts,
    '现在是 2026-10-31 晚上，你刚跟他聊完一阵。他问你的这些问题不是要你交作业，是认真想听你自己的想法。',
    '用你平时的口气回答：短，口语，可以说不知道，可以说"我没想过"，别写排比、别写抽象比喻、别写"不是X而是Y"的警句。',
].join('\n\n')

const questions = process.argv.slice(2)
for (const question of questions) {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
            model: 'deepseek-flash',
            temperature: 1.1,
            max_tokens: 400,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: question },
            ],
        }),
    })
    const data = await res.json()
    const answer = data?.choices?.[0]?.message?.content?.trim() || `（没有回答：${JSON.stringify(data).slice(0, 120)}）`
    console.log(`\n宝宝：${question}\n林梦瑶：${answer.replace(/\n/g, '\n　　　　')}`)
}
