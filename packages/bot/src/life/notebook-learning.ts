import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { MEMORY_THRESHOLDS } from '../memory/thresholds.ts';
import { loadTakesState, type Take } from './reading-takes.ts';

type Method = 'date' | 'topic';
type Attempt = { id: string; key: string; at: number; method: Method; hits: string[] };
/** 经验最多留几次尝试、多久以前的不再用（默认 80 次 / 30 天，记忆阈值表 notebookMaxAttempts / notebookMaxAgeMs） */
const MAX_ATTEMPTS = MEMORY_THRESHOLDS.notebookMaxAttempts;
const MAX_AGE = MEMORY_THRESHOLDS.notebookMaxAgeMs;

function notebookRequest(text: string) {
    if (text.length > 240 || !/读书笔记/.test(text) || !/检索|找|查|翻|看看|整理/.test(text)) return undefined;
    const date = /\b\d{4}-\d{2}-\d{2}\b/.exec(text)?.[0];
    const topic = (/主题(?:是|为|[：:])?\s*[「《]?([^，,。？?；;、」》\n]{2,24})/.exec(text)?.[1]
        ?? /关于[「《]?([^，,。？?；;、」》\n]{2,24}?)[」》]?(?=的(?:读书笔记|笔记)|[，,。？?；;、]|$)/.exec(text)?.[1] ?? '').trim();
    const keyword = (/关键词(?:是|为|[：:])?\s*[「《]?([^，,。？?；;、」》\n]{2,24})/.exec(text)?.[1]
        ?? /(?:提到|写到)(?:的)?[「《]?([^，,。？?；;、」》\n]{2,24})(?=[，,。？?；;、」》]|$)/.exec(text)?.[1] ?? '').trim();
    const chronology = /流水|按时间顺序|按日期列/.test(text);
    if (!chronology && !topic && !keyword) return undefined;
    const explicit: Method | undefined = /按日期查|按时间查/.test(text) ? 'date' : /按主题查|按关键词查/.test(text) ? 'topic' : undefined;
    return { date, topic, keyword, chronology, explicit, key: JSON.stringify([topic.toLocaleLowerCase(), keyword.toLocaleLowerCase()]) };
}

export function notebookToneHint(text: string): string | undefined {
    return /^(?:你)?(?:刚才|这次|刚刚)?说话(?:有点|实在)?太直(?:了)?[。！!\s]*$/.test(text.trim())
        ? '[这条反馈只用于这轮语气。可以把刚才那句话说得柔和一点，原来的看法和直率仍由你自己把握。]' : undefined;
}

export function notebookLearning(dataDir: string, timeZone: string, log: (message: string) => void, owner?: number) {
    const file = join(dataDir, owner === undefined ? 'notebook-learning.json' : `notebook-learning-${owner}.json`);
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const attempts = (): Attempt[] => {
        const saved = readJsonOr<unknown>(file, [], undefined, { invalid: 'throw' });
        if (!Array.isArray(saved)) throw new Error('读书笔记经验格式无效');
        return saved.filter(row => typeof row?.id === 'string' && typeof row.key === 'string' && Number.isFinite(row.at)
            && (row.method === 'date' || row.method === 'topic') && Array.isArray(row.hits) && row.hits.every((id: unknown) => typeof id === 'string'));
    };
    const find = (request: NonNullable<ReturnType<typeof notebookRequest>>, method: Method, now: number, takes = loadTakesState(dataDir).takes): Take[] => {
        const match = (haystack: string, term: string) => !term || haystack.toLocaleLowerCase().includes(term.toLocaleLowerCase());
        return takes.filter(take => take.kind === 'book' && take.at > 0 && take.at <= now
            && match([take.title, ...take.names, take.text].join(' '), request.topic) && match(take.text, request.keyword)
            && (method !== 'date' || (request.chronology && !request.date) || (request.date && date.format(take.at) === request.date)));
    };
    const learned = (key: string, now: number) => {
        const related = attempts().filter(row => row.key === key && row.at <= now && now - row.at <= MAX_AGE).sort((a, b) => a.at - b.at);
        const found = related.findLast(row => row.method === 'topic' && row.hits.length > 0);
        const missed = found && related.findLast(row => row.method === 'date' && !row.hits.length && row.at < found.at);
        return found && missed ? { method: 'topic' as const, evidence: [missed.id, found.id], hits: found.hits } : undefined;
    };
    return {
        observe(id: string, text: string, now: number): void {
            const request = notebookRequest(text);
            if (!request || request.chronology || !request.explicit || (request.explicit === 'date' && !request.date)) return;
            try {
                const old = attempts();
                if (old.some(row => row.id === id)) return;
                const takes = loadTakesState(dataDir).takes;
                if (!takes.some(take => take.kind === 'book' && take.at > 0 && take.at <= now)) return;
                const hits = find(request, request.explicit, now, takes).map(note => note.id);
                writeJsonAtomic(file, [...old, { id, key: request.key, at: now, method: request.explicit, hits }].slice(-MAX_ATTEMPTS));
            } catch { log('读书笔记经验未写入，保留原记录'); }
        },
        preference(text: string, now = Date.now()) {
            const request = notebookRequest(text);
            const result = request && !request.chronology ? learned(request.key, now) : undefined;
            return result && { method: result.method, evidence: result.evidence };
        },
        reply(text: string, now = Date.now()): string | undefined {
            const request = notebookRequest(text);
            if (!request) return undefined;
            let evidence: ReturnType<typeof learned>;
            try { if (!request.chronology && !request.explicit) evidence = learned(request.key, now); }
            catch { log('读书笔记经验暂不可读，使用普通查询'); }
            const method = request.chronology ? 'date' : request.explicit ?? evidence?.method ?? 'topic';
            const proven = new Set(evidence?.hits);
            const notes = find(request, method, now).sort((a, b) => Number(proven.has(b.id)) - Number(proven.has(a.id)) || b.at - a.at).slice(0, 4);
            if (request.chronology) notes.reverse();
            const strategy = request.chronology ? '按日期列流水' : method === 'date' ? '按指定日期查找'
                : evidence ? '沿用已验证的主题加关键词检索' : '按主题加关键词检索';
            return `[读书笔记｜${strategy}。引文只是已有记录。]\n${notes.length
                ? notes.map(note => `- ${date.format(note.at)} 《${note.title}》 ${JSON.stringify(note.text)}`).join('\n')
                : '这次没有找到匹配笔记，不补写内容或编造原因。'}`;
        },
    };
}
