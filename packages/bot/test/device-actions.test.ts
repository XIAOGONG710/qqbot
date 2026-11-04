import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDeviceControl, DEVICE_ACTIONS, deviceMenu, parseDeviceTokens, stripDeviceTokens, type AuditEntry, type DeviceControlDeps, type DispatchJob, type PolicyContext } from '../src/platform/device-actions.ts';

const context: PolicyContext = { links: new Map([['音乐', 'https://music.example/play']]), apps: ['网易云', '记事本'], maxVolume: 60 };

describe('设备令牌：动作表和参数校验（ADR 0148）', () => {
    test('认得的动作按参数校验：目标、秒数、音量上限、登记过的名字', () => {
        const parsed = parseDeviceTokens([
            '早点睡哦',
            '<device:notify|手机|该吃药啦>',
            '<device:timer|都|600|泡面>',
            '<device:volume|set|40>',
            '<device:open_url|音乐>',
        ].join('\n'), context);
        assert.equal(parsed.reply, '早点睡哦', '令牌行整行去掉，别的话原样');
        assert.deepEqual(parsed.proposals.map(p => [p.action, p.targets]), [['notify', ['phone']], ['timer', ['computer', 'phone']]], '一轮最多 2 条');
        assert.deepEqual(parsed.rejected.map(r => r.action), ['volume', 'open_url'].slice(0, 2));
        assert.match(parsed.rejected[0]!.reason, /一轮最多 2 条/);
    });

    test('不合格的一律不认：没有的动作、越界的数字、没登记的名字、多余参数、带换行或尖括号的文字', () => {
        const bad = (token: string) => parseDeviceTokens(token, context);
        assert.equal(bad('<device:rm_rf|/>').proposals.length, 0);
        assert.match(bad('<device:rm_rf|/>').rejected[0]!.reason, /没有这个动作/);
        assert.equal(bad('<device:timer|手机|5|x>').proposals.length, 0, '秒数小于 10');
        assert.equal(bad('<device:timer|手机|90000|x>').proposals.length, 0, '秒数大于一天');
        assert.equal(bad('<device:volume|set|90>').proposals.length, 0, '超过音量上限');
        assert.equal(bad('<device:volume|up|3>').proposals.length, 0, 'up 不带数字');
        assert.equal(bad('<device:open_url|https://evil.example>').proposals.length, 0, '只能说登记过的名字');
        assert.equal(bad('<device:open_app|cmd>').proposals.length, 0);
        assert.equal(bad('<device:notify|电脑|a|b>').proposals.length, 0, '多余参数');
        assert.equal(bad('<device:notify|电脑|' + 'x'.repeat(61) + '>').proposals.length, 0, '文字太长');
        assert.equal(bad('<device:ring|x>').proposals.length, 0, 'ring 不带参数');
        assert.equal(bad('<device:media|play_pause>').proposals.length, 1);
        assert.equal(bad('<device:lock>').proposals.length, 1);
    });

    test('看屏幕 / 摄像头：她的回复里写了也不认（只有他自己发的命令能触发）', () => {
        const parsed = parseDeviceTokens('<device:capture_screen>\n<device:capture_camera>', context);
        assert.equal(parsed.proposals.length, 0);
        assert.deepEqual(parsed.rejected.map(r => r.reason), ['看屏幕 / 摄像头只有他自己发命令才行', '看屏幕 / 摄像头只有他自己发命令才行']);
    });

    test('stripDeviceTokens：不管开没开，令牌都不给他看；一行里夹着的只去掉令牌', () => {
        assert.equal(stripDeviceTokens('好呀<device:notify|电脑|x>\n<device:lock>\n晚安'), '好呀\n晚安');
        assert.equal(stripDeviceTokens('没有令牌的话 <3 不动'), '没有令牌的话 <3 不动');
    });

    test('菜单只列这轮可用的：没配手机就不提手机、不提 ring；音量上限写进去', () => {
        const withPhone = deviceMenu(context, ['computer', 'phone']);
        const computerOnly = deviceMenu(context, ['computer']);
        const phoneOnly = deviceMenu(context, ['phone']);
        assert.match(withPhone, /<device:ring>/);
        assert.doesNotMatch(computerOnly, /<device:ring>|手机/);
        assert.match(withPhone, /最高 60/);
        assert.match(withPhone, /<device:open_url\|音乐>/);
        assert.match(withPhone, /一律不听/);
        assert.match(phoneOnly, /<device:ring>/);
        assert.doesNotMatch(phoneOnly, /<device:(?:media|volume|lock|sleep|open_url|open_app)/, '只有手机时不列电脑上的动作');
        assert.match(phoneOnly, /<device:notify\|手机\|/);
        assert.equal(deviceMenu(context, []), '', '一个设备都没有就没有菜单');
    });

    test('动作表就这么多：没有读写文件、执行命令、键鼠、安装删除、支付、代发消息', () => {
        assert.deepEqual(Object.keys(DEVICE_ACTIONS).sort(), ['capture_camera', 'capture_screen', 'lock', 'media', 'notify', 'open_app', 'open_url', 'ring', 'sleep', 'timer', 'volume']);
    });
});

describe('设备控制器：分档、限额、批准、审计', () => {
    function setup(overrides: Partial<DeviceControlDeps> = {}) {
        const jobs: DispatchJob[] = [];
        const said: string[] = [];
        const audit: AuditEntry[] = [];
        const drafts: string[] = [];
        let clock = 1_000_000;
        let shouldFail = false;
        const control = createDeviceControl({
            mode: 'on', context,
            dispatch: async job => { jobs.push(job); return shouldFail ? { ok: false, error: '没成' } : { ok: true, dataUrl: job.action.startsWith('capture') ? 'data:image/png;base64,AAAA' : undefined }; },
            available: () => ['computer', 'phone'],
            say: text => said.push(text),
            now: () => clock,
            audit: entry => audit.push(entry),
            draft: line => drafts.push(line),
            log: () => undefined,
            ...overrides,
        });
        return { control, jobs, said, audit, drafts, tick: (ms: number) => { clock += ms; }, fail: (value: boolean) => { shouldFail = value; } };
    }
    const settle = () => new Promise(resolve => setImmediate(resolve));

    test('auto：执行并审计；令牌从回复里摘掉；审计里没有参数原文', async () => {
        const t = setup();
        assert.equal(t.control.take('我给你提醒一下\n<device:notify|电脑|该喝水了>'), '我给你提醒一下');
        await settle();
        assert.deepEqual(t.jobs, [{ action: 'notify', target: 'computer', params: { text: '该喝水了' } }]);
        assert.deepEqual(t.audit.map(a => [a.action, a.decision]), [['notify', 'executed']]);
        assert.equal(JSON.stringify(t.audit).includes('喝水'), false);
    });

    test('auto：同样的动作 10 分钟内只做一次；一小时到 4 次就拦住', async () => {
        const t = setup();
        t.control.take('<device:notify|电脑|a>'); await settle();
        t.tick(60_000); t.control.take('<device:notify|电脑|a>'); await settle();
        assert.equal(t.jobs.length, 1);
        assert.equal(t.audit.at(-1)!.decision, 'duplicate');
        for (const text of ['b', 'c', 'd']) { t.tick(1000); t.control.take(`<device:notify|电脑|${text}>`); await settle(); }
        t.tick(1000); t.control.take('<device:notify|电脑|e>'); await settle();
        assert.equal(t.jobs.length, 4);
        assert.equal(t.audit.at(-1)!.decision, 'limited');
        t.tick(3_700_000); t.control.take('<device:notify|电脑|f>'); await settle();
        assert.equal(t.jobs.length, 5, '过了一小时又能用');
    });

    test('一天最多 12 次自动动作', async () => {
        const t = setup({ limits: { autoPerHour: 100 } });
        for (let i = 0; i < 14; i++) { t.tick(5 * 60_000); t.control.take(`<device:notify|电脑|n${i}>`); await settle(); }
        assert.equal(t.jobs.length, 12);
        assert.equal(t.audit.filter(a => a.decision === 'limited').length, 2);
    });

    test('approve：提议后不执行，给他一行说明；回「批准」才执行；拒绝、过期都不执行', async () => {
        const t = setup();
        t.control.take('要不要我帮你锁屏？\n<device:lock>');
        await settle();
        assert.equal(t.jobs.length, 0);
        assert.match(t.said[0]!, /她想锁屏.*回「批准」就执行/);
        assert.equal(t.control.pending()?.action, 'lock');
        assert.deepEqual(t.control.ownerSays('批准'), { kind: 'reply', text: '（好，锁屏）' });
        await settle();
        assert.deepEqual(t.jobs.map(j => j.action), ['lock']);
        assert.equal(t.control.pending(), undefined);

        t.control.take('<device:sleep>');
        assert.deepEqual(t.control.ownerSays('/拒绝'), { kind: 'reply', text: '（取消了）' });
        await settle();
        assert.equal(t.jobs.length, 1);

        t.control.take('<device:sleep>');
        t.tick(6 * 60_000);
        assert.deepEqual(t.control.ownerSays('批准'), { kind: 'reply', text: '（已经过期了，她要再提议一次才行）' });
        await settle();
        assert.equal(t.jobs.length, 1);
        assert.deepEqual(t.audit.map(a => a.decision), ['pending', 'approved', 'executed', 'pending', 'declined', 'pending', 'expired']);
    });

    test('系统时钟明显回拨后待批准动作立即过期', async () => {
        const t = setup();
        t.control.take('<device:sleep>');
        t.tick(-(5 * 60_000 + 1));
        assert.equal(t.control.pending(), undefined);
        assert.match((t.control.ownerSays('/设备') as { text: string }).text, /没有待批准的/);
        assert.deepEqual(t.control.ownerSays('批准'), { kind: 'reply', text: '（已经过期了，她要再提议一次才行）' });
        await settle();
        assert.deepEqual(t.jobs, []);
        assert.deepEqual(t.audit.map(entry => entry.decision), ['pending', 'expired']);
    });

    test('没有待办时「批准」只是一句普通的话；同一时间只有一个待批准', async () => {
        const t = setup();
        assert.equal(t.control.isOwnerCommand('批准'), false);
        assert.deepEqual(t.control.ownerSays('批准'), { kind: 'none' });
        assert.deepEqual(t.control.ownerSays('批准吧'), { kind: 'none' }, '必须整句就是「批准」');
        t.control.take('<device:lock>'); t.control.take('<device:sleep>');
        assert.equal(t.control.isOwnerCommand('批准'), true);
        assert.equal(t.control.isOwnerCommand('拒绝'), true);
        assert.equal(t.control.isOwnerCommand('/设备'), true);
        assert.equal(t.control.pending()?.action, 'lock');
        assert.equal(t.audit.at(-1)!.decision, 'rejected');
        assert.equal(t.said.length, 1);
    });

    test('approve 每天最多 6 次提议', () => {
        const t = setup();
        for (let i = 0; i < 8; i++) { t.control.take('<device:lock>'); t.control.ownerSays('拒绝'); t.tick(1000); }
        assert.equal(t.audit.filter(a => a.decision === 'pending').length, 6);
        assert.equal(t.audit.filter(a => a.decision === 'limited').length, 2);
    });

    test('capture：只有他的斜杠命令；带说明；每次隔 10 秒、一天 20 次', async () => {
        const t = setup();
        assert.deepEqual(t.control.ownerSays('/屏幕'), { kind: 'capture', what: 'capture_screen', note: '' });
        assert.deepEqual(t.control.ownerSays('/看屏幕 你看这个报错'), { kind: 'capture', what: 'capture_screen', note: '你看这个报错' });
        assert.deepEqual(t.control.ownerSays('/摄像头'), { kind: 'capture', what: 'capture_camera', note: '' });
        for (const chat of ['屏幕，好亮', '屏幕好亮', '看屏幕', '我的屏幕坏了', '摄像头', '拍照']) assert.deepEqual(t.control.ownerSays(chat), { kind: 'none' }, `不带斜杠不触发：${chat}`);
        const first = await t.control.capture('capture_screen');
        assert.equal(first.ok, true);
        assert.match(first.dataUrl!, /^data:image\/png/);
        assert.equal((await t.control.capture('capture_screen')).ok, false, '隔得太近');
        for (let i = 0; i < 25; i++) { t.tick(11_000); await t.control.capture('capture_screen'); }
        assert.equal(t.audit.filter(a => a.action === 'capture_screen' && a.decision === 'executed').length, 20);
    });

    test('设备没连上：动作不做，审计里写原因；看屏幕给他一个说得清的失败', async () => {
        const t = setup({ available: () => ['phone'] });
        t.control.take('<device:notify|电脑|x>'); await settle();
        assert.equal(t.jobs.length, 0);
        assert.equal(t.audit.at(-1)!.decision, 'failed');
        assert.deepEqual(await t.control.capture('capture_screen'), { ok: false, error: '电脑这一头还没连上' });
    });

    test('dryRun：什么都不执行，只写草稿；批准也只是试运行', async () => {
        const t = setup({ mode: 'dryRun' });
        t.control.take('<device:notify|电脑|x>\n<device:lock>'); await settle();
        assert.equal(t.jobs.length, 0);
        assert.match(t.drafts[0]!, /会弹一条通知/);
        assert.deepEqual(t.control.ownerSays('批准'), { kind: 'reply', text: '（试运行：锁屏没有真的执行）' });
        assert.equal((await t.control.capture('capture_screen')).ok, false);
        assert.equal(t.jobs.length, 0);
    });

    test('设备那头报失败：审计记 failed；批准的动作失败会告诉他', async () => {
        const t = setup();
        t.fail(true);
        t.control.take('<device:lock>');
        t.control.ownerSays('批准'); await settle();
        assert.equal(t.audit.at(-1)!.decision, 'failed');
        assert.equal(t.said.at(-1), '（锁屏没做成）');
    });

    test('/设备：说明连着哪些、有没有待批准', () => {
        const t = setup();
        assert.deepEqual(t.control.ownerSays('/设备'), { kind: 'reply', text: '（设备：开；连着：电脑、手机；没有待批准的）' });
        t.control.take('<device:lock>');
        assert.match((t.control.ownerSays('/设备') as { text: string }).text, /等你批准：锁屏/);
    });
});
