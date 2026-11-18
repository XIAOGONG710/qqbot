// 她那边的世界的后台维护作为解释器的模块（ADR 0336 第 6 步「计时器迁成模块的 schedules」）：
// - 现实数据的定时刷新（天气、空气质量、日照、法定日历、交通；ADR 0334 起从卡上的 weather.places 读地点），各自按自己的间隔；
// - 世界影子（ADR 0338）每 5 分钟看一眼需要值和动机，只记录、不外发；
// - 没人找她的时候也每 LIFE_TICK_MS 推一次生活（过完的时段尽快落账），顺带看一眼要不要起 AI 生活照草稿。
// 刷新、观察、推进怎么做都还在 app.ts（各自的取数器、构造失败时的收尾、启动时立刻做的那一次都在原位）；开没开由 App 按配置和卡给，给了哪样挂哪样。
// 定时（start: 'built'）：和迁移前一样在 App 搭好时开、不等连上；先后同原来（天气 → 空气 → 日照 → 日历 → 交通 → 世界影子 → 生活），排在所有 built 的最前面。

import type { Module, ScheduleSpec } from '../interpreter/interpreter.ts';

type Job = { every: number; run: () => void } | undefined;

export interface WorldUpkeep {
    weather?: Job;
    airQuality?: Job;
    daylight?: Job;
    calendar?: Job;
    transport?: Job;
    agencyShadow?: Job;
    life?: Job;
}

export function worldUpkeepModule(jobs: WorldUpkeep): Module {
    const schedules: ScheduleSpec[] = [];
    for (const job of [jobs.weather, jobs.airQuality, jobs.daylight, jobs.calendar, jobs.transport, jobs.agencyShadow, jobs.life]) {
        if (job) schedules.push({ every: job.every, run: job.run, start: 'built' });
    }
    return { id: 'world-upkeep', schedules };
}
