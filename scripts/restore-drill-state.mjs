import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { COMPLETE_MARKER } from './backup-state.mjs';

const STATE_SOURCES = new Set(['runtime/bot', 'runtime/bot-shadow']);
const FORBIDDEN_TOP_LEVEL = new Set(['logs', 'secrets', 'bot.lock', 'last-prompt.json']);

const inside = (parent, child) => {
    const rel = relative(resolve(parent), resolve(child));
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function marker(path) {
    let value;
    try { value = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('备份完成标记损坏或不存在'); }
    if (!value || typeof value !== 'object' || value.completed !== true) throw new Error('备份没有有效的完成标记');
    return value;
}

function artifact(path, status, label) {
    if (status?.ok !== true || !Number.isSafeInteger(status.bytes) || status.bytes < 1) throw new Error(`${label}没有可信的大小记录`);
    let info;
    try { info = lstatSync(path); } catch { throw new Error(`${label}不存在`); }
    if (info.isSymbolicLink() || !info.isFile() || info.size !== status.bytes) throw new Error(`${label}与完成标记不一致`);
    return { path, bytes: info.size };
}

/** 读取一次可演练的完整备份；只信带大小记录的完成标记。 */
export function restoreDrillPlan(backupDir) {
    const root = resolve(backupDir);
    const complete = marker(join(root, COMPLETE_MARKER));
    const database = artifact(join(root, 'hindsight.sql'), complete.components?.database, '数据库备份');
    const stateStatus = complete.components?.state;
    if (stateStatus?.skipped === true) throw new Error('这份备份没有状态归档，不能做完整恢复演练');
    if (!STATE_SOURCES.has(stateStatus?.source)) throw new Error('状态备份来源不受支持');
    const state = artifact(join(root, 'her-state.zip'), stateStatus, '状态备份');
    return { backupDir: root, source: stateStatus.source, database, state };
}

/** 演练永远只能写到工作区 runtime/restore-drills 的新空目录。 */
export function safeRestoreDrillTarget(workspaceRoot, target) {
    const base = resolve(workspaceRoot, 'runtime', 'restore-drills');
    const resolved = resolve(target);
    if (!inside(base, resolved)) throw new Error('恢复演练目录必须位于 runtime/restore-drills 下');
    // Windows 的目录联接和 Unix 符号链接都不能成为写入路径的一部分，否则一个看似
    // 隔离的演练目录可能实际指向在线数据。只检查已经存在的祖先；缺失部分随后新建。
    for (let current = resolve(workspaceRoot); inside(current, resolved);) {
        const rel = relative(current, resolved).split(sep)[0];
        if (!rel) break;
        current = join(current, rel);
        if (!existsSync(current)) continue;
        const info = lstatSync(current);
        if (info.isSymbolicLink()) throw new Error('恢复演练路径不能经过符号链接或目录联接');
    }
    if (existsSync(resolved)) {
        const info = lstatSync(resolved);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('恢复演练目标不是安全的普通目录');
        if (readdirSync(resolved).length) throw new Error('恢复演练目标必须为空');
    }
    return resolved;
}

function walk(directory, root, files) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const info = lstatSync(path);
        if (info.isSymbolicLink()) throw new Error(`恢复内容含符号链接：${relative(root, path)}`);
        if (entry.isDirectory()) walk(path, root, files);
        else if (entry.isFile()) files.push(path);
        else throw new Error(`恢复内容含不支持的文件类型：${relative(root, path)}`);
    }
}

function verifyAiPhotoDrafts(root) {
    const directory = join(root, 'ai-photo-drafts');
    if (!existsSync(directory)) return { present: false, entries: 0 };
    const indexPath = join(directory, 'index.json');
    let index;
    try { index = JSON.parse(readFileSync(indexPath, 'utf8')); }
    catch { throw new Error('AI 照片草稿索引无法读取'); }
    if (index?.version !== 1 || !Array.isArray(index.entries)) throw new Error('AI 照片草稿索引格式不受支持');
    const ids = new Set();
    for (const entry of index.entries) {
        if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-f0-9]{12}$/.test(entry.id)
            || typeof entry.file !== 'string' || !new RegExp(`^${entry.id}\\.(?:jpg|png|webp)$`).test(entry.file)
            || ids.has(entry.id)) throw new Error('AI 照片草稿索引含无效条目');
        ids.add(entry.id);
        const file = join(directory, 'files', entry.file);
        let info;
        try { info = lstatSync(file); } catch { throw new Error(`AI 照片草稿缺少文件：${entry.id}`); }
        if (info.isSymbolicLink() || !info.isFile() || info.size < 1) throw new Error(`AI 照片草稿文件不安全：${entry.id}`);
        const bytes = readFileSync(file);
        const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
        if (digest !== entry.id) throw new Error(`AI 照片草稿哈希不一致：${entry.id}`);
        const extension = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpg'
            : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png'
                : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'webp'
                    : undefined;
        if (!extension || !entry.file.endsWith(`.${extension}`)) throw new Error(`AI 照片草稿格式不一致：${entry.id}`);
    }
    return { present: true, entries: index.entries.length };
}

/** 对已解压的状态做只读完整性检查，不会把内容放回在线目录。 */
export function verifyRestoredState(target) {
    const root = resolve(target);
    const info = statSync(root);
    if (!info.isDirectory()) throw new Error('恢复演练结果不是目录');
    for (const name of readdirSync(root)) {
        if (FORBIDDEN_TOP_LEVEL.has(name) || /^config(?:\.|$)/i.test(name)) throw new Error(`备份意外包含敏感或临时内容：${name}`);
    }
    const files = [];
    walk(root, root, files);
    if (!files.length) throw new Error('恢复演练结果为空');
    return { files: files.length, aiPhotos: verifyAiPhotoDrafts(root) };
}

