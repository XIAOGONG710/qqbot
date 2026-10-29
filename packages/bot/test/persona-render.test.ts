import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderPersona } from '../src/st/persona-render.ts';

const names = { user: '宝宝', char: '林梦瑶' };
const card = {
    system_prompt: '你是{{char}}，正在和{{user}}私聊。',
    description: '在读大学生。',
    personality: '嘴上爱硬一下。',
    scenario: '{{user}}就是你的男朋友。',
    post_history_instructions: '不要否认自己是程序。',
    mes_example: '<START>\n{{user}}: 在吗\n{{char}}: 在',
};

test('渲染：身份 / 设定 / 性格 / 场景 / 规矩都在，宏替换掉', () => {
    const text = renderPersona({ card, names, source: 'card.json' });
    for (const piece of ['林梦瑶', '宝宝', '在读大学生', '嘴上爱硬一下', '不要否认自己是程序']) assert.ok(text.includes(piece), piece);
    assert.ok(!text.includes('{{'), '宏没换干净');
    assert.ok(text.includes('生成的，别手改'));
});

test('渲染：不含示例对话（那是 QQ 才用的语气锚）', () => {
    const text = renderPersona({ card, names });
    assert.ok(!text.includes('在吗'), '示例对话漏进来了');
    assert.ok(!text.includes('<START>'));
});

test('渲染：空字段跳过、结果确定', () => {
    const text = renderPersona({ card: { description: '只有一个字段' }, names });
    assert.ok(text.includes('只有一个字段'));
    const a = renderPersona({ card: { description: "同上" }, names }); const b = renderPersona({ card: { description: "同上" }, names }); assert.equal(a.split("生成")[0], b.split("生成")[0]);
});
