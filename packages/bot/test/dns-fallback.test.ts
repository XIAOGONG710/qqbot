import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fallbackLookup, type DnsFallbackOptions } from '../src/dns-fallback.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

type Lookup = NonNullable<DnsFallbackOptions['lookup']>;
const notFound = (): NodeJS.ErrnoException => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });

/** 先成功一次，再让解析器断掉 */
function flaky() {
    let down = false;
    const lookup: Lookup = (_host, options, callback) => {
        if (down) return callback(notFound(), '');
        if ((options as { all?: boolean }).all) callback(null, [{ address: '3.173.21.63', family: 4 }]);
        else callback(null, '3.173.21.63', 4);
    };
    return { lookup, setDown: (value: boolean) => { down = value; } };
}

const resolve = (lookup: ReturnType<typeof fallbackLookup>, host: string, all = false) => new Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }>(done => {
    (lookup as unknown as (host: string, options: object, callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => void) => void)(
        host, all ? { all: true } : {}, (error, address, family) => done({ error, address, ...(family !== undefined ? { family } : {}) }),
    );
});

describe('模型接口的 DNS 兜底（ADR 0070 第 17 项）', () => {
    test('解析成功照常返回并记下；之后解析器断了，白名单里的域名改用上次的地址（单个和 all 两种形状）', async () => {
        const { lookup, setDown } = flaky();
        const logs: string[] = [];
        const guard = fallbackLookup({ hosts: ['api.deepseek.com'], lookup, log: message => logs.push(message) });
        assert.deepEqual(await resolve(guard, 'api.deepseek.com'), { error: null, address: '3.173.21.63', family: 4 });
        setDown(true);
        assert.deepEqual(await resolve(guard, 'api.deepseek.com'), { error: null, address: '3.173.21.63', family: 4 });
        assert.deepEqual(await resolve(guard, 'api.deepseek.com', true), { error: null, address: [{ address: '3.173.21.63', family: 4 }] });
        assert.equal(logs.length, 1, '一小时内只记一次');
        assert.match(logs[0]!, /api\.deepseek\.com.*ENOTFOUND.*3\.173\.21\.63/);
    });

    test('不在白名单的域名、从没解析成功过的域名、其他错误：原样把错误交回去，不乱编地址', async () => {
        const { lookup, setDown } = flaky();
        const guard = fallbackLookup({ hosts: ['api.deepseek.com'], lookup });
        await resolve(guard, 'api.deepseek.com');
        await resolve(guard, 'evil.example');
        setDown(true);
        assert.equal((await resolve(guard, 'evil.example')).error?.code, 'ENOTFOUND');
        const fresh = fallbackLookup({ hosts: ['api.deepseek.com'], lookup });
        assert.equal((await resolve(fresh, 'api.deepseek.com')).error?.code, 'ENOTFOUND', '没有缓存就没有兜底');
        const other: Lookup = (_host, _options, callback) => callback(Object.assign(new Error('refused policy'), { code: 'EACCES' }), '');
        const odd = fallbackLookup({ hosts: ['api.deepseek.com'], lookup: other });
        assert.equal((await resolve(odd, 'api.deepseek.com')).error?.code, 'EACCES');
    });

    test('缓存过期不用；缓存写进文件，重启后的新实例也能用', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-dns-'));
        dirs.push(dir);
        const file = join(dir, 'dns-cache.json');
        let now = 1_000_000;
        const { lookup, setDown } = flaky();
        const first = fallbackLookup({ hosts: ['api.deepseek.com'], lookup, file, now: () => now });
        await resolve(first, 'api.deepseek.com');
        assert.ok(existsSync(file));
        assert.match(readFileSync(file, 'utf8'), /3\.173\.21\.63/);
        setDown(true);
        const restarted = fallbackLookup({ hosts: ['api.deepseek.com'], lookup, file, now: () => now, maxAgeMs: 60_000 });
        assert.equal((await resolve(restarted, 'api.deepseek.com')).address, '3.173.21.63');
        now += 61_000;
        assert.equal((await resolve(restarted, 'api.deepseek.com')).error?.code, 'ENOTFOUND', '超过有效期就不用了');
    });
});
