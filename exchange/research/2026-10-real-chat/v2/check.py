#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""K1/K2 交付自检（红/绿门）。

用法： python check.py
退出码 0 = 通过；非 0 = 有未满足的验收条件（逐条打印）。

它只检查「能不能交」：字段齐不齐、编号全不全、统计能不能复算、
反例够不够数、每条反例的来源行是不是真的存在且真的含那句话。
"""
import json
import os
import sys
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))

ACTS = {'answer', 'confirm', 'comfort', 'joke', 'share', 'clarify', 'ask', 'refuse', 'close', 'silent'}
MOODS = {'平', '开心', '难过', '生气', '撒娇', '无聊', '累'}
TYPES = ['助手腔', '过度安慰', '复述对方的话', '机械追问', '强行汇报生活', '连续三段式', '编造没有的事']

fails = []
warns = []


def fail(msg):
    fails.append(msg)


def load_jsonl(path):
    with open(path, encoding='utf-8') as fh:
        return [json.loads(l) for l in fh if l.strip()]


def is_asked(text):
    t = text.rstrip()
    if not t:
        return False
    if t.endswith('？') or t.endswith('?'):
        return True
    return t.endswith('吗') or t.endswith('呢') or t.endswith('吧')


def median_chars(bubbles):
    return statistics.median([len(b) for b in bubbles]) if bubbles else 0


def check_k1():
    want_ids = [f'rc-{i:03d}' for i in range(1, 31)] + [f'ct-{i:03d}' for i in range(1, 7)]
    seen = {}
    for fname in ('samples.jsonl', 'closing-turns.jsonl'):
        p = os.path.join(HERE, fname)
        if not os.path.exists(p):
            fail(f'K1 缺文件：v2/{fname}')
            continue
        for rec in load_jsonl(p):
            rid = rec.get('id') or rec.get('key')
            if not rid:
                fail(f'{fname}：有一条没有 id/key')
                continue
            seen[rid] = rec
            for f in ('relation', 'scene', 'turns', 'her', 'confidence', 'staged', 'persona_fit', 'stats'):
                if f not in rec:
                    fail(f'{rid}：缺字段 {f}')
            pf = rec.get('persona_fit') or {}
            # her 未知的样本（如 ct-006）没有人设对照可言，允许 n/a
            unknown_her = rec.get('her') in (None, '', '?')
            allowed_levels = ('high', 'mid', 'low', 'n/a') if unknown_her else ('high', 'mid', 'low')
            if pf.get('level') not in allowed_levels:
                fail(f'{rid}：persona_fit.level 不是 {allowed_levels}')
            if not (pf.get('why') or '').strip():
                fail(f'{rid}：persona_fit.why 是空的')
            her = rec.get('her')
            if her in (None, '', '?'):
                her = None   # ct-006 说话人未知，按「没有 her 侧」处理
            n_her = 0
            for t in rec.get('turns', []):
                if t.get('who') != her:
                    if 'act' in t or 'mood' in t or 'stats' in t:
                        fail(f'{rid}：非她这一侧的轮次也被标了 act/mood/stats')
                    continue
                n_her += 1
                for f in ('act', 'mood', 'stats'):
                    if f not in t:
                        fail(f'{rid}：她的第 {n_her} 轮缺 {f}')
                if t.get('act') not in ACTS:
                    fail(f"{rid}：act={t.get('act')!r} 不在 10 个取值里")
                if t.get('mood') not in MOODS:
                    fail(f"{rid}：mood={t.get('mood')!r} 不在 7 个取值里")
                st = t.get('stats') or {}
                bubbles = t.get('bubbles') or []
                if st.get('bubbles') != len(bubbles):
                    fail(f'{rid}：第 {n_her} 轮 stats.bubbles={st.get("bubbles")} 和实际 {len(bubbles)} 对不上')
                if abs(float(st.get('median_chars', -1)) - median_chars(bubbles)) > 1e-9:
                    fail(f'{rid}：第 {n_her} 轮 stats.median_chars 和脚本算的不一致')
                if bool(st.get('asked')) != any(is_asked(b) for b in bubbles):
                    fail(f'{rid}：第 {n_her} 轮 stats.asked 和脚本算的不一致')
                if not isinstance(st.get('switched_topic'), bool):
                    fail(f'{rid}：第 {n_her} 轮 stats.switched_topic 不是布尔（人工标注也要给布尔）')
            if her and n_her == 0:
                fail(f'{rid}：没有任何 her 侧轮次')
            agg = rec.get('stats') or {}
            for f in ('her_turns', 'bubbles_per_turn_median', 'median_chars', 'asked_rate', 'switched_topic_count'):
                if f not in agg:
                    fail(f'{rid}：顶层 stats 缺 {f}')
    missing = [i for i in want_ids if i not in seen]
    if missing:
        fail(f'K1 编号不全，缺 {len(missing)} 个：{", ".join(missing[:8])}…')
    extra = [i for i in seen if i not in want_ids]
    if extra:
        warns.append(f'K1 有任务书外的编号（可接受，但要说明）：{extra}')
    print(f'[K1] 覆盖 {len(seen)}/{len(want_ids)} 段')


def check_k2():
    p = os.path.join(HERE, 'counterexamples.jsonl')
    if not os.path.exists(p):
        fail('K2 缺文件：v2/counterexamples.jsonl')
        return
    rows = load_jsonl(p)
    by_type = {}
    for r in rows:
        for f in ('id', 'type', 'source', 'line', 'why', 'nearest_real'):
            if f not in r or not str(r.get(f, '')).strip():
                fail(f'K2 {r.get("id")}：缺字段 {f}')
        t = r.get('type')
        if t not in TYPES:
            fail(f'K2 {r.get("id")}：type={t!r} 不在 7 类里')
        by_type[t] = by_type.get(t, 0) + 1
        src = str(r.get('source', ''))
        if ':' not in src:
            fail(f'K2 {r.get("id")}：source 要写成「仓库内路径:行号」')
            continue
        path, _, lineno = src.rpartition(':')
        full = os.path.join(REPO, path.replace('/', os.sep))
        if not os.path.exists(full):
            fail(f'K2 {r.get("id")}：source 指向的文件不存在 {path}')
            continue
        try:
            ln = int(lineno)
        except ValueError:
            fail(f'K2 {r.get("id")}：source 行号不是整数：{lineno}')
            continue
        with open(full, encoding='utf-8') as fh:
            lines = fh.read().splitlines()
        if ln < 1 or ln > len(lines):
            fail(f'K2 {r.get("id")}：source 行号 {ln} 超出 {path} 的范围')
            continue
        quoted = str(r.get('line', '')).strip()
        if quoted and quoted not in lines[ln - 1]:
            fail(f'K2 {r.get("id")}：第 {ln} 行里找不到引用的原话（不许编来源）')
    print(f'[K2] 反例 {len(rows)} 条')
    for t in TYPES:
        n = by_type.get(t, 0)
        print(f'      {t}: {n}')
        if n < 8:
            fail(f'K2 类别「{t}」只有 {n} 条，要求 ≥8')
    if len(rows) < 56:
        fail(f'K2 总共 {len(rows)} 条，要求 ≥56')
    md = os.path.join(HERE, 'counterexamples.md')
    if not os.path.exists(md):
        fail('K2 缺文件：v2/counterexamples.md')
    else:
        body = open(md, encoding='utf-8').read()
        for t in TYPES:
            if t not in body:
                fail(f'K2 counterexamples.md 里没有「{t}」这一类')


def check_schema():
    p = os.path.join(HERE, 'SCHEMA.md')
    if not os.path.exists(p):
        fail('缺 v2/SCHEMA.md（字段口径与人工/脚本分工要写明）')
        return
    body = open(p, encoding='utf-8').read()
    for kw in ('act', 'mood', 'stats', 'persona_fit', 'switched_topic', '人工'):
        if kw not in body:
            fail(f'SCHEMA.md 没写清 {kw}')


if __name__ == '__main__':
    check_schema()
    check_k1()
    check_k2()
    print()
    for w in warns:
        print('WARN:', w)
    if fails:
        print(f'✗ 未通过：{len(fails)} 条')
        for f in fails[:60]:
            print('  -', f)
        if len(fails) > 60:
            print(f'  …还有 {len(fails) - 60} 条')
        sys.exit(1)
    print('✓ 全部通过')
