import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

const SAFE_DATABASE = /^qqbot_restore_drill_[a-z0-9_]{1,40}$/;

export function isolatedDatabaseTarget(databaseUrl) {
    let url;
    try { url = new URL(databaseUrl); } catch { throw new Error('隔离数据库地址不是有效 URL'); }
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('恢复演练只支持 PostgreSQL');
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!SAFE_DATABASE.test(database)) throw new Error('隔离数据库名必须以 qqbot_restore_drill_ 开头');
    if (!url.hostname || !url.username) throw new Error('隔离数据库地址缺少主机或用户');
    return {
        host: url.hostname,
        port: url.port || '5432',
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database,
        sslmode: url.searchParams.get('sslmode') ?? undefined,
    };
}

export function safeSqlArtifact(path, expectedBytes) {
    const resolved = resolve(path);
    const info = lstatSync(resolved);
    if (info.isSymbolicLink() || !info.isFile() || info.size < 1) throw new Error('数据库备份不是安全的普通文件');
    if (expectedBytes !== undefined && info.size !== expectedBytes) throw new Error('数据库备份大小与完成标记不一致');
    return { path: resolved, bytes: info.size };
}

export function psqlConnectionArgs(target) {
    return ['-h', target.host, '-p', target.port, '-U', target.user, '-d', target.database];
}
