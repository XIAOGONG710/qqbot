// 几种“一看就是 AI”的说法，数它们出现的比例（ADR 0205）。**只是数字，给她自己看**：进她每晚想说话习惯时看到的那一行、进 /说话趋势；
// 不进提示词里当禁令、不在代码里卡她、不拿去评分（ADR 0193 的约定；用户 10-30：「让她自己决定怎么回答」）。
// 来由：深度探针里（ADR 0202 之后更多轮次走深思），“不是 X，是 Y”的警句和“半夜睡不着”这类道具偶尔冒出来；
// 她线上真聊天里这几种几乎不出现（783 个气泡里各 1 个左右，约 0.1%）。数出来让她看见，要不要改、改多少，她自己定。

/** “不是X，是Y” / “与其X不如Y” / “所谓X就是Y”：警句式的漂亮话 */
export const APHORISM = /不是[^，。！？,.!?]{1,14}[，,]\s*(?:而)?是|与其[^，。！？]{1,14}不如|所谓[^，。！？]{1,10}就是/;
/** “半夜睡不着 / 一个人躺在床上瞎想”：拿来表示心里有事的万能道具 */
export const INSOMNIA = /(?:半夜|夜里|深夜|晚上)[^，。！？]{0,12}(?:睡不着|瞎想|胡思乱想|翻来覆去)|睡不着|一个人(?:躺|待)[^，。！？]{0,6}(?:床|被窝)/;
/** “突然觉得 / 忽然明白 / 一下子懂了”：顿悟式的升华 */
export const SUDDEN = /(?:突然|忽然|一下子)(?:觉得|发现|明白|想到|想起|懂了)/;

export interface TropeShares {
    aphorism: number;
    insomnia: number;
    sudden: number;
}

/** 这些气泡里，各种说法各占多少（0–1）；没有气泡返回全 0 */
export function tropeShares(texts: readonly string[]): TropeShares {
    const n = texts.length;
    if (!n) return { aphorism: 0, insomnia: 0, sudden: 0 };
    const share = (re: RegExp) => texts.filter(text => re.test(text)).length / n;
    return { aphorism: share(APHORISM), insomnia: share(INSOMNIA), sudden: share(SUDDEN) };
}

const pct1 = (share: number) => `${(share * 100).toFixed(1)}%`;

/** 给她和他看的一句：只列出现过的；一个都没出现返回 undefined（不占行） */
export function tropeLine(shares: TropeShares | undefined): string | undefined {
    if (!shares) return undefined;
    const parts = [
        ...(shares.aphorism > 0 ? [`警句式「不是 X，是 Y」${pct1(shares.aphorism)}`] : []),
        ...(shares.insomnia > 0 ? [`「半夜睡不着」一类 ${pct1(shares.insomnia)}`] : []),
        ...(shares.sudden > 0 ? [`「突然明白」一类 ${pct1(shares.sudden)}`] : []),
    ];
    return parts.length ? `这几种说法占气泡的比例：${parts.join('、')}` : undefined;
}
