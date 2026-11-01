// 「真正听到声音」的接口（2026-11-01 用户：「我想让她真正听到声音」→「留好接口，之后再做」）
//
// 和 ASR 的区别：ASR 只给文字（他说了什么）；这里给的是**声音本身**——
// 语气、语速、音量、有没有背景音、是不是在放音乐、音乐大概什么感觉。
// 她收到语音时，先把两种东西放在一起：`[语音 8秒：……][声音：语速偏慢，声音低，背景像在下雨]`
//
// 现在**没接任何实现**（createHearing 返回 undefined），接口和调用点先留好。之后要接的话，
// 在 createHearing 里返回一个 listen() 就行，别处不用动：
//   · 本地：librosa 抽音高/响度/节拍/语速 → 一句话（2–3 小时，不需要 GPU）
//   · 云端：Qwen2-Audio 之类的音频大模型直接问「这段声音里是什么」（半天，要联网）
//   · 本地大模型：Qwen2-Audio-7B，这台 5060 只有 8GB 显存，要量化，慢
export interface HearingInput {
    /** 语音文件在本地磁盘的路径（OneBot 的 data.path）；没有就只能靠转出来的字 */
    path?: string;
    /** 语音时长（秒） */
    seconds?: number;
    /** 已经转出来的文字；做语气分析时可以当上下文 */
    text?: string;
    /** 这条消息的 id，方便以后按 id 去取原音频 */
    messageId?: number;
    signal?: AbortSignal;
}

export interface AudioHearing {
    /** 回一句她读得懂的声音描述；听不出来就返回 undefined（不编） */
    listen(input: HearingInput): Promise<string | undefined>;
}

/** 现在没有实现。接上之后，语音消息旁边会多一段「[声音：…]」。 */
export function createHearing(): AudioHearing | undefined {
    return undefined;
}
