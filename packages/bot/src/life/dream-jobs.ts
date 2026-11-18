// 做梦那一拍（2026-10-31 起，DSH 线）：她睡着的那几小时里做梦、午睡打盹的小梦、一个月回头看看自己常梦见什么、学说话 / 翻日记时没想通的地方——
// 原来是 app.ts 里四个函数加一个每 30 分钟的计时器，ADR 0336 第 6 步搬到这里（逐字搬，闭包里取的东西换成 deps），定时由 modules/dreams.ts 声明。
// 四件事在同一拍里一起起（不等前一件），和原来一样。存梦、存问题、存回看都在 dreams.ts / learning-questions.ts 里；这里读日记、读她自己写的事件。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeelingsReport } from '../emotion/feeling-export.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import { loadNotesState } from '../language/speech-notes.ts';
import type { Contact } from '../platform/config.ts';
import type { TierCard } from '../platform/contact.ts';
import type { Log } from '../platform/log.ts';
import { readLifeEvents } from '../world/life-events.ts';
import { appendDream, dreamPrompt, hasDream, inSleepHours, lastInsightAt, monthlyInsightPrompt, napPrompt, onlyFragment, recentDreams, saveInsight } from './dreams.ts';
import { loadQuestion, questionPrompt, saveQuestion } from './learning-questions.ts';

export interface DreamJobsDeps {
    /** 男朋友档的那一位（没有就什么都不做） */
    owner: Contact | undefined;
    character: (tier: Contact['tier']) => TierCard['character'];
    dataDir: string;
    soulDir: () => string;
    now: () => Date;
    log: Log;
    stopped: () => boolean;
    /** 后台模型调用（抽取用的配置），按温度给 */
    generate: (temperature: number) => (messages: OpenAIMessage[]) => Promise<string>;
    /** 最近一次给他算的心境 */
    lastFeelings: () => FeelingsReport | undefined;
    /** 一个月的回看也记进长期记忆（没开长期记忆返回 undefined） */
    rememberSelfNote: (contact: Contact, text: string, kind: '记住') => Promise<unknown> | undefined;
    /** 她那边的世界（世界账）：做梦前读一次此刻的世界（结算到期的事），有世界账才给 */
    worldAt?: (at: Date) => unknown;
}

export function dreamJobs(deps: DreamJobsDeps): { tick(): void } {
    const { owner, dataDir } = deps;
    /** 她学说话/翻日记时没想通的地方，挑一个留到聊天里问他（2026-10-31） */
    async function makeLearningQuestion(): Promise<void> {
        if (deps.stopped() || !owner) return;
        const at = deps.now();
        if (at.getHours() < 20) return;
        const fresh = loadQuestion(dataDir);
        if (fresh && at.getTime() - fresh.at < 20 * 3_600_000) return;
        try {
            let notes = '';
            try {
                const state = loadNotesState(dataDir);
                notes = state.notes.map(note => note.text).slice(-8).join('；');
            } catch { /* 没笔记就只用日记 */ }
            let journal = '';
            try { journal = readFileSync(join(deps.soulDir(), 'JOURNAL.md'), 'utf8').slice(-800); } catch { /* 没日记 */ }
            const books = deps.character(owner.tier).books?.map(book => book.title).join('、') ?? '';
            const prompt = questionPrompt({ notes, journal, books, name: deps.character(owner.tier).name });
            const raw = await deps.generate(0.8)([{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]);
            const text = String(raw ?? '').trim();
            if (!text || /^SKIP$/i.test(text)) { deps.log('学习问题：这次没想出来'); return; }
            const firstLine = text.split(String.fromCharCode(10)).map(part => part.trim()).filter(Boolean)[0] ?? text;
            saveQuestion(dataDir, { at: at.getTime(), question: firstLine.slice(0, 120), from: notes ? '说话笔记' : '日记' });
            deps.log('学习问题：留了一个，想找机会问他');
        } catch (error) {
            deps.log(`学习问题：出错（${error instanceof Error ? error.message : String(error)}）`);
        }
    }


    /** 午睡打盹的小梦（2026-10-31 她说「午后小睡那个也开吧」）：一天最多一个，不每天都有 */
    async function makeNapDream(): Promise<void> {
        if (deps.stopped() || !owner) return;
        const at = deps.now();
        const hour = at.getHours();
        const date = at.toISOString().slice(0, 10);
        if (hour < 13 || hour > 15 || hasDream(`${date}-nap`, dataDir)) return;
        // 一周里大概两三天会打盹（按日期定，不随机漂）
        const seed = `${date}-nap`;
        let hash = 0x811c9dc5;
        for (const char of seed) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
        if (hash % 100 >= 45) return;
        try {
            const own = readLifeEvents(join(dataDir, 'world', 'events.json'), () => undefined)
                .map(event => String((event as { text?: string }).text ?? ''))
                .filter(text => text && !text.includes('跟我说')).slice(-5);
            const lastFeelings = deps.lastFeelings();
            const fell = lastFeelings ? lastFeelings.felt.filter(item => item.level !== 'faint').map(item => `${item.cause}（${item.kind}）`) : [];
            const prompt = napPrompt({ events: own, feelings: fell, name: deps.character(owner.tier).name });
            const raw = await deps.generate(0.95)([{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]);
            const dream = String(raw ?? '').trim();
            if (!dream) return;
            appendDream(dataDir, { date: `${date}-nap`, dream: dream.slice(0, 300), at: at.getTime(), fragment: true, nap: true });
            deps.log(`做梦：午睡打了个盹（${[...dream].length} 字）`);
        } catch (error) {
            deps.log(`做梦：午睡那个没成（${error instanceof Error ? error.message : String(error)}）`);
        }
    }

    /** 一个月回头看看自己常梦见什么（她说「我也有点想知道自己到底老在怕什么」） */
    async function makeMonthlyInsight(): Promise<void> {
        if (deps.stopped() || !owner) return;
        const now = deps.now().getTime();
        if (now - lastInsightAt(dataDir) < 25 * 86_400_000) return;
        const dreams = recentDreams(dataDir, 31);
        if (dreams.length < 5) return;
        try {
            const prompt = monthlyInsightPrompt(dreams, deps.character(owner.tier).name);
            const raw = await deps.generate(0.8)([{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]);
            const text = String(raw ?? '').trim();
            if (!text) return;
            saveInsight(dataDir, text.slice(0, 400), now);
            void deps.rememberSelfNote(owner, text.slice(0, 400), '记住')?.catch(error => deps.log(`做梦：这段回看没写进记忆（${error instanceof Error ? error.message : String(error)}）`));
            deps.log('做梦：这个月的梦回看了一遍（1 段）');
        } catch (error) {
            deps.log(`做梦：回看出错（${error instanceof Error ? error.message : String(error)}）`);
        }
    }
    async function makeDream(): Promise<void> {
        if (deps.stopped() || !owner) return;
        const at = deps.now();
        const date = at.toISOString().slice(0, 10);
        if (!inSleepHours(at.getHours()) || hasDream(date, dataDir)) return;
        try {
            const events = deps.worldAt
                ? (deps.worldAt(at) ? [] : [])
                : [];
            // 白天的事：她自己写的事件（不含「跟我说」）+ 日记尾巴
            const own = readLifeEvents(join(dataDir, 'world', 'events.json'), () => undefined)
                .map(event => String((event as { text?: string }).text ?? ''))
                .filter(text => text && !text.includes('跟我说'))
                .slice(-8);
            let journal = '';
            try { journal = readFileSync(join(deps.soulDir(), 'JOURNAL.md'), 'utf8').slice(-400); } catch { /* 没日记就算了 */ }
            const lastFeelings = deps.lastFeelings();
            const fell = lastFeelings ? lastFeelings.felt.filter(item => item.level !== 'faint').map(item => `${item.cause}（${item.kind}）`) : [];
            const previous = recentDreams(dataDir, 3).map(item => item.dream);
            const prompt = dreamPrompt({ events: [...own, ...events], feelings: fell, journal, name: deps.character(owner.tier).name, previous });
            const raw = await deps.generate(0.95)([{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]);
            const text = String(raw ?? '');
            const match = text.match(/\{[\s\S]*\}/);
            const parsed = match ? JSON.parse(match[0]) as { dream?: string; feel?: { kind?: string; strength?: number; why?: string } } : { dream: text.trim() };
            const dream = String(parsed.dream ?? '').trim();
            if (!dream) { deps.log('做梦：没写出来，明晚再说'); return; }
            appendDream(dataDir, {
                date, dream: dream.slice(0, 600), at: at.getTime(),
                fragment: onlyFragment(date),
                ...(parsed.feel?.kind ? { feel: { kind: parsed.feel.kind as never, strength: (parsed.feel.strength === 2 || parsed.feel.strength === 3 ? parsed.feel.strength : 1) as never, ...(parsed.feel.why ? { why: String(parsed.feel.why).slice(0, 80) } : {}) } } : {}),
            });
            deps.log(`做梦：1 条（${[...dream].length} 字）`);
        } catch (error) {
            deps.log(`做梦：出错（${error instanceof Error ? error.message : String(error)}）`);
        }
    }
    return { tick: () => { void makeDream(); void makeNapDream(); void makeMonthlyInsight(); void makeLearningQuestion(); } };
}
