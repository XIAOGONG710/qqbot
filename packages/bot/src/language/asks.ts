// 让她多问真问题（2026-10-31 用户：「我希望她能有更多的问题来问我」）
//
// 注意这不是"多打问号"：之前量过她问号率 17.3%、真人 7.3%，而问题质量差——大量是「那你觉得呢」这种空问。
// 这里要的是**真的想知道**：问的是他刚才那句话的来由、他今天的事、他在想什么。
// 做法只在她这句没说什么（太短 / 只是情绪 / 只是结论）时给一句方向，且一轮最多一句。
export interface AskHint {
    /** 递给她的一句 */
    line: string;
    /** 为什么给她这句（日志用） */
    why: '太短' | '只有情绪' | '只有结论';
}

const EMOTION_ONLY = /^(好累|累了|烦|好烦|难受|不开心|还行|一般|不知道|没事|没什么|随便|都行|哈哈|嗯|哦|好|行|算了)[。.!！~～…]*$/;
const CONCLUSION_ONLY = /^(确实|就是|反正|所以|懂了|明白了|知道了|明白了|嗯对)[。.!！~～…]*$/;

/** 他这句要不要她主动问一句（不要就 undefined） */
export function askHint(hisText: string): AskHint | undefined {
    const said = String(hisText ?? '').trim();
    if (!said) return undefined;
    if (/[？?]$/.test(said)) return undefined; // 他在问她，先答再问
    if (EMOTION_ONLY.test(said)) {
        return { why: '只有情绪', line: '[他这句只是把情绪丢出来，没说什么事。问一句真的想知道的：今天怎么了、是谁惹的、你哪一步开始的——问具体的，别问"你怎么了"这种能用一个字糊过去的]' };
    }
    if (CONCLUSION_ONLY.test(said)) {
        return { why: '只有结论', line: '[他只给了个结论。想接下去就问他为什么这么想 / 从哪看出来的——你确实想知道的那种问法，一句就够]' };
    }
    if ([...said].length <= 6) {
        return { why: '太短', line: '[他这句很短。你可以问一句你真正好奇的（他在干嘛、刚才那句话什么意思、他今天过得怎么样）——一句，别连着问]' };
    }
    return undefined;
}
