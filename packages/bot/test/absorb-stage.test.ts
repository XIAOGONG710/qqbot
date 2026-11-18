import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ABSORB_STAGES, absorbStage, type Module } from '../src/interpreter/interpreter.ts';
import { consentModule } from '../src/modules/consent.ts';
import { selfNotesModule, takeMemoryReview, takeSelfNotes } from '../src/modules/self-notes.ts';
import { shellModule } from '../src/modules/shell.ts';
import { workModeModule, type WorkMarkerHooks } from '../src/modules/work-mode.ts';
import type { Contact } from '../src/platform/config.ts';
import type { ShellRun } from '../src/platform/shell-tool.ts';

// 回复里的内部标记（ADR 0336「生成之后那一段」第 12 步）：行为基线 review / self-memory / work-mode / consent 场景逐字不变；
// 这里核对顺序表和四个模块各自的标记——尤其是基线走不到的（跑命令、动电脑、拒绝切工作：都要碰真机器）
const boyfriend: Contact = { qq: 1, name: '阿明', tier: 'boyfriend' };
const classmate: Contact = { qq: 2, name: '小周', tier: 'classmate' };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe('标记处理顺序表（ADR 0336 第 12 步）', () => {
    test('顺序照迁移前的手写顺序；voice 的位置留给 App 里用户自己的语音代码', () => {
        assert.deepEqual([...ABSORB_STAGES], ['notes', 'voice', 'shell', 'workSwitch', 'work', 'consent']);
    });

    test('一个位置上按注册顺序跑；没有模块挂时原样返回', () => {
        const a: Module = { id: 'a', absorbAt: { shell: text => `${text}1` } };
        const b: Module = { id: 'b', absorbAt: { shell: (text, contact) => `${text}2@${contact.qq}`, consent: text => `${text}x` } };
        assert.equal(absorbStage([a, b], 'shell', '稿', boyfriend), '稿12@1');
        assert.equal(absorbStage([a, b], 'notes', '稿', boyfriend), '稿');
        assert.equal(absorbStage([], 'consent', '稿', boyfriend), '稿');
    });
});

describe('她自己记的（modules/self-notes.ts）', () => {
    const setup = (overrides: { diary?: boolean; diaryThrows?: boolean; memory?: boolean; rememberFails?: boolean; review?: boolean } = {}) => {
        const kept: string[] = [], diary: string[] = [], remembered: [number, string, string][] = [], lines: string[] = [];
        const reviews: [number, string][] = [];
        const module = selfNotesModule({
            keepPrivate: text => { kept.push(text); },
            ...(overrides.diary ? { keepDiary: (text: string) => { if (overrides.diaryThrows) throw new Error('盘满了'); diary.push(text); } } : {}),
            remember: (contact, text, kind) => {
                if (overrides.memory === false) return undefined;
                remembered.push([contact.qq, text, kind]);
                return overrides.rememberFails ? Promise.reject(new Error('连不上')) : Promise.resolve();
            },
            ...(overrides.review ? { reviewMemory: (contact: Contact, text: string) => { reviews.push([contact.qq, text]); } } : {}),
            log: line => lines.push(line),
        });
        return { kept, diary, remembered, reviews, lines, absorb: (text: string, contact = boyfriend) => absorbStage([module], 'notes', text, contact) };
    };

    test('takeSelfNotes：三种标记都摘，全角半角冒号都认，空的不算，多出来的空行收掉', () => {
        assert.deepEqual(takeSelfNotes('好呀\n<<记住：他周五考试>>\n\n\n<<日记: 今天很开心>><<私密：>>\n晚安'),
            { text: '好呀\n\n晚安', notes: [{ kind: '记住', text: '他周五考试' }, { kind: '日记', text: '今天很开心' }] });
    });

    test('记忆待核对标记只摘除并保存她写的线索；没有回调时也不漏到对话里', () => {
        assert.deepEqual(takeMemoryReview('我记得不太准\n<<记忆待核对：10月2日｜和阿明聊的｜第一次见面在校门口｜我可能把地点记错了>>'), {
            text: '我记得不太准', reviews: ['10月2日｜和阿明聊的｜第一次见面在校门口｜我可能把地点记错了'],
        });
        const s = setup({ review: true });
        assert.equal(s.absorb('我记得不太准\n<<记忆待核对：10月2日｜和阿明聊的｜见面地点｜记不清>>'), '我记得不太准');
        assert.deepEqual(s.reviews, [[boyfriend.qq, '10月2日｜和阿明聊的｜见面地点｜记不清']]);
        assert.equal(setup().absorb('好呀\n<<记忆待核对：疑点>>'), '好呀');
    });

    test('私密只进她自己的地方，不进记忆、不进本地日记', () => {
        const s = setup({ diary: true });
        assert.equal(s.absorb('嗯嗯\n<<私密：其实有点难过>>'), '嗯嗯');
        assert.deepEqual(s.kept, ['其实有点难过']);
        assert.deepEqual(s.remembered, []);
        assert.deepEqual(s.diary, []);
    });

    test('记住 / 日记写进记忆；日记只有男朋友档、给了 keepDiary 才在本地留一份', () => {
        const s = setup({ diary: true });
        assert.equal(s.absorb('<<记住：他不吃香菜>>\n<<日记：一起看了电影>>'), '');
        assert.deepEqual(s.remembered, [[1, '他不吃香菜', '记住'], [1, '一起看了电影', '日记']]);
        assert.deepEqual(s.diary, ['一起看了电影']);
        s.absorb('<<日记：和同学聊了作业>>', classmate);
        assert.deepEqual(s.diary, ['一起看了电影'], '同学档不留本地日记');
        assert.equal(s.remembered.length, 3, '但照样进记忆');
        const off = setup();
        off.absorb('<<日记：一起看了电影>>');
        assert.deepEqual(off.diary, []);
    });

    test('本地日记没留成、记忆没写进去都只记日志，标记照样摘掉；没开长期记忆就不写', async () => {
        const s = setup({ diary: true, diaryThrows: true, rememberFails: true });
        assert.equal(s.absorb('晚安\n<<日记：今天很累>>'), '晚安');
        await settle();
        assert.deepEqual(s.lines, ['[1] 她写的日记没能在本地留一份：盘满了', '[1] 她自己记的事没写进记忆：连不上']);
        const none = setup({ memory: false });
        assert.equal(none.absorb('<<记住：他周五考试>>晚安'), '晚安');
        assert.deepEqual(none.remembered, []);
    });
});

describe('跑命令（modules/shell.ts 的 absorbAt）', () => {
    const setup = (overrides: { looked?: boolean; fails?: boolean } = {}) => {
        const notes: [number, string][] = [], ran: string[] = [], audited: ShellRun[] = [], lines: string[] = [];
        const module = shellModule({ commands: {
            lookedRecently: () => Boolean(overrides.looked),
            setNote: (contact, note) => { notes.push([contact.qq, note]); },
            run: async command => {
                ran.push(command);
                if (overrides.fails) throw new Error('起不来');
                return { command, ok: true, code: 0, output: '好了', ms: 12 };
            },
            audit: run => { audited.push(run); },
            log: line => lines.push(line),
        } });
        return { notes, ran, audited, lines, absorb: (text: string) => absorbStage([module], 'shell', text, boyfriend) };
    };

    test('没写命令原样返回；模拟器那种不给 commands 的不摘标记', () => {
        const s = setup();
        assert.equal(s.absorb('好呀'), '好呀');
        assert.deepEqual(s.ran, []);
        assert.equal(absorbStage([shellModule()], 'shell', '<<执行：Get-Date>>', boyfriend), '<<执行：Get-Date>>');
    });

    test('摘掉标记、后台跑、跑完审计并记下给她下一轮看的那一行', async () => {
        const s = setup();
        assert.equal(s.absorb('我看看\n<<执行：Get-Date>>'), '我看看');
        assert.deepEqual(s.ran, ['Get-Date']);
        assert.deepEqual(s.notes, [], '结果要等跑完');
        await settle();
        assert.equal(s.audited.length, 1);
        assert.equal(s.notes.length, 1);
        assert.deepEqual(s.lines, ['[1] 她要跑命令：Get-Date', '[1] 命令跑完：成，12 ms']);
    });

    test('这一轮刚看过网上的内容：一条都不跑，只留一行原因（防注入）', () => {
        const s = setup({ looked: true });
        assert.equal(s.absorb('<<执行：Get-Date>>\n<<执行：dir>>'), '');
        assert.deepEqual(s.ran, []);
        assert.equal(s.notes.length, 1);
        assert.match(s.notes[0]![1], /命令没有执行/);
        assert.deepEqual(s.lines, ['[1] 命令没跑：这一轮提示词里有网上内容（防注入）']);
    });

    test('危险的命令拦下、别的照跑；跑的时候出错只记日志', async () => {
        const s = setup();
        s.absorb('<<执行：shutdown /s>>\n<<执行：dir>>');
        assert.deepEqual(s.ran, ['dir']);
        assert.match(s.notes[0]![1], /这条命令没有执行：关机 \/ 重启/);
        const failing = setup({ fails: true });
        failing.absorb('<<执行：dir>>');
        await settle();
        assert.deepEqual(failing.lines, ['[1] 她要跑命令：dir', '[1] 命令出错：起不来']);
        assert.deepEqual(failing.audited, []);
    });
});

describe('切工作和动电脑（modules/work-mode.ts 的 absorbAt）', () => {
    const setup = (task?: string) => {
        const modes: [number, string][] = [], refusals: string[] = [], started: [number, string][] = [], lines: string[] = [];
        let notTyped = 0;
        const hooks: WorkMarkerHooks = {
            setMode: (contact, mode) => { modes.push([contact.qq, mode]); }, refused: reason => { refusals.push(reason); },
            taskOf: () => task, start: (contact, what) => { started.push([contact.qq, what]); }, notTyped: () => { notTyped++; }, log: line => lines.push(line),
        };
        const modules = [workModeModule(() => 'chat', hooks)];
        return {
            modes, refusals, started, lines, notTyped: () => notTyped,
            run: (stage: 'workSwitch' | 'work', text: string, contact = boyfriend) => absorbStage(modules, stage, text, contact),
        };
    };

    test('<<同意工作>> 切到工作模式；<<拒绝工作：原因>> 切回聊天、原因记下；不写就不动', () => {
        const s = setup();
        assert.equal(s.run('workSwitch', '行吧\n<<同意工作>>'), '行吧');
        assert.equal(s.run('workSwitch', '先陪我聊会儿\n<<拒绝工作：今天不想干活>>'), '先陪我聊会儿');
        assert.equal(s.run('workSwitch', '好呀'), '好呀');
        assert.deepEqual(s.modes, [[1, 'work'], [1, 'chat']]);
        assert.deepEqual(s.refusals, ['今天不想干活']);
        assert.deepEqual(s.lines, ['[1] 她答应了切工作模式', '[1] 她拒绝了切工作：今天不想干活']);
    });

    test('<<用电脑>>：他亲手打的那一条交去干；不是亲手打的不动电脑、告诉主人；别的档位不认', () => {
        const typed = setup('帮我看下 D 盘还剩多少');
        assert.equal(typed.run('work', '我去看看\n<<用电脑>>'), '我去看看');
        assert.deepEqual(typed.started, [[1, '帮我看下 D 盘还剩多少']]);
        assert.equal(typed.notTyped(), 0);
        const forwarded = setup(undefined);
        assert.equal(forwarded.run('work', '我去看看\n<<用电脑>>'), '我去看看');
        assert.deepEqual(forwarded.started, []);
        assert.equal(forwarded.notTyped(), 1);
        assert.match(forwarded.lines[0]!, /不是亲手打的字（ADR 0179），不动电脑$/);
        const other = setup('帮我看下');
        assert.equal(other.run('work', '<<用电脑>>', classmate), '<<用电脑>>');
        assert.deepEqual(other.started, []);
    });

    test('不给 markers（模拟器）时不摘标记', () => {
        assert.equal(absorbStage([workModeModule(() => 'chat')], 'workSwitch', '<<同意工作>>', boyfriend), '<<同意工作>>');
    });
});

describe('他的请求（modules/consent.ts 的 absorbAt）', () => {
    const setup = (pending?: { label: string }) => {
        let waiting = pending;
        const told: string[] = [], lines: string[] = [];
        let ran = 0;
        const module = consentModule({ ask: () => undefined, answer: {
            withdraw: () => { const had = Boolean(waiting); waiting = undefined; return had; },
            tellRefusal: (_contact, reason) => { told.push(reason); },
            claim: () => { const got = waiting; waiting = undefined; return got ? { label: got.label, run: () => { ran++; } } : undefined; },
            log: line => lines.push(line),
        } });
        return { told, lines, ran: () => ran, waiting: () => waiting, absorb: (text: string, contact = boyfriend) => absorbStage([module], 'consent', text, contact) };
    };

    test('<<拒绝：原因>>：撤掉他的请求、把原因告诉他；没有请求在等也照样告诉', () => {
        const s = setup({ label: '看你的屏幕' });
        assert.equal(s.absorb('不要\n<<拒绝：在换衣服>>'), '不要');
        assert.equal(s.waiting(), undefined);
        assert.deepEqual(s.told, ['在换衣服']);
        assert.deepEqual(s.lines, ['[1] 她拒绝了：在换衣服（撤掉了他的请求）']);
        const none = setup();
        none.absorb('<<拒绝：>>');
        assert.deepEqual(none.told, ['']);
        assert.deepEqual(none.lines, ['[1] 她拒绝了：不想']);
    });

    test('<<同意>>：请求还在才去做；不在（过期、没提过）只摘标记', () => {
        const s = setup({ label: '看你的屏幕' });
        assert.equal(s.absorb('好吧\n<<同意>>'), '好吧');
        assert.equal(s.ran(), 1);
        assert.deepEqual(s.lines, ['[1] 她答应了：看你的屏幕']);
        const none = setup();
        assert.equal(none.absorb('好吧<<同意>>'), '好吧');
        assert.equal(none.ran(), 0);
        assert.deepEqual(none.lines, []);
    });

    test('没表态原样返回；只给男朋友档', () => {
        const s = setup({ label: '看你的屏幕' });
        assert.equal(s.absorb('等一下'), '等一下');
        assert.equal(s.absorb('<<同意>>', classmate), '<<同意>>');
        assert.equal(s.ran(), 0);
    });
});
