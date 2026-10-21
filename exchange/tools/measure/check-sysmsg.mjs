// Read-only: can we read her system notices (where Bilibili posts violation / risk warnings)? Prints counts and titles only.
import { pathToFileURL } from 'node:url';

const src = 'C:/Users/XG/Desktop/Project/qqbot-claude2/packages/bot/src';
const dataDir = 'C:/Users/XG/Desktop/Project/qqbot/runtime/bot';
const accountMod = await import(pathToFileURL(`${src}/bilibili-account.ts`).href);
const credential = accountMod.loadCredential(accountMod.credentialPath(dataDir));
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', Referer: 'https://message.bilibili.com/', Cookie: accountMod.cookieHeader(credential) };
const urls = [
    ['系统通知', `https://message.bilibili.com/x/sys-msg/query_unified_notify?csrf=${credential.biliJct}&csrf_token=${credential.biliJct}&page_size=10&build=0&mobi_app=web`],
    ['未读数', 'https://api.bilibili.com/x/msgfeed/unread?build=0&mobi_app=web'],
    ['会话列表', 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&build=0&mobi_app=web'],
];
for (const [label, url] of urls) {
    try {
        const response = await accountMod.realRequest(url, { headers, signal: AbortSignal.timeout(10_000) });
        const json = JSON.parse(await response.text());
        console.log(`${label}: http ${response.status} code ${json.code}${json.code === 0 ? '' : ` ${json.message}`}`);
        if (json.code === 0) {
            const data = json.data ?? {};
            const list = data.system_notify_list ?? data.session_list ?? [];
            console.log(`  keys: ${Object.keys(data).join(',')}  list ${Array.isArray(list) ? list.length : '-'}`);
            for (const entry of (Array.isArray(list) ? list : []).slice(0, 6)) console.log(`  - ${String(entry.title ?? entry.content ?? entry.talker_id ?? '').slice(0, 40)} | type ${entry.type ?? entry.session_type ?? ''}`);
            if (label === '未读数') console.log(`  ${JSON.stringify(data)}`);
        }
    } catch (error) {
        console.log(`${label}: 出错 ${error.message}`);
    }
    await new Promise(done => setTimeout(done, 800));
}
