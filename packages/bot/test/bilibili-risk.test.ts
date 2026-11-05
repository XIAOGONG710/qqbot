import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { BiliApiError, type BiliAccount, type SystemNotice } from '../src/bilibili/bilibili-account.ts';
import { createRiskMonitor, isRiskError, RISK_ALERT_GAP_MS, RISK_HALT_DAYS, RISK_NOTICE, RISK_POLL_MS } from '../src/bilibili/bilibili-risk.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-bilirisk-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const T0 = Date.parse('2026-10-21T13:00:00+08:00');
const DAY = 86_400_000;

function setup(options: { unread?: number | Error; notices?: SystemNotice[] | Error; dm?: Error } = {}) {
    const state = { t: T0, unread: options.unread ?? 0, notices: options.notices ?? [] as SystemNotice[] | Error };
    const dms: { uid: number; text: string }[] = [];
    const logs: string[] = [];
    const account = {
        async systemNoticeUnread() { if (state.unread instanceof Error) throw state.unread; return state.unread; },
        async systemNotices() { if (state.notices instanceof Error) throw state.notices; return state.notices; },
        async sendDm(input: { uid: number; text: string }) { if (options.dm) throw options.dm; dms.push(input); },
    } as unknown as BiliAccount;
    const dir = tmp();
    const make = () => createRiskMonitor({ account, uid: 98765, dir, now: () => state.t, log: line => logs.push(line) });
    return { state, dms, logs, dir, make };
}

describe('风险转私信：判断（ADR 0090）', () => {
    test('发评论 / 回复时哪些错误算风险：验证码、风控、账号受限算；评论区关了、重复、太长、登录态不对不算', () => {
        for (const code of [12015, -352, -412, -799, 12035, 12019]) assert.equal(isRiskError(new BiliApiError('x', code)), true, String(code));
        for (const code of [12002, 12051, 12009, 12025, -101, -111]) assert.equal(isRiskError(new BiliApiError('x', code)), false, String(code));
        assert.equal(isRiskError(new Error('断网')), false);
    });

    test('系统通知里像风险的：违规、警告、处罚、限制、评论被删……；欢迎、活动不算', () => {
        for (const text of ['你的评论因违规被删除', '账号存在异常行为，已限制', '警告：请勿发布广告', '风控提醒']) assert.ok(RISK_NOTICE.test(text), text);
        for (const text of ['欢迎来到哔哩哔哩', '你的投稿已通过', '新人任务奖励']) assert.ok(!RISK_NOTICE.test(text), text);
    });
});

describe('风险转私信：停发言、私信告诉他', () => {
    test('出事了（trip）：公开发言停 7 天；私信发给他，带上她想发的话、链接、停多久；不受私信试运行的开关管', async () => {
        const s = setup();
        const risk = s.make();
        assert.equal(risk.halted(), false);
        await risk.trip({ why: '评论被 B 站拦了（B 站接口 code 12015（需要验证码））', wanted: '这个猫也太会了', link: 'https://www.bilibili.com/video/BV1Jonu6mEwN' });
        assert.equal(risk.halted(), true);
        assert.equal(s.dms.length, 1);
        assert.equal(s.dms[0]!.uid, 98765);
        for (const part of ['【B 站风险提醒】评论被 B 站拦了', '她本来想发的：这个猫也太会了', 'https://www.bilibili.com/video/BV1Jonu6mEwN', `停 ${RISK_HALT_DAYS} 天`, '之后的话只走私信']) assert.ok(s.dms[0]!.text.includes(part), part);
        s.state.t += RISK_HALT_DAYS * DAY - 1000;
        assert.equal(risk.halted(), true);
        s.state.t += 2000;
        assert.equal(risk.halted(), false);
    });

    test('停着的时间存在文件里，重启后还停着；单次事件可以指定天数（取更长的）', async () => {
        const s = setup();
        const first = s.make();
        await first.trip({ why: '出事了', days: 3 });
        assert.equal(JSON.parse(readFileSync(join(s.dir, 'bilibili-risk.json'), 'utf8')).until, T0 + 3 * DAY);
        assert.equal(s.make().halted(), true);
        s.state.t += RISK_ALERT_GAP_MS + 1;
        await first.trip({ why: '又出事了', days: 1 });
        assert.equal(JSON.parse(readFileSync(join(s.dir, 'bilibili-risk.json'), 'utf8')).until, T0 + 3 * DAY, '取更长的，不会被短的覆盖');
    });

    test('私信提醒 30 分钟内不重复发（连着失败时不刷屏），停发言照样续上；私信发不出去只记日志', async () => {
        const s = setup();
        const risk = s.make();
        await risk.trip({ why: '第一次' });
        await risk.trip({ why: '第二次' });
        assert.equal(s.dms.length, 1);
        assert.ok(s.logs.some(line => line.includes('刚提醒过他')));
        s.state.t += RISK_ALERT_GAP_MS + 1;
        await risk.trip({ why: '第三次' });
        assert.equal(s.dms.length, 2);

        const broken = setup({ dm: new BiliApiError('私信被限制', 21046) });
        const b = broken.make();
        await b.trip({ why: '出事了' });
        assert.equal(b.halted(), true, '私信没发出去也要停');
        assert.ok(broken.logs.some(line => line.includes('私信提醒也没发出去') && line.includes('私信被限制')));
    });
});

describe('风险转私信：看系统通知', () => {
    test('没有未读：什么都不做；每 15 分钟才看一次', async () => {
        const s = setup({ unread: 0 });
        const risk = s.make();
        await risk.tick();
        await risk.tick();
        assert.equal(s.dms.length, 0);
        assert.equal(risk.halted(), false);
        s.state.unread = 1;
        await risk.tick();
        assert.equal(s.dms.length, 0, '15 分钟内不再看');
        s.state.t += RISK_POLL_MS + 1000;
        s.state.notices = [{ id: '1', title: '欢迎来到哔哩哔哩', content: '', at: 0 }];
        await risk.tick();
        assert.equal(s.dms.length, 0, '没有违规警告字眼：只记日志，不停发言');
        assert.equal(risk.halted(), false);
        assert.ok(s.logs.some(line => line.includes('没有违规 / 警告一类的字眼')));
    });

    test('收到违规 / 警告类的系统通知：立刻停公开发言并私信告诉他（带标题和正文）；同一条不重复提醒', async () => {
        const s = setup({ unread: 1, notices: [{ id: '7', title: '评论违规提醒', content: '你的评论因含有不当内容已被删除，请遵守社区规范', at: T0 }] });
        const risk = s.make();
        await risk.tick();
        assert.equal(risk.halted(), true);
        assert.equal(s.dms.length, 1);
        assert.ok(s.dms[0]!.text.includes('评论违规提醒') && s.dms[0]!.text.includes('不当内容已被删除'), s.dms[0]!.text);
        s.state.t += RISK_ALERT_GAP_MS + RISK_POLL_MS;
        s.state.unread = 2;
        await risk.tick();
        assert.equal(s.dms.length, 1, '同一条通知不重复提醒');
    });

    test('未读数涨了但读不出内容：不停发言，私信让他去看一眼（一个未读数只提醒一次）；读不了未读数只记日志、过 15 分钟再试', async () => {
        const s = setup({ unread: 2, notices: new Error('读不了') });
        const risk = s.make();
        await risk.tick();
        assert.equal(risk.halted(), false);
        assert.equal(s.dms.length, 1);
        assert.ok(s.dms[0]!.text.includes('2 条未读的系统通知'));
        // 读不出内容时未读数不算处理过（ADR 0090：以前读失败也记下未读数，之后同数永远不再读）：继续重试，
        // 但提醒有 30 分钟冷却——冷却内不重复发，冷却过了仍读不出才再提醒一次
        s.state.t += RISK_POLL_MS;
        await risk.tick();
        assert.equal(s.dms.length, 1, '冷却内不重复提醒');
        s.state.t += RISK_ALERT_GAP_MS;
        await risk.tick();
        assert.equal(s.dms.length, 2, '冷却过了仍读不出内容，再提醒一次');

        const down = setup({ unread: new Error('断网') });
        const d = down.make();
        await d.tick();
        assert.ok(down.logs.some(line => line.includes('看系统通知的未读数失败')));
        assert.equal(down.dms.length, 0);
    });
});
