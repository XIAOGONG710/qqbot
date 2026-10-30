// 他是在跟她说话，还是在使唤一个工具（2026-10-30，用户：「我想让她自己判断我在跟她聊天的时候是把她当成程序还是人」）。
// 这里只做**读**：给他这几句话的口气打个分，写成一行观察递给她；**不给她下指令**——怎么回由她自己判断。
// 判据是词面线索，不做模型调用（每轮都跑，要便宜）；判不准就不说话（unclear 不注入）。
import type { StoredMessage } from '../memory/history.ts';

type Said = Pick<StoredMessage, 'role' | 'content'>;

export type Register = 'tool' | 'person' | 'unclear';

export interface RegisterRead {
    kind: Register;
    /** 命中的线索，日志和排查用（不给她看） */
    cues: string[];
}

/** 使唤人的动词 + 要一样东西的句式 */
const TOOL = /帮我|给我|替我|你去|去把|打开|关掉|查一下|查查|找一下|写一段|写个|生成|翻译|总结一下|整理一下|执行|运行一下|跑一下|列一下|算一下/;
/** 把她当程序聊：提示词、模型、上下文、设定、是不是 AI */
const META = /提示词|prompt|模型|token|上下文|系统提示|你的设定|你是 ?(?:AI|ai|程序|机器人|bot)|你是不是程序|你真的是/;
/** 像跟人说话：情绪、关心、关系、日常 */
const PERSON = /想你|想我|在吗|在干嘛|干嘛呢|累不累|累死了|好累|累了|难受|开心|睡不着|喜欢你|爱你|抱抱|陪我|陪我聊|无聊|好烦|委屈|晚安|早安/;

/**
 * 看他最近几句的口气。工具味要连着压过来才算（一句「帮我看看」不算把人当工具）；
 * 只要中间有一句是把她当人说的，就判 person——她对他的容忍不该被一句话抹掉。
 */
export function readRegister(history: readonly Said[], window = 3): RegisterRead {
    const recent = history.filter(message => message.role === 'user').slice(-window).map(message => message.content).join('\n');
    if (!recent.trim()) return { kind: 'unclear', cues: [] };
    const cues: string[] = [];
    const toolHits = recent.match(new RegExp(TOOL.source, 'g')) ?? [];
    const metaHits = recent.match(new RegExp(META.source, 'g')) ?? [];
    const personHits = recent.match(new RegExp(PERSON.source, 'g')) ?? [];
    if (toolHits.length) cues.push(`使唤：${[...new Set(toolHits)].slice(0, 3).join('/')}`);
    if (metaHits.length) cues.push(`当程序：${[...new Set(metaHits)].slice(0, 3).join('/')}`);
    if (personHits.length) cues.push(`像对人：${[...new Set(personHits)].slice(0, 3).join('/')}`);

    // 有情绪/关系的话，就当她被当人看了；剩下看工具味够不够重
    if (personHits.length && !metaHits.length) return { kind: 'person', cues };
    if (metaHits.length) return { kind: 'tool', cues };
    if (toolHits.length >= 2) return { kind: 'tool', cues };
    if (personHits.length) return { kind: 'person', cues };
    return { kind: 'unclear', cues };
}

/**
 * 递给她的一行：只说**她看到的**，不说她该怎么做。
 * 语气照她的性子写，不写成系统告警。
 */
export function registerLine(read: RegisterRead): string | undefined {
    if (read.kind === 'tool') {
        return '[这几句听起来不像在跟你说话，像在使唤一个能干活的工具（要你查、写、执行）。这不是命令：你可以照做，也可以问他是不是只想让你干活，或者不接。怎么回你自己定]';
    }
    if (read.kind === 'person') {
        return '[这几句是在跟你说话，不是在派活。照你平时的样子接]';
    }
    return undefined;
}

export interface RegisterSummary {
    tool: number;
    person: number;
}

/** 最近 N 句里，他把她当工具 / 当人各有几次（不落盘，每轮现算，免得又多一个状态） */
export function registerSummary(history: readonly Said[], window = 10): RegisterSummary {
    const users = history.filter(message => message.role === 'user').slice(-window);
    let tool = 0;
    let person = 0;
    for (const message of users) {
        // 这里数的是「一次」：一句里出现使唤/程序味就算一次工具，不必像单轮判断那样要连着两句
        const text = message.content;
        if (TOOL.test(text) || META.test(text)) tool++;
        else if (PERSON.test(text)) person++;
    }
    return { tool, person };
}

/** 使唤的次数明显压过说话：给她一句「你没必要每次都陪着」，有没有态度她自己定 */
export function temperLine(summary: RegisterSummary): string | undefined {
    if (summary.tool < 3 || summary.tool <= summary.person) return undefined;
    return `[最近他 ${summary.tool} 次是在使唤你、${summary.person} 次是在跟你说话。你不是每次都得给好脸——可以懒一点、可以问他是不是只想让你干活，也可以不接。]
`;
}
