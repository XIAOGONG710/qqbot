import type { GroupEntry, SpeakReason } from './group-chat.ts';

type Boundary = 'unfamiliar' | 'familiar' | 'light' | 'playful' | 'reciprocal' | 'stop';
const DAYS_30 = 30 * 86_400_000;
const TEN_MINUTES = 10 * 60_000;
const INVITES_PLAY = /逗我两句|开个玩笑|你再逗我|再逗逗我|就你会逗/;
const RECIPROCATES_PLAY = /^(?:那|好[啊呀]?[，,]?)?(?:我(?:要|该)?怎么哄(?:你)?|你想我怎么哄|我哄你)[。！？!?\s]*$/u;
const STOP_PLAY = /别逗|不想开玩笑|不好笑|别闹|别这样|换个话题|先说正事|什么意思/;
const PRESSURE = /叫(?:我)?(?:一)?声[^。！？]{0,8}(?:听听|给我听)|叫我(?:一声)?姐姐|再叫一声|别装了|怎么不接(?:招|梗)|怎么不理我|脸红了吧|只准(?:看|理)我/;
const PRIVATE_DISCLOSURE = /(?:我俩|我们|他|她|你|我).{0,10}(?:私聊|私下).{0,12}(?:说|讲|答应|约|吵|和好|道歉)/;
const INTIMATE = /宝宝|宝贝|老婆|老公|亲亲|想亲你|你是我的|我(?:的)?男朋友|我(?:的)?女朋友/;
const DEMANDS_A_REPLY = /这句先记账|下次.{0,8}还我|欠我.{0,8}(?:一句|回应)|下次.{0,8}补我(?:一|这)句/;
const FLIRT_INVITATION = /想被(?:我)?怎么逗|要我怎么撩|想被我怎么撩|想被逗哪|逗[^。！？]{0,8}怕不怕痒/;

export function groupBoundary(entries: readonly GroupEntry[], target: GroupEntry | undefined, reason: SpeakReason, utterance = target?.content ?? '', allowInitiation = false): Boundary {
    if (!target || target.mine || target.history || (reason !== 'mentioned' && !(allowInitiation && reason === 'topic'))) return 'unfamiliar';
    const at = Date.parse(target.time);
    const targetIndex = entries.indexOf(target);
    const prior = (targetIndex < 0 ? entries : entries.slice(0, targetIndex)).filter(row => !row.history && row.messageId !== target.messageId
        && Date.parse(row.time) < at + 1000 && at - Date.parse(row.time) <= DAYS_30);
    const theirs = new Set(prior.filter(row => !row.mine && row.from === target.from).map(row => row.messageId));
    const ourReplies = prior.filter(row => row.mine && row.replyTo !== undefined && theirs.has(row.replyTo));
    const previous = target.replyTo === undefined ? ourReplies.at(-1) : ourReplies.findLast(row => row.messageId === target.replyTo);
    const afterOurPlay = previous && at - Date.parse(previous.time) <= TEN_MINUTES && (previous.playful || PRESSURE.test(previous.content));
    const invited = INVITES_PLAY.test(utterance);
    const reciprocated = allowInitiation && Boolean(afterOurPlay) && target.replyTo !== undefined && RECIPROCATES_PLAY.test(utterance.trim());
    if (STOP_PLAY.test(utterance) || (afterOurPlay && !invited && !reciprocated)) return 'stop';
    const days = new Set(ourReplies.map(row => new Date(row.time).toISOString().slice(0, 10)));
    if (days.size < 2) return 'unfamiliar';
    return reciprocated ? 'reciprocal' : invited ? 'playful' : allowInitiation ? 'light' : 'familiar';
}

export function groupBoundaryLine(boundary: Boundary): string {
    const instruction = {
        unfamiliar: '对这位群友按初见或普通群友接话。可以亲切，先聊公开话题；即使对方起哄要你逗，也不问想被怎么逗，只当普通招呼接住。',
        familiar: '你们在这个群里聊过几次，可以接已共知的梗。没看到对方接梗或邀请，就保持自然，不主动升级。',
        light: '你们在这个群里有公开来往。话题合适时，围绕当下先轻轻逗一句，把话理直气壮地拐成你俩的小玩笑。说完留余地，别索取回应；不合适就照常接话。',
        playful: '这位群友熟悉，而且这次自己邀请开玩笑或明确接了你的玩笑。只接群里刚说的事。对方认真回撩时可以漏一点底，嘴硬半句后放软，直接接住他的好意，别把问题再抛回去。留一句就停。',
        reciprocal: '这位熟人当面把刚才的玩笑认真接回来了。你刚才还理直气壮，现在可以露出一点被说动，坦白自己没料到对方真接，再轻轻收一句。不要再出题、要礼物或索取表示。',
        stop: '对方没接住或请你停下。现在收住，可以简短认一句说过头了，回到正题或停下。不要继续逗、追问、记账或讨回应。',
    }[boundary];
    return `只按这个群里公开发生的事判断分寸。${instruction}群里的称呼和关系只用群里公开说过的，不带私聊的亲密、矛盾或修复过程。`;
}

export function groupBoundaryAllows(text: string, boundary: Boundary): boolean {
    if (PRIVATE_DISCLOSURE.test(text) || INTIMATE.test(text) || (boundary === 'stop' && DEMANDS_A_REPLY.test(text))) return false;
    if (boundary === 'unfamiliar' && FLIRT_INVITATION.test(text)) return false;
    return boundary === 'playful' || !PRESSURE.test(text);
}
