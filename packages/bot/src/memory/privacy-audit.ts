// 联系人隐私审计：只列数据位置、数量和 Hindsight 删除目标，不输出聊天正文，也不改文件。

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PrivacyArtifact {
    path: string;
    kind: 'direct' | 'mixed';
    bytes: number;
    references?: number;
    note: string;
}

export interface PrivacyAudit {
    qq: number;
    dataDir: string;
    artifacts: PrivacyArtifact[];
    hindsight: {
        banks: string[];
        commonDocuments: string[];
        commonMentalModels: string[];
        commonTargets?: { bankId: string; documents: string[]; mentalModels: string[] }[];
    };
    limitations: string[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readJson = (path: string): unknown => {
    if (!existsSync(path)) return undefined;
    try {
        if (lstatSync(path).isSymbolicLink()) throw new Error('link');
        return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch { throw new Error('隐私审计状态读取或校验失败；原文件未修改'); }
};

function walk(root: string): string[] {
    if (!existsSync(root)) return [];
    if (lstatSync(root).isSymbolicLink()) throw new Error('隐私数据目录包含链接，拒绝读取根外范围');
    return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
        const path = join(root, entry.name);
        if (entry.isSymbolicLink()) throw new Error('隐私数据目录包含链接，拒绝读取根外范围');
        return entry.isDirectory() ? walk(path) : [path];
    });
}

const countText = (path: string, needles: readonly string[]) => {
    try {
        const text = readFileSync(path, 'utf8');
        return text.split(/\r?\n/).filter(line => needles.some(needle => line.includes(needle))).length;
    } catch { return 0; }
};

function countContactRefs(value: unknown, qq: number): number {
    if (Array.isArray(value)) return value.reduce((total, item) => total + countContactRefs(item, qq), 0);
    if (!isObject(value)) return 0;
    if (value.contact === qq || value.qq === qq || value.from === qq || value.target === `contact:${qq}`) return 1;
    return Object.values(value).reduce<number>((total, item) => total + countContactRefs(item, qq), 0);
}

const hash = (qq: number, tier: string) => createHash('sha256').update(`qqbot:${qq}-${tier}`).digest('hex').slice(0, 16);

export function auditContactPrivacy(dataDir: string, qq: number): PrivacyAudit {
    if (!Number.isSafeInteger(qq) || qq <= 0) throw new Error('qq 应为正整数');
    const root = resolve(dataDir);
    const artifacts: PrivacyArtifact[] = [];
    const add = (path: string, kind: PrivacyArtifact['kind'], note: string, references?: number) => {
        if (!existsSync(path)) return;
        if (lstatSync(path).isSymbolicLink()) throw new Error('隐私数据文件包含链接，拒绝读取');
        if (!statSync(path).isFile()) return;
        artifacts.push({ path: relative(root, path), kind, bytes: statSync(path).size, ...(references !== undefined ? { references } : {}), note });
    };

    const qqText = String(qq);
    for (const area of ['chats', 'memory', 'promises', 'proactive', 'context', 'jokes', 'idioms']) {
        for (const path of walk(join(root, area))) {
            const name = basename(path);
            if (name === `${qqText}.json` || name === `${qqText}.jsonl` || name.startsWith(`${qqText}-`)) {
                add(path, 'direct', `${area} 中只属于这个联系人的文件`);
            }
        }
    }

    for (const name of (existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [])
        .filter(entry => entry.isFile() && (entry.name === 'tiers.json' || entry.name.startsWith('tiers.before-')))
        .map(entry => entry.name)) {
        const path = join(root, name);
        const value = readJson(path);
        if (isObject(value) && qqText in value) add(path, 'mixed', '档位记录或归档前备份', 1);
    }
    const crisisPath = join(root, 'crisis.json');
    const crisis = readJson(crisisPath);
    if (isObject(crisis) && (qqText in crisis || (isObject(crisis.contacts) && qqText in crisis.contacts))) {
        add(crisisPath, 'mixed', '危机信号级别与时间', 1);
    }
    const prompt = join(root, 'last-prompt.json');
    const lastPrompt = readJson(prompt);
    if (isObject(lastPrompt) && lastPrompt.qq === qq) add(prompt, 'direct', '最近一次完整提示词属于这个联系人');

    for (const path of walk(join(root, 'logs'))) {
        const references = countText(path, [`[${qqText}]`, qqText]);
        if (references) add(path, 'mixed', '混合运行日志；需按行复核或按整段保留期清理', references);
    }

    for (const [name, note] of [
        ['actions.json', '全局生活账的兼容投影'],
        ['events.json', '全局生活事件账'],
        ['action-queue.json', '尚未完成的生活行动队列'],
        ['state.json', '由生活账派生的当前世界快照'],
    ] as const) {
        const path = join(root, 'world', name);
        const json = readJson(path);
        const references = countContactRefs(json, qq);
        if (references) add(path, 'mixed', note, references);
    }

    const stickersPath = join(root, 'stickers', 'index.json');
    const stickerReferences = countContactRefs(readJson(stickersPath), qq);
    if (stickerReferences) add(stickersPath, 'mixed', '图片表情收藏中记录的发送来源', stickerReferences);

    const banks = new Set<string>();
    const commonDocuments = new Set<string>();
    const commonMentalModels = new Set<string>();
    const commonTargets = new Map<string, { bankId: string; documents: string[]; mentalModels: string[] }>();
    let unresolved = 0;
    for (const path of walk(join(root, 'memory'))) {
        const match = new RegExp(`^${qqText}-([a-z_]+)\\.json$`).exec(basename(path));
        if (!match) continue;
        const state = readJson(path);
        if (!isObject(state)) continue;
        if (typeof state?.bankId === 'string') banks.add(state.bankId);
        const owner = hash(qq, match[1]!);
        const bank = typeof state.bankId === 'string' && new RegExp(`^([A-Za-z0-9-]+)-${owner}$`).exec(state.bankId);
        const target = bank ? commonTargets.get(`${bank[1]}-common`) ?? { bankId: `${bank[1]}-common`, documents: [], mentalModels: [] } : undefined;
        if (target) commonTargets.set(target.bankId, target);
        if (!target && (isObject(state.common) && Object.keys(state.common).length || state.personModel !== undefined)) unresolved++;
        const common = state?.common;
        if (common && typeof common === 'object' && !Array.isArray(common)) {
            for (const episode of Object.keys(common as Json)) { commonDocuments.add(`${owner}:${episode}`); target?.documents.push(`${owner}:${episode}`); }
        }
        if (state?.personModel !== undefined) { commonMentalModels.add(`person-${owner}`); target?.mentalModels.push(`person-${owner}`); }
    }

    return {
        qq,
        dataDir: root,
        artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
        hindsight: {
            banks: [...banks].sort(), commonDocuments: [...commonDocuments].sort(), commonMentalModels: [...commonMentalModels].sort(),
            commonTargets: [...commonTargets.values()].map(target => ({ ...target, documents: [...new Set(target.documents)].sort(), mentalModels: [...new Set(target.mentalModels)].sort() })).sort((a, b) => a.bankId.localeCompare(b.bankId)),
        },
        limitations: [
            '本报告不执行删除；清理时必须先停 bot，并对照 Hindsight API 逐项删除后复查。',
            '公共日记、周记和阶段总结可能用自然语言提到联系人，无法仅靠 QQ 号可靠归属，需要人工复核。',
            '部署配置中的联系人 QQ、称呼和权限位于 dataDir 之外，需要单独修改。',
            'NapCat、Koishi、模型供应商及系统备份位于 dataDir 之外，不在本报告覆盖范围内。',
            ...(unresolved ? [`未解决：${unresolved} 份旧记忆进度的历史公共库归属无法核实；仅能按传入的当前公共库清理，历史库须人工逐库复查，不代表彻底遗忘。`] : []),
        ],
    };
}

function main(): void {
    const [, , dataArg, qqArg] = process.argv;
    const qq = Number(qqArg);
    if (!dataArg || !Number.isInteger(qq) || qq <= 0) {
        console.error('用法：node src/privacy-audit.ts <数据目录> <QQ号>');
        process.exitCode = 2;
        return;
    }
    const invocationRoot = process.env.INIT_CWD ?? process.cwd();
    console.log(JSON.stringify(auditContactPrivacy(resolve(invocationRoot, dataArg), qq), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
