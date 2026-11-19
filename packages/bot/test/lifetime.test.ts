import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { appLifetime } from '../src/platform/lifetime.ts';

// App 的统一停止（ADR 0336 第 6 步，取代 ADR 0320 的两份清单）：每项资源登记一次；构造失败按登记先后停，App.stop 按停止先后表停
const tick = () => new Promise<void>(done => setImmediate(done));
function fixture(stopOrder = ['a', 'b', 'c'] as const) {
    const ran: string[] = [], logs: string[] = [];
    let released = 0;
    const lifetime = appLifetime({ release: () => { released++; }, log: line => logs.push(line), stopOrder });
    return { lifetime, ran, logs, released: () => released };
}

describe('统一停止的登记表', () => {
    test('构造失败按登记先后停；App.stop 按先后表停，同名的按登记先后', () => {
        const build = fixture();
        build.lifetime.own('c', () => { build.ran.push('c'); });
        build.lifetime.own('a', () => { build.ran.push('a1'); });
        build.lifetime.own('b', () => { build.ran.push('b'); });
        build.lifetime.own('a', () => { build.ran.push('a2'); });
        build.lifetime.rollback();
        assert.deepEqual(build.ran, ['c', 'a1', 'b', 'a2']);
        assert.equal(build.released(), 1, '没有要等的，当场释放');

        const run = fixture();
        run.lifetime.own('c', () => { run.ran.push('c'); });
        run.lifetime.own('a', () => { run.ran.push('a1'); });
        run.lifetime.own('b', () => { run.ran.push('b'); });
        run.lifetime.commit();
        run.lifetime.own('a', () => { run.ran.push('a2'); });
        assert.equal(run.lifetime.stop(), undefined);
        assert.deepEqual(run.ran, ['a1', 'a2', 'b', 'c'], '搭好之后登记的（名单外的回复器）也停');
        assert.equal(run.released(), 1);
    });

    test('等所有已派发的收尾再释放；没确认的逐条记日志；同步抛错不打断后面的', async () => {
        const { lifetime, ran, logs, released } = fixture();
        let finish!: () => void;
        const slow = new Promise<void>(done => { finish = done; });
        lifetime.own('a', () => [slow, undefined, Promise.reject(new TypeError('x'))]);
        lifetime.own('b', () => { throw new RangeError('y'); });
        lifetime.own('c', () => { ran.push('c'); });
        lifetime.commit();
        const drain = lifetime.stop();
        assert.ok(drain instanceof Promise);
        assert.deepEqual(ran, ['c']);
        await tick();
        assert.equal(released(), 0, '还有没结束的收尾，租约不放');
        finish(); await drain;
        assert.equal(released(), 1);
        assert.deepEqual(logs, ['停止时持久收尾未确认（TypeError）', '停止时持久收尾未确认（RangeError）']);
    });

    test('构造失败的收尾在后台等，日志换成启动失败的说法', async () => {
        const { lifetime, logs, released } = fixture();
        lifetime.own('a', () => Promise.reject(new Error('z')));
        lifetime.rollback();
        assert.equal(released(), 0);
        await tick();
        assert.equal(released(), 1);
        assert.deepEqual(logs, ['启动失败时后台收尾未确认（Error）']);
    });

    test('只停一次；搭好后不回滚；停了之后再登记的不收；名字不在先后表里直接报错', () => {
        const { lifetime, ran, released } = fixture();
        assert.throws(() => lifetime.own('d' as 'a', () => {}), /不在停止先后表里/);
        lifetime.own('a', () => { ran.push('a'); });
        lifetime.commit();
        lifetime.rollback();
        assert.equal(ran.length, 0);
        lifetime.stop(); lifetime.stop();
        lifetime.own('b', () => { ran.push('b'); });
        lifetime.stop();
        assert.deepEqual(ran, ['a']);
        assert.equal(released(), 1);
    });

    test('交接：拿掉被接手的几项，接手的那一项登记在这时', () => {
        const { lifetime, ran } = fixture();
        lifetime.own('b', () => { ran.push('b-jokes'); });
        lifetime.own('c', () => { ran.push('c'); });
        lifetime.handOver(['b'], 'a', () => { ran.push('a-modules'); });
        lifetime.rollback();
        assert.deepEqual(ran, ['c', 'a-modules']);
    });
});

describe('App 只用这一份登记（源码）', () => {
    const app = readFileSync(new URL('../src/platform/app.ts', import.meta.url), 'utf8');
    const order = [...app.slice(app.indexOf('const STOP_ORDER = ['), app.indexOf('] as const;')).matchAll(/'([a-z-]+)'/g)].map(match => match[1]!);
    const owned = new Set([...app.matchAll(/lifetime\.(?:own\('([a-z-]+)'|handOver\(\[[^\]]*\], '([a-z-]+)')/g)].map(match => (match[1] ?? match[2])!));

    test('不再有构造收尾登记和手写的停止清单；stop() 只按先后表停', () => {
        assert.doesNotMatch(app, /construction\.|appConstruction|releaseLock/);
        const stop = app.slice(app.indexOf('        stop() {\n            if (stopped) return stopDrain;'), app.indexOf('        status() {'));
        assert.match(stop, /stopDrain = lifetime\.stop\(\);\n\s+return stopDrain;\n\s+\},\n$/);
        assert.doesNotMatch(stop, /\.stop\(\)(?!;\n\s+return stopDrain)|exec\.cancel|use[A-Z]\w+\(undefined\)/);
    });

    test('先后表里每一项都有登记的地方，登记的每一项都在先后表里', () => {
        assert.ok(order.length > 30, `先后表 ${order.length} 项`);
        assert.equal(new Set(order).size, order.length, '先后表没有重复');
        assert.deepEqual([...owned].filter(name => !order.includes(name)), []);
        assert.deepEqual(order.filter(name => !owned.has(name)), []);
        // 有意的先后：先置 stopped；日记、答应的事先于长期记忆（收尾时还要写记忆）；解释器接手小梗、口头习惯；最后撤现实数据读口
        const at = (name: string) => order.indexOf(name);
        assert.equal(order[0], 'stopped');
        assert.ok(at('diaries') < at('memory') && at('promises') < at('memory'));
        assert.ok(at('jokes') < at('modules') && at('idioms') < at('modules'));
        assert.deepEqual(order.slice(-6), ['weather', 'air-quality', 'daylight', 'calendar', 'transport', 'world-needs']);
    });
});
