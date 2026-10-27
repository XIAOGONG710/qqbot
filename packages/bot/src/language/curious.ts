// 她会追问（ADR 0126，配置 curious，默认关）。
// 用户 10-23：「现在她不回主动发问，就算问了也是一些极小的无关问题，是否可以让她发问」。
// 量过（线上 10-08 → 10-23，她的 700 多条）：问句率 12%，和真人（10–16%）持平——不是问得少，是问的不对：
// 绝大多数是口头语（「睡吧？」「好了吧」「至于乐成这样吗」），真正问他生活的、问他刚说的那件事的，十几天里没几句。
// 原因在两句提示词里：他说自己的事时，意图行写着「别急着追问细节，真要问也只问一两个字」（intent.ts 的 saysOwnThing，为了治“每轮都以问句收尾”）；
// 顺着说的轮次又写着「别用反问句」。两句合起来，她就只会问「哪个手指头啊」这类一两个字的小问题。
// 这里的做法：他说了一件有细节的事（去了哪、见了谁、买了什么、考试 / 面试 / 项目……），约六成的情况让她回完反应之后，问一个**关于这件事本身**的、真想知道的问题；
// 不是每轮都问：她最近几条里已经问过就不再问，一轮最多一个问题。判断全是代码（不额外调模型），问什么由模型看他的话挑。

import { unit } from './expression.ts';

type Said = { role: 'user' | 'assistant'; content: string };

/** 满足条件的轮次里，约这么多让她追问（按他那句话取哈希，同一句每次一样） */
export const CURIOUS_SHARE = 0.6;
/** 她最近这么多条里问过，这一轮就不再问（免得变成盘问） */
export const CURIOUS_RECENT = 4;
/** 他这一句至少多长才有可追问的细节 */
export const CURIOUS_MIN_CHARS = 6;

/** 事件 / 计划 / 人：有这些才有“可追问的细节”；只有累、困、烦这类感受的不追（那是接情绪，不是追问） */
const DETAIL = /去(?:了|过|到)|到了|回(?:了|到)?家|出差|旅游|旅行|出门|搬|开会|聚(?:餐|会)?|约了|见了|见到|碰到|遇到|发生|买了|订了|报名|面试|考试|考了|答辩|比赛|项目|方案|作业|论文|代码|上线|加班|同事|朋友|室友|同学|老师|领导|老板|客户|爸|妈|哥|姐|弟|妹|亲戚|生日|婚礼|打球|健身|跑步|游戏|电影|演唱会|看了|玩了|吃了|做了|干了|修|换了|学了|练|拍了|画了/;
/** 他在问她 / 在收尾 / 只是附和：不追问（前面的意图行已经处理了这些，这里再挡一道） */
const NOT_NOW = /[？?]|(?:吗|么)\s*$|晚安|睡了|先去忙|不聊了|拜拜/;

const chars = (text: string) => [...text].length;

/** 她上一次回复以后，他说的内容 */
function said(history: readonly Said[]): string {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    return history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('\n').trim();
}

/** 她最近几条里已经问过（带问号） */
function askedRecently(history: readonly Said[]): boolean {
    return history.filter(message => message.role === 'assistant').slice(-CURIOUS_RECENT).some(message => /[？?]/.test(message.content));
}

/**
 * 这一轮要不要让她追问。条件：他说的话够长、有事件 / 人 / 计划的细节、不是问句 / 收尾；她最近几条里没问过；再按哈希取约六成。
 * 难受、生病、危机、亲密邀约这些由 describeIntent 里排在前面的意图先接走，不会走到这里。
 */
export function curiousTurn(history: readonly Said[]): boolean {
    const text = said(history);
    if (chars(text) < CURIOUS_MIN_CHARS || NOT_NOW.test(text) || !DETAIL.test(text)) return false;
    if (askedRecently(history)) return false;
    return unit(`${text} curious`) < CURIOUS_SHARE;
}

/**
 * 追问那一行：给方向，不给台词。保留“回应他刚说的那件事”这几个字（长短、表情包按“认真接话”算）；
 * 问的必须是他刚说的这件事本身，不是顺带的客套（在干嘛 / 吃了吗 / 你呢），也不是反问
 */
export const CURIOUS_INTENT = '[这一轮你想：回应他刚说的那件事——先有个真实的反应，然后问一个你真想知道的问题，问的是他刚说的这件事本身：谁、在哪、怎么回事、后来怎么样、他当时怎么想、接下来怎么打算，挑你最想知道的一个；'
    + '一个问题就够，别连着问两个；别问和这件事无关的（「在干嘛」「吃了吗」「你呢」这类），也别问他已经说过的答案；是真好奇，不是客套，更不是反问；他说得很少的地方别硬编细节替他补]';

/** 主动问他（ADR 0126，把 ask 这个时机换成“想多了解他”）：只从聊天里和她记得的事里挑，不编他没说过的 */
export const CURIOUS_ASK_NOTE = '想多了解他一点，问他一件关于他自己的具体的事：从上面的聊天和你记得的他的事里挑一件他提过、但你还不知道细节或后来怎么样了的'
    + '（他的学习 / 工作、朋友和同事、爱好、家里、最近在忙的事、他提过的计划或烦心事）；问得具体，一个问题，像突然想起来随口问的；'
    + '那里没有合适的，就问他这几天的安排或最近有什么事让他费心；不编他没说过的事，不问「在干嘛」「吃了吗」这类客套，也不问你自己的事；他没回也不催';
