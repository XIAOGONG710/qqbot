#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""K3 第一批（试采）：把 12 条小红书笔记里**收下的 5 段**写成 v2 格式。

来源：`runtime/xhs/raw/`（本机被忽略目录，图片与接口数据用完已删）。
抄录：看图逐字抄 → 按第 2 节的硬规则脱敏（≤20 字/气泡、人名换 A/B、地名换「某地」、
      时间一律不记、表情包写 [表情包]）。抄录由 DSH 本人 + 两个子代理完成，全部逐条复核。

**没收的 6 条**（写在 README 的「没收的类别」表里）：
  - `e32ea13da7b9-2`：截屏者头像是男性照片，判不出哪边是女生 → 按「拿不准就不收」
  - `4126ea62cf89-2`：交友撮合/引流语域，界面像另一个平台（英文日期 + Delivered 回执）→ 不收
  - `1c60ec30888c-2`：帖子封面卡（一行大字，无气泡）
  - `969a92354c01-2`：语录式摆拍，只有单侧三条、无来无回，还有贴纸遮挡
  - `0cd7a9538662-2`：纯文字教学话术长图
  - `0096d2940c86-2`：营销号字幕覆盖的加工图（引流转发）

**staged 判定**（宁可多标）：
  - `d114cc6de982-2`：画面有「捞月狗」水印 → staged=true，不进主统计
  - `8508d9f7dde8-2`：品牌软广段子（帖文是「有梗方式 be like」）→ staged=true，不进主统计
  - 其余三段看不出加工，staged=false

跑法： python build_batch1.py && python check_batch.py samples-b1.jsonl
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from annotate import (is_asked, is_asked_strict, med, text_bubbles, sticker_counts,
                      turn_median)   # 复用 K1 的口径（含 [表情包] 占位符口径）

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- 抄录（已脱敏）
# 每条：(id, 源图名, relation, scene, staged, staged_why, confidence, confidence_why,
#        stats_scope, context, her, turns, notes)
# turns: [(who, [气泡...], gap, act|None, mood|None, switched_topic|None)]
# her 侧才给 act/mood/switched_topic；gap 一律「不知道」（截图里没有可靠时间，时间不记）
SEGS = [
    ('rc-b1-001', '696e5792c7c8-2', 'friend', 9, False, '', 'low',
     '对方性别与关系都只能按熟人朋友判断（提到「年糕」像宠物）；只有一段，语域证据薄',
     'low_confidence',
     '放假前约对方出门、被婉拒之后又改口约夜宵',
     'A',
     [
         ('A', ['明天放假啦 你有什么打算吗', '[表情包]'], '不知道', 'ask', '平', False),
         ('B', ['在家'], '不知道', None, None, None),
         ('A', ['不出门吗'], '不知道', 'ask', '平', False),
         ('B', ['不想动'], '不知道', None, None, None),
         ('A', ['你这样会发霉的！！'], '不知道', 'joke', '开心', False),
         ('B', ['习惯了'], '不知道', None, None, None),
         ('A', ['要多出去走走', '那要不要出来吃夜宵 或者年糕…'], '不知道', 'ask', '平', True),
     ],
     '场景 9：被婉拒后换一个由头再约（先劝出门、再约夜宵）'),

    ('rc-b1-002', 'ffd5011d7e3d-2', 'friend', 9, False, '', 'medium',
     '对方备注名是暧昧对象（引用块里露了，已不记），关系未确立，按非情侣的熟人记',
     'in',
     '对方约她吃饭、并定好集合地点，她答应',
     'A',
     [
         ('B', ['你今晚有课吗', '要不要去吃个饭啊', '我舍友说那边有家烤肉很好吃'], '不知道', None, None, None),
         ('A', ['没有课', '可以呀'], '不知道', 'confirm', '开心', False),
         ('A', ['[表情包]'], '不知道', 'confirm', '开心', False),
         ('B', ['好，那我下课以后 我们在校门口集合怎么样'], '不知道', None, None, None),
         ('A', ['好呀'], '不知道', 'confirm', '开心', False),
     ],
     '场景 9：约人成功；她这一侧的答应用短句 + 表情包，第三轮是引用对方那句再回表情包'),

    ('rc-b1-003', '836f3cf46c5a-2', 'friend', 9, False, '', 'medium',
     '暧昧期（对方说「想和你去」但没有情侣称呼）',
     'in',
     '对方绕着弯约她，她把话挑明',
     'A',
     [
         ('B', ['我想去吃那家面'], '不知道', None, None, None),
         ('A', ['去啊'], '不知道', 'answer', '平', False),
         ('B', ['一个人不想去'], '不知道', None, None, None),
         ('A', ['那你可以说得再明显点'], '不知道', 'joke', '开心', False),
         ('B', ['想和你去'], '不知道', None, None, None),
         ('A', ['收到', '这版清楚多了'], '不知道', 'joke', '开心', False),
     ],
     '场景 9：对方含糊约人时她不接软话、直接要求说明白，是「嘴硬 + 直球」的合体'),

    ('rc-b1-004', 'd114cc6de982-2', 'boyfriend', 9, True,
     '画面有「捞月狗」水印，四句排比像抖包袱的合集排版', 'low',
     '排版与水印都指向摆拍/搬运，句子也过于工整',
     'staged_only',
     '她用整活的方式约对方共进晚餐，对方顺着接',
     'A',
     [
         ('A', ['诚邀一位帅哥共进晚餐', '全世界80多亿人口', '我只约了你一个', '还不速速答应'], '不知道', 'joke', '撒娇', False),
         ('A', ['[表情包]'], '不知道', 'joke', '撒娇', False),
         ('B', ['好啊，是想我了吗'], '不知道', None, None, None),
         ('A', ['没想'], '不知道', 'answer', '撒娇', False),
         ('B', ['又嘴硬'], '不知道', None, None, None),
         ('A', ['嘴硬不硬，你亲一口就知道了'], '不知道', 'joke', '撒娇', False),
     ],
     '摆拍样本，只作「嘴硬」句式的参照，不进主统计'),

    ('rc-b1-005', '8508d9f7dde8-2', 'boyfriend', 6, True,
     '帖文是品牌软广的「有梗方式 be like」，对话是围绕喝酒的成型段子', 'low',
     '段子 + 帖文带品牌，不能当自然聊天',
     'staged_only',
     '她主动说自己想喝酒，对方让她说人话',
     'A',
     [
         ('A', ['今晚我打算开展一项研究'], '不知道', 'share', '开心', False),
         ('B', ['研究什么?'], '不知道', None, None, None),
         ('A', ['研究大麦芽及水在发酵作用下，其液态产物…'], '不知道', 'joke', '开心', False),
         ('B', ['说人话'], '不知道', None, None, None),
         ('A', ['想喝点了', '[表情包]'], '不知道', 'share', '开心', False),
     ],
     '摆拍/软广样本，只作「她主动起话头」的句式参照，不进主统计'),
]

# 复核建议（10-12）：暧昧语域标成 friend 会让「朋友」格偏向调情，单独写一句
REL_NOTE = {
    'rc-b1-002': '暧昧期（对方是她备注的 crush），不是情侣；K4 的朋友 / 闺蜜格不要混进去',
    'rc-b1-003': '暧昧期（对方说「想和你去」但没有情侣称呼）；同上，K4 单独看待',
}

PF = {    'rc-b1-001': ('mid', '「你这样会发霉的！！」「年糕给我 rua 一下」是熟人之间的损加黏，和她嘴硬里透黏有一半像；但整段是她在追着对方出门，比她主动'),
    'rc-b1-002': ('mid', '答应得干脆、只有短句加表情包，像她「想他不含糊」那一面；但两句太短，看不出她的口癖'),
    'rc-b1-003': ('mid', '不接对方的软话、直接要他说明白，是嘴硬加直球；但只有一轮，看不出日常说话习惯'),
    'rc-b1-004': ('mid', '「没想」「你亲一口就知道了」正是她嘴硬加撩的样子；但整段是摆拍，不能当干净样本'),
    'rc-b1-005': ('mid', '主动起话头、整活式表达像她；但这是软广段子'),
}


def main():
    rows = []
    for (rid, img, rel, scene, staged, staged_why, conf, conf_why, scope, ctx, her, turns, notes) in SEGS:
        rec = {
            'id': rid, 'source': f'小红书公开笔记（已脱敏，原图不留）', 'img_ref': img,
            'relation': rel, 'scene': scene, 'staged': staged, 'context': ctx,
            'her': her, 'confidence': conf, 'confidence_why': conf_why,
            'stats_scope': scope, 'notes': notes,
        }
        if staged:
            rec['staged_why'] = staged_why
        if rid in REL_NOTE:                 # 复核建议：暧昧语域单独标，别混进「朋友」格
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

    out = os.path.join(HERE, 'samples-b1.jsonl')
    with open(out, 'w', encoding='utf-8') as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'写出 samples-b1.jsonl {len(rows)} 段（她这一侧 {sum(r["stats"]["her_turns"] for r in rows)} 轮）')
    for r in rows:
        print(f"  {r['id']}  {r['relation']}/scene {r['scene']}  staged={r['staged']}  "
              f"scope={r['stats_scope']}  {r['stats']['her_turns']} 轮")


if __name__ == '__main__':
    main()
