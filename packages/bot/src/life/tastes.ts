// 从经历里长出偏好（ADR 0162，配置 tastes，默认关）。
// 来自 10-25 用户给的清单：「兴趣、偏好和表达习惯不必全部由提示词预先写死；我们更希望提供可靠记忆、工具和探索空间，让个人特征有机会在经历中逐渐形成」
// 「我们希望你记得当时为何选择，以及后来的结果」。
// 现状：她的兴趣是人设里写好的（摄影、独立游戏、王者荣耀……），经历（生活账里她真做过的事、看过的视频）不会反过来改变什么。
// 做法：每天最多一次「回头看」——把最近两周生活账里她真做过的事（休闲、吃饭、读书、做项目的结果）和看过的视频摘要列成带编号的清单，
// 让模型指出最多 2 条「看得出来的偏好」（喜欢 / 不太喜欢什么，为什么），**每条必须引用清单里的编号当证据**，
// 代码这边校验：编号必须是清单里真有的、喜欢要有至少 2 条证据（不喜欢 1 条够：一次失败 / 烦也算）、名字短、理由短，不合格的丢掉；
// 通过的写进 tastes.json，带着证据和日期，之后再有相反的经历就改（stance 翻转要至少 2 条新证据）。
// 用法：提示词里放最强 / 最近的 3 条「你自己慢慢发现的口味」，聊到相关的事时自然带出来，不硬提。
// 不做：不改人设里写好的兴趣（那是作者的）；不从聊天内容里猜；偏好不会凭空出现，没有证据就没有。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { clip, whenText } from '../memory/timeline.ts';

export interface Experience {
    /** 清单里的编号（来自生活账 id / 看过的视频 bvid） */
    ref: string;
    at: string;
    /** 休闲 / 吃饭 / 读书 / 项目 / 看视频 */
    kind: string;
    text: string;
    /** 结果不好（没做成、被打断）时标 'bad'；好的标 'good'（如看完、做成）；没有就是 neutral */
    outcome?: 'good' | 'bad';
}

export interface Taste {
    name: string;
    stance: 'like' | 'dislike';
    strength: 1 | 2 | 3;
    why: string;
    since: string;
    last: string;
    evidence: { ref: string; at: string; text: string }[];
}

interface TastesFile { version: 1; lastReflectAt?: string; tastes: Taste[] }

export const MAX_TASTES = 12;
export const MAX_NEW_PER_REFLECTION = 2;
const MIN_GAP_MS = 20 * 3_600_000;
const DAYS = 14;

const SYSTEM = `你在帮一个大学生回头看自己最近两周真做过的事，找出「看得出来的偏好」。
下面是带编号的经历清单。只指出有清单支持的偏好：一件事反复出现、或每次的结果都好 / 都不好。最多 2 条，宁可少，没有就输出 []。
每条的格式：{"name":"2 到 8 个字的名字，如 独立游戏、刷摄影区","stance":"like" 或 "dislike","strength":1 到 3,"why":"不超过 30 字，说清楚为什么看得出来","refs":["清单里的编号", ...]}
refs 只能用清单里有的编号；喜欢至少引用 2 个编号；不能编清单里没有的事，不涉及任何人。只输出一个 JSON 数组。`;

const clean = (s: unknown, max: number) => (typeof s === 'string' ? clip(s, max) : '');

export interface TastesOptions {
    dataDir: string;
    /** 最近的经历（调用方从生活账、看过的视频里拼） */
    experiences: (now: Date) => Experience[];
    /** 回头看用的模型调用（要 JSON 数组） */
    ask: (system: string, user: string) => Promise<string>;
    now?: () => Date;
    log?: (message: string) => void;
    /** 新增 / 改了一条偏好时回调（时间线用） */
    onChange?: (taste: Taste, kind: 'new' | 'update') => void;
}

export class Tastes {
    readonly #options: TastesOptions;
    readonly #path: string;

    constructor(options: TastesOptions) {
        this.#options = options;
        this.#path = join(options.dataDir, 'tastes.json');
    }

    #load(): TastesFile {
        const value = readJsonOr<TastesFile>(this.#path, { version: 1, tastes: [] }, this.#options.log, { label: '口味' });
        return value && Array.isArray(value.tastes) ? value : { version: 1, tastes: [] };
    }

    list(): Taste[] { return this.#load().tastes; }

    /** 回头看一次；一天最多一次。返回新增 / 更新的条数 */
    async reflect(): Promise<number> {
        const now = this.#options.now?.() ?? new Date();
        const file = this.#load();
        if (file.lastReflectAt && now.getTime() - Date.parse(file.lastReflectAt) < MIN_GAP_MS) return 0;
        const since = now.getTime() - DAYS * 86_400_000;
        const experiences = this.#options.experiences(now).filter(e => Date.parse(e.at) >= since).slice(-60);
        file.lastReflectAt = now.toISOString();
        if (experiences.length < 6) {
            writeJsonAtomic(this.#path, file);
            return 0;
        }
        const known = file.tastes.map(t => `${t.name}（${t.stance === 'like' ? '喜欢' : '不太喜欢'}）`).join('、');
        const list = experiences.map(e => `${e.ref} | ${whenText(new Date(e.at), now)} | ${e.kind} | ${clip(e.text, 40)}${e.outcome === 'bad' ? ' | 结果不好' : e.outcome === 'good' ? ' | 结果好' : ''}`).join('\n');
        let raw: string;
        try {
            raw = await this.#options.ask(SYSTEM, `${known ? `已经发现的：${known}\n\n` : ''}经历清单（编号 | 时间 | 类别 | 内容）：\n${list}`);
        } catch (error) {
            this.#options.log?.(`口味：回头看失败（${error instanceof Error ? error.message : String(error)}）`);
            return 0;
        }
        const accepted = this.#validate(raw, experiences, file, now);
        writeJsonAtomic(this.#path, file);
        this.#options.log?.(`口味：回头看了 ${experiences.length} 件经历，${accepted ? `记下 ${accepted} 条（日志不记内容）` : '没有新发现'}`);
        return accepted;
    }

    #validate(raw: string, experiences: readonly Experience[], file: TastesFile, now: Date): number {
        let proposals: unknown;
        try { proposals = JSON.parse(/\[[\s\S]*\]/.exec(raw)?.[0] ?? '[]'); } catch { return 0; }
        if (!Array.isArray(proposals)) return 0;
        const byRef = new Map(experiences.map(e => [e.ref, e]));
        let accepted = 0;
        for (const item of proposals.slice(0, MAX_NEW_PER_REFLECTION)) {
            const p = item as Record<string, unknown>;
            const name = clean(p.name, 10);
            const why = clean(p.why, 40);
            const stance = p.stance === 'like' || p.stance === 'dislike' ? p.stance : undefined;
            const refs = [...new Set(Array.isArray(p.refs) ? p.refs.filter((r): r is string => typeof r === 'string' && byRef.has(r)) : [])];
            if (!name || [...name].length < 2 || !why || !stance || refs.length < (stance === 'like' ? 2 : 1)) continue;
            if (/[\[\]「」]/.test(name + why)) continue;
            const strength = (Math.min(3, Math.max(1, Math.round(Number(p.strength) || 1))) as 1 | 2 | 3);
            const evidence = refs.slice(0, 4).map(ref => ({ ref, at: byRef.get(ref)!.at, text: clip(byRef.get(ref)!.text, 30) }));
            const existing = file.tastes.find(t => t.name === name);
            if (existing) {
                // 相反的偏好要至少 2 条新证据才翻；同方向的补证据、可以加强
                const fresh = evidence.filter(e => !existing.evidence.some(old => old.ref === e.ref));
                if (existing.stance !== stance) {
                    if (fresh.length < 2) continue;
                    existing.stance = stance;
                    existing.why = why;
                    existing.evidence = fresh;
                    existing.strength = strength;
                } else if (fresh.length) {
                    existing.evidence = [...existing.evidence, ...fresh].slice(-6);
                    existing.strength = Math.min(3, Math.max(existing.strength, strength)) as 1 | 2 | 3;
                } else continue;
                existing.last = now.toISOString();
                this.#options.onChange?.(existing, 'update');
            } else {
                const taste: Taste = { name, stance, strength, why, since: now.toISOString(), last: now.toISOString(), evidence };
                file.tastes.push(taste);
                this.#options.onChange?.(taste, 'new');
            }
            accepted++;
        }
        if (file.tastes.length > MAX_TASTES) {
            file.tastes.sort((a, b) => b.strength - a.strength || Date.parse(b.last) - Date.parse(a.last));
            file.tastes.length = MAX_TASTES;
        }
        return accepted;
    }

    /** 放进聊天提示词的一段：最强 / 最近的 3 条；没有就没有 */
    promptLine(): string | undefined {
        const top = [...this.list()].sort((a, b) => b.strength - a.strength || Date.parse(b.last) - Date.parse(a.last)).slice(0, 3);
        if (!top.length) return undefined;
        const parts = top.map(t => `${t.stance === 'like' ? '喜欢' : '不太喜欢'}${t.name}（${t.why}）`);
        return `[你自己慢慢发现的口味（是你真的经历过之后才有的，不是设定）：${parts.join('；')}。聊到相关的事时可以自然带出来，别硬提，也别当成口头禅；这里没写的细节（具体是哪个游戏、哪道菜、发生过什么）别编]`;
    }
}

/** 生活账里的事 → 经历清单：只收休闲 / 吃饭 / 读书 / 项目，有 subject 的；没做成的标“结果不好” */
export function experiencesFromLife(events: readonly { id: string; kind: string; startedAt: string; subject?: string; result: string }[]): Experience[] {
    const KIND: Record<string, string> = { leisure: '休闲', eat: '吃饭', read_book: '读书', work_on_project: '项目' };
    return events
        .filter(e => KIND[e.kind] && e.subject)
        .map(e => ({ ref: e.id, at: e.startedAt, kind: KIND[e.kind]!, text: e.subject!, ...(e.result === 'succeeded' ? {} : { outcome: 'bad' as const }) }));
}

/** 看过的视频 → 经历清单 */
export function experiencesFromWatched(entries: readonly { bvid: string; title: string; day: string }[]): Experience[] {
    return entries.map(e => ({ ref: e.bvid, at: new Date(`${e.day}T20:00:00+08:00`).toISOString(), kind: '看视频', text: e.title }));
}
