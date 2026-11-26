import { createHash } from 'node:crypto';
import { closeSync, createReadStream, lstatSync, openSync, readSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export function backupArtifactIdentity(path) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1) throw new Error('备份制品不是非空普通文件');
    const fd = openSync(path, 'r');
    try {
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(256 * 1024);
        let size = 0;
        for (let read; (read = readSync(fd, buffer, 0, buffer.length, null));) {
            hash.update(buffer.subarray(0, read));
            size += read;
        }
        if (size !== info.size) throw new Error('备份制品大小在校验期间变化');
        return { bytes: size, sha256: hash.digest('hex') };
    } finally { closeSync(fd); }
}

export const validBackupDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export async function checkBackupDigest(path, expected) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    const measured = hash.digest('hex');
    if (expected && measured !== expected) throw new Error('备份制品与完成标记的 SHA-256 不一致');
    return measured;
}
