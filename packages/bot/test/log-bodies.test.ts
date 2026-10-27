import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { issuesForLog, type ExitIssue } from '../src/language/exit-check.ts';
import { logBody, SENSITIVE_OFF, SENSITIVE_ON, sensitiveOn, useSensitiveSwitch } from '../src/platform/sensitive.ts';

afterEach(() => useSensitiveSwitch(SENSITIVE_OFF));

describe('日志里的聊天原文（ADR 0070 第 8 项：默认不写）', () => {
    test('没人装开关的时候是关着的：logBody 只剩字数（按字，不按字节）', () => {
        assert.equal(sensitiveOn(), false);
        assert.equal(logBody('字节的面试'), '（5 字）');
        assert.equal(logBody('a😀b'), '（3 字）');
        assert.equal(logBody(''), '（0 字）');
    });

    test('开着就是原文；再关上又只剩字数', () => {
        useSensitiveSwitch(SENSITIVE_ON);
        assert.equal(logBody('字节的面试'), '字节的面试');
        useSensitiveSwitch(SENSITIVE_OFF);
        assert.equal(logBody('字节的面试'), '（5 字）');
    });

    test('出口检查写进日志的那一句：关着时保留行号和中文类别描述（审计按这些词数每类几次），只把命中的原文抹成「…」', () => {
        const issues = [{ line: 2, kind: 'banned', match: '某个敏感词' }, { line: 0, kind: 'face', match: '[微笑]' }] as unknown as ExitIssue[];
        assert.equal(issuesForLog(issues), '第 3 行禁用词「…」、第 1 行QQ 里没有的表情「…」');
        assert.ok(!issuesForLog(issues).includes('某个敏感词'));
        useSensitiveSwitch(SENSITIVE_ON);
        assert.equal(issuesForLog(issues), '第 3 行禁用词「某个敏感词」、第 1 行QQ 里没有的表情「[微笑]」');
    });
});
