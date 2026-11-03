import { chatCompletion, type Fetch, type LlmDeps, type LlmOptions } from './language/llm.ts';
import type { HumanValues } from './human-values.ts';

/** DSH 连接层只接收脱敏后的状态，不直接接收聊天记录。 */
export interface DshState {
    at: string;
    tier?: string;
    needs?: Record<string, number>;
    values?: Pick<HumanValues, 'energy' | 'hunger' | 'stress' | 'mood' | 'health' | 'loneliness' | 'motivation' | 'boredom' | 'socialBattery'>;
    relationship?: Pick<HumanValues['relationship'], 'intimacy' | 'trust' | 'familiarity' | 'attachment' | 'friction'>;
    recentEvents?: readonly string[];
}

export interface DshAdviceRequest {
    question: string;
    state?: DshState;
    /** 仅在 QQ 明确发起 /dsh ask 时带入的最近几轮；不会自动读取。 */
    recentTurns?: readonly DshConversationTurn[];
    /** 林梦瑶的最小语气档案，让 DSH 的回答能直接接回 QQ。 */
    voice?: DshVoice;
}

export interface DshConversationTurn {
    role: 'user' | 'assistant';
    content: string;
}

export interface DshVoice {
    name?: string;
    description?: string;
    personality?: string;
}

export interface DshProbeResult {
    ok: boolean;
    at: string;
    model: string;
    latencyMs: number;
    error?: string;
}

export interface DshLink {
    readonly model: string;
    probe(): Promise<DshProbeResult>;
    advise(request: DshAdviceRequest): Promise<string>;
}

export interface DshLinkDeps extends Partial<Pick<LlmDeps, 'fetch' | 'sleep' | 'log' | 'guard'>> {
    now?: () => number;
}

const PROBE_SYSTEM = '你是 DSH 连接探针。只回复 OK，不要输出其他内容。';
const ADVISOR_SYSTEM = [
    '你是 DSH，作为林梦瑶的外部思考协作者。',
    '你只能根据本次请求中的脱敏状态给建议，不要猜测、补造或索取真实身份信息。',
    '不要复述或要求聊天原文、QQ 号、密钥、地址、日志和私密记忆。',
    '不要输出分析报告、角色标签或“DSH 建议”等前缀；直接用她平时在 QQ 里会用的自然中文聊天口吻回答。',
    '只给当前问题需要的短回答；不要改变世界账或关系账。',
].join(' ');

const STATE_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_STATE_NUMBERS = 32;

function sanitizeNumberRecord(value: unknown): Record<string, number> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const output: Record<string, number> = {};
    for (const [key, number] of Object.entries(value)) {
        if (!STATE_KEY_RE.test(key) || typeof number !== 'number' || !Number.isFinite(number)) continue;
        output[key] = Math.round(number);
        if (Object.keys(output).length >= MAX_STATE_NUMBERS) break;
    }
    return Object.keys(output).length ? output : undefined;
}

/** DSH 的在线请求和落盘快照共用同一份最小状态白名单。 */
export function sanitizeDshState(state: DshState): DshState {
    const parsedAt = typeof state?.at === 'string' ? Date.parse(state.at) : Number.NaN;
    const needs = sanitizeNumberRecord(state?.needs);
    const values = sanitizeNumberRecord(state?.values);
    const relationship = sanitizeNumberRecord(state?.relationship);
    const recentEvents = Array.isArray(state?.recentEvents)
        ? state.recentEvents.filter(event => typeof event === 'string' && STATE_KEY_RE.test(event)).slice(-8)
        : [];
    return {
        at: Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : '',
        ...(typeof state?.tier === 'string' && STATE_KEY_RE.test(state.tier) ? { tier: state.tier } : {}),
        ...(needs ? { needs } : {}),
        ...(values ? { values: values as DshState['values'] } : {}),
        ...(relationship ? { relationship: relationship as DshState['relationship'] } : {}),
        ...(recentEvents.length ? { recentEvents } : {}),
    };
}

/** 从外部输入中移除常见的身份和凭据字段；调用者仍应优先传入已脱敏内容。 */
export function sanitizeDshQuestion(question: string): string {
    return question
        .replace(/(qq|user|uid|id|账号|号码)\s*[:：]?\s*\d{5,}/gi, '$1=<redacted>')
        .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s,，;；]+/gi, '$1<redacted>')
        .replace(/(sk-|api[_-]?key|token|password|密码)\s*[:：=]?\s*[^\s,，;；&#]+/gi, '$1=<redacted>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);
}

/** 给 QQ 负责人看的探针错误摘要：隐藏凭据和 URL 查询串，避免把上游原文直接发进聊天。 */
export function sanitizeDshError(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return sanitizeDshQuestion(text).slice(0, 160) || '未知错误';
}

function stateText(state: DshState | undefined): string {
    if (!state) return '状态：未提供（只做抽象建议，不推断她的现实情况）。';
    const safe = sanitizeDshState(state);
    const lines = [`时间：${safe.at || '未提供'}`];
    if (safe.tier) lines.push(`关系档位：${safe.tier}`);
    if (safe.needs) lines.push(`需要值：${Object.entries(safe.needs).map(([key, value]) => `${key}=${value}`).join('，')}`);
    if (safe.values) lines.push(`真人式状态：${Object.entries(safe.values).map(([key, value]) => `${key}=${value}`).join('，')}`);
    if (safe.relationship) lines.push(`关系状态：${Object.entries(safe.relationship).map(([key, value]) => `${key}=${value}`).join('，')}`);
    if (safe.recentEvents?.length) lines.push(`最近事件（仅类型摘要）：${safe.recentEvents.join('、')}`);
    return lines.join('\n');
}

function voiceText(voice: DshVoice | undefined): string {
    if (!voice) return '语气：沿用普通、自然、克制的中文私聊口吻，不自称系统。';
    const lines = ['语气档案（只用于措辞，不用于推断现实身份）：'];
    if (voice.name) lines.push(`名字：${sanitizeDshQuestion(voice.name).slice(0, 80)}`);
    if (voice.description) lines.push(`角色描述：${sanitizeDshQuestion(voice.description).slice(0, 700)}`);
    if (voice.personality) lines.push(`性格和说话方式：${sanitizeDshQuestion(voice.personality).slice(0, 900)}`);
    return lines.join('\n');
}

function turnsText(turns: readonly DshConversationTurn[] | undefined): string {
    const safe = (turns ?? []).slice(-6).map(turn => ({
        role: turn.role === 'assistant' ? '她' : '他',
        content: sanitizeDshQuestion(turn.content).slice(0, 500),
    })).filter(turn => turn.content);
    if (!safe.length) return '最近 QQ 对话：未提供。';
    return `最近 QQ 对话（本次明确咨询才提供，最多 6 条，已截短）：\n${safe.map(turn => `${turn.role}：${turn.content}`).join('\n')}`;
}

/** 创建一个显式、可测试的 DSH API 连接。它不会自动把建议写回聊天或世界账。 */
export function createDshLink(options: LlmOptions, deps: DshLinkDeps = {}): DshLink {
    const now = deps.now ?? Date.now;
    const probeOptions: LlmOptions = {
        ...options,
        temperature: 0,
        maxTokens: Math.min(options.maxTokens, 8),
        extraBody: { ...options.extraBody, thinking: { type: 'disabled' } },
    };
    const adviseOptions: LlmOptions = {
        ...options,
        temperature: Math.min(options.temperature, 0.4),
        maxTokens: Math.min(options.maxTokens, 500),
        extraBody: { ...options.extraBody, thinking: { type: 'disabled' } },
    };
    return {
        model: options.model,
        async probe(): Promise<DshProbeResult> {
            const started = now();
            try {
                const reply = await chatCompletion(probeOptions, [{ role: 'system', content: PROBE_SYSTEM }, { role: 'user', content: 'ping' }], { ...deps, purpose: 'background' });
                if (!/^OK[.!。！]?$/i.test(reply.trim())) throw new Error(`探针返回异常：${reply.slice(0, 80)}`);
                return { ok: true, at: new Date(now()).toISOString(), model: options.model, latencyMs: Math.max(0, now() - started) };
            } catch (error) {
                return { ok: false, at: new Date(now()).toISOString(), model: options.model, latencyMs: Math.max(0, now() - started), error: error instanceof Error ? error.message : String(error) };
            }
        },
        async advise(request: DshAdviceRequest): Promise<string> {
            const question = sanitizeDshQuestion(request.question);
            if (!question) throw new Error('DSH 问题不能为空');
            const prompt = `问题：${question}\n\n${stateText(request.state)}\n\n${voiceText(request.voice)}\n\n${turnsText(request.recentTurns)}\n\n直接回复这一次 QQ 咨询，最多 5 个短气泡，每个不超过 80 字。`;
            return chatCompletion(adviseOptions, [{ role: 'system', content: ADVISOR_SYSTEM }, { role: 'user', content: prompt }], { ...deps, purpose: 'background' });
        },
    };
}

/** 给 CLI / 测试使用的最小依赖构造器，避免把环境变量或 key 写入日志。 */
export function dshOptionsFromLlm(llm: LlmOptions, overrides: Partial<Pick<LlmOptions, 'baseUrl' | 'model' | 'timeoutMs'>> = {}): LlmOptions {
    return { ...llm, ...overrides };
}

export type DshFetch = Fetch;
