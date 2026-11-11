// 设备表（devices.json）：配对码和长期凭据。
// - 配对码 8 位数字，10 分钟有效，用过即废，连错 5 次作废；表里只存它的 SHA-256。
// - token 是 32 字节随机数（base64url），表里只存 SHA-256，比对用恒定时间。
// 每次操作都重新读文件：`npm run pair` / `npm run devices` 是另一个进程，它们写的东西中继马上要看得到。
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRecord } from './types.ts';
import type { Clock } from './types.ts';

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_WRONG = 5;
export const MAX_DEVICES = 16;
const MAX_NAME_CHARS = 64;

export interface DeviceStorage {
    read(): string | undefined;
    write(text: string): void;
}

export interface DeviceInfo {
    id: string;
    name: string;
    createdAt: number;
}

interface DeviceRecord extends DeviceInfo {
    tokenHash: string;
}

interface PairingRecord {
    codeHash: string;
    expiresAt: number;
    wrong: number;
}

interface DeviceFile {
    version: 1;
    devices: DeviceRecord[];
    pairing?: PairingRecord;
}

export type PairResult =
    | { ok: true; deviceId: string; token: string }
    /** none：现在没有有效的配对码（没发过、过期了、用掉了、错太多次作废了）；wrong：码不对；full：设备太多 */
    | { ok: false; reason: 'none' | 'wrong' | 'full' };

export interface DeviceStore {
    /** 生成一个新的配对码（旧的作废）。返回值只应该打印在本机终端 */
    startPairing(): string;
    pair(code: unknown, deviceName: unknown): PairResult;
    verify(deviceId: unknown, token: unknown): boolean;
    has(deviceId: string): boolean;
    list(): DeviceInfo[];
    revoke(deviceId: string): boolean;
}

export interface DeviceStoreOptions {
    storage: DeviceStorage;
    now?: Clock;
    randomBytes?: (size: number) => Uint8Array;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** 两个十六进制摘要的恒定时间比较 */
function sameHash(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

function cleanName(value: unknown): string {
    const text = typeof value === 'string' ? value : '';
    // 控制字符去掉：名字会显示在终端里
    const cleaned = [...text].filter(ch => ch >= ' ' && ch !== '\u007f').join('').trim();
    return [...cleaned].slice(0, MAX_NAME_CHARS).join('') || '手机';
}

function parseFile(text: string | undefined): DeviceFile {
    const empty: DeviceFile = { version: 1, devices: [] };
    if (!text) return empty;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('devices.json 不是合法的 JSON；修好或删掉它再启动（删掉后所有设备要重新配对）'); }
    if (!isRecord(parsed) || !Array.isArray(parsed.devices)) return empty;
    const devices = parsed.devices.filter((item): item is DeviceRecord => isRecord(item)
        && typeof item.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(item.id)
        && typeof item.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(item.tokenHash))
        .map(item => ({ id: item.id, name: cleanName(item.name), createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0, tokenHash: item.tokenHash }));
    const pairing = parsed.pairing;
    const valid = isRecord(pairing) && typeof pairing.codeHash === 'string' && /^[0-9a-f]{64}$/.test(pairing.codeHash)
        && typeof pairing.expiresAt === 'number' && typeof pairing.wrong === 'number';
    return valid
        ? { version: 1, devices, pairing: { codeHash: pairing.codeHash as string, expiresAt: pairing.expiresAt as number, wrong: pairing.wrong as number } }
        : { version: 1, devices };
}

export function createDeviceStore(options: DeviceStoreOptions): DeviceStore {
    const { storage } = options;
    const now = options.now ?? Date.now;
    const random = options.randomBytes ?? (size => nodeRandomBytes(size));
    const load = () => parseFile(storage.read());
    const save = (file: DeviceFile) => storage.write(`${JSON.stringify(file, null, 1)}\n`);

    /** 均匀的 8 位数字：拒绝采样，不取模偏 */
    const newCode = (): string => {
        const limit = Math.floor(0x1_0000_0000 / 100_000_000) * 100_000_000;
        for (;;) {
            const value = Buffer.from(random(4)).readUInt32BE(0);
            if (value < limit) return String(value % 100_000_000).padStart(8, '0');
        }
    };

    return {
        startPairing() {
            const file = load();
            const code = newCode();
            file.pairing = { codeHash: sha256(code), expiresAt: now() + PAIRING_TTL_MS, wrong: 0 };
            save(file);
            return code;
        },
        pair(code, deviceName) {
            const file = load();
            const pairing = file.pairing;
            if (!pairing) return { ok: false, reason: 'none' };
            if (now() >= pairing.expiresAt) {
                delete file.pairing;
                save(file);
                return { ok: false, reason: 'none' };
            }
            if (typeof code !== 'string' || !sameHash(sha256(code), pairing.codeHash)) {
                pairing.wrong += 1;
                if (pairing.wrong >= PAIRING_MAX_WRONG) delete file.pairing;
                save(file);
                return { ok: false, reason: 'wrong' };
            }
            if (file.devices.length >= MAX_DEVICES) return { ok: false, reason: 'full' };
            const deviceId = Buffer.from(random(12)).toString('base64url');
            const token = Buffer.from(random(32)).toString('base64url');
            delete file.pairing;
            file.devices.push({ id: deviceId, name: cleanName(deviceName), createdAt: now(), tokenHash: sha256(token) });
            save(file);
            return { ok: true, deviceId, token };
        },
        verify(deviceId, token) {
            if (typeof deviceId !== 'string' || typeof token !== 'string' || !token || token.length > 256) return false;
            const offered = sha256(token);
            let matched = false;
            // 不提前退出：每一项都比一遍
            for (const device of load().devices) {
                if (sameHash(offered, device.tokenHash) && device.id === deviceId) matched = true;
            }
            return matched;
        },
        has: deviceId => load().devices.some(device => device.id === deviceId),
        list: () => load().devices.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
        revoke(deviceId) {
            const file = load();
            const kept = file.devices.filter(device => device.id !== deviceId);
            if (kept.length === file.devices.length) return false;
            file.devices = kept;
            save(file);
            return true;
        },
    };
}

export function fileDeviceStorage(path: string): DeviceStorage {
    mkdirSync(dirname(path), { recursive: true });
    return {
        read() {
            try { return readFileSync(path, 'utf8'); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
                throw error;
            }
        },
        write(text) {
            // 先写临时文件再改名：另一个进程不会读到写了一半的表
            const temp = `${path}.${process.pid}.tmp`;
            writeFileSync(temp, text, { mode: 0o600 });
            renameSync(temp, path);
        },
    };
}

export function memoryDeviceStorage(initial?: string): DeviceStorage {
    let text = initial;
    return { read: () => text, write(next) { text = next; } };
}
