import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('PWA 用连接代次隔离旧 WebSocket 消息、旧 HTTPS 轮询和动作回执', async () => {
    const source = await readFile(resolve(import.meta.dirname, '..', 'app.js'), 'utf8');
    assert.match(source, /connectionGeneration:\s*0/);
    assert.match(source, /const generation = \+\+state\.connectionGeneration/);
    assert.match(source, /message', event => \{ if \(!isCurrentConnection\(generation, socket\)\) return/);
    assert.match(source, /const session = state\.session;[\s\S]*?if \(!isCurrentConnection\(generation, undefined, session\)\) return/);
    assert.match(source, /handleIncoming\(action, generation\)/);
    assert.match(source, /sendActionResult\(value\.requestId, ok, decision, error, generation\)/);
    assert.match(source, /state\.connectionGeneration\+\+;[\s\S]*?HTTPS 会话已过期/);
});
