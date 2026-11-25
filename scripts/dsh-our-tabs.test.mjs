// DSH 面板我们自己的三块标签页（client.js：她的状态 / 项目 / 她心里的）：
// 用一个假的 React（createElement 出树、useState 按队列给值、effect 不跑）把组件渲染成树，查文字和结构。
// 不连网、不起服务；数据全是合成的。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../dsh-plugins/dsh-qqbot-services/client.js', import.meta.url), 'utf8');

function load() {
    let queue = [];
    const React = {
        Fragment: 'fragment',
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState: initial => [queue.length ? queue.shift() : typeof initial === 'function' ? initial() : initial, () => {}],
        useRef: current => ({ current }),
        useEffect() {},
        useCallback: fn => fn,
        useId: () => 'test',
    };
    let panel;
    runInNewContext(source, {
        document: { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() {} } },
        window: { __ModuleLoader__: { load(bundle) { panel = bundle.factory(() => React); } }, localStorage: { getItem: () => null, setItem() {} } },
        URLSearchParams,
    });
    const slots = {};
    panel.apply({ slots: { inject(_name, callback) { callback(); }, register(slot, render) { slots[slot.name] = render; } } });
    return { Panel: slots.main, setStates: values => { queue = [...values]; } };
}

/** 把函数组件展开（深度优先，和 React 调 hook 的顺序一致），返回纯元素树 */
function expand(node) {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }));
    return { ...node, children: node.children.map(expand) };
}
const texts = node => Array.isArray(node) ? node.flatMap(texts)
    : node && typeof node === 'object' ? [...(node.props?.title ? [node.props.title] : []), ...node.children.flatMap(texts)]
        : typeof node === 'string' || typeof node === 'number' ? [String(node)] : [];
const find = (node, predicate) => Array.isArray(node) ? node.map(child => find(child, predicate)).find(Boolean)
    : node && typeof node === 'object' ? (predicate(node) ? node : find(node.children, predicate)) : undefined;
const named = name => node => typeof node.type === 'function' && node.type.name === name;

test('the three tabs and their endpoints are wired; 她心里的 only when panels.herInner is true', () => {
    for (const id of ["id: 'her'", "id: 'project'", "id: 'inner'"]) assert.ok(source.includes(id), id);
    for (const path of ['/her/memory', '/her/emotion', '/her/life', '/her/day', '/project/switches', '/project/metrics?days=',
        '/project/inventory', '/project/golive', '/inner/today', '/inner/ledger?days=14']) assert.ok(source.includes(path), path);
    assert.match(source, /state\?\.panels\?\.herInner === true/);
    assert.doesNotMatch(source, /innerHTML|dangerouslySetInnerHTML/);

    const { Panel, setStates } = load();
    const tabsOf = root => find(root, named('Tabs')).props.list.map(tab => tab.id);
    const plain = list => [...list];
    // Panel 的 hook 顺序：state, notice, sending, diagnosticOpen, copyStatus, loadError, tab
    setStates([{ health: {} }, '', false, false, '', '', 'her']);
    let root = Panel();
    assert.deepEqual(plain(tabsOf(root)), ['home', 'her', 'chat', 'room', 'house', 'soul', 'memory', 'books', 'link', 'project', 'sys']);
    assert.ok(find(root, named('HerState')));
    assert.equal(find(root, named('HerInner')), undefined);

    // 记住的是 inner 但没开：退回总览，不挂她心里的
    setStates([{ health: {}, panels: { herInner: false } }, '', false, false, '', '', 'inner']);
    root = Panel();
    assert.equal(find(root, named('Tabs')).props.value, 'home');
    assert.equal(find(root, named('HerInner')), undefined);
    assert.equal(find(root, node => node.props?.id === 'test-panel-inner'), undefined);

    // 开着才有，紧跟在她的状态后面
    setStates([{ health: {}, panels: { herInner: true } }, '', false, false, '', '', 'inner']);
    root = Panel();
    assert.deepEqual(plain(tabsOf(root)).slice(0, 4), ['home', 'her', 'inner', 'chat']);
    assert.ok(find(root, named('HerInner')));

    setStates([{ health: {} }, '', false, false, '', '', 'project']);
    assert.ok(find(Panel(), named('ProjectTools')));
});

test('她的状态 shows counts, freshness badges and her day; unavailable and errors get short notes', () => {
    const { Panel, setStates } = load();
    setStates([{ health: {} }, '', false, false, '', '', 'her']);
    const herState = find(Panel(), named('HerState'));
    setStates([
        0,
        { data: { linked: true, registeredAt: '2026-11-20T01:00:00.000Z', hindsight: { reachable: false }, common: { facts: 12, documents: 3 },
            own: null, episodes: { pending: 2, requeued: 1, lastWrittenAt: null }, audit: null, reconcile: { recorded: false } }, error: '' },
        { data: { feelingsExport: { at: '2026-11-26T01:00:00.000Z', ageMinutes: 300, stale: true }, ledger: { rows: 41, lastAt: null }, review: null }, error: '' },
        { data: null, error: 'her_unavailable' },
        { data: { heartbeat: { at: '2026-11-26T01:55:00.000Z', ageMinutes: 5, stale: false, ref: 'abc1234', connectedAt: null, lastMessageAt: null },
            proactive: { sentToday: 2, triedToday: 3, lastSentAt: null } }, error: '' },
        '',
        { data: { date: '2026-11-26', today: '2026-11-26', events: [{ time: '08:10', kind: 'eat', summary: '吃了早饭' }],
            days: [{ date: '2026-11-26', count: 1 }, { date: '2026-11-25', count: 4 }] }, error: '' },
    ]);
    const tree = expand(herState);
    const all = texts(tree).join('\n');
    assert.match(all, /12 条 · 3 份文档/);
    assert.match(all, /连不上/);
    assert.match(all, /待确认 2 · 重排过 1 次/);
    assert.match(all, /41 条/);
    assert.match(all, /QQ 那边/);
    assert.match(all, /发了 2 条（试了 3 次）/);
    assert.match(all, /abc1234/);
    assert.match(all, /过期/);
    assert.match(all, /暂时读不到/);
    assert.match(all, /08:10/);
    assert.match(all, /吃了早饭/);
    assert.doesNotMatch(all, /\beat\b/);
    const select = find(tree, node => node.type === 'select');
    assert.deepEqual([...select.children.map(option => option.props.value)], ['2026-11-26', '2026-11-25']);
    assert.match(texts(select).join(), /2026-11-26（今天） · 1 件/);

    setStates([0, { data: { available: false }, error: '' }, { data: undefined, error: '' }, { data: undefined, error: '' }, '', { data: undefined, error: '' }]);
    const empty = texts(expand(herState)).join('\n');
    assert.match(empty, /读不到插件配置/);
    assert.match(empty, /正在读取/);

    const life = desktop => ({ data: { world: { events: 5, latestDay: '2026-11-25' }, timeline: null, diary: { lastDay: '2026-11-24' },
        selfExport: null, nowExport: { at: '2026-11-26T03:00:00.000Z', ageMinutes: 10, stale: false }, ...desktop }, error: '' });
    const loading = { data: undefined, error: '' };
    setStates([0, loading, loading, life({ desktop: { turns: 6, lastAt: '2026-11-25T12:00:00.000Z' } }), '', loading]);
    const withDesktop = texts(expand(herState)).join('\n');
    assert.match(withDesktop, /5 件 · 最近一天 2026-11-25/);
    assert.match(withDesktop, /写到 2026-11-24/);
    assert.match(withDesktop, /电脑上和他聊了 6 回，最近一次/);
    setStates([0, loading, loading, life({ desktop: null }), '', loading]);
    assert.match(texts(expand(herState)).join('\n'), /没有记录/);
    setStates([0, loading, loading, life({}), '', loading]);
    assert.doesNotMatch(texts(expand(herState)).join('\n'), /电脑上/);
});

test('她心里的 renders only the said phrases, never causes or kinds that happen to be in the payload', () => {
    const { Panel, setStates } = load();
    setStates([{ health: {}, panels: { herInner: true } }, '', false, false, '', '', 'inner']);
    const inner = find(Panel(), named('HerInner'));
    setStates([
        0,
        { data: { day: '2026-11-26', at: Date.parse('2026-11-26T02:00:00Z'), stale: true,
            feelings: [{ label: '难过', said: '有点难过', cause: '合成来由-不该出现' }] }, error: '' },
        { data: { days: [{ day: '2026-11-26', rows: [{ time: '09:00', label: '开心', said: '挺开心', coarse: false, source: '合成来源-不该出现' }] },
            { day: '2026-11-25', rows: [] },
            { day: '2026-08-01', rows: [{ time: null, label: null, said: '只记得个大概：身上不太舒服', coarse: true }] }] }, error: '' },
    ]);
    const all = texts(expand(inner)).join('\n');
    assert.match(all, /这些是她愿意让你看的那部分：疼、家里的事只写换过的说法，不写是什么事。/);
    assert.match(all, /有点难过/);
    assert.match(all, /超过 3 小时没刷新/);
    assert.match(all, /挺开心/);
    assert.match(all, /只记得个大概：身上不太舒服/);
    assert.doesNotMatch(all, /不该出现/);
    assert.doesNotMatch(all, /2026-11-25/);

    setStates([0, { data: null, error: 'inner_disabled' }, { data: null, error: 'inner_disabled' }]);
    assert.match(texts(expand(inner)).join('\n'), /这一块没开/);
});

test('项目 renders switches with merge and fewerRules badges, metrics deltas, inventory slots and golive blockers', () => {
    const { Panel, setStates } = load();
    setStates([{ health: {} }, '', false, false, '', '', 'project']);
    const project = find(Panel(), named('ProjectTools'));
    const metric = (turns, extra = {}) => ({ hisMessages: 10, herBubbles: 12, turns, replyTurns: turns, proactiveTurns: 0, followOnTurns: 0,
        proactiveShare: 0, avgChars: 14, assistantToneRate: 0.05, repeatRate: 0, nagRate: 0.1, questionEndRate: 0.2, correctedRate: 0,
        latency: { count: 3, p50: 40, p90: 300 }, ...extra });
    setStates([
        0,
        { data: { available: true, counts: { total: 2, on: 1, merged: 1, legacyWritten: 1 }, groups: ['说话', '工具'], invalid: false,
            unrepresentable: ['合成合并：旧键 a=1 并不成一个合成合并'],
            fewerRules: { on: true, forced: [{ key: 'styleCheck', value: false, feature: true }] },
            features: [
                { key: 'styleCheck', label: '出口检查', group: '说话', adr: '0100', kind: 'bool', value: false, written: true, on: false, forcedOff: 'fewerRules' },
                { key: 'mergedKey', label: '合并开关', group: '说话', adr: null, kind: 'mode', value: 'on', written: false, on: true,
                    merged: { legacyWritten: ['oldKey'], absorbs: [{ key: 'oldKey', label: '旧开关', adr: null, written: true, value: true }] } },
            ] }, error: '' },
        7,
        { data: { available: true, window: { from: 'x', to: 'y', days: 7 }, contacts: 1, zone: { process: 'UTC', configured: 'Asia/Shanghai', matches: false },
            week: metric(20), days: [{ day: '2026-11-25', ...metric(3) }],
            previous: { at: '2026-11-19T00:00:00.000Z', deltas: { turns: { before: 18, after: 20, delta: 2 },
                assistantToneRate: { before: 0.08, after: 0.05, delta: -0.03 }, avgChars: { before: 14, after: 14, delta: 0 } } } }, error: '' },
        { data: { available: true, files: 2, firstDay: '2026-11-24', lastDay: '2026-11-25',
            inventory: { rounds: { total: 10, fallback: 0 }, chars: { avg: 3000, max: 5000, min: 900 }, piecesPerRound: { main: 5, history: 8, now: 2 },
                byKind: [{ kind: 'reply', rounds: 10, avgChars: 3000, avgNow: 200, maxNow: 400 }],
                slots: [{ slot: 'small', module: 'm1', list: 'main', rounds: 10, chars: 100, omitted: 0 },
                    { slot: 'big', module: 'm2', list: 'main', rounds: 5, chars: 9000, omitted: 1 }],
                modules: [{ module: 'm2', rounds: 5, chars: 9000 }] } }, error: '' },
        { data: { available: true, switches: { migrating: ['合成组：旧键 → 新键'], unrepresentable: ['合成阻断'] } }, error: '' },
    ]);
    const tree = expand(project);
    const all = texts(tree).join('\n');
    for (const want of ['出口检查', '少规矩强制关', '合并', '旧键还写着：oldKey', '旧开关（oldKey=开）', '合成合并：旧键 a=1', '共 2 项 · 生效 1',
        '时区 UTC', '↑ 2', '↓ 3.0 个百分点', '持平', '2026-11-25', '9000', '50%', '合成组：旧键 → 新键', '合成阻断', '40秒']) {
        assert.ok(all.includes(want), want);
    }
    const slotRows = find(tree, node => node.type === 'tbody' && texts(node).includes('big'));
    assert.equal(texts(slotRows.children[0])[0], 'big');
});
