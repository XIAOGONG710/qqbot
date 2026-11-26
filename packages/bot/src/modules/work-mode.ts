// 工作模式的三行作为解释器的模块（ADR 0336 第 5 步）：DSH 线 10-29 / 10-30。按他这个人现在的状态（platform/work-mode.ts，<数据目录>/work-mode.json）放其中一行：
// - pending（他发了 /dsh，在求她切工作）：答不答应由她，可以提条件（workRequest 槽）；
// - work（她答应了）：干活，但说话还是她（workMode 槽）；
// - chat（平常）：他这条要是得真动电脑，她自己决定写 <<用电脑>>（workJudge 槽）。
// 只给男朋友档；危机、主动找他、只想一想的轮次照样放（原来就只看状态）。不存状态（状态的读写在 app.ts 收 /dsh、/QQ 和她的标记时做），不调模型。
// 工作模式下他的消息会先转去电脑那边（app.ts），不一定走到这里。
// 她回复里的标记（ADR 0336「生成之后那一段」第 12 步，App 给了 markers 才摘）：
// - absorbAt.workSwitch：<<同意工作>> 切到工作模式；<<拒绝工作：原因>> 切回聊天、原因记进她拒绝过的事。只认男朋友档（2026-11-26 入站审查前不看档位），别人那里只摘不办。
// - absorbAt.work：<<用电脑>>（只给男朋友档）——他最后那一条是亲手打的字才交给电脑那边干（ADR 0179），不是就不动、告诉主人。干活本身（start）还在 App 里。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 work-mode 等场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import { logBody } from '../platform/sensitive.ts';
import { takeWorkMarker, WORK_MARKER, type WorkMode } from '../platform/work-mode.ts';

/** 他刚把你切到工作模式（/dsh）时加的一行：干活，但说话还是她 */
export const WORK_MODE_NOTE = '他刚把你切到工作模式：这会儿他让你帮忙干活。先说结果，用你平时的口气，别分点汇报、别写“好的/已完成/总结”，过程他追问再说。';

/** 他在求她切工作：答不答应由她，可以提条件 */
export const WORK_REQUEST_NOTE = '他在求你切到工作模式。你可以答应、可以拒绝、也可以提条件（比如先陪你聊十分钟）。答应就在回复最后写 `<<同意工作>>`；拒绝就写 `<<拒绝工作：原因>>`。两个都不写就算没答应，他还在聊天模式。';

/** 她自己决定要不要动电脑：不用他先发 /dsh，也不用事后 /QQ 切回来 */
export const WORK_JUDGE_NOTE = '他这条要是得真动电脑才办得到（跑命令、改代码、看文件、装东西、上网查东西、替他操作软件），就在回复最后另起一行写 `<<用电脑>>`，系统会把这条交给你去做，做完你照结果回他；只是聊天、聊打算、开玩笑、问你觉得——都别写。这个标记不会发出去。';

/** 她回复里的工作标记怎么办（App 给） */
export interface WorkMarkerHooks {
    /** 改这个人的状态（写 work-mode.json） */
    setMode: (contact: Contact, mode: WorkMode) => void;
    /** 她拒绝切工作的原因记下来 */
    refused: (reason: string) => void;
    /** 他这一条亲手打的话（要交给电脑那边干的事）；不是亲手打的就没有 */
    taskOf: (contact: Contact) => string | undefined;
    /** 交给电脑那边干，干完把结果发回去（不等它） */
    start: (contact: Contact, task: string) => void;
    /** 她写了 <<用电脑>>、但他最后那一条不是亲手打的：告诉主人 */
    notTyped: () => void;
    log: Log;
}

/** modeOf：这个人现在的状态（App 每一轮现读 work-mode.json） */
export function workModeModule(modeOf: (contact: Contact) => WorkMode, markers?: WorkMarkerHooks): Module {
    return {
        id: 'work-mode',
        contribute(turn) {
            if (turn.contact.tier !== 'boyfriend') return [];
            const mode = modeOf(turn.contact);
            if (mode === 'pending') return [{ slot: 'workRequest', text: WORK_REQUEST_NOTE }];
            if (mode === 'work') return [{ slot: 'workMode', text: WORK_MODE_NOTE }];
            return [{ slot: 'workJudge', text: WORK_JUDGE_NOTE }];
        },
        ...(markers ? { absorbAt: {
            workSwitch: (input: string, contact: Contact) => {
                // 只有男朋友档有工作模式（教她写这两个标记的那一行也只给他）。别人那里标记照样摘掉，不改状态、不记拒绝原因：
                // 2026-11-26 入站审查——原来不看档位，同学档的私聊里她照抄一句 <<拒绝工作：…>>，那段字就进了「你最近拒绝过」，出现在他的提示词里
                if (contact.tier !== 'boyfriend') {
                    const stripped = input.replace(/<<同意工作>>/g, '').replace(/<<拒绝工作[：:][\s\S]*?>>/g, '');
                    return stripped === input ? input : stripped.trim();
                }
                let text = input;
                if (text.includes('<<同意工作>>')) {
                    markers.setMode(contact, 'work');
                    text = text.replace(/<<同意工作>>/g, '').trim();
                    markers.log(`[${contact.qq}] 她答应了切工作模式`);
                }
                const rejected = /<<拒绝工作[：:]\s*([\s\S]*?)>>/.exec(text);
                if (rejected) {
                    const reason = (rejected[1] ?? '').trim();
                    markers.setMode(contact, 'chat');
                    markers.refused(reason);
                    text = text.replace(/<<拒绝工作[：:][\s\S]*?>>/g, '').trim();
                    markers.log(`[${contact.qq}] 她拒绝了切工作：${reason.slice(0, 40)}`);
                }
                return text;
            },
            work: (input: string, contact: Contact) => {
                if (contact.tier !== 'boyfriend') return input;
                const judged = takeWorkMarker(input);
                if (!judged.wanted) return input;
                const task = markers.taskOf(contact);
                if (task) {
                    markers.log(`[${contact.qq}] 她判断这条要动电脑：${logBody(task.slice(0, 60))}`);
                    markers.start(contact, task);
                } else {
                    markers.log(`[${contact.qq}] 她写了 ${WORK_MARKER}，但他最后那一条不是亲手打的字（ADR 0179），不动电脑`);
                    markers.notTyped();
                }
                return judged.text;
            },
        } } : {}),
    };
}
