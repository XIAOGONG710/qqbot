import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { credentialPath, saveCredential, type BiliCredential, type BiliRequest, type BiliResponse } from '../src/bilibili-account.ts';
import { PROBE_DM_TEXT, runProbe } from '../src/bilibili-probe.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-biliprobe-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const json = (body: unknown): BiliResponse => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const credential: BiliCredential = { sessdata: 'secret-sess', biliJct: 'secret-jct', dedeUserId: '4242', buvid3: 'secret-bv3', savedAt: '2026-10-20T00:00:00.000Z' };
const NAV = { code: 0, data: { isLogin: true, uname: '繁星小窝', mid: 4242, wbi_img: { img_url: 'https://x/a1b2c3.png', sub_url: 'https://x/d4e5f6.png' } } };

const item = (n: number) => ({ bvid: `BV1abcdefg${String(n).padStart(2, '0')}`, aid: 1000 + n, title: `<em class="keyword">猫</em>视频${n}`, description: '简介', author: 'up', typename: '动物', play: 100, like: 10, duration: '3:20' });

interface Options {
    /** 每个关键词搜到几个（不同关键词的视频 id 错开，防止被去重） */
    perKeyword?: number;
    searchError?: (keyword: string) => BiliResponse | undefined;
    subtitle?: 'ok' | 'none' | 'needLogin' | 'view412';
    dm?: BiliResponse;
}

function harness(options: Options = {}) {
    const requests: { url: string; body?: string }[] = [];
    const out: string[] = [];
    const clock = { t: 1_800_000_000_000 };
    const dataDir = tmp();
    saveCredential(credentialPath(dataDir), credential);
    const perKeyword = options.perKeyword ?? 3;
    let keywordIndex = 0;
    const request: BiliRequest = async (url, init) => {
        requests.push({ url, ...(init.body !== undefined ? { body: init.body } : {}) });
        if (url.includes('web-interface/nav')) return json(NAV);
        if (url.includes('wbi/search/type')) {
            const keyword = decodeURIComponent(/keyword=([^&]*)/.exec(url)![1]!);
            const failed = options.searchError?.(keyword);
            if (failed) return failed;
            const base = keywordIndex++ * 10;
            return json({ code: 0, data: { result: Array.from({ length: perKeyword }, (_, i) => item(base + i)) } });
        }
        if (url.includes('web-interface/view')) return options.subtitle === 'view412' ? { ok: false, status: 412, text: async () => '' } : json({ code: 0, data: { cid: 77 } });
        if (url.includes('player/wbi/v2')) {
            if (options.subtitle === 'none') return json({ code: 0, data: { subtitle: { subtitles: [] } } });
            if (options.subtitle === 'needLogin') return json({ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } });
            return json({ code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: '//subtitle.example/s.json' }] } } });
        }
        if (url.includes('subtitle.example')) return json({ body: [{ content: '今天带大家看一只三花猫' }, { content: '它特别会撒娇' }] });
        if (url.includes('send_msg')) return options.dm ?? json({ code: 0, data: {} });
        throw new Error(`没有准备：${url}`);
    };
    const deps = { request, dataDir, now: () => clock.t, out: (line: string) => out.push(line), sleep: async (ms: number) => { clock.t += ms; } };
    return { deps, requests, out, dataDir };
}

const all = (out: string[]) => out.join('\n');

describe('B 站账号体检（--probe，ADR 0089）', () => {
    test('默认只读：登录、搜两个词、读最多 5 个视频的字幕；不发任何 POST，不发私信；输出里没有凭证', async () => {
        const h = harness();
        const result = await runProbe(h.deps);
        assert.equal(result.ok, true);
        assert.deepEqual(result.subtitles, { readable: 5, tried: 5 });
        assert.equal(result.dm, 'skipped');
        assert.equal(h.requests.filter(r => r.url.includes('wbi/search/type')).length, 2);
        assert.equal(h.requests.filter(r => r.url.includes('player/wbi/v2')).length, 5, '最多试 5 个视频');
        assert.ok(!h.requests.some(r => r.body !== undefined || r.url.includes('send_msg')), '只读：没有任何写请求');
        assert.match(all(h.out), /登录有效：「繁星小窝」（uid 4242）/);
        assert.match(all(h.out), /字幕：5 个视频里 5 个读到了/);
        assert.match(all(h.out), /私信没试/);
        assert.ok(!all(h.out).includes('secret-'), '输出里没有凭证内容');
        assert.ok(!all(h.out).includes('<em'), '标题里的 HTML 已去掉');
    });

    test('每个视频之间隔一会儿再问（不像在爬）', async () => {
        const h = harness();
        let slept = 0;
        await runProbe({ ...h.deps, sleep: async ms => { slept += ms; } });
        assert.ok(slept >= 5 * 1_000, `睡了 ${slept} 毫秒`);
    });

    test('B 站说读字幕还要登录：不通过，并且如实说是登录态的问题', async () => {
        const h = harness({ subtitle: 'needLogin' });
        const result = await runProbe(h.deps);
        assert.equal(result.ok, false);
        assert.equal(result.subtitles.readable, 0);
        assert.match(all(h.out), /读字幕要登录/);
    });

    test('视频都没有字幕轨：说明可能是视频本来没有，不当成登录问题；找不到 cid（view 被拦）：每个视频单独报错、继续往下', async () => {
        const none = harness({ subtitle: 'none' });
        const r1 = await runProbe(none.deps);
        assert.equal(r1.subtitles.readable, 0);
        assert.match(all(none.out), /没有字幕轨/);
        assert.match(all(none.out), /本来就没有/);
        assert.equal(r1.ok, true, '没有字幕轨不是接口坏了');

        const blocked = harness({ subtitle: 'view412' });
        const r2 = await runProbe(blocked.deps);
        assert.equal(r2.subtitles.tried, 5);
        assert.match(all(blocked.out), /读字幕出错：B 站接口返回 412\n/);
        assert.match(all(blocked.out), /5 个视频里 0 个读到了，5 个出错\n/);
        assert.doesNotMatch(all(blocked.out), /本来就没有/, '出错不是「本来就没有」');
        assert.equal(r2.ok, false, '读字幕全出错 = 体检不通过');
    });

    test('一个关键词被风控：报 code，另一个照搜；两个都失败：没有视频，不通过', async () => {
        const one = harness({ searchError: keyword => (keyword === '三花猫' ? json({ code: -412, message: '请求被拦截' }) : undefined) });
        const r1 = await runProbe(one.deps);
        assert.match(all(one.out), /搜「三花猫」失败：B 站接口 code -412（请求被拦截）/);
        assert.match(all(one.out), /搜「流浪猫 日常」：3 条/);
        assert.equal(r1.ok, true);

        const both = harness({ searchError: () => json({ code: -352, message: '风控' }) });
        const r2 = await runProbe(both.deps);
        assert.equal(r2.ok, false);
        assert.match(all(both.out), /没有搜到视频/);
    });

    test('给了 uid 才发私信：只发一条固定的测试话，发到那个 uid；成功则通过', async () => {
        const h = harness();
        const result = await runProbe({ ...h.deps, dmUid: 9999 });
        const sends = h.requests.filter(r => r.url.includes('send_msg'));
        assert.equal(sends.length, 1);
        const form = new URLSearchParams(sends[0]!.body);
        assert.equal(form.get('msg[receiver_id]'), '9999');
        assert.equal(form.get('msg[sender_uid]'), '4242');
        assert.deepEqual(JSON.parse(form.get('msg[content]')!), { content: PROBE_DM_TEXT });
        assert.equal(result.dm, 'sent');
        assert.equal(result.ok, true);
        assert.match(all(h.out), /私信已发给 uid 9999/);
        assert.ok(!all(h.out).includes('secret-'));
    });

    test('私信被拒：报 code 和消息，提醒先关注她的号；体检不通过，但读的部分照常报告', async () => {
        const h = harness({ dm: json({ code: 21026, message: '对方没有关注你，不能继续发送' }) });
        const result = await runProbe({ ...h.deps, dmUid: 9999 });
        assert.equal(result.dm, 'failed');
        assert.equal(result.ok, false);
        assert.equal(result.subtitles.readable, 5);
        assert.match(all(h.out), /私信失败：B 站接口 code 21026（对方没有关注你，不能继续发送）。/);
        assert.match(all(h.out), /关注了她的号/);
    });

    test('没有凭证 / 凭证失效 / 问不了：各说各的，且一个搜索请求都不发', async () => {
        const dataDir = tmp();
        const base = { dataDir, now: () => 1_800_000_000_000, sleep: async () => {} };
        const seen: string[] = [];
        const out: string[] = [];
        const missing = await runProbe({ ...base, request: async url => { seen.push(url); return json(NAV); }, out: line => out.push(line) });
        assert.equal(missing.ok, false);
        assert.match(out.join('\n'), /还没有登录凭证/);
        assert.equal(seen.length, 0);

        saveCredential(credentialPath(dataDir), credential);
        const invalidOut: string[] = [];
        const invalid = await runProbe({ ...base, request: async url => { seen.push(url); return json({ code: 0, data: { isLogin: false } }); }, out: line => invalidOut.push(line) });
        assert.equal(invalid.ok, false);
        assert.match(invalidOut.join('\n'), /凭证已经失效/);
        assert.ok(seen.every(url => url.includes('web-interface/nav')));

        const downOut: string[] = [];
        const down = await runProbe({ ...base, request: async () => { throw new Error('断网'); }, out: line => downOut.push(line) });
        assert.equal(down.ok, false);
        assert.match(downOut.join('\n'), /不代表凭证失效/);
    });
});
