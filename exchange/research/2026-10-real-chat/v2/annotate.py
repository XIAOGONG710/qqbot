#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""K1：给现有 36 段补标注，产出 v2/samples.jsonl 与 v2/closing-turns.jsonl。

分工（见 SCHEMA.md）：
- 脚本算：turns[].stats.bubbles / median_chars / asked，以及顶层 stats 聚合。
- 人工标：turns[].act、turns[].mood、turns[].stats.switched_topic、persona_fit。

跑法： python annotate.py
原语料 ../samples.jsonl 与 ../closing-turns.jsonl 只读，产物写 v2/ 覆盖同名文件。
人工标注与 her 侧轮次数对不上会直接报错（不静默补空）。
"""
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)

# ---------------------------------------------------------------- 人工标注
# 每条的 turns 按「her 侧轮次出现的先后」排列：(act, mood, switched_topic)
# act 只能取 10 个：answer confirm comfort joke share clarify ask refuse close silent
# mood 只能取 7 个：平 开心 难过 生气 撒娇 无聊 累
# switched_topic：她这一轮有没有自己把话题拐到别处（脚本算不出，人工判断）
ANN = {
    # ---- samples（30 段）----
    'rc-001': {'pf': ('low', '只有「怼陌生人 + 要钱式玩笑」这一层嘴硬，看不到她自己的生活与人际'), 't': [
        ('refuse', '平', False), ('refuse', '平', False), ('refuse', '平', False)]},
    'rc-002': {'pf': ('mid', '替人出主意的条理感偏「顾问」，和她不主动揽麻烦的性格只重合一半'), 't': [
        ('ask', '平', False), ('answer', '平', False), ('share', '平', True)]},
    'rc-003': {'pf': ('low', '关系未知、又是主动搭讪的一方，只有「真的假的」这类词和她沾边'), 't': [
        ('ask', '平', False), ('ask', '平', False), ('ask', '平', False), ('joke', '平', True),
        ('joke', '开心', False), ('ask', '平', False), ('close', '平', False), ('close', '平', False)]},
    'rc-004': {'pf': ('high', '短句琐碎、笨拙地承认「不送东西就没有理由找你」，和她嘴硬里透软的口气同一种'), 't': [
        ('answer', '平', True), ('answer', '平', True), ('joke', '撒娇', False), ('ask', '撒娇', False)]},
    'rc-005': {'pf': ('mid', '语气自然、有表情包，但只有一次坦白，辨不出她的口癖'), 't': [
        ('answer', '平', False), ('share', '平', True), ('answer', '平', False), ('share', '平', False)]},
    'rc-006': {'pf': ('mid', '有「你也真抽象」这种损法，但整段是错位争吵，看不清日常口吻'), 't': [
        ('share', '开心', False), ('answer', '平', False), ('answer', '平', False),
        ('joke', '平', False), ('ask', '平', False), ('ask', '生气', False)]},
    'rc-007': {'pf': ('high', '「哎／算了」加赌气式撒娇，正是她的口头禅与雷区同型'), 't': [
        ('share', '难过', False), ('share', '难过', False), ('share', '难过', False),
        ('answer', '难过', False), ('close', '难过', False), ('answer', '生气', False)]},
    'rc-008': {'pf': ('mid', '叠词安慰「吹吹吹吹」像她，其余是通用的粘人语气'), 't': [
        ('comfort', '平', False), ('comfort', '撒娇', False), ('share', '累', True), ('answer', '平', False)]},
    'rc-009': {'pf': ('mid', '前后两半分叉：鸡汤式安慰不像她，转到「下次我请你吃小蛋糕」就对了'), 't': [
        ('comfort', '平', False), ('comfort', '平', False), ('comfort', '平', True)]},
    'rc-010': {'pf': ('mid', '直接要抱、称呼来回逗像她；「老公／丈夫」是已婚样本的称呼，不是她的'), 't': [
        ('joke', '撒娇', False), ('ask', '撒娇', False), ('joke', '撒娇', False), ('joke', '撒娇', False)]},
    'rc-011': {'pf': ('mid', '撒娇追问「有多想」的节奏像她，称呼同样是「老婆」体系'), 't': [
        ('joke', '撒娇', False), ('ask', '撒娇', False), ('ask', '撒娇', False),
        ('ask', '撒娇', False), ('answer', '撒娇', False)]},
    'rc-012': {'pf': ('mid', '「不知道／没事」的回避加一记实话，像她的闷和不擅长表达'), 't': [
        ('close', '平', False), ('answer', '平', False), ('comfort', '平', False)]},
    'rc-013': {'pf': ('mid', '熬夜、睡不着、语气软像她；全程用小名自称不是她的习惯'), 't': [
        ('answer', '平', True), ('answer', '累', False), ('answer', '平', False),
        ('answer', '平', False), ('answer', '平', False)]},
    'rc-014': {'pf': ('mid', '损人激将像她，但「敢不敢挑战」这种梗更像摆拍'), 't': [
        ('ask', '开心', False), ('joke', '开心', False), ('joke', '开心', False)]},
    'rc-015': {'pf': ('mid', '「我的英名我的脸面」的整活像真人，随后转软说失眠也像她'), 't': [
        ('answer', '平', False), ('joke', '开心', False), ('answer', '难过', True),
        ('share', '难过', False), ('ask', '平', False)]},
    'rc-016': {'pf': ('mid', '讲事干净、分句连发像她，但内容是八卦型输出'), 't': [
        ('share', '平', False), ('share', '平', False), ('share', '平', False), ('share', '平', False),
        ('share', '平', False), ('share', '开心', False), ('share', '开心', False),
        ('share', '开心', False), ('share', '开心', False), ('answer', '平', False)]},
    'rc-017': {'pf': ('mid', '接梗整活、把话拐回自己身上像真人；不是她的口癖'), 't': [
        ('ask', '平', False), ('answer', '平', False), ('joke', '开心', False), ('share', '平', True)]},
    'rc-018': {'pf': ('high', '「我乐意」顶回去、被否掉就用「行」收尾，正是她的嘴硬与「算了」'), 't': [
        ('share', '开心', False), ('clarify', '生气', False), ('answer', '生气', False),
        ('answer', '生气', False), ('close', '生气', False)]},
    'rc-019': {'pf': ('high', '被否掉先顶一句、再把「我就想好好跟你聊会天」说出来，和她嘴硬带直球同型'), 't': [
        ('ask', '平', False), ('share', '累', False), ('clarify', '累', False),
        ('refuse', '生气', False), ('ask', '累', False), ('answer', '生气', False)]},
    'rc-020': {'pf': ('mid', '深夜长段、反复改口真人味足；整段是检讨讨好，和她「报喜不报忧」反着来'), 't': [
        ('ask', '难过', False), ('share', '难过', False), ('share', '累', True), ('share', '难过', False),
        ('close', '难过', False), ('share', '难过', False), ('ask', '难过', False),
        ('share', '难过', False), ('close', '难过', False), ('share', '难过', False),
        ('close', '难过', False)]},
    'rc-021': {'pf': ('mid', '「怕被冷落、追一句在不在」是她的心事；这里连刷六轮比她更黏'), 't': [
        ('share', '难过', False), ('ask', '难过', False), ('ask', '难过', False),
        ('ask', '难过', False), ('ask', '难过', False), ('ask', '难过', False)]},
    'rc-022': {'pf': ('low', '全程敬语加追债的条理，和她生活里的说话方式无关'), 't': [
        ('clarify', '平', False), ('ask', '平', False), ('clarify', '平', False),
        ('answer', '平', False), ('ask', '平', False), ('ask', '平', False),
        ('answer', '平', False), ('clarify', '平', False), ('ask', '生气', False)]},
    'rc-023': {'pf': ('high', '打错又自己纠正、玩暧昧小游戏并直接要亲密，正对她撒娇与「想他不含糊」'), 't': [
        ('ask', '开心', False), ('joke', '开心', False), ('ask', '撒娇', False),
        ('clarify', '开心', False), ('clarify', '开心', False), ('ask', '撒娇', False)]},
    'rc-024': {'pf': ('high', '「这么敷衍」「这么激烈」的连怼加一个软表情，是她嘴硬但不真闹的口气'), 't': [
        ('ask', '难过', False), ('answer', '生气', False), ('ask', '撒娇', False),
        ('answer', '生气', False), ('joke', '开心', True)]},
    'rc-025': {'pf': ('low', '涂鸦遮掉大半内容、可读只有几个短句，且语境与她的日常不同'), 't': [
        ('ask', '平', False), ('joke', '撒娇', False), ('answer', '撒娇', False),
        ('joke', '撒娇', False), ('ask', '撒娇', False), ('ask', '撒娇', False)]},
    'rc-026': {'pf': ('high', '家庭群里想家、面试被拒只淡淡一个「晕」，还会自嘲情绪太多，正是她报喜不报忧那一面'), 't': [
        ('share', '难过', False), ('share', '难过', False), ('joke', '平', False),
        ('share', '难过', True), ('answer', '平', False)]},
    'rc-027': {'pf': ('mid', '共情的方向对，但只回两个问号和半句话，信息量太少'), 't': [
        ('answer', '平', False), ('answer', '平', False), ('comfort', '难过', False)]},
    'rc-028': {'pf': ('low', '只有一句反问，看不出说话习惯，只能算不冲突'), 't': [
        ('ask', '难过', False)]},
    'rc-029': {'pf': ('high', '担心就直接说（怕分手、想哄他），和她「怕被冷落、想他不含糊」两条贴'), 't': [
        ('ask', '难过', False), ('answer', '难过', False), ('comfort', '难过', False),
        ('ask', '难过', False), ('close', '难过', False)]},
    'rc-030': {'pf': ('mid', '逼问式追责、短促重复，真人味足但不是她的说话方式'), 't': [
        ('clarify', '平', False), ('clarify', '生气', False), ('clarify', '生气', False),
        ('ask', '难过', False), ('answer', '生气', False), ('ask', '难过', False),
        ('answer', '生气', False), ('ask', '难过', False)]},
    # ---- closing-turns（6 段）----
    'ct-001': {'pf': ('mid', '已婚样本、叫「老公」；直接说「太想你了」和她「想他不含糊」沾边'), 't': [
        ('share', '撒娇', False)]},
    'ct-002': {'pf': ('mid', '连说带发图的日常报备有真人味，称呼体系不是她的'), 't': [
        ('share', '开心', False), ('answer', '平', False)]},
    'ct-003': {'pf': ('low', '只有一句「好哒」，她的词库里没有这个'), 't': [
        ('confirm', '平', False)]},
    'ct-004': {'pf': ('mid', '连发三条加一句反问「你呢」，连发习惯像她'), 't': [
        ('close', '累', False), ('ask', '平', False)]},
    'ct-005': {'pf': ('mid', '「我不，我就要叫」的嘴硬像她，样本本身置信只有 low'), 't': [
        ('close', '平', True), ('joke', '撒娇', False)]},
    'ct-006': {'pf': ('n/a', '说话人未知，不参与人设对照'), 't': []},
}


def is_asked(text: str) -> bool:
    t = text.rstrip()
    if not t:
        return False
    if t.endswith('？') or t.endswith('?'):
        return True
    return t.endswith('吗') or t.endswith('呢') or t.endswith('吧')


def med(nums):
    return statistics.median(nums) if nums else 0


def annotate(rec, rid, key_turns='turns'):
    ann = ANN.get(rid)
    if ann is None:
        raise SystemExit(f'缺人工标注：{rid}')
    her = rec.get('her')
    turns = rec[key_turns]
    her_idx = [i for i, t in enumerate(turns) if her and t.get('who') == her]
    if len(her_idx) != len(ann['t']):
        raise SystemExit(f'{rid}：人工标注 {len(ann["t"])} 轮，实际 her 侧 {len(her_idx)} 轮，对不上')
    marks = dict(zip(her_idx, ann['t']))
    agg_bubbles, agg_chars, asked_n, switched_n = [], [], 0, 0
    for i, t in enumerate(turns):
        if i not in marks:
            continue
        act, mood, switched = marks[i]
        bubbles = t.get('bubbles') or []
        t['act'] = act
        t['mood'] = mood
        t['stats'] = {
            'bubbles': len(bubbles),
            'median_chars': med([len(b) for b in bubbles]),
            'asked': any(is_asked(b) for b in bubbles),
            'switched_topic': bool(switched),
        }
        agg_bubbles.append(len(bubbles))
        agg_chars.extend([len(b) for b in bubbles])
        asked_n += 1 if t['stats']['asked'] else 0
        switched_n += 1 if switched else 0
    rec['persona_fit'] = {'level': ann['pf'][0], 'why': ann['pf'][1]}
    rec['stats'] = {
        'her_turns': len(her_idx),
        'bubbles_per_turn_median': med(agg_bubbles),
        'bubbles_per_turn_counts': agg_bubbles,
        'median_chars': med(agg_chars),
        'asked_rate': round(asked_n / len(her_idx), 3) if her_idx else 0,
        'switched_topic_count': switched_n,
    }
    return rec


def main():
    out = []
    with open(os.path.join(SRC, 'samples.jsonl'), encoding='utf-8') as fh:
        for line in fh:
            if line.strip():
                rec = json.loads(line)
                out.append(annotate(rec, rec['id']))
    with open(os.path.join(HERE, 'samples.jsonl'), 'w', encoding='utf-8') as fh:
        for rec in out:
            fh.write(json.dumps(rec, ensure_ascii=False) + '\n')

    out2 = []
    with open(os.path.join(SRC, 'closing-turns.jsonl'), encoding='utf-8') as fh:
        for line in fh:
            if not line.strip():
                continue
            rec = json.loads(line)
            rec['turns'] = rec.pop('closing')
            rec['scene'] = 5              # 收尾渠道抽样，按原 1–8 口径归到场景 5
            rec['staged'] = rec.get('staged') == 'yes' or rec.get('staged') is True
            rec['staged_note'] = '原字段为字符串 yes/no，v2 统一成布尔'
            out2.append(annotate(rec, rec['key']))
    with open(os.path.join(HERE, 'closing-turns.jsonl'), 'w', encoding='utf-8') as fh:
        for rec in out2:
            fh.write(json.dumps(rec, ensure_ascii=False) + '\n')

    print(f'写出 v2/samples.jsonl {len(out)} 段、v2/closing-turns.jsonl {len(out2)} 段')
    print('her 侧轮次合计：', sum(r['stats']['her_turns'] for r in out + out2))


if __name__ == '__main__':
    main()
