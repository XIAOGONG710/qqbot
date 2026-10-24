// 话说到一半就停了（ADR 0141，随 speechCheck）：发出去之前看一遍她这一轮的最后几条，有没有停在转折 / 铺垫上、读起来像被打断的。
// 10-24 夜里：「想啊，都想得有点睡不着了」后面隔一条只有「不过你别得意」，没有下文。10-21 起线上 26 个多条回复的轮次里有 2 处这样的结尾
// （另一处是 10-22 的「会伤心」+「不过你别瞎想这些」）。来源有两个：分成几条发（ADR 0096 / 0134）时最后一条只剩一句转折的态度，
// 和 shape.ts 的提示词里写过「半句也行」「不用把话说圆」「留半句」——模型照做了。提示词那几句已经改掉（shape.ts），这里是写死的出口，不靠模型听话。
// 两种：
//   tail：多条回复的最后一条，以转折词开头（不过 / 但是 / 可是 / 只是 / 不然……），后面只剩一小句态度（≤ 8 个字、没有逗号），不是问句——读起来是转折起了头没有下文；
//   cut：某一条停在不能结句的词上（要是……的话、要是、如果、因为、所以、然后、觉得、说得）；以「……」「？」结尾的不算（是故意拖着、是在问）。
// 处理：先带说明让她重写一次（说明里不引用原句）；还是这样，tail 并回前一条（前一条是问句就去掉它），cut 退到上一个逗号（退不回去就去掉那一条，只有一条就原样留着）。
// 纯函数（find / repair），重写在 finishReply。危机回合不走（调用方不传）。

const STICKER_LINE = /^<(?:sticker|photo):[a-f0-9]{12}>$/i;
const TRAILING = /[。！!？?～~…，,、；;\s]+$/;

/** 转折 / 让步的连词开头 */
const TURN = /^(?:不过|但是|但|可是|只是|只不过|不然|要不然|否则|虽然)/;
/** tail 后面只剩多短的话算「没有下文」（连词后面的字数） */
const TAIL_BODY_MAX = 8;
/** 不能结句的结尾：连词、假设、「觉得 / 说得」这类后面一定还有话的词 */
const HANGING = /(?:要是|如果|假如|万一|因为|所以|但是|不过|可是|然后|而且|或者|不然|以及|比如|虽然|就是说|觉得|说得|讲得|看得|听得|想得|做得|写得|玩得|吃得|睡得|长得|跟你|和你|跟我|和我)$/;
/** 「……的话」只有前面有假设词才算没说完（「等你说句正经的话」是一个完整的名词短语，档案里 10-04 有） */
const CONDITIONAL = /(?:要是|如果|假如|万一|若是|倘若)[^，,。！!？?；;]*的话$/;
/** 只剩假设的半句：最后一个小句是「要是 / 如果 / 万一……」又没有后半句的词（就、会、也、别、可以……），例如「要是你不来」 */
const PROTASIS = /(?:^|[，,；;、])\s*(?:要是|如果|假如|万一|若是|倘若)[^，,。！!？?；;]{1,12}$/;
const APODOSIS = /就|那|会|也|才|肯定|一定|准|得|可以|能|该|还|都|别|不用|算|行|好|成/;

export interface Unfinished {
    /** 在 lines(reply) 里的第几行（0 起） */
    index: number;
    kind: 'tail' | 'cut';
}

const chars = (text: string) => [...text].length;
const bare = (text: string) => text.replace(TRAILING, '');

function lines(reply: string): string[] {
    return reply.split('\n').map(line => line.trim()).filter(Boolean);
}

/** 这一条停在不能结句的词上（不管后面有没有标点；「……」「？」结尾的调用方自己排除） */
export function endsHanging(text: string): boolean {
    const core = bare(text);
    if (HANGING.test(core) || CONDITIONAL.test(core)) return true;
    const half = PROTASIS.exec(core);
    return Boolean(half) && !APODOSIS.test(half![0]);
}

/** 哪几条话没说完；没有就是空数组 */
export function findUnfinished(reply: string): Unfinished[] {
    const all = lines(reply);
    const text = all.map((line, index) => ({ line, index })).filter(({ line }) => !STICKER_LINE.test(line));
    const found: Unfinished[] = [];
    const last = text.length >= 2 ? text[text.length - 1] : undefined;
    if (last && TURN.test(last.line) && !/[？?…]$/.test(last.line)) {
        const body = bare(last.line).replace(TURN, '');
        if (chars(body) <= TAIL_BODY_MAX && !/[，,。！!；;]/.test(body)) found.push({ index: last.index, kind: 'tail' });
    }
    for (const { line, index } of text) {
        if (found.some(item => item.index === index)) continue;
        if (!/[？?…]$/.test(line) && endsHanging(line)) found.push({ index, kind: 'cut' });
    }
    return found.sort((a, b) => a.index - b.index);
}

/** 重写之后还是这样时的办法：tail 并回前一条，cut 退到上一个逗号；返回处理后的回复和改了什么（给日志） */
export function repairUnfinished(reply: string, found: readonly Unfinished[]): { reply: string; notes: string[] } {
    const out = lines(reply);
    const notes: string[] = [];
    const drop = new Set<number>();
    for (const item of [...found].sort((a, b) => b.index - a.index)) {
        const line = out[item.index]!;
        if (item.kind === 'tail') {
            const before = [...out.keys()].filter(i => i < item.index && !drop.has(i) && !STICKER_LINE.test(out[i]!)).pop();
            if (before === undefined) continue;
            if (/[？?]$/.test(out[before]!)) { drop.add(item.index); notes.push('最后一条停在转折上，前一条是问句，去掉最后一条'); continue; }
            out[before] = `${bare(out[before]!)}，${bare(line)}`;
            drop.add(item.index);
            notes.push('最后一条停在转折上，并回前一条');
            continue;
        }
        const core = bare(line);
        const comma = Math.max(core.lastIndexOf('，'), core.lastIndexOf(','), core.lastIndexOf('、'), core.lastIndexOf('；'), core.lastIndexOf(';'));
        const head = comma > 0 ? bare(core.slice(0, comma)) : '';
        if (chars(head) >= 2 && !endsHanging(head)) { out[item.index] = head; notes.push(`一条停在 ${chars(core)} 字处没说完，退到上一个逗号`); continue; }
        if (out.filter((_, i) => !drop.has(i) && !STICKER_LINE.test(out[i]!)).length > 1) { drop.add(item.index); notes.push('一条停在没说完的词上，去掉'); continue; }
        notes.push('只有一条且停在没说完的词上，原样留着');
    }
    return { reply: out.filter((_, i) => !drop.has(i)).join('\n'), notes };
}

export interface FinishDeps {
    /** 在原来的提示词末尾加上这句说明重新生成，返回清理过的回复 */
    regenerate: (note: string) => Promise<string>;
    log: (message: string) => void;
}

/** 说明里不引用原句：模型会照抄被点名的那句（10-10 的教训，见 ADR 0036 adj. 夜） */
const NOTE = '[上一版回复没有发出去：有一条话没说完，停在了转折或铺垫上，读起来像被打断。每一条都要把意思说完——起了转折就把后半句说出来，实在没有下文就不要起这一条。意思和语气不变，只输出要发的消息。]';

/** 出口：话没说完就带说明重写一次；还是这样就按 repairUnfinished 处理。只记条数和种类到日志，不记原话 */
export async function finishReply(reply: string, deps: FinishDeps): Promise<string> {
    const first = findUnfinished(reply);
    if (first.length === 0) return reply;
    const describe = (items: readonly Unfinished[]) => [items.some(i => i.kind === 'tail') ? '最后一条停在转折上' : '', items.some(i => i.kind === 'cut') ? `有 ${items.filter(i => i.kind === 'cut').length} 条停在没说完的词上` : ''].filter(Boolean).join('，');
    deps.log(`话没说完：${describe(first)}，带说明重写一次`);
    let current = reply;
    try {
        const rewritten = await deps.regenerate(NOTE);
        if (lines(rewritten).length > 0) current = rewritten;
    } catch (error) {
        deps.log(`话没说完：重写失败（${error instanceof Error ? error.message : String(error)}），直接处理`);
    }
    const again = findUnfinished(current);
    if (again.length === 0) return current;
    const repaired = repairUnfinished(current, again);
    if (repaired.notes.length) deps.log(`话没说完：重写后还是这样；${repaired.notes.join('；')}`);
    return repaired.reply;
}
