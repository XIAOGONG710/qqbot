#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""K3 第三批（最后一批）：**3 段**，来自两次动作。

> **2026-10-15 修订（Claude 10-12 复核要求）**：删掉 `rc-b3-004`（合租室友那段）。
> 理由：室友对「忘在洗衣机里的贴身衣物」说「好香 / 好软 / 和宝宝一样」，属性暗示；
> 任务书第 2 节第 4 条不收色情，而它又是 `staged_only`、不进任何统计——留着没有收益。
> 同批给 `rc-b3-001` 补 `staged_guess: possible`（台词像设计过的段子）。

## 动作 ①（12 个关键词各 4 篇的设计）
脚本的 `--per-keyword` **从来没生效**（定义了却没写进循环），所以 15 篇全来自第 1 个关键词
「男朋友难过怎么哄」：**12 篇是话术教学/海报卡**，只有 1 段可用（`rc-b3-001`）。

## 动作 ②（修好 `--per-keyword`，8 个空格子各取 1 篇）→ 4 篇真聊天，收 3 段
  - `rc-b3-002` `0caeee2c0760`：她冷处理、对方追着要说法（场景 7）——本批最像她的一段
  - `rc-b3-003` `772758f64f50`：闺蜜互怼（bestie 格）——但台词是设计过的段子（`staged_guess: possible`）
  - `rc-b3-004` `54876353daff`：合租室友求助——**有生成/草稿痕迹（`staged_guess: likely`）**，只列不计

## 动作 ② 里**收不下**的（这轮最要紧的发现）
  - `0bb0890bd166`（晚安）与 `969a92354c01`（和男朋友聊天没必要太正经）：**图上只有对方一个人说话，
    她这一侧 0 轮**——按 schema 必须 her 侧有轮才成段，所以这两篇**一条都进不来**。
    这就是这类话题的主流形态：女生晒「他对我多好」，**她本人的话根本不在画面里**。
  - `9c2c3640c53b`（撒娇）：日文 LINE，语域不符，不收。
  - `3448f186bff8`（异地恋）：5 张全是长文卡/照片，没有聊天截图。
  - `15f81f1b51bf`（拒绝别人）：教学卡「万能公式」。

**结论**：`男朋友 × {难过、亲密话、收尾}` 与 `撒娇` 这几格**用公开笔记补不上**，原因不在搜索词，
在内容供给（教学话术 + 单侧独白帖两种形态占满）。K3 停在 **49 段**。

跑法： python build_batch3.py && python check_batch.py samples-b3.jsonl
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from annotate import (is_asked, is_asked_strict, med, text_bubbles, sticker_counts,
                      turn_median, counted_bubbles, truncated_count)

HERE = os.path.dirname(os.path.abspath(__file__))

# (id, 源图, relation, scene, staged, staged_why, confidence, confidence_why, scope, context, her, turns, notes)
SEGS = [
    ('rc-b3-001', 'c486fba8b20c-2', 'friend', 7, False, '', 'high',
     '界面是原生聊天、文字全部可读，说话人是不是女方由第一人称内容（「我男朋友」）与笔记标题（「女朋友」）双重支撑；只有对方是普通朋友还是闺蜜无法确证',
     'low_confidence',
     '她把准备发给男朋友的话误发到这边：先认错、说要请吃烧烤，再问「你觉得他会吗」；对方只回一个「?」，她才发现发错人、要去撤回',
     'A',
     [
         ('A', ['和男朋友吵架了', '这次是我的问题', '我已经深刻认识到错误并且准备改正了',
                '晚上我会找一家好吃的烧烤店请我男朋友吃…', '希望他能原谅我 你觉得他会吗'],
          '不知道', 'share', '难过', False),
         ('B', ['?'], '不知道', None, None, None),
         ('A', ['无语', '发错人了', '撤回不了了', '[表情包]', '原谅吗？'],
          '不知道', 'share', '平', True),
     ],
     '场景 7：认错 + 准备补偿 + 问朋友意见。注意「她」是左侧说话人、截图者是她的朋友——'
     '她对男朋友说的话只出现在转述里，不是直接对话'),

    ('rc-b3-002', '0caeee2c0760-2', 'boyfriend', 7, False, '', 'medium',
     '界面原生、左右归属清晰、文字可读；但整图无头像、无称呼与备注名，关系只能由语气与冲突强度推断，气泡还有上下裁断',
     'in',
     '她连续短句冷处理（「管我啥事」「莫名其妙」），对方追着要说法（「我哪里很让你不满意吗」），她收尾「那你别和我说话」',
     'A',
     [
         ('B', ['我又不这样'], '不知道', None, None, None),
         ('A', ['那你team呗', '又不是我的team', '管我啥事', '莫名其妙'],
          '不知道', 'joke', '生气', False),
         ('B', ['你为啥', '非要这么说话啊', '我哪里很让你不满意吗', '[?]', '就非要来那么两句'],
          '不知道', None, None, None),
         ('A', ['那你别和我说话'], '不知道', 'refuse', '生气', False),
     ],
     '场景 7：吵架里她那一侧的样子——不留台阶、短句、火气直接。原文有一处含日期跨度，按规则整条记 [?]'),

    ('rc-b3-003', '772758f64f50-2', 'bestie', 6, False, '', 'medium',
     '界面与文字清晰、左右归属可由气泡方向与第一人称内容判定；但气泡内没有性别自称证据，女方身份依赖笔记文案的「闺蜜」称谓，头像未入镜',
     'low_confidence',
     '她用成语自嘲倒霉（「生活就是如履薄冰」），对方按字面接梗（「你把老子冰箱里蛋糕吃了？」）',
     'A',
     [
         ('A', ['生活就是如履薄冰', '总有人对我恶语相向', '可能是我动了某人的蛋糕吧'],
          '不知道', 'share', '平', False),
         ('B', ['你咋了你', '你把老子冰箱里蛋糕吃了？'], '不知道', None, None, None),
     ],
     'bestie 格：损人式互怼。**`staged_guess: possible`**——台词是「如履薄冰／动了某人的蛋糕」双关被字面化'
     '的一次性完整段子，笔记标签自述 #聊天套路，词条像是为发帖效果设计过；界面本身是原生微信'),
]

REL_NOTE = {
    'rc-b3-001': '聊天双方是她与朋友；文里出现的男朋友只是被转述的对象，判关系时别把这段当情侣对话',
}

# 台词像设计过的段子、但界面是原生截图的（Claude 10-12 复核：rc-b3-001 也加这条）
STAGED_GUESS = {
    'rc-b3-001': 'possible',
    'rc-b3-003': 'possible',
}

PF = {
    'rc-b3-001': ('mid', '认错那几句太规矩（像在写检讨），但「无语 / 发错人了 / 撤回不了了」这一串社死自嘲很像她：短句、口语、不自怜'),
    'rc-b3-002': ('high', '「管我啥事」「莫名其妙」「那你别和我说话」是嘴硬那一面：短句（4–7 字）、不留台阶、无客套；'
                          '按复核收紧后的 high 标准，四项里占了「损或嘴硬」「气泡 ≤10 字」「没有客套」三条'),
    'rc-b3-003': ('mid', '「生活就是如履薄冰」这种夸张怨念＋把成语按字面用，像她整活的路子；但没有语气词、也看不出她的口癖，且台词是设计过的段子'),
}


def main():
    rows = []
    for (rid, img, rel, scene, staged, staged_why, conf, conf_why, scope, ctx, her, turns, notes) in SEGS:
        rec = {
            'id': rid, 'source': '小红书公开笔记（已脱敏，原图不留）', 'img_ref': img,
            'relation': rel, 'scene': scene, 'staged': staged, 'context': ctx,
            'her': her, 'confidence': conf, 'confidence_why': conf_why,
            'stats_scope': scope, 'notes': notes,
        }
        if staged:
            rec['staged_why'] = staged_why
        if rid in REL_NOTE:
            rec['relation_note'] = REL_NOTE[rid]
        if rid in STAGED_GUESS:
            rec['staged_guess'] = STAGED_GUESS[rid]
        if rid == 'rc-b3-001':
            rec['stats_scope_why'] = ('女方身份由第一人称内容与笔记标题双重支撑（比 b2 那两段的角色推断强），'
                                      '但按 Claude 10-12 的裁定「推断的不进数字统计」，仍只作定性参照')
        rec['persona_fit'] = {'level': PF[rid][0], 'why': PF[rid][1]}

        agg_b, agg_c, asked, asked_s, sw = [], [], 0, 0, 0
        sticker_total, sticker_turns, truncated_total = 0, 0, 0
        out_turns = []
        for who, bubbles, gap, act, mood, switched in turns:
            t = {'who': who, 'bubbles': bubbles, 'gap': gap}
            if who == her:
                tb = text_bubbles(bubbles)
                st = sticker_counts(bubbles)
                t['act'] = act
                t['mood'] = mood
                t['stats'] = {
                    'bubbles': len(bubbles),
                    'text_bubbles': len(tb),
                    'truncated': truncated_count(bubbles),
                    'median_chars': turn_median(bubbles),
                    'stickers': st,
                    'asked': any(is_asked(b) for b in tb),
                    'asked_strict': any(is_asked_strict(b) for b in tb),
                    'switched_topic': bool(switched),
                }
                agg_b.append(len(bubbles))
                agg_c += [len(b) for b in counted_bubbles(bubbles)]
                truncated_total += t['stats']['truncated']
                sticker_total += sum(st.values())
                sticker_turns += 1 if sum(st.values()) else 0
                asked += 1 if t['stats']['asked'] else 0
                asked_s += 1 if t['stats']['asked_strict'] else 0
                sw += 1 if switched else 0
            out_turns.append(t)
        rec['turns'] = out_turns
        n_her = len(agg_b)
        rec['stats'] = {
            'her_turns': n_her,
            'silent_turns': 0,
            'bubbles_per_turn_median': med(agg_b),
            'bubbles_per_turn_counts': agg_b,
            'median_chars': med(agg_c) if agg_c else None,
            'stickers_total': sticker_total,
            'sticker_turns': sticker_turns,
            'truncated_bubbles': truncated_total,
            'asked_rate': round(asked / n_her, 3) if n_her else 0,
            'asked_strict_rate': round(asked_s / n_her, 3) if n_her else 0,
            'switched_topic_count': sw,
        }
        rows.append(rec)

    out = os.path.join(HERE, 'samples-b3.jsonl')
    with open(out, 'w', encoding='utf-8') as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'写出 samples-b3.jsonl {len(rows)} 段（她这一侧 {sum(r["stats"]["her_turns"] for r in rows)} 轮）')
    for r in rows:
        print(f"  {r['id']}  {r['relation']}/scene {r['scene']}  staged={r['staged']}  scope={r['stats_scope']}  "
              f"{r['stats']['her_turns']} 轮  {r['stats']['bubbles_per_turn_counts']}  pf={r['persona_fit']['level']}")


if __name__ == '__main__':
    main()
