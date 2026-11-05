// 联系人隐私审计：只列数据位置、数量和 Hindsight 删除目标，不输出聊天正文，也不改文件。

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEEDBACK_MONTH_FILE, isFeedbackRow } from '../emotion/feedback.ts';
import { ACCOUNT_ACTIONS } from '../social/account.ts';
import { CONTACT_TIERS, UNLISTED_TIER } from '../platform/config.ts';
import { isDerivedState } from './derived-state.ts';
import { FORGET_JOBS_DIRECTORY, isContactJsonResidue, isForgetJob } from './forget-job.ts';
import { ARCHIVE_JOBS_DIRECTORY, isArchiveJob } from './archive-job.ts';

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

/** 只检查结构化归属，不在聊天/摘要原文中搜索号码；坏行只计为审计局限。 */
function scanJsonLines(path: string, inspect: (value: unknown) => void): number {
    let text: string;
    try {
        if (lstatSync(path).isSymbolicLink()) throw new Error('link');
        text = readFileSync(path, 'utf8');
    } catch { throw new Error('隐私审计记录读取失败；原文件未修改'); }
    let bad = 0;
    for (let offset = 0; offset < text.length;) {
        const end = text.indexOf('\n', offset);
        const line = text.slice(offset, end < 0 ? text.length : end).trim();
        offset = end < 0 ? text.length : end + 1;
        if (!line) continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch { bad++; continue; }
        inspect(value);
    }
    return bad;
}

export function auditContactPrivacy(dataDir: string, qq: number): PrivacyAudit {
    if (!Number.isSafeInteger(qq) || qq <= 0) throw new Error('qq 应为正整数');
    const root = resolve(dataDir);
    const artifacts: PrivacyArtifact[] = [];
    const inventoryLimitations: string[] = [];
    const add = (path: string, kind: PrivacyArtifact['kind'], note: string, references?: number) => {
        if (!existsSync(path)) return;
        if (lstatSync(path).isSymbolicLink()) throw new Error('隐私数据文件包含链接，拒绝读取');
        if (!statSync(path).isFile()) return;
        artifacts.push({ path: relative(root, path), kind, bytes: statSync(path).size, ...(references !== undefined ? { references } : {}), note });
    };

    const qqText = String(qq);
    // These are shared authored documents, not per-QQ stores. Their bodies
    // cannot establish an exclusive owner, so never copy or move them for one contact.
    for (const file of ['diary.json', 'written-retain.json', 'written-retain.initialized']) {
        const path = join(root, 'memory', file);
        add(path, 'mixed', '共享日记/异步提交恢复资料；可能包含正文，不能按号码猜归属，保留原位人工复核');
    }
    add(join(root, 'memory', 'written-retain-coordination', 'index.coordination.sqlite'), 'mixed', '共享日记提交意图的独立OS协调文件，不存正文，运行中不可删换');
    for (const path of walk(join(root, 'memory')).filter(path => /^(?:diary|written-retain)\.json\.tmp-[1-9]\d*-[1-9]\d*$/.test(basename(path)))) {
        add(path, 'mixed', '共享日记或提交意图的实际原子写残留，可能含正文；归属未知，不能按单一联系人移动或导出');
    }
    for (const area of ['chats', 'memory', 'promises', 'proactive', 'context', 'jokes', 'idioms']) {
        for (const path of walk(join(root, area))) {
            const name = basename(path);
            // recalled.json 现在也保存尚未解码/已准备的私密入站正文。
            // 后缀只接受 json-file.ts 实际生成的临时/旧隔离文件名，不按号码前缀猜归属。
            const recalled = area === 'chats' && /^([1-9]\d*)\.recalled\.json(?:\.tmp-\d+-\d+|\.corrupt-\d+)?$/.exec(name)?.[1] === qqText;
            if (name === `${qqText}.json` || name === `${qqText}.jsonl` || name.startsWith(`${qqText}-`) || recalled || isContactJsonResidue(area, name, qq)) {
                add(path, 'direct', `${area} 中只属于这个联系人的文件`);
            }
        }
    }

    // 反馈月文件包含多位联系人及旧无来源行，绝不能当作某个人的整份专属文件移走。
    let unknownFeedback = 0; let badFeedback = 0;
    for (const path of walk(join(root, 'feedback')).filter(path => FEEDBACK_MONTH_FILE.test(basename(path)))) {
        let references = 0;
        const malformed = scanJsonLines(path, value => {
            if (!isFeedbackRow(value)) { badFeedback++; return; }
            if (value.contact === undefined) unknownFeedback++;
            else if (value.contact === qq) references++;
        });
        badFeedback += malformed;
        if (references) add(path, 'mixed', '多联系人反馈月文件；仅已标明 contact 的行可归属，需逐行复核', references);
    }
    if (unknownFeedback || badFeedback) inventoryLimitations.push(`反馈中有 ${unknownFeedback} 条旧无来源记录、${badFeedback} 条坏行或无效记录，无法归属联系人，需人工复核；未猜测分配。`);

    const intimacy = join(root, 'intimacy.json');
    const intimacyState = readJson(intimacy);
    if (isObject(intimacyState) && Object.hasOwn(intimacyState, qqText)) add(intimacy, 'mixed', '按 QQ 分开的临时亲热状态；同文件可能含其他联系人', 1);

    // derived.json包含所有bank的守卫，不是当前bank前缀或某个QQ的专属文件。
    // 审计只读明确owner.qq；不调用DerivedState.snapshot，避免创建/刷新状态。
    const derivedPath = join(root, 'memory', 'derived.json');
    const derived = readJson(derivedPath);
    let derivedOwned = false;
    if (derived !== undefined) {
        if (!isDerivedState(derived)) {
            throw new Error('隐私审计派生屏障归属格式无效；原文件未修改');
        }
        const references = Object.values(derived.banks).reduce<number>((total, bank) => total
            + bank.owners.filter(owner => owner.qq === qq).length, 0);
        if (references) {
            derivedOwned = true;
            add(derivedPath, 'mixed', '全bank派生屏障中的明确owner.qq元数据；共享状态须保留，遗忘不整份删除或解除旧守卫', references);
        }
    }
    // writeJsonAtomic写失败且unlink失败会留下实际.tmp-PID-seq，不虚构
    // critical状态的corrupt隔离后缀，也不泛收derived前缀的其他文件。
    let unknownDerivedResidues = 0;
    for (const path of walk(join(root, 'memory')).filter(path => /^derived\.json\.tmp-[1-9]\d*-[1-9]\d*$/.test(basename(path)))) {
        let value: unknown;
        try { value = readJson(path); } catch { unknownDerivedResidues++; continue; }
        if (!isDerivedState(value)) { unknownDerivedResidues++; continue; }
        const references = Object.values(value.banks).reduce<number>((total, bank) => total
            + bank.owners.filter(owner => owner.qq === qq).length, 0);
        if (references) {
            derivedOwned = true;
            add(path, 'mixed', '原子写失败留下的共享派生屏障临时资料；仅按明确owner.qq归属，保留原件，不整份遗忘', references);
        }
    }
    if (derivedOwned) add(join(root, 'memory', 'index.coordination.sqlite'), 'mixed', '派生屏障的共享协调与缺失见证；不存聊天正文，不单独移走或删除');
    if (unknownDerivedResidues) inventoryLimitations.push(`派生屏障临时残留有 ${unknownDerivedResidues} 份读不了或schema无效，无法归属联系人；属于共享未确认资料，保留原件并需人工复核，未按正文号码猜测分配。`);

    // Maintenance intent must remain in place to exclude automatic restart.
    // Audit it by the validated plan owner, never move it as ordinary contact data.
    let unknownForgetJobs = 0, forgetOwned = false;
    for (const path of walk(join(root, FORGET_JOBS_DIRECTORY))) {
        const match = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json(?:\.tmp-[1-9]\d*-[1-9]\d*)?$/.exec(basename(path));
        if (!match) { unknownForgetJobs++; continue; }
        let value: unknown;
        try { value = readJson(path); } catch { unknownForgetJobs++; continue; }
        if (!isForgetJob(value, root, match[1]!)) { unknownForgetJobs++; continue; }
        if (value.plan.qq === qq) {
            forgetOwned = true;
            add(path, 'mixed', '遗忘维护意图与恢复检查点中的明确plan.qq；含目标/文件摘要，不含正文，须原地保留，不能自动移动或删除启动屏障', 1);
        }
    }
    if (forgetOwned) add(join(root, 'bot.coordination.sqlite'), 'mixed', '全目录运行/维护协调租约；不存聊天正文，运行中不可删换');
    if (unknownForgetJobs) inventoryLimitations.push(`遗忘维护目录有 ${unknownForgetJobs} 份未知或无效记录，无法安全归属联系人；保留原件核实，未按正文猜测。`);

    // Archive recovery includes shared configuration text. Even a partial or
    // invalid journal is sensitive; exclusive ownership cannot be inferred.
    let unknownArchiveJobs = 0, archiveOwned = false;
    const archiveResidues = new Set<string>();
    for (const path of walk(join(root, ARCHIVE_JOBS_DIRECTORY))) {
        archiveOwned = true;
        add(path, 'mixed', '共享归档恢复意图或原子写残留，可能含配置正文和密钥；不按号码猜归属，保留原位，不整份导出');
        const match = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json(?:\.tmp-[1-9]\d*-[1-9]\d*)?$/.exec(basename(path));
        let value: unknown;
        try { value = readJson(path); } catch { unknownArchiveJobs++; continue; }
        if (!match || !isArchiveJob(value, root, match[1]!)) { unknownArchiveJobs++; continue; }
        for (const [index, step] of value.steps.entries()) if (step.kind === 'replace') {
            const temp = `${step.target}.archive-${value.id}-${index}.tmp`;
            if (!archiveResidues.has(temp)) {
                archiveResidues.add(temp);
                add(temp, 'mixed', '原归档计划精确定位的配置/档位文本临时文件；可能含私密正文，保留人工核实，不复制或移动给单联系人');
            }
        }
    }
    if (archiveOwned && !forgetOwned) add(join(root, 'bot.coordination.sqlite'), 'mixed', '全目录运行/归档协调租约；运行中不可删换');
    if (unknownArchiveJobs) inventoryLimitations.push(`归档维护目录有 ${unknownArchiveJobs} 份未知或无效记录；保留共享原件，无法推定其外部配置残留位置或单一联系人归属。`);

    // peek.uin 的写入源是 QQ 好友 target.qq，不把 B 站 uid 或摘要中的号码当作 QQ。
    walk(join(root, 'presence'));
    const presence = join(root, 'presence', 'presence.json');
    const presenceState = readJson(presence);
    if (isObject(presenceState) && isObject(presenceState.peek) && presenceState.peek.uin === qq) add(presence, 'mixed', '全局存在感中的 QQ 好友空间缓存，需复核对应 peek 记录', 1);

    const account = join(root, 'account-audit.jsonl');
    if (existsSync(account)) {
        let references = 0;
        const bad = scanJsonLines(account, row => {
            if (isObject(row) && typeof row.action === 'string' && ACCOUNT_ACTIONS[row.action]?.target === 'friend' && row.target === qq) references++;
        });
        if (references) add(account, 'mixed', '账号动作审计中明确以好友为对象的记录；同号群操作不归属此联系人', references);
        if (bad) inventoryLimitations.push('账号动作审计存在坏行，无法完整判定联系人归属，需人工复核。');
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

    const stickerDir = join(root, 'stickers'), stickerImages = new Set<string>(), knownStickerImages = new Set<string>();
    const stickerFiles = walk(stickerDir).filter(path => dirname(path) === stickerDir);
    const stickerIndexes = stickerFiles.filter(path => /^index\.json(?:\.tmp-[1-9]\d*-[1-9]\d*|\.corrupt-\d+)?$/.test(basename(path)));
    for (const path of stickerIndexes) {
        let value: unknown;
        try { value = readJson(path); }
        catch (error) {
            if (basename(path) === 'index.json') throw error;
            add(path, 'mixed', '表情索引实际残留无法解析，可能含私密描述与来源；归属未知，保留原位人工核实');
            inventoryLimitations.push('存在无法解析的表情索引残留，不能推定联系人归属或自动删除');
            continue;
        }
        if (isObject(value) && Array.isArray(value.entries)) for (const entry of value.entries) {
            if (isObject(entry) && typeof entry.file === 'string' && /^[^\\/:]+\.(?:png|jpg|jpeg|gif|webp)$/i.test(entry.file)) knownStickerImages.add(join(stickerDir, entry.file));
        }
        const references = countContactRefs(value, qq);
        if (!references) continue;
        add(path, 'mixed', '共享图片表情索引或实际写入残留中的明确来源；不按单一联系人整份导出或遗忘', references);
        if (!isObject(value) || !Array.isArray(value.entries)) continue;
        for (const entry of value.entries) {
            if (!isObject(entry) || !countContactRefs(entry.source, qq)) continue;
            const name = entry.file;
            if (typeof name !== 'string' || !/^[^\\/:]+\.(?:png|jpg|jpeg|gif|webp)$/i.test(name) || name === '.' || name === '..') {
                inventoryLimitations.push('表情索引含无法安全定位的图片路径，未跨出货架读取，保留人工核实');
                continue;
            }
            const image = join(stickerDir, name);
            if (stickerImages.has(image)) continue;
            stickerImages.add(image);
            add(image, 'mixed', '明确来源关联的共享表情图片；内容可能被多个来源收藏，不猜独占，不整份导出或遗忘');
        }
    }
    for (const path of stickerFiles) {
        const name = basename(path);
        if (/^[a-f0-9]{12}\.(?:png|jpg|gif|webp)\.tmp-[1-9]\d*-[1-9]\d*$/.test(name)
            || /^[a-f0-9]{12}\.(?:png|jpg|gif|webp)$/.test(name) && !knownStickerImages.has(path)) {
            add(path, 'mixed', '表情图片发布残留或无索引图片，来源未知；不读取内容猜归属，不整份导出或遗忘');
            inventoryLimitations.push('存在来源未知的表情图片或发布残留，保留原位人工核实');
        }
    }

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

    walk(join(root, 'identity'));
    const ledger = join(root, 'identity', 'memory.jsonl');
    if (existsSync(ledger)) {
        const owners = [...CONTACT_TIERS, UNLISTED_TIER].map(tier => hash(qq, tier));
        const privateBank = new RegExp(`^[A-Za-z0-9-]+-(?:${owners.join('|')})$`);
        const document = new RegExp(`^(?:${owners.join('|')}):ep--?\\d+$`);
        const models = new Set(owners.map(owner => `person-${owner}`));
        const repairKinds = new Set(['model-repair-configure', 'model-repair-clear', 'model-repair-refresh-submit', 'model-repair-restore']);
        const forgotten = createHash('sha256').update(qqText).digest('hex').slice(0, 12);
        let references = 0;
        const bad = scanJsonLines(ledger, row => {
            if (!isObject(row) || !isObject(row.data)) return;
            const data = row.data;
            if ((row.kind === 'forget' || row.kind === 'forget-dry-run') && data.contact === forgotten
                || ['retain', 'model-create', 'model-update'].includes(row.kind as string) && (
                    typeof data.bank === 'string' && privateBank.test(data.bank)
                    || typeof data.document === 'string' && document.test(data.document)
                    || typeof data.model === 'string' && models.has(data.model))
                || repairKinds.has(row.kind as string) && typeof data.bank === 'string' && (
                    privateBank.test(data.bank)
                    || /^[A-Za-z0-9-]+-common$/.test(data.bank) && typeof data.model === 'string' && models.has(data.model))) references++;
        });
        if (references) {
            add(ledger, 'mixed', '共享记忆哈希链账本中的明确库、文档、模型或遗忘记录；不可逐行删改而破坏链', references);
            add(`${ledger}.head`, 'mixed', '共享记忆账本的末尾校验点；随整条链复核，不单独删除');
        }
        if (bad) inventoryLimitations.push('共享记忆账本存在坏行，无法完整判定联系人归属，需人工复核。');
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
            ...inventoryLimitations,
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
