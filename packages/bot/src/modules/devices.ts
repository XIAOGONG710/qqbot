// 设备菜单作为解释器的模块（ADR 0336 第 5 步）：她能替他操作的设备（ADR 0148，配置 deviceControl）——菜单放进「此刻」块的 devices 槽。
// 只给 App 认定的人（男朋友档）；危机回合、只想一想（内心）的轮次不给；主动找他的轮次照样给。
// 设备服务是异步起来的，起来之前菜单是空串——照样放一段空的（迁移前就是这样，「此刻」块里会多一个空行），不在这里改。
// 回复里的指令行怎么摘、怎么登记（parse / commit）还在联系人流水线的回复后处理里，属于审查阶段，以后迁。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 devices 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Contact } from '../platform/config.ts';

export interface DevicesModuleOptions {
    /** 这一轮的菜单；服务还没起来时是空串 */
    menu: () => string;
    /** 谁能用（App：男朋友档） */
    allowed: (contact: Contact) => boolean;
}

export function devicesModule(options: DevicesModuleOptions): Module {
    return {
        id: 'devices',
        contribute(turn) {
            if (!options.allowed(turn.contact) || turn.facts.crisis || turn.thinking) return [];
            return [{ slot: 'devices', text: options.menu() }];
        },
    };
}
