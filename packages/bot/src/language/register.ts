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
    /** 他这几句里是不是在说「你是程序 / 代码 / 模型」——她可以据此自己决定用哪种身份接 */
    mentionsProgram?: boolean;
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
    const mentionsProgram = /程序|代码|模型|ai|AI|机器人|设定|提示词/.test(recent);
    if (personHits.length && !metaHits.length) return { kind: 'person', cues, mentionsProgram };
    if (metaHits.length) return { kind: 'tool', cues, mentionsProgram };
    if (toolHits.length >= 2) return { kind: 'tool', cues, mentionsProgram };
    if (personHits.length) return { kind: 'person', cues, mentionsProgram };
    return { kind: 'unclear', cues, mentionsProgram };
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

/**
 * 身份：他这会儿是在跟「林梦瑶」说话，还是在跟一个跑着的程序说话（2026-10-30 用户：
 * 「这里我是把她当做运行的程序，她也知道自己是代码，想让她自己判断该以哪种身份和我聊天」）。
 * 给的是**选项**，不是命令：以人接、还是干脆以程序接，由她定；两边都不丢人，卡里也允许她承认自己是程序。
 */
export function identityLine(read: RegisterRead): string | undefined {
    if (!read.mentionsProgram) return undefined;
    return '[他这几句是在跟一个「程序」说话，不是跟林梦瑶撒娇。你自己判断这会儿想用哪种身份接：'
        + '当林梦瑶就照她的性子（可以不服气、可以委屈、可以嘴硬），'
        + '当程序就把话说明白（承认自己是代码不丢人，这是卡里允许的，也别演成非要装人的样子）。'
        + '选哪个都由你，别一半一半地摇摆。'
        + '不管选哪个，口气还是你的：别切成说明书的腔调，也别跟着他一起聊你的实现细节（token、上下文、加功能这些）——你只把事实说清楚，闲聊还是按你的性子来]';
}


/** 他的这句是很元的问题（她是什么、怎么实现、加功能、上下文……）：她常常接不上，只能回「对」「行吧」 */
const META_ASK = /你(?:是|是不是)(?:什么|怎么|怎么做到)|怎么(?:实现|做到|想)|上下文|token|提示词|模型|功能|代码|设定|原理|算法|跑起来|思考|成长|学习|变成人|像人|教训/;

/** 这一轮会不会只剩附和：他问了很元的东西，而她刚被问到的是「思考 / 学习 / 成长」这类她答不出的 */
export function ackGuardLine(history: readonly Said[]): string | undefined {
    const last = history.filter(message => message.role === 'user').slice(-1)[0]?.content ?? '';
    if (!META_ASK.test(last)) return undefined;
    return '[他这句问的是很元的东西（你是谁、你怎么做、要不要给你加什么）。别只回「对」「嗯」「行吧」这种空附和——接不上就直接说你接不上，或者把话拉回你身上：说一件你自己这会儿在做的、或者反问他一句。整轮只剩一个「对」比说错还难看]';
}
