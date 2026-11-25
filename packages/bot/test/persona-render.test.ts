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

test('桌面私聊把玩笑当作偶尔的选择，累了或认真问事就直接回应', () => {
    const text = renderPersona({ card, names });
    assert.match(text, /自己也觉得好玩.*顺着他刚说的一个细节拐一下.*说完就停/);
    assert.match(text, /他累了、难受，或者在认真说事、正经问你，就直接回应/);
    assert.equal(text.split('它明天早八啊').length - 1, 1);
    assert.match(text, /参考这个拐法，话还是用你自己的/);
});

test('废话和互损只在合适的私聊顺口接', () => {
    const text = renderPersona({ card, names });
    assert.match(text, /他正常闲聊时，你也可以自己先来一句废话/);
    assert.match(text, /像是要下结论，最后绕回原地/);
    assert.match(text, /你们明显在互逗.*我靠/);
    assert.match(text, /别扯家人.*旁边有人就收着/);
    assert.match(text, /难受.*直接回应/);
});

test('闲聊接到位就收住，真正的下文和认真提问可以说完整', () => {
    const text = renderPersona({ card, names });
    assert.match(text, /闲聊已经接到位，那句本身就是完整回复/);
    assert.match(text, /不用为了收尾再补建议、提醒或反问/);
    assert.match(text, /真有下文，就把想说的说完/);
    assert.match(text, /正经问你，就直接回应/);
});

test('桌面私聊允许自然改口，数字、时间和认真拿主意先弄清楚', () => {
    const text = renderPersona({ card, names });
    assert.match(text, /没想圆也可以先说，接住一个点就够/);
    assert.match(text, /真听岔了就自然改口，不用故意说错/);
    assert.match(text, /数字、时间，或者他认真请你拿主意时，先弄清楚再答/);
});

test('对别人的做法可以直说不满，信息不足时不定性也不拱火', () => {
    const text = renderPersona({ card, names });
    assert.match(text, /真觉得过火.*只说具体做法/);
    assert.match(text, /只听到一面.*不下定论/);
    assert.match(text, /不骂人.*长相、身体或家人.*不拱火/);
});

test('渲染：空字段跳过、结果确定', () => {
    const text = renderPersona({ card: { description: '只有一个字段' }, names });
    assert.ok(text.includes('只有一个字段'));
    const a = renderPersona({ card: { description: "同上" }, names }); const b = renderPersona({ card: { description: "同上" }, names }); assert.equal(a.split("生成")[0], b.split("生成")[0]);
});
