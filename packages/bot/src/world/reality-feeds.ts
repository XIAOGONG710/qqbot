import { join } from 'node:path';
import type { Lifetime } from '../platform/lifetime.ts';
import { DEFAULTS, type AppConfig } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import type { Character } from '../st/card.ts';
import { airQualityFetcher, useRealAirQuality, type AirQualityFetcherStatus } from './air-quality.ts';
import { calendarFetcher, useRealCalendar, type CalendarStatus } from './calendar.ts';
import { daylightFetcher, useRealDaylight, type DaylightFetcherStatus } from './daylight.ts';
import { transportFetcher, useRealTransport, type TransportFetcherStatus } from './transport.ts';
import { useRealWeather, weatherFetcher, type WeatherFetcherStatus } from './weather.ts';
import { parseWeatherObservation, readWeatherEvidenceLedger, reconciledWeather, userWeatherEvidence } from './weather-evidence.ts';
import type { worldState } from './world.ts';
import type { WorldUpkeep } from '../modules/world-upkeep.ts';

// 现实数据的取数器（真实天气 ADR 0048 / 0338、空气质量 0227、日照 0228、法定日历 0231、交通 0334）：
// 建取数器、接上全局读口、搭 App 时立刻取一次、登记停法（撤读口、等进行中的那一轮）、记一行开没开。
// 原来在 app.ts 里，ADR 0336 收尾（docs/plans/2026-11-24-0336-finish.md）原样搬到这里，先后不变；
// 定时刷新仍由 world-upkeep 模块声明（这里只给它要挂的几样），他说的现场天气仍由 App 在收下私聊时交过来记。

/** 真实天气多久取一次（ADR 0048） */
export const WEATHER_REFRESH_MS = 30 * 60_000;
/** 真实空气质量多久取一次（ADR 0227） */
export const AIR_QUALITY_REFRESH_MS = 30 * 60_000;
/** 真实日照多久取一次（ADR 0228） */
export const DAYLIGHT_REFRESH_MS = 6 * 60 * 60_000;
/** 现实法定日历多久取一次（ADR 0231） */
export const CALENDAR_REFRESH_MS = 12 * 60 * 60_000;
/** 现实交通刷新周期；供应商失败时继续使用仍在有效期内的旧缓存。 */
export const TRANSPORT_REFRESH_MS = 30 * 60_000;

type FeedStop = 'weather' | 'air-quality' | 'daylight' | 'calendar' | 'transport';

export interface RealityFeedsDeps {
    config: Pick<AppConfig, 'dataDir' | 'realWeather' | 'realAirQuality' | 'realDaylight' | 'realCalendar' | 'realTransport'>;
    /** 她的世界用的那张卡（名单里最亲的、卡上有作息和世界的那一档）；没有就什么都不取、也不记日志 */
    worldCard: Character | undefined;
    /** 世界账（记他说的现场天气时判断她在学校还是家里） */
    ledgerWorld: Pick<NonNullable<ReturnType<typeof worldState>>, 'at'> | undefined;
    worldNow: () => number;
    stopped: () => boolean;
    lifetime: Pick<Lifetime<FeedStop>, 'own'>;
    log: Log;
}

export interface RealityStatus {
    weather?: WeatherFetcherStatus;
    airQuality?: AirQualityFetcherStatus;
    daylight?: DaylightFetcherStatus;
    calendar?: CalendarStatus;
    transport?: TransportFetcherStatus;
}

export interface RealityFeeds {
    /** 真实天气接上了没有（主动消息的计划器要知道） */
    weather: ReturnType<typeof weatherFetcher> | undefined;
    /** world-upkeep 模块要挂的定时刷新（只有接上的那几样） */
    upkeep: Pick<WorldUpkeep, 'weather' | 'airQuality' | 'daylight' | 'calendar' | 'transport'>;
    /** 状态页上的那几项（只有接上的那几样，先后同原来） */
    status(): RealityStatus;
    /** 他亲手打的字里说了现场天气（ADR 0338）：记成证据，记下了返回 true（App 接着戳他的计划器） */
    noteUserWeather(userId: number, text: string, time: string): boolean;
}

export function realityFeeds({ config, worldCard, ledgerWorld, worldNow, stopped, lifetime, log }: RealityFeedsDeps): RealityFeeds {
    // 真实天气（ADR 0048 / 0338）：当前天气须经软件实况与现场观察裁决；取不到就保持未知，不用模拟天气冒充现实。
    const weatherPlaces = worldCard?.herWorld?.weather?.places;
    const weather = config.realWeather && worldCard && weatherPlaces
        ? weatherFetcher({ dir: join(config.dataDir, 'weather'), places: [weatherPlaces.school, weatherPlaces.home], log, now: worldNow })
        : undefined;
    const weatherEvidence = weather ? readWeatherEvidenceLedger(join(config.dataDir, 'weather', 'evidence.json'), log) : undefined;
    const weatherReality = weather && weatherEvidence ? reconciledWeather(weather, weatherEvidence) : weather;
    useRealWeather(weatherReality);
    const ownRealityRefresh = (
        source: { refresh(): Promise<void> } | undefined,
        refreshes: Set<Promise<void>>,
    ): Promise<void> | undefined => {
        if (stopped() || !source) return undefined;
        let resolveOwned!: () => void;
        let rejectOwned!: (reason?: unknown) => void;
        const owned = new Promise<void>((resolve, reject) => { resolveOwned = resolve; rejectOwned = reject; });
        refreshes.add(owned);
        const finished = () => { refreshes.delete(owned); };
        void owned.then(finished, finished);
        try { void source.refresh().then(resolveOwned, rejectOwned); }
        catch (error) { rejectOwned(error); }
        return owned;
    };
    // A refresh owns both cities and may still publish caches after its first
    // await. Keep that whole round inside this App's data-directory lease.
    const weatherRefreshes = new Set<Promise<void>>();
    const refreshWeather = () => ownRealityRefresh(weather, weatherRefreshes);
    void refreshWeather();
    lifetime.own('weather', () => { useRealWeather(undefined); return [...weatherRefreshes]; });
    if (worldCard) log(`真实天气：${weather ? `开（${weatherPlaces!.school.name} / ${weatherPlaces!.home.name}逐小时，每 ${WEATHER_REFRESH_MS / 60_000} 分钟取一次；当前事实过期或冲突时保持未知）`
        : !config.realWeather ? '关（配置 realWeather: false），按日期生成' : '关（卡上没写 weather.places），按日期生成'}`);
    const airQuality = config.realAirQuality === true && worldCard && weatherPlaces ? airQualityFetcher({ dir: join(config.dataDir, 'air-quality'), places: [weatherPlaces.school, weatherPlaces.home], log, now: worldNow }) : undefined;
    useRealAirQuality(airQuality);
    const airQualityRefreshes = new Set<Promise<void>>();
    const refreshAirQuality = () => ownRealityRefresh(airQuality, airQualityRefreshes);
    void refreshAirQuality();
    lifetime.own('air-quality', () => { useRealAirQuality(undefined); return [...airQualityRefreshes]; });
    if (worldCard) log(`真实空气质量：${airQuality ? `开（${weatherPlaces!.school.name} / ${weatherPlaces!.home.name}当前观测，每 ${AIR_QUALITY_REFRESH_MS / 60_000} 分钟取一次；取不到不写进世界）` : (config.realAirQuality !== true ? '关（配置 realAirQuality: false）' : '关（卡上没写 weather.places）')}`);
    const daylight = config.realDaylight === true && worldCard && weatherPlaces ? daylightFetcher({ dir: join(config.dataDir, 'daylight'), places: [weatherPlaces.school, weatherPlaces.home], log, now: worldNow }) : undefined;
    useRealDaylight(daylight);
    const daylightRefreshes = new Set<Promise<void>>();
    const refreshDaylight = () => ownRealityRefresh(daylight, daylightRefreshes);
    void refreshDaylight();
    lifetime.own('daylight', () => { useRealDaylight(undefined); return [...daylightRefreshes]; });
    if (worldCard) log(`真实日照：${daylight ? `开（${weatherPlaces!.school.name} / ${weatherPlaces!.home.name}日出日落，每 ${DAYLIGHT_REFRESH_MS / 60_000} 分钟取一次；取不到不写进世界）` : (config.realDaylight !== true ? '关（配置 realDaylight: false）' : '关（卡上没写 weather.places）')}`);
    const calendar = config.realCalendar === true && worldCard ? calendarFetcher({ dir: join(config.dataDir, 'calendar'), log, now: worldNow }) : undefined;
    useRealCalendar(calendar);
    const calendarRefreshes = new Set<Promise<void>>();
    const refreshCalendar = () => ownRealityRefresh(calendar, calendarRefreshes);
    void refreshCalendar();
    lifetime.own('calendar', () => { useRealCalendar(undefined); return [...calendarRefreshes]; });
    if (worldCard) log(`现实法定日历：${calendar ? `开（当前年和下一年，每 ${CALENDAR_REFRESH_MS / 60_000} 小时取一次；取不到不写进世界）` : '关（配置 realCalendar: false）'}`);
    const transportConfig = config.realTransport ?? DEFAULTS.realTransport;
    const worldTransport = transportConfig.enabled && worldCard && weatherPlaces ? transportFetcher({
        dir: join(config.dataDir, 'transport'), log, now: worldNow,
        // 地点和天气一样从卡上读（weather.places，ADR 0334）
        locations: [weatherPlaces.school, weatherPlaces.home].map(place => ({ id: place.id, name: place.name })),
        endpoint: transportConfig.endpoint, source: transportConfig.source,
    }) : undefined;
    useRealTransport(worldTransport);
    const transportRefreshes = new Set<Promise<void>>();
    const refreshTransport = () => ownRealityRefresh(worldTransport, transportRefreshes);
    void refreshTransport();
    lifetime.own('transport', () => { useRealTransport(undefined); return [...transportRefreshes]; });
    if (worldCard) log(`现实交通：${worldTransport ? `开（${weatherPlaces!.school.name} / ${weatherPlaces!.home.name}，每 ${TRANSPORT_REFRESH_MS / 60_000} 分钟取一次；取不到不写进世界）` : (!transportConfig.enabled ? '关（配置 realTransport.enabled: false）' : '关（卡上没写 weather.places）')}`);

    return {
        weather,
        upkeep: {
            ...(weather ? { weather: { every: WEATHER_REFRESH_MS, run: () => void refreshWeather() } } : {}),
            ...(airQuality ? { airQuality: { every: AIR_QUALITY_REFRESH_MS, run: () => void refreshAirQuality() } } : {}),
            ...(daylight ? { daylight: { every: DAYLIGHT_REFRESH_MS, run: () => void refreshDaylight() } } : {}),
            ...(calendar ? { calendar: { every: CALENDAR_REFRESH_MS, run: () => void refreshCalendar() } } : {}),
            ...(worldTransport ? { transport: { every: TRANSPORT_REFRESH_MS, run: () => void refreshTransport() } } : {}),
        },
        status: () => ({
            ...(weather ? { weather: weather.status() } : {}),
            ...(airQuality ? { airQuality: airQuality.status() } : {}),
            ...(daylight ? { daylight: daylight.status() } : {}),
            ...(calendar ? { calendar: calendar.status() } : {}),
            ...(worldTransport ? { transport: worldTransport.status() } : {}),
        }),
        noteUserWeather(userId, text, time) {
            if (!(weatherEvidence && weatherPlaces && worldCard && ledgerWorld)) return false;
            const parsed = parseWeatherObservation(text);
            if (!parsed) return false;
            const at = new Date(time);
            const current = ledgerWorld.at(worldCard.herWorld!, worldCard.schedule!, at);
            const location = parsed.target === 'user' ? 'user'
                : parsed.target === 'school' ? weatherPlaces.school.id
                    : parsed.target === 'home' ? weatherPlaces.home.id
                        : current ? (current.atSchool ? weatherPlaces.school.id : weatherPlaces.home.id) : undefined;
            const evidence = location ? userWeatherEvidence(location, parsed.condition, at) : undefined;
            if (evidence && weatherEvidence.append(evidence)) {
                log(`[${userId}] 天气证据：记下${parsed.target === 'user' ? '他所在地' : '她所在地'}的现场观察（有效 60 分钟，不记原话）`);
                return true;
            }
            return false;
        },
    };
}
