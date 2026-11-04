// 按 SillyTavern 默认 Chat Completion 预设拼提示词。
//
// 对照 vendor/SillyTavern：
//   顺序：default/content/presets/openai/Default.json 的 prompt_order（dummyId 100001）
//     main → worldInfoBefore → personaDescription → charDescription → charPersonality
//     → scenario → nsfw → worldInfoAfter → dialogueExamples → chatHistory → jailbreak
//   内容：public/scripts/openai.js preparePromptsForChatCompletion / populateChatCompletion / populateChatHistory
//     - 角色卡的 system_prompt 覆盖 main，post_history_instructions 覆盖 jailbreak，{{original}} 是被覆盖的原文
//     - 聊天记录前插一条系统消息 “[Start a new Chat]”；从最新往前放，放不下就停（和 ST 不同：没有示例对话时不插，那时它只是噪音，DSH 诊断 2.3）
//     - 示例对话（populateDialogueExamples）：每块前插一条 “[Example Chat]”，整块放得下才放，放不下就停；
//       默认先放聊天记录、剩下的预算给示例，pinExamples（ST 的 Always include examples）时反过来
//     - 每段一条 system 消息，空内容的消息丢弃
//   宏：st/macros.ts（{{user}} {{char}} 等）和 st/time-macros.ts（时间宏）
//   世界书扫描文本：public/script.js 里的 chatForWI（“名字: 内容”，最新在前）

import { EPISODE_GAP_MS } from '.././memory/episodes.ts';
import type { Character } from '.././st/card.ts';
import { parseExampleIntoIndividual, parseMesExamples } from '.././st/examples.ts';
import { substituteMacros } from '.././st/macros.ts';
import { timeMacros } from '.././st/time-macros.ts';
import { checkWorldInfo, type WorldInfoEntry, type WorldInfoSettings } from '.././st/world-info.ts';

/** Default.json 里用到的预设文本 */
export const ST_DEFAULT_PRESET = {
    main: 'Write {{char}}\'s next reply in a fictional chat between {{char}} and {{user}}.',
    nsfw: '',
    jailbreak: '',
    newChatPrompt: '[Start a new Chat]',
    newExampleChatPrompt: '[Example Chat]',
    personalityFormat: '{{personality}}',
    scenarioFormat: '{{scenario}}',
};

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    /** ISO 时间，时间宏用 */
    time?: string;
}

export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    /** 只有示例对话带：example_user / example_assistant */
    name?: string;
}

export interface PromptSettings {
    /** 上下文 token 上限（ST 的 openai_max_context） */
    maxContext: number;
    /** 为回复预留的 token（ST 的 openai_max_tokens） */
    maxTokens: number;
    worldInfo: WorldInfoSettings;
    /** ST 的 Example Messages Behavior 选 Always include examples（power_user.pin_examples）：示例先于聊天记录占预算 */
    pinExamples?: boolean;
}

export interface PromptInput {
    character: Character;
    worldInfo: WorldInfoEntry[];
    /** 聊天记录，从旧到新，最后一条通常是对方刚发的消息 */
    history: ChatMessage[];
    /** {{user}}：聊天对象的称呼 */
    userName: string;
    /** 联系人的人设描述（对应 ST dummyId 100001 的 personaDescription，可选） */
    userPersona?: string;
    /**
     * 运行时自己加的、不常变的内容（长期记忆里的关系概况），每段一条 system 消息，紧跟在 main 之后
     * （同 ST 摘要扩展的 After Main Prompt：openai.js 把 IN_PROMPT 的 summary 插在 main 之后）。
     */
    afterMain?: string[];
    /**
     * 运行时自己加的内容（时间提示、召回的记忆），每段一条 system 消息，放在聊天记录之后、末尾指令之前。
     * ST 里没有固定对应（相当于作者注放在聊天中 depth 0）；放在后面是因为每次都变，不让前面的前缀缓存失效。
     * 顺序同时表示预算优先级：前面的较泛，后面的更贴近当前轮次；预算不足时先省略前面的，但始终保留最新聊天。
     */
    afterHistory?: string[];
    /** 时间宏用的当前时间，默认现在 */
    now?: Date;
    settings: PromptSettings;
    countTokens: (text: string) => number;
    random?: () => number;
}

export interface PromptResult {
    messages: OpenAIMessage[];
    activatedWorldInfo: WorldInfoEntry[];
    /** 为保留最新聊天而省略的低优先级运行时背景段数（不含内容） */
    omittedAfterHistory?: number;
}

/**
 * 世界书只按这一段聊天匹配：从现在往回，隔了 EPISODE_GAP_MS 以上的上一段不算（没带时间的消息照旧算）。
 * ST 没有这一层（它只看最近几条）：10-09 08:08 她主动找他道早安，最近两条是前一晚 00:32 的「晚安」，命中了「深夜道晚安」。
 */
export function currentConversation(history: readonly ChatMessage[], now: Date): ChatMessage[] {
    let later = now.getTime();
    let start = history.length;
    while (start > 0) {
        const at = Date.parse(history[start - 1]!.time ?? '');
        if (!Number.isNaN(at)) {
            if (later - at >= EPISODE_GAP_MS) break;
            later = at;
        }
        start--;
    }
    return history.slice(start);
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 聊天记录里隔天的那一行（ADR 0049）：「10月5日 星期日」，不是今年的带年份 */
export function chatDayLabel(date: Date, nowYear: number): string {
    return `${date.getFullYear() !== nowYear ? `${date.getFullYear()}年` : ''}${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
}

export function buildPrompt(input: PromptInput): PromptResult {
    const { character, history, settings, countTokens } = input;
    const names = { user: input.userName, char: character.name };
    const time = timeMacros(input.now ?? new Date(), history);
    const sub = (text: string, extra?: Record<string, string>) =>
        substituteMacros(text, names, { ...time, ...extra }).replace(/\r/g, '');

    const chatForWI = currentConversation(history, input.now ?? new Date())
        .map(m => (settings.worldInfo.includeNames ? `${m.role === 'user' ? names.user : names.char}: ${m.content}` : m.content))
        .reverse();
    const wi = checkWorldInfo({
        entries: input.worldInfo,
        chat: chatForWI,
        maxContext: settings.maxContext,
        settings: settings.worldInfo,
        substitute: text => sub(text),
        countTokens,
        random: input.random,
    });

    const main = character.systemPrompt
        ? sub(character.systemPrompt, { original: sub(ST_DEFAULT_PRESET.main) })
        : sub(ST_DEFAULT_PRESET.main);
    const jailbreak = character.postHistoryInstructions
        ? sub(character.postHistoryInstructions, { original: sub(ST_DEFAULT_PRESET.jailbreak) })
        : sub(ST_DEFAULT_PRESET.jailbreak);
    const personality = character.personality
        ? sub(ST_DEFAULT_PRESET.personalityFormat, { personality: sub(character.personality) })
        : '';
    const scenario = character.scenario
        ? sub(ST_DEFAULT_PRESET.scenarioFormat, { scenario: sub(character.scenario) })
        : '';
    const personaDescription = input.userPersona ? sub(input.userPersona) : '';

    const system = (content: string): OpenAIMessage => ({ role: 'system', content });
    const head = [
        system(main),
        ...(input.afterMain ?? []).map(text => system(text)),
        system(wi.before),
        system(personaDescription),
        system(sub(character.description)),
        system(personality),
        system(scenario),
        system(sub(ST_DEFAULT_PRESET.nsfw)),
        system(wi.after),
    ];
    const newChat = system(sub(ST_DEFAULT_PRESET.newChatPrompt));
    const afterHistoryCandidates = (input.afterHistory ?? []).map(text => system(text)).filter(message => message.content);
    const tail = [system(jailbreak)];

    // 预算：上下文 - 回复预留 - 回复引导（ST 固定预留 3）- 固定部分；剩下的分给运行时背景、聊天记录和示例对话。
    // 最新一条聊天是这一轮真正要答的内容：先为它留位置，再按从后到前（当前轮次优先）保留运行时背景。
    const cost = (m: OpenAIMessage) =>
        (m.content ? countTokens(m.role) + countTokens(m.content) + (m.name ? countTokens(m.name) : 0) : 0);
    const nowYear = (input.now ?? new Date()).getFullYear();
    const dayOf = (m: ChatMessage | undefined) => (m?.time ? chatDayLabel(new Date(m.time), nowYear) : undefined);
    const marker = (label: string) => system(`[${label}]`);
    const latest = history.at(-1);
    const latestMessage = latest ? { role: latest.role, content: latest.content.replace(/\r/g, '') } satisfies OpenAIMessage : undefined;
    const latestDay = dayOf(latest);
    const latestReserve = (latestMessage ? cost(latestMessage) : 0) + (latestDay ? cost(marker(latestDay)) : 0);
    const baseRemaining = settings.maxContext - settings.maxTokens - 3
        - [...head, newChat, ...tail].reduce((sum, m) => sum + cost(m), 0);
    let afterHistoryBudget = Math.max(0, baseRemaining - latestReserve);
    const afterHistory: OpenAIMessage[] = [];
    let omittedAfterHistory = 0;
    for (let i = afterHistoryCandidates.length - 1; i >= 0; i--) {
        const message = afterHistoryCandidates[i]!;
        const messageCost = cost(message);
        if (messageCost <= afterHistoryBudget) {
            afterHistory.unshift(message);
            afterHistoryBudget -= messageCost;
        } else {
            // 优先级是一个整体顺序：更靠后的都保住以前，不用更早、更泛的段落填剩余缝隙。
            omittedAfterHistory += i + 1;
            break;
        }
    }
    let remaining = baseRemaining - afterHistory.reduce((sum, message) => sum + cost(message), 0);

    // 聊天记录隔了一天就插一行日期（ADR 0049，像 QQ 隔天显示时间）：分得清哪句是哪天说的（放完假还以为他在青岛，ADR 0007 调整 2026-10-10）。
    // 绝对日期，旧消息前面那一行不会变，不影响缓存；放进去的最早一条前面也有一行
    const chat: OpenAIMessage[] = [];
    const addHistory = () => {
        // 最早那一条前面的日期行先留出来
        const firstDay = dayOf(history.at(-1));
        if (firstDay) remaining -= cost(marker(firstDay));
        let oldestDay: string | undefined;
        for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i]!;
            const message: OpenAIMessage = { role: m.role, content: m.content.replace(/\r/g, '') };
            const day = dayOf(m);
            // 这一条和更新的那一条不是同一天：更新的那一条前面插一行它的日期
            const boundary = oldestDay !== undefined && day !== oldestDay ? marker(oldestDay) : undefined;
            const total = cost(message) + (boundary ? cost(boundary) : 0);
            if (total > remaining) break;
            remaining -= total;
            if (boundary) chat.unshift(boundary);
            chat.unshift(message);
            oldestDay = day;
        }
        if (oldestDay) chat.unshift(marker(oldestDay));
    };

    const examples: OpenAIMessage[] = [];
    const newExampleChat = system(sub(ST_DEFAULT_PRESET.newExampleChatPrompt));
    const addExamples = (reserveLatest = false) => {
        for (const block of parseMesExamples(sub(character.mesExample))) {
            const dialogue = [{ ...newExampleChat }, ...parseExampleIntoIndividual(block, names)];
            const dialogueCost = dialogue.reduce((sum, m) => sum + cost(m), 0);
            if (dialogueCost > remaining - (reserveLatest ? latestReserve : 0)) break;
            remaining -= dialogueCost;
            examples.push(...dialogue);
        }
    };

    if (settings.pinExamples) {
        addExamples(Boolean(latest));
        addHistory();
    } else {
        addHistory();
        addExamples();
    }

    // [Start a new Chat] 是隔开示例对话和真聊天的；没有示例时（同学档没写示例）只是一行噪音，像提示词（DSH 诊断 2.3），不放。和 ST 不同
    const messages = [...head, ...examples, ...(examples.length ? [newChat] : []), ...chat, ...afterHistory, ...tail].filter(m => m.content);
    return { messages, activatedWorldInfo: wi.activated, ...(omittedAfterHistory ? { omittedAfterHistory } : {}) };
}
