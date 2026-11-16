// 把已有的大世界 / 箱庭世界投影成 ADR 0338 的世界事件。
// 这里只取已经验证过的结构化事实；不保存供应商正文、精确地点或聊天内容。

import type { WorldNow } from './world.ts';
import type { WorldEvent, WorldEventSource } from './events.ts';

const hourKey = (at: Date): string => `${String(at.getFullYear()).padStart(4, '0')}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}T${String(at.getHours()).padStart(2, '0')}`;
const keyPart = (value: string): string => encodeURIComponent(value).replace(/%/g, '_');

function event(id: string, source: WorldEventSource, kind: string, at: Date, details: WorldEvent['details'], subjects: readonly string[] = ['self']): WorldEvent {
    return {
        id, source, kind, occurredAt: at.toISOString(), observedAt: at.toISOString(),
        status: 'active', subjects, details, confidence: 1,
    };
}

/**
 * 将当前世界快照变成幂等事件。
 *
 * 每种事实按其自然变化粒度取稳定 id：环境按小时，日照/假日/所在地按状态。
 * 这样轮询不会制造事件洪水，而状态真的变化时会留下新的、可审计的事实。
 */
export function observeWorldNow(now: WorldNow, observedAt: Date): WorldEvent[] {
    if (!Number.isFinite(observedAt.getTime())) return [];
    const hour = hourKey(observedAt);
    const events: WorldEvent[] = [];
    const weather = now.weather;
    if (weather) {
        const condition = weather.now?.text ?? 'range';
        const source: WorldEventSource = weather.real ? 'world' : 'sandbox';
        events.push(event(
            `${weather.real ? 'world' : 'sandbox'}-weather:${now.day}:${hour}:${weather.rain ? 'wet' : 'dry'}:${keyPart(condition)}`,
            source, weather.real ? 'world.weather.observed' : 'sandbox.weather.projected', observedAt,
            { day: now.day, source: weather.real ? 'real' : 'simulated', raining: weather.rain, low: weather.low, high: weather.high, condition },
            ['self', 'space:current'],
        ));
    }
    if (now.airQuality) {
        const air = now.airQuality;
        events.push(event(`world-air:${hour}:${keyPart(air.category)}`, 'world', 'world.air.quality.observed', observedAt,
            { category: air.category, aqi: air.aqi, observed: air.observedAt }, ['self', 'space:current']));
    }
    if (now.daylight) {
        const daylight = now.daylight;
        events.push(event(`world-daylight:${now.day}:${keyPart(daylight.phase)}`, 'world', 'world.daylight.phase.observed', observedAt,
            { day: now.day, phase: daylight.phase }, ['self', 'space:current']));
    }
    if (now.holiday) {
        const holiday = now.holiday;
        events.push(event(`sandbox-holiday:${now.day}:${keyPart(holiday.name)}`, 'sandbox', 'sandbox.holiday.context', observedAt,
            { day: now.day, name: holiday.name, home: Boolean(holiday.home) }, ['self', 'space:current']));
    }
    if (now.publicHoliday) {
        const holiday = now.publicHoliday;
        events.push(event(`society-holiday:${now.day}:${keyPart(holiday.name)}`, 'society', 'society.public_holiday.observed', observedAt,
            { day: now.day, name: holiday.name, kind: holiday.kind }, ['self', 'space:current']));
    }
    if (now.transport) {
        const transport = now.transport;
        // 不记录 location/detail：地点可能是个人行程，detail 也可能来自第三方正文。
        events.push(event(`world-transport:${hour}:${transport.status}`, 'world', 'world.transport.status.observed', observedAt,
            { status: transport.status, observed: transport.observedAt }, ['self', 'space:current']));
    }
    events.push(event(`sandbox-presence:${now.day}:${now.atSchool ? 'school' : 'home'}`, 'sandbox', 'sandbox.presence.context', observedAt,
        { day: now.day, place: now.atSchool ? 'school' : 'home' }, ['self', 'space:current']));
    return events;
}
