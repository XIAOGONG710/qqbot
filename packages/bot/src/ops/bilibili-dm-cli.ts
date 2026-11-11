// node src/ops/bilibili-dm-cli.ts --uid <对方 uid> [--data-dir runtime/bot-shadow] [--size 20] [--json] [--send "一句话"]
// 读她和某个人的 B 站私信（ADR 0168 第 3 期只读层 + ADR 0089 的发送）：默认只读；--send 才真发一句（要登录态）。
// --json 输出 {"ok":true,"data":{messages:[...]}}；失败 {"ok":false,"error":{code,message,hint}}。

import { resolve } from 'node:path';
import { credentialPath, loadCredential, openAccount, realRequest } from '../bilibili/bilibili-account.ts';

const args = process.argv.slice(2);
const one = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const json = args.includes('--json');
const uid = Number(one('--uid') ?? 0);
const size = Number(one('--size') ?? 20);
const send = one('--send');
const dataDir = resolve(process.env.INIT_CWD ?? process.cwd(), one('--data-dir') ?? 'runtime/bot-shadow');

const fail = (code: string, message: string, hint: string, exit: number): never => {
    if (json) console.log(JSON.stringify({ ok: false, error: { code, message, hint } }));
    else console.error(`${message}（${hint}）`);
    process.exit(exit);
};

if (!Number.isSafeInteger(uid) || uid <= 0) fail('invalid_argument', '缺少对方的 uid', '例如：--uid 400000004', 2);
const credential = loadCredential(credentialPath(dataDir)) ?? fail('not_logged_in', `没有登录凭证：${credentialPath(dataDir)}`, '先跑 bilibili-login-cli', 3);
const account = (await openAccount(realRequest, credential)) ?? fail('auth_expired', 'B 站说这个凭证不能用了', '重新扫码登录', 3);
const fetchDms = account.fetchDms ?? fail('not_supported', '这个账号实现没有读私信的能力', '检查代码版本', 1);

try {
    if (send !== undefined) {
        if (!send.trim()) fail('invalid_argument', '--send 后面要有话', '去掉 --send 就只读', 2);
        await account.sendDm({ uid, text: send });
        if (!json) console.log(`已发送给 ${uid}：${send.slice(0, 40)}`);
    }
    const messages = await fetchDms({ uid, size: Number.isSafeInteger(size) && size > 0 ? size : 20 });
    if (json) console.log(JSON.stringify({ ok: true, data: { uid, messages } }));
    else {
        console.log(`和 ${uid} 的私信 ${messages.length} 条（新的在后）：`);
        for (const message of messages) console.log(`${message.fromMe ? '她' : '他'} ${message.at ? new Date(message.at).toLocaleString('zh-CN') : '?'}：${message.text.slice(0, 80)}`);
    }
} catch (error) {
    fail('network_error', error instanceof Error ? error.message : String(error), '过一会儿重试；连续失败就记一行', 8);
}
