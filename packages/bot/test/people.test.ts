import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { parseAppConfig, type Contact } from '../src/config.ts';
import { describePerson, knowsPeople, MAX_MENTIONED, mentionedPeople } from '../src/people.ts';

// 名单是虚构的
const me: Contact = { qq: 10001, name: '宝宝', tier: 'boyfriend' };
const gege: Contact = { qq: 10002, name: '鸽鸽', tier: 'classmate', intro: '网上认识的朋友，网络运维的大神，比较熟' };
const xiaoli: Contact = { qq: 10003, name: '小李', tier: 'known', intro: '社团里的学姐' };
const nointro: Contact = { qq: 10004, name: '老王', tier: 'classmate' };
const contacts = [me, gege, xiaoli, nointro];
const he = (content: string) => ({ role: 'user' as const, content });
const she = (content: string) => ({ role: 'assistant' as const, content });

describe('她认识的人（ADR 0016）', () => {
    test('他的话里提到名单里写了介绍的人；没写介绍的、自己都不算', () => {
        assert.deepEqual(mentionedPeople([he('鸽鸽最近在忙啥')], me, contacts), [gege]);
        assert.deepEqual(mentionedPeople([he('老王今天找我了')], me, contacts), []);
        // 鸽鸽自己说「鸽鸽」不算提起别人
        assert.deepEqual(mentionedPeople([he('鸽鸽来了')], gege, contacts), []);
        assert.deepEqual(mentionedPeople([he('在干嘛')], me, contacts), []);
    });

    test('窗口：他最后 3 条、她最后 2 次回复（连发算一次）；最近提到的在前，最多 2 个', () => {
        const history = [he('鸽鸽说他明天上班'), she('是吗'), he('嗯'), he('对'), he('好吧')];
        assert.deepEqual(mentionedPeople(history, me, contacts), [], '他第 4 条之前说的已经出窗口');
        assert.deepEqual(mentionedPeople([he('你认识鸽鸽吗'), she('认识啊'), she('小李也认识'), he('哦')], me, contacts), [xiaoli, gege]);
        assert.deepEqual(mentionedPeople([he('小李和鸽鸽')], me, contacts), [gege, xiaoli], '同一句里靠后的算最近');
        const many = [...contacts, { qq: 10005, name: '阿强', tier: 'known' as const, intro: '高中同学' }];
        assert.equal(mentionedPeople([he('小李、鸽鸽、阿强都在')], me, many).length, MAX_MENTIONED);
    });

    test('陌生人档、名单外提起时不给；单字称呼不算', () => {
        assert.equal(knowsPeople('stranger'), false);
        assert.equal(knowsPeople('unlisted'), false);
        assert.equal(knowsPeople('classmate'), true);
        assert.deepEqual(mentionedPeople([he('鸽鸽是谁')], { qq: 10009, name: '路人', tier: 'stranger' }, contacts), []);
        assert.deepEqual(mentionedPeople([he('鸽鸽是谁')], { qq: 10009, name: '路人', tier: 'unlisted' }, contacts), []);
        const single: Contact = { qq: 10006, name: '鸽', tier: 'classmate', intro: '同学' };
        assert.deepEqual(mentionedPeople([he('鸽子飞了')], me, [me, single]), []);
    });

    test('介绍：称呼、介绍，召回到的接在后面', () => {
        assert.equal(describePerson(gege), '[你认识的人：鸽鸽]\n鸽鸽：网上认识的朋友，网络运维的大神，比较熟');
        assert.equal(describePerson(gege, '[你和鸽鸽聊过的事]\n- 10月5日：鸽鸽说他在值班'),
            '[你认识的人：鸽鸽]\n鸽鸽：网上认识的朋友，网络运维的大神，比较熟\n[你和鸽鸽聊过的事]\n- 10月5日：鸽鸽说他在值班');
    });

    test('配置：intro 可选，去掉首尾空白，空的当没写；不是字符串报错', () => {
        const repoRoot = resolve(import.meta.dirname, '../../..');
        const base = { llm: { baseUrl: 'https://api.deepseek.com', model: 'm' }, characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json' };
        const env = { QQBOT_LLM_API_KEY: 'k' };
        const parsed = parseAppConfig({ ...base, contacts: [{ qq: 1, name: '鸽鸽', tier: 'classmate', intro: '  比较熟 ' }, { qq: 2, name: '阿明', tier: 'boyfriend', intro: ' ' }] }, repoRoot, env);
        assert.equal(parsed.contacts[0]!.intro, '比较熟');
        assert.equal('intro' in parsed.contacts[1]!, false);
        assert.throws(() => parseAppConfig({ ...base, contacts: [{ qq: 1, name: 'x', tier: 'classmate', intro: 3 }] }, repoRoot, env), /contacts\[0\]\.intro 应为字符串/);
    });
});
