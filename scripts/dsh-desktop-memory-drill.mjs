import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Exercise the installed Electron desktop host using its normal session RPC. */
export async function verifyDesktopMemory({ exe, root, ownerBankFile, manifest, recall }) {
    const runtime = join(dirname(exe), 'resources', 'app.asar', 'dsh');
    const project = join(root, 'dsh', 'profiles', 'desktop');
    const soul = join(root, 'desktop-soul');
    const input = join(root, 'synthetic-model-input.jsonl');
    const tails = join(soul, 'session-tails.jsonl');
    const sessions = ['fixture-old', 'fixture-same', 'fixture-recalled', 'fixture-other'];
    mkdirSync(project, { recursive: true });
    mkdirSync(soul, { recursive: true });
    cpSync(fileURLToPath(new URL('../dsh-plugins/dsh-linmengyao-memory', import.meta.url)),
        join(project, 'node_modules', 'dsh-linmengyao-memory'), { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, dsh: { profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-linmengyao-memory'], patchReload: 'startup',
    } } }));
    writeFileSync(join(project, 'cordis.patch.yml'), JSON.stringify([{ id: 'linmengyao-memory', config: {
        prefix: 'synthetic', presets: ['cordis'], ownerPrivateSessions: sessions, ownerBankFile,
        baseUrl: 'http://127.0.0.1:1/memory', personaCardFile: join(root, 'no-card.json'),
    } }]));
    const guard = join(root, 'desktop-network.mjs');
    writeFileSync(guard, `import net from 'node:net';
import { appendFileSync } from 'node:fs';
net.Socket.prototype.connect = () => { throw Error('synthetic desktop: outgoing sockets denied'); };
globalThis.fetch = async (input, init) => {
    const url = new URL(input.url ?? input);
    if (url.origin !== 'http://127.0.0.1:1') throw Error('synthetic desktop: unexpected endpoint');
    if (url.pathname === '/memory/v1/default/banks') return Response.json({banks:[{bank_id:'synthetic-owner'},{bank_id:'synthetic-other'}]});
    if (url.pathname === '/memory/v1/default/banks/synthetic-owner/memories/recall') return Response.json({
        results:[{id:'stale',type:'observation',text:'PRIVATE-DESKTOP-SUMMARY',document_id:'ep-1'}]
    });
    if (url.pathname.endsWith('/memories/recall')) return Response.json({results:[]});
    if (url.pathname !== '/v1/messages') throw Error('synthetic desktop: unexpected path');
    const body = JSON.parse(String(init?.body ?? await input.text()));
    appendFileSync(${JSON.stringify(input)}, JSON.stringify(body) + '\\n');
    const content = JSON.stringify(body).includes('合成首轮') ? 'PRIVATE-DESKTOP-TAIL' : '合成新会话回复';
    const events = [
        {type:'message_start',message:{id:'synthetic',type:'message',role:'assistant',content:[],model:body.model,usage:{input_tokens:10,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:content}},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}},
        {type:'message_stop'},
    ];
    return new Response(events.map(e=>'event: '+e.type+'\\ndata: '+JSON.stringify(e)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
};`);

    const read = file => {
        try { return readFileSync(file, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
    };
    const waitFor = async (check, reason) => {
        const deadline = Date.now() + 20_000;
        do {
            const result = check();
            if (result) return result;
            await sleep(50);
        } while (Date.now() < deadline);
        throw Error(reason);
    };
    let diagnostic = '';
    const run = async body => {
        const child = spawn(exe, ['--expose-internals', '--import', pathToFileURL(guard).href,
            join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
            runtime, project, join(dirname(exe), 'resources', 'runtime', 'primary-runtime')], {
            cwd: project, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            env: {
                SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH,
                TEMP: root, TMP: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
                ELECTRON_RUN_AS_NODE: '1', DSH_HOME: join(root, 'dsh'), QQBOT_SOUL_DIR: soul,
                QQBOT_DECISION_AUDIT: '1', DEEPSEEK_API_KEY: 'synthetic-fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
            },
        });
        const exited = once(child, 'exit');
        child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-6000); });
        let ready;
        let failed;
        child.on('message', message => {
            if (message.type === 'ready') ready = message.url;
            if (message.type === 'fatal') failed = message.message;
        });
        child.on('error', error => { failed = error.message; });
        try {
            const url = await waitFor(() => {
                if (failed) throw Error(failed);
                return ready;
            }, 'DSH desktop host did not start');
            const base = new URL(url).origin;
            assert.equal(new URL(url).hostname, '127.0.0.1');
            const launch = await fetch(url, { redirect: 'manual' });
            const cookie = launch.headers.getSetCookie()[0]?.split(';')[0];
            assert.ok(cookie, 'DSH desktop host did not issue an isolated browser cookie');
            const rpc = async (method, request) => {
                const rpcId = randomUUID();
                const response = await fetch(base + '/api/' + method, { method: 'POST',
                    headers: { cookie, origin: base, 'content-type': 'application/json' },
                    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }),
                });
                assert.equal(response.status, 200);
                const payload = await response.json();
                assert.equal(payload.rpcId, rpcId);
                assert.equal(payload.result.ok, true, JSON.stringify(payload.result.error));
            };
            const turn = async (sessionId, text) => {
                const rows = () => read(input).trim().split('\n').filter(Boolean);
                const before = rows().length;
                await rpc('session/create', { sessionId, cwd: project, agentPreset: 'cordis' });
                await rpc('session/prompt', { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] });
                return waitFor(() => rows().slice(before).find(row => row.includes(text)), 'Desktop turn did not reach the synthetic model');
            };
            await body(turn);
        } finally {
            const timer = setTimeout(() => child.kill(), 5000);
            if (child.connected) child.send({ type: 'shutdown' }, () => {});
            await exited.catch(() => {});
            clearTimeout(timer);
        }
    };

    await run(async turn => {
        const first = await turn(sessions[0], '合成首轮');
        assert.match(first, /PRIVATE-RECALL-SENTINEL/);
        assert.match(first, /PRIVATE-DESKTOP-SUMMARY/);
        await waitFor(() => read(tails).includes('PRIVATE-DESKTOP-TAIL'), 'The desktop did not save the first session tail');
        assert.match(await turn(sessions[1], '合成同账号续聊'), /PRIVATE-DESKTOP-TAIL/);
    }).catch(error => { throw Error(error.message + '\n' + diagnostic, { cause: error }); });

    await recall();
    await run(async turn => {
        const fresh = await turn(sessions[2], '合成撤回后重开');
        assert.match(fresh, /撤回了一条消息/);
        assert.doesNotMatch(fresh, /PRIVATE-RECALL-SENTINEL|PRIVATE-DESKTOP-SUMMARY|PRIVATE-DESKTOP-TAIL/);
        const otherChat = join(dirname(manifest.chatFile), '20003.jsonl');
        writeFileSync(otherChat, JSON.stringify({ messageId: 2, time: new Date().toISOString(), role: 'user', content: 'SYNTHETIC-OTHER-ACCOUNT' }) + '\n');
        writeFileSync(ownerBankFile, JSON.stringify({ ...manifest, ownerBank: 'synthetic-other', chatFile: otherChat,
            recalledFile: join(dirname(otherChat), '20003.recalled.json') }));
        const other = await turn(sessions[3], '合成换账号重开');
        assert.match(other, /SYNTHETIC-OTHER-ACCOUNT/);
        assert.doesNotMatch(other, /PRIVATE-RECALL-SENTINEL|PRIVATE-DESKTOP-SUMMARY|PRIVATE-DESKTOP-TAIL|撤回了一条消息/);
    }).catch(error => { throw Error(error.message + '\n' + diagnostic, { cause: error }); });
}
