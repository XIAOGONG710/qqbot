import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { airQualityFetcher } from '../src/world/air-quality.ts';
import { calendarFetcher } from '../src/world/calendar.ts';
import { daylightFetcher } from '../src/world/daylight.ts';
import { weatherFetcher } from '../src/world/weather.ts';

const SECRET_ERROR = 'HTTP 401 https://user:password@example.test/data?api_key=supplier-secret '
    + 'Authorization: Bearer bearer-value Cookie=cookie-value ' + 'x'.repeat(300);

function safe(summary: string, label: string): void {
    assert.match(summary, /HTTP 401/, label);
    assert.match(summary, /<redacted>/, label);
    assert.ok(summary.length <= 160, `${label}: ${summary.length}`);
    assert.doesNotMatch(summary, /supplier-secret|password@example|bearer-value|cookie-value/, label);
}

test('天气、空气质量、日照和日历的供应商异常在日志与状态中统一脱敏', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-external-error-'));
    const logs: string[] = [];
    const now = () => Date.parse('2026-11-03T04:00:00.000Z');
    const fail = async () => { throw new Error(SECRET_ERROR); };
    try {
        const weather = weatherFetcher({
            dir: join(root, 'weather'), now, log: message => logs.push(message),
            provider: { id: 'test', fetchHourly: fail },
        });
        const air = airQualityFetcher({ dir: join(root, 'air'), now, log: message => logs.push(message), fetchJson: fail });
        const daylight = daylightFetcher({ dir: join(root, 'daylight'), now, log: message => logs.push(message), fetchJson: fail });
        const calendar = calendarFetcher({
            dir: join(root, 'calendar'), now, log: message => logs.push(message), years: () => [2026], fetchJson: fail,
        });

        await Promise.all([weather.refresh(), air.refresh(), daylight.refresh(), calendar.refresh()]);
        const errors = [
            weather.status().places.jinan.error,
            air.status().places.jinan.error,
            daylight.status().places.jinan.error,
            calendar.status().error,
        ];
        errors.forEach((error, index) => safe(error ?? '', `status-${index}`));
        for (const [index, line] of logs.entries()) {
            assert.match(line, /HTTP 401.*<redacted>/, `log-${index}`);
            assert.doesNotMatch(line, /supplier-secret|password@example|bearer-value|cookie-value/, `log-${index}`);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
