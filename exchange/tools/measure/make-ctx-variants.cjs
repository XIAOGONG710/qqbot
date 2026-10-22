// Context-aware blind-judge cases: same 72 target turns as judge-cases.json, but her scenario carries the earlier turns of the real segment as chat history
// (the girl's earlier real turns = assistant, the other side = user), so one-line cryptic stimuli ("一食堂 / 楼梯旁边有一个窗口") have their context.
const fs = require('node:fs');
const path = require('node:path');
const base = 'C:/Users/XG/Desktop/Project/qqbot-exchange/exchange/research/2026-10-real-chat';
const files = ['samples.jsonl', 'v2/samples-b1.jsonl', 'v2/samples-b2.jsonl', 'v2/samples-b3.jsonl'];
const out = __dirname;
const CHUNKS = 3;
const VARIANT = process.argv[2] ?? 'v0'; const MIN = { v0: 0, v1: 11, v2: 23 }[VARIANT]; const START = Date.parse('2026-10-24T21:00:00+08:00') + MIN * 60_000;
const cases = [];
const scenarios = [];
for (const f of files) {
    for (const line of fs.readFileSync(path.join(base, f), 'utf8').split(/\r?\n/).filter(Boolean)) {
        const seg = JSON.parse(line);
        if (seg.relation !== 'boyfriend' || seg.staged) continue;
        const turns = (seg.turns ?? []).filter(t => Array.isArray(t.bubbles) && t.bubbles.length);
        for (let i = 1; i < turns.length; i++) {
            if (turns[i].who !== seg.her || turns[i - 1].who === seg.her) continue;
            const stimulus = turns[i - 1].bubbles.map(String).map(s => s.trim()).filter(Boolean);
            const human = turns[i].bubbles.map(String).map(s => s.trim()).filter(Boolean);
            if (!stimulus.length || !human.length || stimulus.some(s => /^\[|^（|^\(/.test(s) && s.length < 8)) continue;
            const id = `jc-${String(cases.length + 1).padStart(3, '0')}`;
            const prior = turns.slice(Math.max(0, i - 1 - 8), i - 1);
            const lines = [];
            for (const t of prior) for (const b of t.bubbles) { const c = String(b).trim(); if (c) lines.push({ role: t.who === seg.her ? 'assistant' : 'user', content: c }); }
            const history = lines.map((l, k) => ({ time: new Date(START - (lines.length - k + 1) * 60_000 * 2).toISOString(), role: l.role, content: l.content }));
            cases.push({ id, stimulus, human, context: lines });
            scenarios.push({ id, scenario: { name: id, description: '带上文的盲评：真人情侣聊天里男方这一轮说的话，让她回一次', tier: 'boyfriend', user: '宝宝', start: new Date(START).toISOString().replace('Z', '+00:00'), memory: false, shortReplies: true, history, steps: stimulus.map(say => ({ say })) } });
        }
    }
}
fs.writeFileSync(path.join(out, 'ctx-cases-' + VARIANT + '.json'), JSON.stringify(cases, null, 2));
for (let c = 1; c <= CHUNKS; c++) { fs.rmSync(path.join(out, `ctx-${VARIANT}-chunk-${c}`), { recursive: true, force: true }); fs.mkdirSync(path.join(out, `ctx-${VARIANT}-chunk-${c}`), { recursive: true }); }
scenarios.forEach((s, index) => fs.writeFileSync(path.join(out, `ctx-${VARIANT}-chunk-${(index % CHUNKS) + 1}`, `${s.id}.json`), JSON.stringify(s.scenario, null, 2)));
const withCtx = cases.filter(c => c.context.length).length;
console.log(`cases ${cases.length}, with context ${withCtx}, median context lines ${cases.map(c => c.context.length).sort((a, b) => a - b)[Math.floor(cases.length / 2)]}`);
