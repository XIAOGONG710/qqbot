// 挑候选作为解释器的模块（ADR 0336「生成之后那一段」第 10 步）：ADR 0041——他难过、说亲密话、收尾这三种时候（按这一轮最终的意图行认），
// 同一份提示词一次生成几个，每个清理之后按看得见的规则打分，挑扣分最少的；主动找他、别的轮次只生成一个。
//
// 分工：
// - 这里定「这一轮挑不挑、按什么规则挑」：contribute 时（意图行、她那边已经在 turn.facts 上）算好规则写进 turn.facts.pick，不放段落；
//   说话的毛病要的聊天记录也在这一刻读（迁移前在拼段落之前读，中间没有 await）。
// - 生成几次、每个怎么清理仍是联系人流水线的事（它有模型和清理顺序表）：流水线问 candidates(turn) 要不要挑，要就生成 count 个、各清理一次，
//   把清理过的字交给 choose，拿回挑中的下标；挑中的那个原文交回复器，由它再清理一次、成为选中的那一稿（落选的设备指令不登记）。
// 不存状态、不调模型。配置 candidates 不大于 1 时什么都不做。行为和迁移前 contact.ts 里的逐字一样（行为基线 candidates 场景核对）。

import type { CandidatePlan, Module } from '../interpreter/interpreter.ts';
import { describePick, pickBest, PICKED_INTENTS } from '../language/candidates.ts';
import { styleBannedWords } from '../language/style-rules.ts';
import { speechContext } from '../language/speech-check.ts';
import type { StoredMessage } from '../memory/history.ts';
import { heardSinceReply } from '../memory/long-term.ts';

export interface CandidatesModuleOptions {
    /** 一次生成几个（配置 candidates，1–5）；不大于 1 就不挑 */
    count: number;
    /** 开着说话的毛病检查（配置 speechCheck）时，候选也按它扣分；要读存下来的聊天记录 */
    speechCheck?: boolean;
    history: (qq: number) => readonly StoredMessage[];
}

export function candidatesModule(options: CandidatesModuleOptions): Module {
    return {
        id: 'candidates',
        contribute(turn) {
            const { facts } = turn;
            const picked = options.count > 1 && facts.intent && !turn.initiate ? PICKED_INTENTS.find(p => p.pattern.test(facts.intent!)) : undefined;
            if (!picked) return [];
            facts.pick = {
                kind: picked.kind, maxLines: picked.maxLines, heard: heardSinceReply(turn.history), banned: [...(turn.card?.banned ?? []), ...styleBannedWords()],
                // 她自己生活里的东西：猫、相机、在读的书、手上的爱好（DSH 诊断 1.2、ADR 0036 的四类）
                own: [...(facts.world?.cat ? [facts.world.cat.name] : []), '相机', ...(turn.card?.books ?? []).map(book => book.title), '追剧', '调色', '构图', '修片', '摄影区'],
                ...(options.speechCheck ? { speech: speechContext(options.history(turn.contact.qq)) } : {}),
            };
            return [];
        },
        candidates(turn): CandidatePlan | undefined {
            const rules = turn.facts.pick;
            if (!rules) return undefined;
            return {
                count: options.count,
                choose(cleaned, log) {
                    const { index, scored } = pickBest(cleaned, rules, text => text);
                    log(describePick(index, scored));
                    return index;
                },
            };
        },
    };
}
