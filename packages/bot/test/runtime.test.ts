import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { ChatHistory, type StoredMessage } from '../src/history.ts';
import { isPrivateFriendMessage, segmentsToText } from '../src/onebot.ts';
import type { PromptResult } from '../src/prompt.ts';
import { cleanUpReply, splitReply } from '../src/reply.ts';
import { createResponder, PART_GAP_MS, type ResponderDeps } from '../src/responder.ts';

const names = { user: '阿明', char: '林梦瑶' };

describe('回复清理（同 ST cleanUpMessage 默认设置）', () => {
    test('去掉行首的“角色名:”和首尾空白', () => {
        assert.equal(cleanUpReply('林梦瑶: 在呢  \n', names), '在呢');
        assert.equal(cleanUpReply('嗯\n林梦瑶: 干嘛', names), '嗯\n干嘛');
    });
    test('以对方名字开头的整条作废，中途出现的截断', () => {
        assert.equal(cleanUpReply('阿明: 我来替你说', names), '');
        assert.equal(cleanUpReply('好呀\n阿明: 那走吧', names), '好呀');
    });
    test('按行拆成几条，空行和行首尾空白去掉', () => {
        assert.deepEqual(splitReply('躺着呢 刷土豆的照片\n\n  怎么了嘛 \r\n这么晚'), ['躺着呢 刷土豆的照片', '怎么了嘛', '这么晚']);
        assert.deepEqual(splitReply('\n \n'), []);
    });
});

describe('OneBot 消息', () => {
    test('消息段转文本：文字原样，表情包用名字，其他用占位符', () => {
        assert.equal(segmentsToText([
            { type: 'reply', data: { id: '1' } },
            { type: 'text', data: { text: '你看' } },
            { type: 'image', data: { summary: '[动画表情]', url: 'x' } },
            { type: 'image', data: { summary: '' } },
            { type: 'face', data: { id: '1' } },
            { type: 'record', data: {} },
            { type: 'poke', data: {} },
        ]), '你看[动画表情][图片][表情][语音][poke]');
        assert.equal(segmentsToText('纯文本'), '纯文本');
    });
    test('只认直接私聊（sub_type friend），群临时会话和群消息不算', () => {
        const base = { post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 1 };
        assert.equal(isPrivateFriendMessage(base as never), true);
        assert.equal(isPrivateFriendMessage({ ...base, sub_type: 'group' } as never), false);
        assert.equal(isPrivateFriendMessage({ ...base, message_type: 'group' } as never), false);
        assert.equal(isPrivateFriendMessage({ ...base, post_type: 'message_sent' } as never), false);
    });
});

describe('聊天记录', () => {
    test('按联系人分文件追加，读回时跳过写坏的行', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-history-'));
        try {
            const history = new ChatHistory(dir);
            history.append(1, { time: 't1', role: 'user', content: '在吗', messageId: 10 });
            history.append(2, { time: 't2', role: 'user', content: '别人' });
            appendFileSync(join(dir, 'chats', '1.jsonl'), '{"time":"t3","ro');
            assert.deepEqual(history.load(1), [{ time: 't1', role: 'user', content: '在吗', messageId: 10 }]);
            assert.equal(history.load(2).length, 1);
            assert.deepEqual(history.load(3), []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('回复调度', () => {
    function setup(overrides: Partial<ResponderDeps> = {}) {
        const stored: StoredMessage[] = [];
        const sent: string[] = [];
        const prompts: string[][] = [];
        const logs: string[] = [];
        const gaps: number[] = [];
        let release: () => void = () => {};
        const deps: ResponderDeps = {
            userId: 1,
            history: { load: () => [...stored], append: (_id, m) => { stored.push(m); } },
            buildPrompt: chat => {
                prompts.push(chat.map(m => `${m.role}:${m.content}`));
                return { messages: chat.map(m => ({ role: m.role, content: m.content })), activatedWorldInfo: [] } satisfies PromptResult;
            },
            // 第一次生成卡住，直到测试 release，用来模拟生成期间又来消息
            generate: () => new Promise(resolve => { release = () => resolve(` 回复${sent.length + 1} `); }),
            clean: reply => reply.trim(),
            send: async (_id, text) => { sent.push(text); return 100 + sent.length; },
            log: message => logs.push(message),
            sleep: async ms => { gaps.push(ms); },
            ...overrides,
        };
        return { responder: createResponder(deps), stored, sent, prompts, logs, gaps, release: () => release() };
    }

    const tick = () => new Promise(r => setImmediate(r));

    test('生成期间又来消息：丢掉这次生成，带上新消息重新生成，只发一条', async () => {
        const { responder, stored, sent, prompts, release } = setup();
        responder.receive('在吗', 1, new Date());
        await tick();
        responder.receive('人呢', 2, new Date());
        responder.receive('？', 3, new Date());
        release();
        await tick();
        release();
        await responder.whenIdle();

        assert.deepEqual(prompts, [['user:在吗'], ['user:在吗', 'user:人呢', 'user:？']]);
        assert.deepEqual(sent, ['回复1']);
        assert.deepEqual(stored.map(m => `${m.role}:${m.content}`), ['user:在吗', 'user:人呢', 'user:？', 'assistant:回复1']);
        assert.equal(stored[3]!.messageId, 101);
    });

    test('对方一直在发：最多重新生成 2 次，之后照常发出，再回复没看到的那条', async () => {
        const { responder, sent, prompts, release } = setup();
        responder.receive('1', 1, new Date());
        for (let i = 2; i <= 4; i++) {
            await tick();
            responder.receive(String(i), i, new Date());
            release();
        }
        await tick();
        await tick();
        release();
        await responder.whenIdle();
        assert.deepEqual(prompts.map(p => p.at(-1)), ['user:1', 'user:2', 'user:3', 'assistant:回复1']);
        assert.deepEqual(prompts[3], ['user:1', 'user:2', 'user:3', 'user:4', 'assistant:回复1']);
        assert.deepEqual(sent, ['回复1', '回复2']);
    });

    test('发送之后才到的消息会再触发一次回复', async () => {
        const { responder, sent, release } = setup();
        responder.receive('在吗', 1, new Date());
        await tick();
        release();
        await responder.whenIdle();
        responder.receive('人呢', 2, new Date());
        await tick();
        release();
        await responder.whenIdle();
        assert.deepEqual(sent, ['回复1', '回复2']);
    });

    test('模型出错时不发送、不记录回复，下一条消息照常处理', async () => {
        let calls = 0;
        const { responder, stored, sent, logs } = setup({
            generate: async () => {
                calls++;
                if (calls === 1) throw new Error('模型接口返回 500');
                return '好了';
            },
        });
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(sent, []);
        assert.ok(logs.some(l => l.includes('回复失败：模型接口返回 500')));

        responder.receive('？', 2, new Date());
        await responder.whenIdle();
        assert.deepEqual(sent, ['好了']);
        assert.deepEqual(stored.map(m => m.content), ['在吗', '？', '好了']);
    });

    test('多行回复拆成几条依次发，每条单独记录', async () => {
        const { responder, stored, sent, gaps } = setup({ generate: async () => '土豆是猫啊\n\n你能不能上点心\n我拍好多张呢' });
        responder.receive('土豆是什么', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(sent, ['土豆是猫啊', '你能不能上点心', '我拍好多张呢']);
        assert.deepEqual(gaps, [PART_GAP_MS, PART_GAP_MS]);
        assert.deepEqual(stored.map(m => `${m.role}:${m.content}:${m.messageId}`), [
            'user:土豆是什么:1', 'assistant:土豆是猫啊:101', 'assistant:你能不能上点心:102', 'assistant:我拍好多张呢:103',
        ]);
    });

    test('发送期间来的消息排在已发出的后面，发完后再回复', async () => {
        let replies = 0;
        let onGap: () => void = () => {};
        const { responder, stored, sent, prompts } = setup({
            generate: async () => (++replies === 1 ? '第一条\n第二条' : '回你了'),
            sleep: async () => { onGap(); },
        });
        onGap = () => { onGap = () => {}; responder.receive('等下', 2, new Date()); };
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(sent, ['第一条', '第二条', '回你了']);
        assert.deepEqual(stored.map(m => `${m.role}:${m.content}`), [
            'user:在吗', 'assistant:第一条', 'user:等下', 'assistant:第二条', 'assistant:回你了',
        ]);
        assert.deepEqual(prompts[1], ['user:在吗', 'assistant:第一条', 'user:等下', 'assistant:第二条']);
    });

    test('发到一半失败：已发出的照常记录，失败写进日志', async () => {
        let sends = 0;
        const { responder, stored, logs } = setup({
            generate: async () => '一\n二',
            send: async () => { if (++sends === 2) throw new Error('NapCat 未连接'); return 100 + sends; },
        });
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(stored.map(m => `${m.role}:${m.content}`), ['user:在吗', 'assistant:一']);
        assert.ok(logs.some(l => l.includes('回复失败：NapCat 未连接')));
    });

    test('catchUp：不记新消息，按现有记录回复一次；没有没回的消息时什么都不做', async () => {
        const { responder, stored, sent } = setup({ generate: async () => '刚看到' });
        stored.push({ time: 't', role: 'user', content: '在吗', messageId: 1 });
        responder.catchUp();
        await responder.whenIdle();
        assert.deepEqual(sent, ['刚看到']);
        assert.equal(stored.filter(m => m.role === 'user').length, 1);

        responder.catchUp();
        await responder.whenIdle();
        assert.deepEqual(sent, ['刚看到']);
    });

    test('清理后为空的回复不发送', async () => {
        const { responder, sent, logs } = setup({ generate: async () => '阿明: 替他说话', clean: r => cleanUpReply(r, names) });
        responder.receive('在吗', 1, new Date());
        await responder.whenIdle();
        assert.deepEqual(sent, []);
        assert.ok(logs.some(l => l.includes('为空')));
    });
});

describe('配置', () => {
    function withConfig(config: unknown, env: Record<string, string>) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-config-'));
        const path = join(dir, 'config.json');
        writeFileSync(path, JSON.stringify(config));
        try {
            return loadConfig(dir, { QQBOT_CONFIG: path, ...env });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
    const valid = {
        onebot: { url: 'ws://127.0.0.1:3001/' },
        llm: { baseUrl: 'https://example.com/v1', model: 'm' },
        characterCard: 'characters/linmengyao/st/linmengyao.json',
        contacts: [{ qq: 123456, name: '阿明' }],
    };

    test('密钥只从环境变量读取，其余默认值同 ST 默认预设', () => {
        const config = withConfig(valid, { QQBOT_LLM_API_KEY: 'k', QQBOT_ONEBOT_TOKEN: 't' });
        assert.equal(config.llm.apiKey, 'k');
        assert.equal(config.onebot.token, 't');
        assert.equal(config.llm.temperature, 1);
        assert.equal(config.llm.maxTokens, 300);
        assert.equal(config.prompt.worldInfo.depth, 2);
        assert.equal(config.llm.promptPostProcessing, '');
        assert.deepEqual(config.llm.extraBody, {});
    });

    test('后处理方式和额外请求参数要合法', () => {
        const withLlm = (llm: object) => withConfig({ ...valid, llm: { ...valid.llm, ...llm } }, { QQBOT_LLM_API_KEY: 'k' });
        const config = withLlm({ promptPostProcessing: 'semi', extraBody: { thinking: { type: 'disabled' } } });
        assert.equal(config.llm.promptPostProcessing, 'semi');
        assert.deepEqual(config.llm.extraBody, { thinking: { type: 'disabled' } });
        assert.throws(() => withLlm({ promptPostProcessing: 'single' }), /promptPostProcessing/);
        assert.throws(() => withLlm({ extraBody: [] }), /extraBody/);
    });

    test('缺少 API key 或白名单不对时报错', () => {
        assert.throws(() => withConfig(valid, {}), /QQBOT_LLM_API_KEY/);
        const withContacts = (contacts: unknown) => withConfig({ ...valid, contacts }, { QQBOT_LLM_API_KEY: 'k' });
        assert.throws(() => withContacts([{ qq: '123', name: 'a' }]), /contacts\[0\]\.qq/);
        assert.throws(() => withContacts([]), /contacts/);
        assert.throws(() => withContacts([{ qq: 1, name: 'a' }, { qq: 1, name: 'b' }]), /重复/);
        assert.deepEqual(withContacts([{ qq: 1, name: '宝宝' }, { qq: 2, name: '宝宝' }]).contacts.map(c => c.qq), [1, 2]);
    });
});
