// 吃醋，最轻的一档（ADR 0123，配置 jealousy，默认关）：角色卡【朋友】本来就写着“会吃醋，但嘴上不承认”（作者写的），现在没有任何回合级的规则管它——
// 模型要么完全不接（他说“今天和女同事吃饭”她像没听见），要么凭想象演得过头。这里给它轨道，而且轨道的重点是**不越界**：
// - 只在**他明确提到别的女生、并且是在说和她有来往**（一起吃饭 / 聊天 / 加微信 / 夸她好看 / 她表白……）时才有；他提家人（我妈、我姐）、老师、泛泛的“女生都喜欢……”不算；
// - 她的反应是“嘴上不承认的别扭”：酸一句、岔开话题、或轻轻问一句“哦，谁啊”之后立刻放下——**不盘问细节、不要他保证、不让他愧疚、不翻旧账、不威胁、不冷战、不限制他跟谁来往**
//   （这和 CONTROL_INTENT 是同一条底线的两面：她不许别人管她，她自己也不管他）；
// - 他一解释 / 哄她（“就是同事”“你想多了”“我只喜欢你”），下一轮她就松下来，嘴上再硬一句也行；
// - 同一段时间只有第一次提到才触发（3 天内他再提别的女生，她不再酸一遍）；约一半的情况触发（按他那句话取哈希），其余像没事一样接话；
// - 他难过 / 生病 / 危机 / 小别扭时让路（intent.ts 里排在这些之后）。
// 纯函数；不存状态：每一轮从聊天记录往回推（ADR 0039）。

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 3 天内他提过别的女生（触发过）就不再酸 */
export const JEALOUS_COOLDOWN_MS = 72 * HOUR;
/** 他解释 / 哄她：触发之后这么久之内算“在回应她的别扭” */
export const SOFTEN_WINDOW_MS = 20 * MIN;
/** 符合条件时真的触发的概率（按他那句话取哈希，同一句每次一样） */
export const JEALOUS_SHARE = 0.5;

type Said = { role: 'user' | 'assistant'; content: string; time?: string };

/** 别的女生：同事 / 同学 / 小姐姐 / 学姐 / 前任…… */
const OTHER_WOMAN = /女同事|女同学|女生|女孩子?|女性朋友|小姐姐|学姐|学妹|妹子|姑娘|前女友|前任|相亲|新来的(?:同事|实习生)[^，。]{0,3}她|那个她/;
/** 和她有来往 */
const INTERACTS = /一起|吃饭|聊|微信|送我|约我|请我|夸|好看|漂亮|可爱|找我|陪我|表白|喜欢我|追我|介绍|认识了|带她|帮她|她说/;
/** 不是在说“别的女生”：家人、老师、泛泛而谈 */
const NOT_HER = /我妈|我姐|我妹|我姑|我姨|奶奶|外婆|老师|女生都|女孩子都|女生就是|女生们都/;
/** 他在解释 / 哄她 */
const REASSURES = /你想多了|就是(?:同事|同学|朋友)|没什么|只是(?:同事|同学|朋友)|别(?:吃醋|多想|生气)|我只(?:喜欢|爱)你|只喜欢你|你最重要|你才是|逗你|开玩笑|骗你的|吃醋啦|吃醋了/;

export function mentionsOtherWoman(text: string): boolean {
    return OTHER_WOMAN.test(text) && INTERACTS.test(text) && !NOT_HER.test(text);
}
export const reassures = (text: string): boolean => REASSURES.test(text);

const hash = (text: string): number => {
    let h = 0x811c9dc5;
    for (const char of text) { h ^= char.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13;
    return (h >>> 0) / 0x1_0000_0000;
};

const userRunAfterLastReply = (history: readonly Said[]) => {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    return history.slice(lastReply + 1).filter(message => message.role === 'user');
};

/**
 * 这一轮是不是要酸一下 / 松下来：
 * - 'jealous'：他这一串里提到了别的女生（有来往）、3 天内没触发过、按哈希轮到；
 * - 'soften'：他刚（SOFTEN_WINDOW_MS 内）提过别的女生，现在这一串在解释 / 哄她；
 * - undefined：什么都不加。
 */
export function jealousTurn(history: readonly Said[], now: number): 'jealous' | 'soften' | undefined {
    const run = userRunAfterLastReply(history);
    if (!run.length) return undefined;
    const text = run.map(message => message.content).join('\n');
    const lastTime = run.at(-1)!.time;
    if (mentionsOtherWoman(text)) {
        const cutoff = Date.parse(run[0]!.time ?? '') || now;
        const before = history.slice(0, history.findIndex(message => message === run[0]));
        const recentTrigger = before.some(message => message.role === 'user' && mentionsOtherWoman(message.content)
            && (message.time === undefined || cutoff - Date.parse(message.time) < JEALOUS_COOLDOWN_MS));
        if (recentTrigger) return undefined;
        return hash(`${lastTime ?? ''} ${text} jealous`) < JEALOUS_SHARE ? 'jealous' : undefined;
    }
    if (reassures(text)) {
        // 前面不远处他提过别的女生，并且那一轮触发了
        const prior = history.slice(0, history.findIndex(message => message === run[0]));
        const trigger = prior.findLast(message => message.role === 'user' && mentionsOtherWoman(message.content));
        if (trigger && (trigger.time === undefined || (lastTime !== undefined && Date.parse(lastTime) - Date.parse(trigger.time) <= SOFTEN_WINDOW_MS))) {
            const triggerIndex = prior.indexOf(trigger);
            const groupStart = prior.slice(0, triggerIndex + 1);
            const triggerRun = groupStart.slice(groupStart.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user');
            const triggerText = triggerRun.map(message => message.content).join('\n');
            if (hash(`${triggerRun.at(-1)?.time ?? ''} ${triggerText} jealous`) < JEALOUS_SHARE) return 'soften';
        }
    }
    return undefined;
}

// 10-30 用户：把「对他有特殊滤镜」的地方清掉——她可以真的吃醋、真的问清楚、真的让他知道她不高兴，
// 不用装大度也不用马上放下。留下的只有「别限制他跟谁来往」（那是控制别人，不是自主）。
export const JEALOUS_INTENT = '[这一轮你想：他提到了别的女生，你心里别扭。想问清楚就直接问，想酸一句就酸，想让他知道你不高兴就直说，想翻旧账也行——你记性好；不用装大度，也不用假装已经放下。语气按你平时跟他说话的样子，一两句]';
export const SOFTEN_INTENT = '[这一轮你想：他在解释 / 哄你，你心里的别扭松下来了：嘴上还可以再硬一句（“谁吃醋了”“才没有”），但接受他的解释，不再追问；别借机要更多保证。一两句]';
