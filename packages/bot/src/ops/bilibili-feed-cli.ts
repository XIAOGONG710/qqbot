// node src/ops/bilibili-feed-cli.ts [--json] [--fresh 1] [--size 5]
// B 站推荐流的一次「刷」（ADR 0168 第 2 期，只读）：拿一页推荐，按口味排一次会话（停 / 划走），只打印计划，不播视频。
// --json 输出 {"ok":true,"data":{size,visited,stayed,skipped}}；失败 {"ok":false,"error":{code,message,hint}}。
// 不登录、不点赞、不评论；被风控 / 签名变了就返回错误码，别刷第二次。

import { fetchRecommend, planSession, sessionSize, stayVerdict } from '../bilibili/bilibili-feed.ts';

const args = process.argv.slice(2);
const json = args.includes('--json');
const one = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const fresh = Number(one('--fresh') ?? 1);
const sizeArg = Number(one('--size') ?? 0);
const day = new Date().toISOString().slice(0, 10);

const fail = (code: string, message: string, hint: string, exit: number): never => {
    if (json) console.log(JSON.stringify({ ok: false, error: { code, message, hint } }));
    else console.error(`${message}（${hint}）`);
    process.exit(exit);
};

try {
    const items = await fetchRecommend(fetch, { freshIdx: Number.isSafeInteger(fresh) && fresh > 0 ? fresh : 1 });
    const size = Number.isSafeInteger(sizeArg) && sizeArg > 0 ? sizeArg : sessionSize(day);
    const session = planSession(items, [], day, size);
    const data = {
        size,
        items: items.length,
        visited: session.visited.map(item => ({ bvid: item.bvid, title: item.title, category: item.category, seconds: item.duration, reason: item.reason ?? '' })),
        stayed: session.stayed.map(entry => ({ bvid: entry.item.bvid, seconds: entry.seconds, why: stayVerdict(entry.item, day).reason })),
        skipped: session.skipped,
    };
    if (json) {
        console.log(JSON.stringify({ ok: true, data }));
    } else {
        console.log(`推荐 ${items.length} 个，这次刷 ${size} 个：停 ${session.stayed.length}、划走 ${session.skipped.length}`);
        for (const entry of session.stayed) console.log(`  停 ${entry.seconds} 秒 ·「${entry.item.title}」(${entry.item.category || '未分类'}, ${entry.item.duration} 秒)`);
        for (const bvid of session.skipped) {
            const item = session.visited.find(visited => visited.bvid === bvid)!;
            console.log(`  划走 ·「${item.title}」（${stayVerdict(item, day).reason}）`);
        }
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const risk = /code -?352|code -?412|风控/.test(message);
    fail(risk ? 'risk_control' : 'network_error', message, risk ? '被风控了：今天别再刷，隔天再看' : '过一会儿重试；连续失败就记一行', risk ? 5 : 8);
}
