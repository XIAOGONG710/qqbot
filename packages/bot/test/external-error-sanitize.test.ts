import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sanitizeExternalError } from '../src/world/external-error.ts';

describe('供应商异常摘要脱敏（external-error）', () => {
    test('普通文本和 Error 取消息；非 Error 值按 String 转换', () => {
        assert.equal(sanitizeExternalError('boom'), 'boom');
        assert.equal(sanitizeExternalError(new Error('oops')), 'oops');
        assert.equal(sanitizeExternalError(42), '42');
        assert.equal(sanitizeExternalError(null), 'null');
        assert.equal(sanitizeExternalError(undefined), 'undefined');
        assert.equal(sanitizeExternalError(['a']), 'a');
        assert.equal(sanitizeExternalError({}), '[object Object]');
    });

    test('空输入回退到「未知错误」', () => {
        assert.equal(sanitizeExternalError(''), '未知错误');
        assert.equal(sanitizeExternalError('   \n\t '), '未知错误');
        assert.equal(sanitizeExternalError(new Error('')), '未知错误');
    });

    test('URL 里的用户名密码被遮掉；没有凭据的 URL 原样保留', () => {
        assert.equal(sanitizeExternalError('https://user:pass@example.com/x'), 'https://<redacted>@example.com/x');
        assert.equal(sanitizeExternalError('HTTP://A:B@host.test/p'), 'HTTP://<redacted>@host.test/p');
        assert.equal(sanitizeExternalError('https://example.com/x'), 'https://example.com/x');
    });

    test('Authorization / proxy-authorization 头（含 Bearer / basic）被遮掉', () => {
        assert.equal(sanitizeExternalError('Authorization: Bearer abc123'), 'Authorization=<redacted>');
        assert.equal(sanitizeExternalError('proxy-authorization: basic dXNlcjpwYXNz'), 'proxy-authorization=<redacted>');
        assert.equal(sanitizeExternalError('authorization=raw-token'), 'authorization=<redacted>');
    });

    test('Cookie / Set-Cookie 整行被遮掉', () => {
        assert.equal(sanitizeExternalError('Cookie: session=abc; theme=dark'), 'Cookie=<redacted>');
        assert.equal(sanitizeExternalError('Set-Cookie: a=b'), 'Set-Cookie=<redacted>');
    });

    test('session / refresh_token 在逗号或空白前截断', () => {
        assert.equal(sanitizeExternalError('sessionId=abc123, ok'), 'sessionId=<redacted>, ok');
        assert.equal(sanitizeExternalError('session: abc'), 'session=<redacted>');
        assert.equal(sanitizeExternalError('refresh_token: xyz, 你好'), 'refresh_token=<redacted>, 你好');
    });

    test('URL 查询串被遮掉，片段保留', () => {
        assert.equal(sanitizeExternalError('https://api.example.com/v1?token=abc&page=2'), 'https://api.example.com/v1?<redacted>');
        assert.equal(sanitizeExternalError('https://x.com/a?b=1#frag'), 'https://x.com/a?<redacted>#frag');
        assert.equal(sanitizeExternalError('https://x.com/a#frag'), 'https://x.com/a#frag');
    });

    test('密钥类字段被遮掉', () => {
        assert.equal(sanitizeExternalError('api_key=sk-123'), 'api_key=<redacted>');
        assert.equal(sanitizeExternalError('apikey=abc'), 'apikey=<redacted>');
        assert.equal(sanitizeExternalError('access_token=abc'), 'access_token=<redacted>');
        assert.equal(sanitizeExternalError('token=abc'), 'token=<redacted>');
        assert.equal(sanitizeExternalError('secret=abc'), 'secret=<redacted>');
        assert.equal(sanitizeExternalError('password: abc'), 'password=<redacted>');
    });

    // 记录实际行为：正则用 \b 开头，而中文「密」不是 \w，词边界匹配不上，
    // 所以开头/非 ASCII 字符后的「密码：」不会被脱敏。见收尾话的疑似问题。
    test('中文「密码：」当前不会被遮掉（记录现状）', () => {
        assert.equal(sanitizeExternalError('密码：123456'), '密码：123456');
        assert.equal(sanitizeExternalError('a密码：123456'), 'a密码=<redacted>');
    });

    test('空白折叠成单空格，最多保留 160 个 UTF-16 码元', () => {
        assert.equal(sanitizeExternalError('a\n  b\t c'), 'a b c');
        assert.equal(sanitizeExternalError('x'.repeat(160)), 'x'.repeat(160));
        assert.equal(sanitizeExternalError('x'.repeat(200)), 'x'.repeat(160));
        assert.equal(sanitizeExternalError('😀'.repeat(100)).length, 160);
    });

    test('多种凭据混在一条里也能全部遮掉', () => {
        assert.equal(
            sanitizeExternalError('https://u:p@api.example.com/v1?token=abc&page=2 Authorization: Bearer xyz'),
            'https://<redacted>@api.example.com/v1?<redacted> Authorization=<redacted>',
        );
    });
});
