#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""K3 第二批：第二轮采集（6 篇笔记）里**收下的 4 段**。

来源：`runtime/xhs/raw/`（本机被忽略目录，图片与接口数据用完即删）。
这一轮用的是**用户日常 Edge profile 的副本**（cookie 一起带过来）——
因为 Edge 147 禁止在默认 profile 上开远程调试，副本是当时唯一能带着登录态跑的路子；
跑完副本（1.3GB，含凭据）**当场删除**。节奏放到 12–25 秒/步、一次 6 篇。

**没收的**：
  - `0dc08bb0443b-2`：打牌互骂的**反转段子**（`staged_guess: possible`），而且**判不出哪边是女生** →
    两条都踩：拿不准 + 摆拍，整条不收。

**要重点看的两段**（K3 最缺的格子：她被邀请 / 被拒之后怎么接）：
  - `rc-b2-001`：她**拒绝**对方的见面与身体要求，态度明确、不吊着（ADR 0061 的 C1 要的正是这种）
  - `rc-b2-002`：她被约请吃饭时**只问在哪、叫什么**，不接对方的热情

跑法： python build_batch2.py && python check_batch.py samples-b2.jsonl
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from annotate import (is_asked, is_asked_strict, med, text_bubbles, sticker_counts,
                      turn_median)

HERE = os.path.dirname(os.path.abspath(__file__))

# (id, 源图, relation, scene, staged, staged_why, confidence, confidence_why, scope, context, her, turns, notes)
SEGS = [
    ('rc-b2-001', '20a8bf1d1da7-2', 'unknown', 9, False, '', 'medium',
     '字面全部可读、关系由原话点明（「不是男女朋友，只见过一次面」）；但谁是女方靠角色结构推断，无称呼或性别词',
     'in',
     '见过一次面的人求见面、要求拥抱，她三次明确拒绝并以互删收尾',
     'A',
     [
         ('B', ['虽然在我看来那是你片面的判断，但是…'], '不知道', None, None, None),
         ('A', ['抱歉，我们不是男女朋友，我只和你见过…'], '不知道', 'refuse', '平', False),
         ('B', ['只是简单的拥抱一下'], '不知道', None, None, None),
         ('A', ['抱歉，我做不到，就此别过。'], '不知道', 'refuse', '平', False),
         ('B', ['也不是马上就见面', '也许是我考完离开…也许是我考上了在这…'], '不知道', None, None, None),
         ('A', ['我不想见面，态度已明确，无需再谈。与其…'], '不知道', 'refuse', '平', False),
         ('B', ['别删我，我不会再打扰了'], '不知道', None, None, None),
     ],
     '场景 9：她拒绝（ADR 0061 C1 的语料）。拒绝时给理由、划边界、不吊着；全程不接对方的软话'),

    ('rc-b2-002', '6a6bb90cb923-2', 'friend', 9, False, '', 'medium',
     '气泡文字清晰；女方身份靠笔记标题「被女生拒绝了 3 次」推断，聊天内没有硬性性别标记',
     'in',
     '对方请她吃饭并让她定时间，她只问在哪、叫什么',
     'A',
     [
         ('A', ['这边生意不好不新鲜', '不好吃'], '不知道', 'share', '平', False),
         ('B', ['这样', '[引用]这边生意不好不新鲜', '那你平常想吃的时候咋办', '自己买自己烤吗'], '不知道', None, None, None),
         ('A', ['勉强一下'], '不知道', 'answer', '平', False),
         ('B', ['可不能委屈了自己', '[A]我带你去吃一家还是不错的'], '不知道', None, None, None),
         ('A', ['在哪啊'], '不知道', 'ask', '平', False),
         ('B', ['[?]', '你定个时间，我们一起去'], '不知道', None, None, None),
         ('A', ['叫什么'], '不知道', 'ask', '平', False),
         ('B', ['某店'], '不知道', None, None, None),
     ],
     '场景 9：被约时她只问地点和店名，不接「你定个时间」的热情——「改天再说」的另一种写法'),

    ('rc-b2-003', 'c0b4f82eb38b-2', 'friend', 6, False, '', 'high',
     '两侧头像性别特征明显（男自拍 / 长发女生自拍），来回清晰',
     'in',
     '她拿第三个人的朋友圈截图去损朋友',
     'A',
     [
         ('A', ['[图片]', '哥们你发达了啊', '带女朋友住这种级别宾馆'], '不知道', 'share', '开心', False),
         ('B', ['你哪来的图？'], '不知道', None, None, None),
         ('A', ['[C]发朋友圈了啊', '我又没被C屏蔽', '还发了抱看一束满天星的图嘞'], '不知道', 'share', '开心', False),
     ],
     '场景 6：她主动起话头（拿图去损人）。第三个人只记作 [C]'),

    ('rc-b2-004', 'bc51ff23e108-2', 'unknown', 6, False, '', 'low',
     '女方身份只能靠对方的备注名与撒娇语气推断，对方头像是卡通图，没有性别硬证据',
     'low_confidence',
     '她撒娇求对方帮忙上课打卡，对方说卡没了',
     'A',
     [
         ('A', ['拍了拍B', '你下午去上课吗，可以帮我打个卡嘛', '[表情包]'], '不知道', 'ask', '撒娇', False),
         ('B', ['啊？', '[表情包]', '没你的卡了手机里面', '[表情包]', '上次刷了无效就删掉了'], '不知道', None, None, None),
     ],
     '低置信：关系与性别都是推断，只作「撒娇求人办事」的句式参照，不进主统计'),
]

REL_NOTE = {
    'rc-b2-001': '见过一次面的追求者（不是情侣）；K4 的男朋友格不要混进去',
    'rc-b2-002': '追求中（笔记标题写着被女生拒绝了 3 次）；K4 单列',
    'rc-b2-004': '对方备注像前任/熟人，两人又互相帮忙打卡像同校；低置信',
}

PF = {
    'rc-b2-001': ('mid', '行为像她（给理由、划边界、不吊着），语气不像（「就此别过」「无需再谈」太书面客气）；她的损与短句在这段里没有'),
    'rc-b2-002': ('mid', '不接对方「你定个时间」的热情、只反问「在哪啊」「叫什么」，是她不接软话那一面；但四句都太短，看不出说话习惯'),
    'rc-b2-003': ('high', '「哥们你发达了啊」「我又没被 C 屏蔽」是损人式开场，短句 + 语气词「嘞」的节奏跟她的嘴硬损人一路；这是本批最像她的一段'),
    'rc-b2-004': ('mid', '「可以帮我打个卡嘛」+ 委屈表情是她撒娇那一面；但置信度低，只作参照'),
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
        rec['persona_fit'] = {'level': PF[rid][0], 'why': PF[rid][1]}

        agg_b, agg_c, asked, asked_s, sw = [], [], 0, 0, 0
        sticker_total, sticker_turns = 0, 0
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
                    'median_chars': turn_median(bubbles),
                    'stickers': st,
                    'asked': any(is_asked(b) for b in tb),
                    'asked_strict': any(is_asked_strict(b) for b in tb),
                    'switched_topic': bool(switched),
                }
                agg_b.append(len(bubbles))
                agg_c += [len(b) for b in tb]
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
            'asked_rate': round(asked / n_her, 3) if n_her else 0,
            'asked_strict_rate': round(asked_s / n_her, 3) if n_her else 0,
            'switched_topic_count': sw,
        }
        rows.append(rec)

    out = os.path.join(HERE, 'samples-b2.jsonl')
    with open(out, 'w', encoding='utf-8') as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'写出 samples-b2.jsonl {len(rows)} 段（她这一侧 {sum(r["stats"]["her_turns"] for r in rows)} 轮）')
    for r in rows:
        print(f"  {r['id']}  {r['relation']}/scene {r['scene']}  staged={r['staged']}  "
              f"scope={r['stats_scope']}  {r['stats']['her_turns']} 轮  pf={r['persona_fit']['level']}")


if __name__ == '__main__':
    main()
