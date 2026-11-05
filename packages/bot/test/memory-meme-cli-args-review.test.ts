import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMemeArgs } from '../src/ops/meme-cli-args.ts';

test('显式目录缺值不能退回默认真实目录', () => {
    for (const args of [['remove', '合成梗', '--dir'], ['list', '--dir', ' '], ['list', '--dir', '--example', '合成']]) assert.throws(() => parseMemeArgs(args), /缺少有效值/);
});
test('重复或未知选项拒绝，不让首值掩盖用户意图', () => {
    for (const args of [['list', '--dir', 'a', '--dir', 'b'], ['list', '--directory', 'a'], ['add', '合成梗', '合成解释', '--example', '甲', '--example', '乙']]) assert.throws(() => parseMemeArgs(args), /重复|未知/);
});
test('命令和位置参数数量严格匹配', () => {
    for (const args of [[], ['unknown'], ['list', '额外'], ['remove'], ['remove', '甲', '乙'], ['add', '甲'], ['remove', ' '], ['list', '--example', '合成']]) assert.throws(() => parseMemeArgs(args));
});
test('有效显式目录和例句保持原文，选项不吞位置参数', () => {
    assert.deepEqual(parseMemeArgs(['add', '--dir', 'C:/synthetic dir', '合成梗', '--example', '合成例句', '合成的意思']), { command: 'add', positional: ['合成梗', '合成的意思'], dir: 'C:/synthetic dir', example: '合成例句' });
});
test('未指定目录继续保留既有默认行为，解析本身不访问文件', () => {
    assert.deepEqual(parseMemeArgs(['list']), { command: 'list', positional: [] });
    assert.deepEqual(parseMemeArgs(['remove', '合成梗']), { command: 'remove', positional: ['合成梗'] });
});
