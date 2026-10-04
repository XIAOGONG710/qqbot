// 假 NapCat（OneBot 11 正向 WS 服务端）+ 假模型（OpenAI 兼容），给临时 Koishi 实例或独立入口做端到端测试（docs/koishi.md「临时实例」）。
// 好友、消息都是虚构的；不连真 QQ，回复不会发到任何人。
//
//   node scripts/dev/fake-napcat.mjs serve [日志文件]     起服务：WS 3911、控制 3912、模型 3913
//   node scripts/dev/fake-napcat.mjs inject <QQ> <文字>   让这个好友发一条私聊（中文请用这个，不要用 Git Bash 的 curl）
//   node scripts/dev/fake-napcat.mjs drop                 断开 WS（测重连）
//   node scripts/dev/fake-napcat.mjs sent                 列出 bot 发出去的消息
//
// 临时实例的 koishi.yml：adapter-onebot 的 endpoint 写 ws://127.0.0.1:3911（不用 token），qqbot 的 llm.baseUrl 写 http://127.0.0.1:3913。
// 假模型只记请求参数（不含消息和请求头），每次回两行固定文字。

import { appendFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const WS_PORT = 3911;
const CONTROL_PORT = 3912;
const MODEL_PORT = 3913;
const SELF_ID = 20000;
const FRIENDS = [
    { user_id: 20001, nickname: '测试男友', remark: '阿明' },
    { user_id: 20002, nickname: '同学甲', remark: '' },
    { user_id: 20003, nickname: '路人乙', remark: '乙' },
    { user_id: 20004, nickname: 'Alice', remark: '' },
];

const [command = 'serve', ...args] = process.argv.slice(2);
const control = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${path}`, { method, body: body && JSON.stringify(body) });
    console.log(await res.text());
};

if (command === 'inject') await control('POST', '/inject', { user_id: Number(args[0]), text: args[1] });
else if (command === 'drop') await control('POST', '/drop');
else if (command === 'sent') await control('GET', '/sent');
else if (command === 'serve') serve(args[0]);
else throw new Error(`不认识的命令 ${command}`);

function serve(logFile) {
    // ws 是 Koishi 的依赖，从仓库根目录的 node_modules 取
    const { WebSocketServer } = createRequire(new URL('../../package.json', import.meta.url))('ws');
    const log = line => {
        const text = `${new Date().toISOString()} ${line}`;
        if (logFile) appendFileSync(logFile, text + '\n');
        else console.log(text);
    };

    const sent = [];
    const history = new Map(); // QQ 号 -> 消息（含小号发的），get_friend_msg_history 用
    let messageId = 1000;
    let socket;
    const push = (userId, message) => {
        if (!history.has(userId)) history.set(userId, []);
        history.get(userId).push(message);
    };

    new WebSocketServer({ port: WS_PORT }).on('connection', ws => {
        socket = ws;
        log('ws connected');
        ws.on('message', raw => {
            const { action, params, echo } = JSON.parse(raw.toString());
            log(`call ${action}`);
            const reply = data => ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }));
            const fail = () => ws.send(JSON.stringify({ status: 'failed', retcode: 1400, data: null, echo }));
            switch (action) {
                case 'get_login_info': return reply({ user_id: SELF_ID, nickname: '测试小号' });
                case 'get_friend_list': return reply(FRIENDS);
                case 'get_friend_msg_history': {
                    // 真 NapCat 在没有任何记录时也报错
                    const list = history.get(Number(params.user_id));
                    return list ? reply({ messages: list.slice(-(params.count ?? 20)) }) : fail();
                }
                case 'send_private_msg': {
                    const id = ++messageId;
                    sent.push({ user_id: params.user_id, text: params.message.map(s => s.data?.text ?? '').join(''), time: new Date().toISOString() });
                    push(params.user_id, { message_id: id, time: Math.floor(Date.now() / 1000), user_id: SELF_ID, sender: { user_id: SELF_ID }, message: params.message });
                    log(`sent to ${params.user_id}`);
                    return reply({ message_id: id });
                }
                default: return fail();
            }
        });
        ws.on('close', () => log('ws closed'));
    });

    const readBody = req => new Promise(done => {
        let text = '';
        req.on('data', chunk => text += chunk);
        req.on('end', () => done(text ? JSON.parse(text) : {}));
    });

    http.createServer(async (req, res) => {
        const json = data => {
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(data));
        };
        if (req.method === 'POST' && req.url === '/inject') {
            const { user_id, text } = await readBody(req);
            const id = ++messageId;
            const time = Math.floor(Date.now() / 1000);
            const message = [{ type: 'text', data: { text } }];
            push(user_id, { message_id: id, time, user_id, sender: { user_id }, message });
            const nickname = FRIENDS.find(f => f.user_id === user_id)?.nickname ?? '?';
            // 字段同 NapCat 的私聊事件（10-04 从真 NapCat 只读核对过）
            socket?.send(JSON.stringify({
                post_type: 'message', message_type: 'private', sub_type: 'friend', time, self_id: SELF_ID, user_id, message_id: id,
                message, raw_message: text, font: 0, sender: { user_id, nickname },
            }));
            return json({ ok: !!socket, message_id: id });
        }
        if (req.method === 'POST' && req.url === '/drop') {
            socket?.close();
            return json({ ok: true });
        }
        if (req.url === '/sent') return json(sent);
        res.statusCode = 404;
        res.end();
    }).listen(CONTROL_PORT, '127.0.0.1');

    let generations = 0;
    http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
            const { messages, ...params } = await readBody(req);
            generations++;
            log(`model call #${generations} (${messages?.length} messages) ${JSON.stringify(params)}`);
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `假回复 ${generations}\n第二行` }, finish_reason: 'stop' }] }));
        }
        res.statusCode = 404;
        res.end();
    }).listen(MODEL_PORT, '127.0.0.1');

    log(`fake NapCat: ws ${WS_PORT}, control ${CONTROL_PORT}, model ${MODEL_PORT}`);
}
