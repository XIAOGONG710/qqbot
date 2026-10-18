// 外网通不通的滑动窗口（服务守护 services-watchdog.mjs 用，单独成文件好测）。
// 为什么不是「连着 N 分钟不通」：10-18 02:05 起的断网是时好时坏（DNS 偶尔成功、新连接大半超时），连续计数常常凑不齐——
// 第一条告警拖到 02:57 才写（断网 02:05 起），当天 02:47–21:26 守护记了 10 段断网，加起来约 17.5 小时，每一段都要先等 10 分钟连续解析不了。
// 规则：最近 window 次检查里不通的有 badMin 次以上算断（报一次）；断了以后最近 goodRun 次都通算恢复（报一次）。
// 纯函数式的小状态机：不碰时钟（now 由调用方给）、不碰网络。

export function createNetWatch({ window = 10, badMin = 7, goodRun = 5, everyMs = 60_000 } = {}) {
    /** 最近几次检查的结果（true = 通） */
    const results = [];
    let downSince;
    let alerted = false;
    return {
        /** 记一次检查；返回这一次要报的事（{kind:'down', bad, minutes} / {kind:'up', minutes}），没有就是 undefined */
        push(up, now = Date.now()) {
            results.push(up);
            if (results.length > window) results.shift();
            if (!alerted) {
                const bad = results.filter(ok => !ok).length;
                if (results.length >= window && bad >= badMin) {
                    downSince = now - (results.length - 1 - results.indexOf(false)) * everyMs;
                    alerted = true;
                    return { kind: 'down', bad, minutes: Math.round((now - downSince) / 60_000) };
                }
                return undefined;
            }
            const tail = results.slice(-goodRun);
            if (tail.length === goodRun && tail.every(Boolean)) {
                const minutes = Math.round((now - downSince) / 60_000);
                alerted = false;
                downSince = undefined;
                return { kind: 'up', minutes };
            }
            return undefined;
        },
        get alerted() { return alerted; },
    };
}
