// 场景应答（2026-10-31）：从免费算力跑出来的聊天诊断里，挑出的三处反复出错，写成提示词里的一句。
//
// 证据都来自她自己的聊天记录（ginka 批量诊断，45 段）：
//   1. 他说「哄我睡觉呗」→ 她回「那你睡吧」：把请求当成指令，没接住「哄」；
//   2. 他讲代码报错 → 她先调侃「你这代码写得，登录都能认出你不是人」，没问报错原文；
//   3. 他问「你会因为这个看不起我吗」→ 她回「行了不为难你了」：没先给明确回答。
// 这些不是风格问题，是「该接的没接」。所以只在他这句话命中时才加一句，不常驻。
export interface SceneRead {
    /** 命中哪一种 */
    kind: '哄睡' | '报错' | '自我怀疑' | '暗号';
    /** 递给她的一句 */
    line: string;
}

const SLEEP = /哄(?:我)?睡|哄睡|唱首(?:歌|儿歌)|讲个故事|陪我睡/;
const ERROR = /报错|错误|异常|跑不起来|编译不过|栈|traceback|stack ?trace|\berror\b|崩溃|报了个/;
const SELF_DOUBT = /看不起我|(?:是|这)不是(?:有点)?变态|不正常|我是不是有病|你会不会嫌(?:弃)?我|讨厌我/;
/** 纯字母缩写、且不像正常英文单词（zdjd / yyds / xswl 这种） */
const CIPHER = /^[a-z]{2,6}$/i;

const LINES: Record<SceneRead['kind'], string> = {
    哄睡: '[他说的是「哄我睡」——先接这个动作：说点软的、哄一句（哼半句歌、让他闭眼、说你会守着），别回「那你睡吧 / 睡醒了再找我」]',
    报错: '[他在讲代码出错：先问「报错原文是什么 / 哪一行」再说话，别先调侃他的代码]',
    自我怀疑: '[他在担心你怎么看他（看不起 / 变态 / 嫌他）：先正面给一句明确的回答，再问原因，别绕开、别「不为难你了」]',
    暗号: '[他发的是看不懂的缩写：先问「这是啥意思 / 指哪个」，别猜着往下接、别跳到转账或旧梗]',
};

/** 他这句话要不要特殊处理（没有就是 undefined） */
export function readScene(text: string): SceneRead | undefined {
    const said = String(text ?? '').trim();
    if (!said) return undefined;
    if (SELF_DOUBT.test(said)) return { kind: '自我怀疑', line: LINES.自我怀疑 };
    if (SLEEP.test(said)) return { kind: '哄睡', line: LINES.哄睡 };
    if (ERROR.test(said)) return { kind: '报错', line: LINES.报错 };
    if (CIPHER.test(said) && !/^(ok|no|yes|hi|by|id|pm|am)$/i.test(said)) return { kind: '暗号', line: LINES.暗号 };
    return undefined;
}
