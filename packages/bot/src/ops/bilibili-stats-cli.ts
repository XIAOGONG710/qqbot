// node src/ops/bilibili-stats-cli.ts <BV号…> [--json]
// 单稿公开数据（ADR 0168 第 3 期只读层）：播放 / 赞 / 币 / 藏 / 评 / 弹幕 + 每百播互动率。匿名可读。
// --json 输出 {"ok":true,"data":[{bvid,stats,rates}]}；失败 {"ok":false,"error":{code,message,hint}}。
// 完播率 / 平均观看时长在创作中心后台，要登录，这里不做。

import { fetchVideoStats, perHundred, statsLine, type VideoStats } from '../bilibili/bilibili-stats.ts';

const args = process.argv.slice(2);
const json = args.includes('--json');
const bvids = args.filter(arg => !arg.startsWith('--'));

const fail = (code: string, message: string, hint: string, exit: number): never => {
    if (json) console.log(JSON.stringify({ ok: false, error: { code, message, hint } }));
    else console.error(`${message}（${hint}）`);
    process.exit(exit);
};

if (!bvids.length) fail('invalid_argument', '缺少 BV 号', '例如：node src/ops/bilibili-stats-cli.ts BV1xx411c7mD --json', 2);
for (const bvid of bvids) {
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) fail('invalid_argument', `不是 BV 号：${bvid}`, '只接受 BV 号', 2);
}

const results: { bvid: string; stats: VideoStats; rates: ReturnType<typeof perHundred> }[] = [];
for (const bvid of bvids) {
    try {
        const stats = (await fetchVideoStats(fetch, bvid)) ?? fail('not_found', `读不到数据：${bvid}`, '确认 BV 号；被风控就过一会儿再来', 4);
        results.push({ bvid, stats, rates: perHundred(stats) });
        if (!json) console.log(`${bvid}  ${statsLine(stats)}`);
    } catch (error) {
        fail('network_error', error instanceof Error ? error.message : String(error), '过一会儿重试；连续失败就记一行', 8);
    }
}
if (json) console.log(JSON.stringify({ ok: true, data: results }));
