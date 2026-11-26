import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseExampleIntoIndividual, parseMesExamples } from '../src/st/examples.ts';
import type { MacroNames } from '../src/st/macros.ts';

const names: MacroNames = { user: '我', char: '她' };

describe('角色卡示例对话（st/examples）', () => {
    test('parseMesExamples：空串和单个 <START> 返回空数组', () => {
        assert.deepEqual(parseMesExamples(''), []);
        assert.deepEqual(parseMesExamples('<START>'), []);
    });

    test('parseMesExamples：没有 <START> 时补一个，并 trim 首尾空白', () => {
        assert.deepEqual(parseMesExamples('你好\n世界'), ['<START>\n你好\n世界\n']);
        assert.deepEqual(parseMesExamples('  A  \n  B  '), ['<START>\nA  \n  B\n']);
        assert.deepEqual(parseMesExamples('   '), ['<START>\n\n']);
    });

    test('parseMesExamples：已带 <START> 不重复补，按块切开', () => {
        assert.deepEqual(parseMesExamples('<START>\n{{user}}: 你好\n{{char}}: 嗨'), [
            '<START>\n{{user}}: 你好\n{{char}}: 嗨\n',
        ]);
        assert.deepEqual(parseMesExamples('<START>\nA\n<START>\nB'), ['<START>\nA\n', '<START>\nB\n']);
        assert.deepEqual(parseMesExamples('<START>  A  <START> B '), ['<START>\nA\n', '<START>\nB\n']);
    });

    test('parseMesExamples：分割大小写不敏感，但开头判断大小写敏感', () => {
        assert.deepEqual(parseMesExamples('<start>\nA'), ['<START>\n\n', '<START>\nA\n']);
        assert.deepEqual(parseMesExamples('A<START>B'), ['<START>\nA\n', '<START>\nB\n']);
    });

    test('parseExampleIntoIndividual：user / char 各成一条，名字前缀去掉', () => {
        assert.deepEqual(parseExampleIntoIndividual('<START>\n我: 你好\n她: 嗨呀\n', names), [
            { role: 'system', content: '你好', name: 'example_user' },
            { role: 'system', content: '嗨呀', name: 'example_assistant' },
        ]);
    });

    test('parseExampleIntoIndividual：不以名字开头的行并入当前这条（多行）', () => {
        assert.deepEqual(parseExampleIntoIndividual('<START>\n我: 第一行\n第二行\n她: 回复\n', names), [
            { role: 'system', content: '第一行\n第二行', name: 'example_user' },
            { role: 'system', content: '回复', name: 'example_assistant' },
        ]);
    });

    test('parseExampleIntoIndividual：同一人连续多行合成一条，只去掉第一处名字前缀', () => {
        assert.deepEqual(parseExampleIntoIndividual('<START>\n我: A\n我: B\n', names), [
            { role: 'system', content: 'A\n我: B', name: 'example_user' },
        ]);
    });

    test('parseExampleIntoIndividual：没有说话人行、空块都返回空数组', () => {
        assert.deepEqual(parseExampleIntoIndividual('<START>\n随便什么\n', names), []);
        assert.deepEqual(parseExampleIntoIndividual('', names), []);
    });

    test('parseExampleIntoIndividual：没有 <START> 头的块把第一行当块头丢掉', () => {
        assert.deepEqual(parseExampleIntoIndividual('我: 你好\n她: 嗨', names), [
            { role: 'system', content: '嗨', name: 'example_assistant' },
        ]);
    });

    test('parseExampleIntoIndividual：中英混排名字和 CRLF 换行', () => {
        assert.deepEqual(parseExampleIntoIndividual('<START>\r\nUser: hello 世界\r\nBot: hi 你好\r\n', {
            user: 'User', char: 'Bot',
        }), [
            { role: 'system', content: 'hello 世界', name: 'example_user' },
            { role: 'system', content: 'hi 你好', name: 'example_assistant' },
        ]);
    });
});
