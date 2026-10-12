#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""K3 批次自检门（边界 + 格式）。

用法：python check_batch.py samples-b1.jsonl
退出码 0 = 通过。查的是任务书第 2 节那几条硬规则和 v2 的格式：
  ① 每条气泡 ≤ 20 个字（码点）
  ② 气泡里不许出现：数字、链接、@、QQ/微信号模样、地名店名学校名（用「某地」代替）
  ③ who 只能是 A / B / C；her 必须是 A；只收单聊（C 出现时必须在 notes 里说明是转述）
  ④ relation ∈ {boyfriend, bestie, friend, unknown}；scene ∈ 1..9
  ⑤ staged 为 true 时必须写 staged_why
  ⑥ 她这一侧每轮要有 act / mood / stats；act、mood 词表不越界
  ⑦ 顶层要有 stats、persona_fit、confidence、stats_scope
  ⑧ 编号唯一、格式 rc-b1-NNN
"""
import json
import os
import re
import sys
import statistics

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from annotate import text_bubbles, sticker_counts, turn_median  # noqa: E402  与 annotate.py 共用同一套口径

ACTS = {'answer', 'confirm', 'comfort', 'joke', 'share', 'clarify', 'ask', 'refuse', 'close', 'silent'}
MOODS = {'平', '开心', '难过', '生气', '撒娇', '无聊', '累'}
RELS = {'boyfriend', 'bestie', 'friend', 'unknown'}
BAD = [
    (re.compile(r'https?://|www\.|\.com|\.cn', re.I), '出现链接'),
    (re.compile(r'@[A-Za-z0-9_]'), '@ 后面跟账号'),
    (re.compile(r'\d{5,}'), '像号码（连续 5 位以上数字）'),
    (re.compile(r'\d{1,2}[:：]\d{2}'), '出现钟点'),
    (re.compile(r'\d+\s*(月|日|号|点|分|星期|周[一二三四五六日])'), '出现日期/时间'),
    (re.compile(r'(微信|QQ|qq|小红书)号'), '提到账号'),
]


def med(ns):
    return statistics.median(ns) if ns else 0


def is_asked(t):
    t = t.rstrip()
    return bool(t) and (t.endswith('？') or t.endswith('?') or t.endswith('吗') or t.endswith('呢') or t.endswith('吧'))


_Q = re.compile(r'(?:[?？]|[吗呢么])[~～!！。.]*$')
_RH = re.compile(r'(?:是吧|对吧|好吧|行吧|不是吗|难道|还不|又怎么|怎么了吗|谁让|凭什么|有意见吗|不行吗|可以吗你|是不是傻)[吗呢吧啊？?]*$')


def is_asked_strict(t):
    t = t.rstrip()
    return bool(t) and bool(_Q.search(t)) and not bool(_RH.search(t))


def main(path):
    fails, warns = [], []
    rows = [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
    ids = [r.get('id') for r in rows]
    for i in set(ids):
        if ids.count(i) > 1:
            fails.append(f'编号重复：{i}')
    for r in rows:
        rid = r.get('id', '?')
        if not re.fullmatch(r'rc-b\d+-\d{3}', str(rid)):
            fails.append(f'{rid}：编号格式应为 rc-b<批号>-NNN')
        for f in ('relation', 'scene', 'staged', 'context', 'turns', 'her', 'confidence',
                  'persona_fit', 'stats', 'stats_scope'):
            if f not in r:
                fails.append(f'{rid}：缺字段 {f}')
        if r.get('relation') not in RELS:
            fails.append(f"{rid}：relation={r.get('relation')!r} 不在 {RELS}")
        if r.get('scene') not in range(1, 10):
            fails.append(f"{rid}：scene={r.get('scene')!r} 不在 1..9")
        if r.get('staged') is True and not (r.get('staged_why') or '').strip():
            fails.append(f'{rid}：staged=true 却没写 staged_why')
        if r.get('confidence') not in ('high', 'medium', 'low'):
            fails.append(f"{rid}：confidence={r.get('confidence')!r}")
        pf = r.get('persona_fit') or {}
        if pf.get('level') not in ('high', 'mid', 'low', 'n/a') or not (pf.get('why') or '').strip():
            fails.append(f'{rid}：persona_fit 不完整')
        if r.get('her') != 'A':
            fails.append(f"{rid}：her 必须是 A（截图者本人），现在是 {r.get('her')!r}")

        if r.get('stats_scope') not in ('in', 'low_confidence', 'staged_only', 'overall_only', 'excluded'):
            fails.append(f"{rid}：stats_scope={r.get('stats_scope')!r} 不在允许值里")
        aggb, aggc, asked, asked_s, sw = [], [], 0, 0, 0
        n_her = 0
        for t in r.get('turns', []):
            who = t.get('who')
            if who not in ('A', 'B', 'C'):
                fails.append(f'{rid}：who={who!r} 只能 A/B/C')
            bubbles = t.get('bubbles') or []
            for b in bubbles:
                if len(b) > 20:
                    fails.append(f'{rid}：气泡超过 20 字（{len(b)}）：{b[:24]}…')
                for rx, why in BAD:
                    if rx.search(b):
                        fails.append(f'{rid}：气泡{why}：{b[:24]}')
            if who != 'A':
                if any(k in t for k in ('act', 'mood', 'stats')):
                    fails.append(f'{rid}：非她这一侧带了标注')
                continue
            n_her += 1
            for f in ('act', 'mood', 'stats'):
                if f not in t:
                    fails.append(f'{rid}：她的第 {n_her} 轮缺 {f}')
            if t.get('act') not in ACTS:
                fails.append(f"{rid}：act={t.get('act')!r} 越界")
            if t.get('mood') not in MOODS:
                fails.append(f"{rid}：mood={t.get('mood')!r} 越界")
            st = t.get('stats') or {}
            tb = text_bubbles(bubbles)
            if st.get('bubbles') != len(bubbles):
                fails.append(f'{rid}：第 {n_her} 轮 bubbles 对不上')
            if st.get('median_chars') != turn_median(bubbles):
                fails.append(f'{rid}：第 {n_her} 轮 median_chars 对不上（整轮只有表情时必须是 null）')
            if st.get('stickers') != sticker_counts(bubbles):
                fails.append(f'{rid}：第 {n_her} 轮 stickers 对不上')
            if st.get('text_bubbles') != len(tb):
                fails.append(f'{rid}：第 {n_her} 轮 text_bubbles 对不上')
            if bool(st.get('asked')) != any(is_asked(b) for b in tb):
                fails.append(f'{rid}：第 {n_her} 轮 asked 对不上')
            if bool(st.get('asked_strict')) != any(is_asked_strict(b) for b in tb):
                fails.append(f'{rid}：第 {n_her} 轮 asked_strict 对不上')
            aggb.append(len(bubbles))
            aggc += [len(b) for b in tb]
            asked += 1 if st.get('asked') else 0
            asked_s += 1 if st.get('asked_strict') else 0
            sw += 1 if st.get('switched_topic') else 0
        agg = r.get('stats') or {}
        for k in ('her_turns', 'silent_turns', 'bubbles_per_turn_median', 'median_chars',
                  'stickers_total', 'sticker_turns', 'asked_rate', 'asked_strict_rate',
                  'switched_topic_count'):
            if k not in agg:
                fails.append(f'{rid}：顶层 stats 缺 {k}')
        if agg.get('her_turns') != n_her:
            fails.append(f'{rid}：顶层 her_turns={agg.get("her_turns")} 与实际 {n_her} 对不上')
        if agg.get('silent_turns'):
            warns.append(f'{rid}：有 {agg["silent_turns"]} 个空轮')
    print(f'[{os.path.basename(path)}] {len(rows)} 段 / 她这一侧 {sum(r.get("stats", {}).get("her_turns", 0) for r in rows)} 轮')
    for w in warns:
        print('WARN:', w)
    if fails:
        print(f'✗ 未通过：{len(fails)} 条')
        for f in fails[:40]:
            print('  -', f)
        if len(fails) > 40:
            print(f'  …还有 {len(fails) - 40} 条')
        return 1
    print('✓ 全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'samples-b1.jsonl'))
