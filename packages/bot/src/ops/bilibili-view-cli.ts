// node src/ops/bilibili-view-cli.ts <BV号> [--json] [--peaks 3]
// 「看懂一个视频」的命令行（ADR 0168）：视频信息 + 章节 + 弹幕高能时刻 + 雪碧图地址；只读，不需要登录。
// 默认输出人看的摘要；--json 输出 {"ok":true,"data":{...}}（照 bili-cli 的接口形态，给 Agent 用）。
// 读不到（风控 / 接口改了 / 视频不存在）时：--json 下 {"ok":false,"error":{"code":…,"message":…,"hint":…}}。

import { danmakuPeaks, fetchDanmaku, fetchStoryboard, fetchView, viewNote } from '../bilibili/bilibili-view.ts';
import { fetchSummary } from '../bilibili/bilibili-summary.ts';

const args = process.argv.slice(2);
const bvid = args.find(arg => !arg.startsWith('--'));
const json = args.includes('--json');
const peakCount = (() => { const i = args.indexOf('--peaks'); const value = i >= 0 ? Number(args[i + 1]) : 3; return Number.isSafeInteger(value) && value > 0 ? value : 3; })();

const fail = (code: string, message: string, hint: string, exit: number): never => {
    if (json) console.log(JSON.stringify({ ok: false, error: { code, message, hint } }));
    else console.error(`${message}（${hint}）`);
    process.exit(exit);
};

const id: string = bvid ?? fail('invalid_argument', '缺少 BV 号', '例如：node src/ops/bilibili-view-cli.ts BV1xx411c7mD --json', 2);
if (!/^BV[0-9A-Za-z]{10}$/.test(id)) fail('invalid_argument', `不是 BV 号：${id}`, '只接受 BV 号（av 号先换）', 2);

try {
    const view = (await fetchView(fetch, id)) ?? fail('not_found', `读不到视频：${id}`, '确认 BV 号；被风控就过一会儿再来', 4);
    const points = view.cid ? await fetchDanmaku(fetch, view.cid) : [];
    const peaks = danmakuPeaks(points, { top: peakCount });
    const storyboard = view.cid ? await fetchStoryboard(fetch, id, view.cid) : undefined;
    const withSummary = args.includes('--summary');
    const summaryResult = withSummary && view.cid && view.upMid ? await fetchSummary(fetch, { bvid: id, cid: view.cid, upMid: view.upMid }) : { status: 'none' as const };
    const data = { view, peaks, ...(storyboard ? { storyboard } : {}), ...(withSummary ? { summary: summaryResult.status === 'ok' ? summaryResult.summary : null, summaryStatus: summaryResult.status } : {}) };
    if (json) {
        console.log(JSON.stringify({ ok: true, data }));
    } else {
        console.log(viewNote(view, peaks));
        console.log(`弹幕 ${points.length} 条${storyboard ? `；雪碧图 ${storyboard.urls.length} 张` : '；雪碧图读不到（可能要 wbi）'}`);
        if (withSummary) {
            if (summaryResult.status === 'needLogin') console.log('AI 总结：要她的 B 站号登录（这个接口未登录回 code -101）');
            else if (summaryResult.status === 'none') console.log('AI 总结：没有（短视频 / 新视频可能没有）');
            else {
                console.log(`AI 总结：${summaryResult.summary.summary || '（只有大纲）'}`);
                for (const chapter of summaryResult.summary.chapters) console.log(`  · ${chapter.title}：${chapter.points.map(point => `${point.at}s ${point.text}`).join('；')}`);
            }
        }
    }
} catch (error) {
    fail('network_error', error instanceof Error ? error.message : String(error), '过一会儿重试；连续失败就记一行、别刷', 8);
}
