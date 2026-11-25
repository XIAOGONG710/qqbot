// source/ 的编辑服务（ADR 0010）：DSH 面板和 Koishi 控制台共用这一层，页面只负责显示和提交。
// 流程是「查看 → 预览 → 确认保存」：
// - 查看只读文件原文，给一个快照 token（所有源文件的 sha256）；
// - 预览不写盘，返回字段位置、问题类别和合成样本，不透传命中的原文、输入值或 YAML 路径；
// - 保存先比快照 token，再校验结构、引用和档位隐私，最后写 source/ 和 st/；中途失败按日志回滚已写的文件。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCharacter, checkPrivacy } from './build.ts';
import { SOURCE_FILES, SOURCE_HEADERS, checkSource, fromYaml, readSource, toYaml, type CharacterSource } from './source.ts';

export interface CharacterPaths {
    sourceDir: string;
    stDir: string;
    /** st/ 下卡文件名的前缀，例如 linmengyao */
    prefix: string;
}

/** 页面能改的部分；moods / books 是后加的文件，资料里没有时页面不显示它们的分页 */
export const EDIT_PARTS = ['persona', 'scenes', 'schedule', 'tiers', 'moods', 'books'] as const;
export type EditPart = (typeof EDIT_PARTS)[number];

export type ProblemKind = 'privacy' | 'reference' | 'format';

/** 给页面和日志看的问题：只有字段位置、类别和合成样本，不含命中的原文 */
export interface PublicProblem {
    part: EditPart | 'output';
    /** 资料里的位置，例如 persona.yml traits.名字、tiers.yml、她的过去 年表 */
    field: string;
    kind: ProblemKind;
    /** 档位名（档位隐私检查时才有） */
    tier?: string;
    /** 怎么改：固定的合成示例，和真实资料无关 */
    hint: string;
}

const HINTS: Record<ProblemKind, string> = {
    privacy: '这一档的提示词里出现了本档不该出现的说法；换成不涉及它的写法（示例：可以说「今天有点累」）。',
    reference: '引用的档位或说话方式在资料里不存在；从已有的档位和说话方式里重新选。',
    format: '当前页面的必填项或类型不对（示例：名字写成一行字，不要留空；时间写 08:30）。',
};

/** 从校验错误里取出资料位置，例如 persona.yml.name、persona.yml traits.名字；取不到就给文件名 */
function fieldOf(message: string): string {
    const at = /[a-z]+\.yml(?:\.[A-Za-z0-9_\[\]]+)*/.exec(message)?.[0];
    if (!at) return '资料';
    const key = /[a-z]+\.yml\s+([A-Za-z0-9_.\[\]]+)/.exec(message)?.[1];
    return key ? `${at.split(' ')[0]} ${key}` : at;
}

function classify(message: string): ProblemKind {
    if (/HH:MM|时间格式|(?:schedule\.yml\.)?(?:sleep|wakeup)/i.test(message)) return 'format';
    if (/没有档位|不存在|没有|引用/.test(message) && !/应为|缺少|重复/.test(message)) return 'reference';
    return 'format';
}

/** 校验异常 → 位置 + 类别 + 合成样本；原始消息只留在受控日志，不进页面 */
function problemsFromError(part: EditPart, error: unknown): PublicProblem[] {
    const message = error instanceof Error ? error.message : String(error);
    const kind = classify(message);
    return [{ part, field: fieldOf(message), kind, hint: HINTS[kind] }];
}

/** 档位隐私问题 → 位置 + 档位 + 类别；命中的词和上下文不返回 */
function privacyProblems(problems: ReturnType<typeof checkPrivacy>): PublicProblem[] {
    return problems.map(problem => ({
        part: 'output' as const,
        field: problem.where,
        kind: 'privacy' as const,
        tier: problem.tier,
        hint: HINTS.privacy,
    }));
}

export interface CharacterSnapshot {
    token: string;
    parts: Partial<Record<EditPart, unknown>>;
    /** 资料里没有的 part 文件（页面不显示对应分页） */
    missing: EditPart[];
}

export type PreviewOutcome =
    | { ok: true; token: string; written: string[]; unchanged: string[] }
    | { ok: false; conflict: true; token: string }
    | { ok: false; conflict?: false; problems: PublicProblem[] };

export type SaveOutcome =
    | { ok: true; token: string; written: string[]; unchanged: string[] }
    | { ok: false; conflict: true; token: string }
    | { ok: false; conflict?: false; problems: PublicProblem[] };

export interface CharacterEditor {
    load(): CharacterSnapshot;
    preview(part: EditPart, value: unknown, token?: string): PreviewOutcome;
    save(part: EditPart, value: unknown, token?: string): SaveOutcome;
}

/** 检查的三种结果：源文件变过 / 校验没过 / 可以写 */
type CheckOutcome =
    | { conflict: true; token: string }
    | { problems: PublicProblem[] }
    | { token: string; plan: ReturnType<typeof planWrites> };

/** 写文件的方式；测试用它注入「写到一半失败」 */
export interface CharacterEditorOptions {
    writeFile?(path: string, text: string): void;
}

/** 所有源文件的原文快照：文件名 + 内容（没有的文件记空） */
function snapshotToken(sourceDir: string): string {
    const hash = createHash('sha256');
    for (const file of Object.values(SOURCE_FILES)) {
        hash.update(file).update('\0');
        const path = join(sourceDir, file);
        hash.update(existsSync(path) ? readFileSync(path, 'utf8') : '\u0001').update('\0');
    }
    return hash.digest('hex');
}

/** 原子写：先写同目录的 .tmp 再改名，单个文件不会留下半个内容 */
function writeAtomic(path: string, text: string): void {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
}

/** 源文件「没变」按内容算，不按字节：手写格式和统一表头重排不算改动，别为此触发插件重载 */
function sameContent(before: string | null, file: string, value: unknown): boolean {
    if (before === null) return false;
    try {
        return JSON.stringify(fromYaml(before, file)) === JSON.stringify(value);
    } catch {
        return false;
    }
}

/** 要写的文件：内容有变的才写（插件监听 st/ 和 source/，没变就不该触发重载） */
function planWrites(paths: CharacterPaths, source: CharacterSource) {
    const writes: { path: string; text: string; before: string | null; label: string }[] = [];
    const unchanged: string[] = [];
    for (const [key, file] of Object.entries(SOURCE_FILES) as [keyof typeof SOURCE_FILES, string][]) {
        const value = source[key];
        if (value === undefined) continue;
        const path = join(paths.sourceDir, file);
        const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
        const text = SOURCE_HEADERS[key] + toYaml(value);
        if (before === text || sameContent(before, file, value)) {
            unchanged.push(file);
            continue;
        }
        writes.push({ path, text, before, label: file });
    }
    const built = buildCharacter(source, paths.prefix);
    for (const [file, text] of built.files) {
        const path = join(paths.stDir, file);
        const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (before === text) {
            unchanged.push(file);
            continue;
        }
        writes.push({ path, text, before, label: file });
    }
    return { writes, built, written: writes.map(write => write.label), unchanged };
}

export function createCharacterEditor(paths: CharacterPaths, options: CharacterEditorOptions = {}): CharacterEditor {
    const write = options.writeFile ?? writeAtomic;
    const current = () => snapshotToken(paths.sourceDir);

    function load(): CharacterSnapshot {
        const parts: Partial<Record<EditPart, unknown>> = {};
        const missing: EditPart[] = [];
        for (const part of EDIT_PARTS) {
            const path = join(paths.sourceDir, SOURCE_FILES[part]);
            if (!existsSync(path)) {
                missing.push(part);
                continue;
            }
            try {
                parts[part] = fromYaml(readFileSync(path, 'utf8'), SOURCE_FILES[part]);
            } catch {
                // 文件坏了也要能打开页面改它：这一页先给空对象
                parts[part] = null;
            }
        }
        return { token: current(), parts, missing };
    }

    /** 比快照、校验、算要写的文件；不写盘 */
    function check(part: EditPart, value: unknown, token: string | undefined): CheckOutcome {
        const now = current();
        if (token !== undefined && token !== now) return { conflict: true as const, token: now };
        let source: CharacterSource;
        try {
            const existing = readSource(paths.sourceDir);
            source = checkSource({ ...existing, [part]: value });
        } catch (error) {
            return { problems: problemsFromError(part, error) };
        }
        let plan: ReturnType<typeof planWrites>;
        try {
            plan = planWrites(paths, source);
        } catch (error) {
            return { problems: problemsFromError(part, error) };
        }
        const problems = privacyProblems(checkPrivacy(plan.built, source));
        if (problems.length) return { problems };
        return { token: now, plan };
    }

    function preview(part: EditPart, value: unknown, token?: string): PreviewOutcome {
        const result = check(part, value, token);
        if ('conflict' in result) return { ok: false, conflict: true, token: result.token };
        if ('problems' in result) return { ok: false, problems: result.problems };
        return { ok: true, token: result.token, written: result.plan.written, unchanged: result.plan.unchanged };
    }

    function save(part: EditPart, value: unknown, token?: string): SaveOutcome {
        const result = check(part, value, token);
        if ('conflict' in result) return { ok: false, conflict: true, token: result.token };
        if ('problems' in result) return { ok: false, problems: result.problems };
        const { writes, written, unchanged } = result.plan;
        mkdirSync(paths.sourceDir, { recursive: true });
        mkdirSync(paths.stDir, { recursive: true });
        const done: typeof writes = [];
        try {
            for (const item of writes) {
                write(item.path, item.text);
                done.push(item);
            }
        } catch {
            // 失败恢复：已经写的按原内容写回，原先没有的删掉，再报告没有保存
            for (const item of done.reverse()) {
                try {
                    if (item.before === null) unlinkSync(item.path);
                    else writeAtomic(item.path, item.before);
                } catch { /* 回滚尽力而为，原始错误下面照样报 */ }
            }
            return { ok: false, problems: [{ part: 'output', field: '写入', kind: 'format', hint: '写入没有完成，已经恢复到改动前的样子；请再试一次。' }] };
        }
        return { ok: true, token: current(), written, unchanged };
    }

    return { load, preview, save };
}
