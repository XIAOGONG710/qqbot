// 生成一份脱敏的 koishi.yml 快照（开关状态可供交接核对，密钥不能进仓库）。
// 用法：node scripts/snapshot-config.mjs [--source <koishi.yml>] [--out <snapshot.yaml>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_KEY = /^(?:api[-_]?key|access[-_]?token|client[-_]?secret|token|password|secret|authorization|cookie)$/i;
const OBVIOUS_SECRET = /(?:\bsk-[A-Za-z0-9_-]{10,}\b|\bBearer\s+[^\s"']{10,})/i;

// 快照只用来核对开关，用不着真的号码：键名以 qq / uid / id 结尾、值是 5 位以上纯数字的（联系人、群、B 站 uid）一律遮掉。
// 2026-11-27：仓库被发现是公开的，exchange/live 里的快照带着名单里联系人的 QQ 号。端口（5140）、timeoutMs 这类不受影响。
const ID_KEY = /(?:qq|uid|id)$/i;
export const ID_MASK = '<号码已隐去>';
export function isIdentifier(key, value) {
    return ID_KEY.test(String(key)) && /^\d{5,}$/.test(String(value ?? '').trim().replace(/^(["'])(.*)\1$/, '$2'));
}

// 行首可以是列表项「- 」：原来匹配不上，列表里的 token / qq 都漏掉
const LINE = /^(\s*(?:-\s+)?)(["']?)([A-Za-z0-9_-]+)\2(\s*:\s*)(.*)$/;

export function redactYamlSecrets(text) {
    return text.split(/(\r?\n)/).map(part => {
        if (/^\r?\n$/.test(part)) return part;
        const match = LINE.exec(part);
        if (!match) return part;
        if (SECRET_KEY.test(match[3])) return `${match[1]}${match[2]}${match[3]}${match[2]}${match[4]}<已脱敏>`;
        if (isIdentifier(match[3], match[5])) return `${match[1]}${match[2]}${match[3]}${match[2]}${match[4]}${ID_MASK}`;
        return part;
    }).join('');
}

export function containsObviousSecret(text) {
    if (OBVIOUS_SECRET.test(text)) return true;
    return text.split(/\r?\n/).some(line => {
        const match = /^\s*(?:-\s+)?["']?([A-Za-z0-9_-]+)["']?\s*:\s*(.*)$/.exec(line);
        return Boolean(match && SECRET_KEY.test(match[1]) && match[2].trim() !== '<已脱敏>');
    });
}

export function snapshotStamp(date = new Date()) {
    const two = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function option(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

export function runSnapshotConfig({
    source = 'runtime/koishi/koishi.yml',
    target = `exchange/live/koishi-${snapshotStamp()}.yaml`,
} = {}) {
    const sourcePath = resolve(source);
    const targetPath = resolve(target);
    if (sourcePath === targetPath) throw new Error('配置快照不能覆盖源配置');
    const redacted = redactYamlSecrets(readFileSync(sourcePath, 'utf8'));
    if (containsObviousSecret(redacted)) throw new Error('脱敏后仍检测到疑似凭证，已拒绝写出快照');
    mkdirSync(dirname(targetPath), { recursive: true });
    // 不静默覆盖同名审计快照；需要指定另一个 --out 才能再次写入。
    writeFileSync(targetPath, redacted, { encoding: 'utf8', flag: 'wx' });
    return targetPath;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        const source = option('--source');
        const target = option('--out');
        const written = runSnapshotConfig({
            ...(source ? { source } : {}),
            ...(target ? { target } : {}),
        });
        console.log(`写好 ${written}；已完成凭证检查`);
    } catch (error) {
        console.error(`配置快照失败：${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
