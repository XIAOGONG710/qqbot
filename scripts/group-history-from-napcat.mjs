#!/usr/bin/env node
// 从正在跑的 NapCat 把某个群的聊天记录拉下来，直接导进她那边（2026-11-14）。
//
//   node scripts/group-history-from-napcat.mjs --list
//   node scripts/group-history-from-napcat.mjs --group 群号 [--count 2000] [--data-dir runtime/bot-shadow] [--dry-run]
//
// 需要：NapCat 在跑（默认 ws://127.0.0.1:3001，token 取 QQBOT_ONEBOT_TOKEN），
// 而且**她的号必须在这个群里**——不在群里就拿不到任何一条。
// 这条通道只读：调 get_group_list / get_group_msg_history / get_login_info，不发任何消息。

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { importGroupHistory } from '../packages/bot/src/social/group-import.ts';
import { segmentsToText } from '../packages/bot/src/platform/onebot.ts';

const { values } = parseArgs({
    options: {
        list: { type: 'boolean', default: false },
        group: { type: 'string' },
        count: { type: 'string', default: '2000' },
        'data-dir': { type: 'string', default: 'runtime/bot-shadow' },
        ws: { type: 'string', default: 'ws://127.0.0.1:3001' },
        token: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
    },
});

const token = values.token ?? process.env.QQBOT_ONEBOT_TOKEN ?? '';
const ws = new WebSocket(`${values.ws}/?access_token=${encodeURIComponent(token)}`);
let nextEcho = 0;
const pending = new Map();

ws.addEventListener('message', event => {
    let data;
    try { data = JSON.parse(String(event.data)); } catch { return; }
    if (data.echo === undefined) return;
    const waiter = pending.get(String(data.echo));
    if (!waiter) return;
    pending.delete(String(data.echo));
    waiter(data);
});

const call = (action, params = {}) => new Promise((resolve, reject) => {
    const echo = `cli-${nextEcho++}`;
    const timer = setTimeout(() => { pending.delete(echo); reject(new Error(`${action} 超时`)); }, 20_000);
    pending.set(echo, data => {
        clearTimeout(timer);
        if (data.status === 'failed') reject(new Error(`${action} 失败：${data.wording ?? data.message ?? data.retcode}`));
        else resolve(data.data);
    });
    ws.send(JSON.stringify({ action, params, echo }));
});

const opened = await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(true), { once: true });
    ws.addEventListener('error', () => reject(new Error(`连不上 ${values.ws}：NapCat 没在跑，或者 token 不对（QQBOT_ONEBOT_TOKEN）`)), { once: true });
});
void opened;

try {
    if (values.list) {
        const groups = await call('get_group_list');
        const list = Array.isArray(groups) ? groups : [];
        if (!list.length) console.log('她的号一个群都没有。');
        for (const group of list) {
            const item = group;
            console.log(`${item.group_id}\t${item.group_name}\t${item.member_count ?? ''} 人`);
        }
        ws.close();
        process.exit(0);
    }

    const groupId = Number(values.group);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
        console.error('用法：node scripts/group-history-from-napcat.mjs --list  或  --group 群号 [--count 2000] [--data-dir 目录] [--dry-run]');
        process.exit(2);
    }

    const login = await call('get_login_info');
    const selfQq = Number(login?.user_id);
    const selfName = String(login?.nickname ?? '');

    const max = Math.min(Math.max(Number(values.count) || 2000, 1), 20_000);
    const lines = [];
    let seq;
    let lastSeq = null;
    for (;;) {
        const want = Math.min(100, max - lines.length);
        const page = await call('get_group_msg_history', { group_id: groupId, ...(seq === undefined ? {} : { message_seq: seq }), count: want });
        const messages = Array.isArray(page?.messages) ? page.messages : [];
        if (!messages.length) break;
        const mapped = messages.map(message => ({
            time: new Date(Number(message.time) * 1000).toISOString(),
            from: Number(message.sender?.user_id ?? message.user_id ?? 0),
            name: String(message.sender?.card || message.sender?.nickname || '群友').replace(/\s+/g, ' ').trim().slice(0, 16),
            content: segmentsToText(message.message).replace(/\s+/g, ' ').trim(),
        })).filter(line => line.content);
        lines.unshift(...mapped);
        if (lines.length >= max) break;
        const oldest = messages[0];
        seq = oldest?.message_seq ?? oldest?.message_id;
        if (seq === undefined || seq === lastSeq) break;
        lastSeq = seq;
        if (messages.length < want) {
            // 这一页已经到头了：再往更早问一条，确认真没有了
            const probe = await call('get_group_msg_history', { group_id: groupId, message_seq: seq, count: 1 });
            if (!Array.isArray(probe?.messages) || !probe.messages.length) break;
        }
    }
    if (!lines.length) {
        console.error('这个群一条都拿不到：她的号可能不在群里，或者群号写错了（先用 --list 看看）。');
        process.exit(1);
    }
    console.log(`拿到 ${lines.length} 条（${lines[0].time} ~ ${lines[lines.length - 1].time}），她的号 ${selfQq}（${selfName}）`);

    if (values['dry-run']) {
        const dump = values.group ? `runtime/napcat-export-${groupId}.jsonl` : undefined;
        if (dump) { writeFileSync(dump, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`); console.log(`试运行：只写了一份 ${dump}`); }
        process.exit(0);
    }

    const result = importGroupHistory({ groupId, lines, dataDir: values['data-dir'], ...(selfQq ? { selfQq } : {}), ...(selfName ? { selfName } : {}) });
    console.log(`写进群 ${groupId}：${result.added} 条，认下 ${result.people} 个人（${values['data-dir']}/groups/${groupId}.jsonl 和 ${groupId}.people.json）`);
    ws.close();
    process.exit(0);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
